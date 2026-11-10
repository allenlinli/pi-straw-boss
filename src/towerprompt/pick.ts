import { memoryWords, type ViewEntry } from "../memorycmd.ts";
import { type Act, actsOf, cardTitle, rowsOf, rowText, type Tower, towerWord, WORDS } from "../waitview.ts";
import type { Kind } from "./look.ts";
import type { Locale } from "./messages.ts";
import type { PickSource } from "./source.ts";

// The picker of the tower prompt (docs/specs/2026-11-10-wait-cards-tui.md, §3a): `/wait` (or `/boss wait`) lists the open wait cards as numbered lines, and the boss types a number to pick a card and a number to pick its act, as `/boss wait` does in
// pi's dialogs (waitcmd.ts). The presses are the server's own `tower-memory { op: "press" }`; nothing here decides what may be pressed. Plain Node and no pi package, like the rest of towerprompt/.
// Only typed keys press. prompt.ts feeds this one line at a time, the way it groups its input: a paste (a bracketed paste, or a group of more than one line) is no pick, and ends the mode with nothing pressed or posted. The whole of pick mode runs
// under the here mark (heremark.ts, through the source): a paired device's key pad cannot drive it, and a pane that cannot be marked refuses the mode. The numbers and the words of the acts are drawn by this code in a column of their own;
// everything a card says is cleaned again before it is written, since the prompt writes raw to a terminal.

const PICK = {
	en: {
		word: "wait", list: "(type a number; an empty line leaves)", card: "(type a number; an empty line goes back)", reason: "Reason (optional; Enter for none):", confirm: (tower: string, who: string | undefined) => `Skip this? ${tower}${who ? ` and ${who}` : ""} will know you will not do this. (y/N)`,
		reply: (tower: string) => `Reply to ${tower} (an empty line cancels):`, bad: "That is not one of the numbers above.", markRefused: (why: string) => `Pick mode needs this pane marked as local-only, and it could not be (${why}); nothing was asked. Try again.`,
		unavailable: "This prompt cannot press cards: its source has no way to.", pasted: "a paste is not a pick; nothing was pressed", read: (why: string) => `The cards could not be read: ${why}`, refused: (why: string) => `${why} (the list is read again)`,
		unreplied: (tower: string, answered: string, id: string) => `Handed to ${tower}.${answered === id ? ` ${id} is marked answered.` : ` ${id} was not marked answered: the memory no longer has it as a wait for you.`}`,
	},
	"zh-TW": {
		word: "等待", list: "（輸入編號；空行離開）", card: "（輸入編號；空行返回）", reason: "原因（選填，直接 Enter 表示沒有）：", confirm: (tower: string, who: string | undefined) => `確定略過？${tower}${who ? `和 ${who}` : ""}會知道你不做這件事。(y/N)`,
		reply: (tower: string) => `回覆${tower}（空行取消）：`, bad: "這不是上面列出的編號。", markRefused: (why: string) => `選擇模式需要把這個窗格標成只有本機能操作，但標不起來（${why}）；什麼都沒問。請再試一次。`,
		unavailable: "這個提示沒有按卡片的管道。", pasted: "貼上的文字不算選擇，沒有按下任何東西", read: (why: string) => `讀不到卡片：${why}`, refused: (why: string) => `${why}（清單已重新讀取）`,
		unreplied: (tower: string, answered: string, id: string) => `已交給${tower}。${answered === id ? `${id} 已標為回覆。` : `${id} 沒有標為回覆：記憶裡已經沒有這個等你的等待。`}`,
	},
};
/** What the picker draws on: a line of its own kind (the prompt's glyph and colour), and the prompt string of the mode. */
export interface PickIo {
	/** What the boss's keys press with; none: this prompt's source cannot press. */
	source: PickSource | undefined;
	locale: Locale;
	/** One line of output; a plain one carries no glyph. */
	say(line: string, kind?: Kind | "plain"): void;
	/** The mode begins (true) and ends (false): the prompt string changes. */
	mode(on: boolean): void;
	now(): number;
}
type Step = { at: "list" } | { at: "card"; i: number } | { at: "reason"; i: number } | { at: "confirm"; i: number; reason: string } | { at: "reply"; i: number };
type Row = { tower: Tower; wait: ViewEntry };
/** Controls and invisible formatting characters out of a line; a card's own line breaks make lines of their own. */
const safe = (text: string): string[] => text.split("\n").map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ""));

export function createPick(io: PickIo) {
	const w = PICK[io.locale], v = WORDS[io.locale], m = memoryWords(io.locale);
	const source = io.source as PickSource;
	let state: "off" | "starting" | "on" = "off", rows: Row[] = [], auto = false, step: Step = { at: "list" }, release: (() => void) | undefined, closed: Promise<unknown> | undefined, busy: Promise<void> = Promise.resolve();
	const out = (text: string, kind: Kind | "plain" = "plain") => void safe(text).forEach((line, i) => io.say(line, i === 0 ? kind : "plain"));
	const numbered = (labels: string[]) => labels.forEach((label, i) => out(`  ${i + 1}. ${label}`));

	/** The mark opens before anything is asked; it stays until the mode ends. Rejects when the pane cannot be marked. */
	const open = async () => {
		const held = new Promise<void>((resolve) => (release = resolve));
		const opened = new Promise<void>((ok, bad) => void (closed = source.here(() => (ok(), held)).catch(bad)));
		await opened;
	};
	const finish = async () => {
		if (state === "off") return;
		state = "off";
		rows = [];
		io.mode(false);
		release?.();
		release = undefined;
		await closed?.catch(() => {});
		closed = undefined;
	};
	/** The cards, read again; the mode ends when none is left. */
	const reload = async (): Promise<boolean> => {
		try {
			const got = await source.waits();
			auto = got.auto;
			rows = rowsOf(got.towers);
		} catch (cause) {
			out(w.read((cause as Error).message), "bad");
			await finish();
			return false;
		}
		if (!rows.length) {
			out(v.none, "info");
			await finish();
			return false;
		}
		step = rows.length === 1 ? { at: "card", i: 0 } : { at: "list" };
		show();
		return true;
	};
	const acts = (i: number) => actsOf(io.locale, auto, rows[i]!.tower, rows[i]!.wait).filter((a) => a.act.kind !== "switch");
	/** What the current step asks, as lines. */
	function show() {
		if (step.at === "list") {
			out(v.title(rows.length), "ask");
			numbered(rows.map((r, i) => rowText(io.locale, io.now(), i + 1, r.tower, r.wait).replace(/^\d+\. /, "")));
			out(w.list);
		} else if (step.at === "card") {
			const { tower, wait } = rows[step.i]!;
			out(cardTitle(io.locale, auto, tower, wait), "ask");
			numbered(acts(step.i).map((a) => a.label));
			out(w.card);
		} else if (step.at === "reason") out(w.reason, "ask");
		else if (step.at === "confirm") out(w.confirm(towerWord(io.locale, rows[step.i]!.tower), rows[step.i]!.wait.card?.from?.name), "ask");
		else out(w.reply(towerWord(io.locale, rows[step.i]!.tower)), "ask");
	}
	/** After a press or a reply: with one card the mode ends, with several the list is read again; after a refusal the list is read again either way. */
	const after = async (went: boolean) => {
		if (went && rows.length === 1) return finish();
		await reload();
	};
	const press = async (i: number, json: Record<string, unknown>, what: string): Promise<boolean> => {
		const { tower, wait } = rows[i]!, name = wait.card?.from?.name ?? "";
		try {
			const r = await source.press(tower.workspace, json);
			if (r.status !== 200) throw new Error(String(r.body?.reason ?? r.body?.error ?? r.status));
			const status = (r.body?.press as { main?: { status: string } } | undefined)?.main?.status;
			out(m.pressed(wait.id, what, !name || !status ? "" : status === "delivered" || status === "queued" ? m.told(name) : m.notReached(name, status)), "ok");
			return true;
		} catch (cause) {
			out(w.refused((cause as Error).message), "bad");
			return false;
		}
	};
	const act = async (i: number, a: Act): Promise<void> => {
		if (a.kind === "back") return void (rows.length === 1 ? await finish() : await reload());
		if (a.kind === "press") return after(await press(i, a.json, a.what));
		step = { at: a.kind === "skip" ? "reason" : "reply", i };
		show();
	};
	const handle = async (raw: string): Promise<void> => {
		const text = raw.trim();
		if (step.at === "list") {
			if (text === "") return finish();
			const n = Number(text);
			if (!/^\d+$/.test(text) || n < 1 || n > rows.length) return out(w.bad, "warn");
			step = { at: "card", i: n - 1 };
			return show();
		}
		const i = step.i;
		if (step.at === "card") {
			if (text === "") return rows.length === 1 ? finish() : reload().then(() => undefined);
			const list = acts(i), n = Number(text);
			if (!/^\d+$/.test(text) || n < 1 || n > list.length) return out(w.bad, "warn");
			return act(i, list[n - 1]!.act);
		}
		if (step.at === "reason") {
			step = { at: "confirm", i, reason: text };
			return show();
		}
		if (step.at === "confirm") {
			const reason = step.reason;
			if (!/^y(es)?$/i.test(text)) return void ((step = { at: "card", i }), show());
			return after(await press(i, { op: "press", id: rows[i]!.wait.id, act: "decline", ...(reason ? { reason } : {}) }, m.didDecline));
		}
		// reply
		if (text === "") return void ((step = { at: "card", i }), show());
		const { tower, wait } = rows[i]!;
		try {
			const r = await source.reply(tower, text, wait.id);
			out(w.unreplied(towerWord(io.locale, tower), r.answered ?? "", wait.id), "ok");
			return after(true);
		} catch (cause) {
			out(w.refused((cause as Error).message), "bad");
			return after(false);
		}
	};
	return {
		/** Whether the mode owns the keyboard: its lines are never the boss's words, not even while it starts. */
		active: () => state !== "off",
		/** `/wait`: marks the pane, reads the cards, and asks. Refused when the pane cannot be marked or the source cannot press. */
		async start(): Promise<void> {
			if (state !== "off") return;
			if (!io.source) return out(w.unavailable, "warn");
			state = "starting";
			io.mode(true);
			try {
				await open();
			} catch (cause) {
				// A paste or a leave that came meanwhile has ended the mode already (finish).
				if (state === "starting") {
					state = "off";
					io.mode(false);
				}
				return out(w.markRefused((cause as Error).message), "bad");
			}
			// A paste or a leave ended the mode while the mark was opening: it stays ended, the mark is dropped, and the cards are neither read nor listed.
			if (state !== "starting") return void release?.();
			state = "on";
			await reload();
		},
		/** One typed line of the mode (lines come one at a time; the next waits for this one). Dropped while it is starting: the boss has not seen the list yet. */
		line(raw: string): Promise<void> {
			if (state !== "on") return Promise.resolve();
			const next = busy.then(() => handle(raw)).catch((cause: Error) => out(w.refused(cause.message), "bad"));
			busy = next;
			return next;
		},
		/** A paste reached the mode: it ends, and nothing is pressed or posted. */
		async paste(): Promise<void> {
			if (state === "off") return;
			await busy;
			out(w.pasted, "warn");
			await finish();
		},
		/** The mode ends without a word (the prompt leaves, or a run starts): the mark is dropped. */
		stop: () => finish(),
		/** An operation of the mode that is under way (a press whose answer is not in yet) is waited for, so its result is printed before the prompt leaves. */
		whenIdle: () => busy,
	};
}
