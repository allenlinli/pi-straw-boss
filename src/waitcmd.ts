import { asBoss } from "./autoscope.ts";
import { clean } from "./board.ts";
import type { Here } from "./heremark.ts";
import { terminalOnlyOpts } from "./intercept.ts";
import { type Lang, matchWorkspaces, memoryWords, tidy, type View, type ViewEntry, type ViewFrom } from "./memorycmd.ts";

// `/boss wait` (docs/specs/2026-11-10-wait-cards-tui.md, §2): the boss picks an open wait card from a list in the terminal, then an act, and nobody types or remembers a `W<n>`. It is the picker of the same presses
// `/boss memory done|choose|decline|restate W<n>` makes (one `tower-memory { op: "press" }` each, the server's own checks and refusals), over the cards `boss-waits` lists (waitlist.ts). The same code runs in an ordinary pi (boss.ts)
// and in the pi of a tower run that stands in a pane (runmode.ts), each with the requests it may make; the run's token is never attached.
// Only the boss's typed command reaches it. Every dialog is drawn terminal-only (`terminalOnlyOpts`: the GUI never gets a relayed select for a menu opened at a keyboard), under the boss's mark (`asBoss`), and the whole
// flow runs inside the here mark (heremark.ts), so a paired device's key pad cannot drive the picker. A pane that cannot be marked refuses the command, and a session with no screen is refused.

/** The dialogs of a pi session (`ctx.ui`): this command draws every one terminal-only. */
export interface WaitUi {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
}
type Reply = { ok: boolean; error?: string; [key: string]: unknown };
export interface WaitCmdDeps {
	lang: Lang;
	/** True when the pi session has a screen (`ctx.hasUI`). */
	interactive: boolean;
	/** This session's workspace id, so its own tower's cards are listed first. */
	own: string | undefined;
	tell(text: string, level?: "info" | "warning" | "error"): void;
	/** One request to the control socket (`boss-waits`, `tower-event`, `head-event`); the caller adds the sender of an event. Never with a run token. */
	ask(request: Record<string, unknown>): Promise<Reply>;
	/** One request to a workspace's `tower-memory`: its reply, whose `status` and `body` are the memory route's. */
	memory(workspace: string, json: Record<string, unknown>): Promise<Reply & { status?: number; body?: Record<string, unknown> }>;
	workspaces(): Promise<{ workspace_id: string; label: string; tokens?: Record<string, string> }[]>;
	/** The tabs of a Herdr workspace, for the switch to a raiser's tab (the card names the raiser's workspace and tab by their labels). */
	tabs(workspace: string): Promise<{ tab_id: string; label?: string }[]>;
	ui: WaitUi;
	here: Here;
	/** Brings a Herdr tab forward. */
	focus(tab: string): Promise<void>;
	now(): number;
}
interface Tower { workspace: string; label: string; head?: true; own?: true; waits: ViewEntry[]; problem?: string }
interface Listed { auto: boolean; rows: { tower: Tower; wait: ViewEntry }[] }

const WORDS = {
	en: {
		usage: "Usage: /boss wait [-w <workspace id | label | head>]",
		noUi: "/boss wait presses a card only in a pi session with a screen (a person at the keyboard): this one has none.",
		none: "No wait card is open for you.",
		title: (n: number) => `Waits for you (${n})`,
		needs: "Needs you: ", from: (who: string) => ` · from ${who}`, sep: " · ", parked: "[parked] ", replied: " (you replied)",
		ago: (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`),
		tag: (label: string) => `[${label}] `,
		happened: "What happened", do: "What you do", where: "Where", run: "Run", after: "After that", secret: "Secret", raised: "Raised by", legacy: "An old free-text wait: it has no buttons.",
		stateParked: "Parked for your return.", stateReplied: "You replied; the tower has not resolved it yet.", statePressed: (what: string) => `Pressed: ${what}.`,
		done: "I'm done", skip: "Skip", back: "Back", restate: (tower: string) => `Ask ${tower} to rewrite it as a card`,
		secretStart: (name: string) => `Start entering (asks ${name} to open the entry box)`, secretDone: "I entered it",
		reply: (tower: string) => `Reply to ${tower}`, switchTo: (name: string) => `Switch to ${name}'s tab`,
		tower: "the tower", head: "the head tower", raiserFallback: "the raiser",
		autoSecret: "Start entering is off while auto mode is on: /boss auto off first.",
		reason: "Reason (optional)", skipTitle: "Skip this?", skipBody: (tower: string, who: string | undefined) => `${tower}${who ? ` and ${who}` : ""} will know you will not do this.`,
		replyTitle: (tower: string) => `Reply to ${tower}`, replied2: (tower: string, answered: string, id: string) => `Handed to ${tower}.${answered === id ? ` ${id} is marked answered.` : ` ${id} was not marked answered: the memory no longer has it as a wait for you.`}`,
		didSecret: (name: string) => `asked ${name} to open the entry box`,
		noWorkspace: "This session is not in a Herdr workspace: name one with -w <workspace id | label | head>.",
		noMatch: (q: string) => `No workspace matches "${q}".`, many: (q: string) => `"${q}" names more than one workspace; nothing was done: name the id.`,
		refused: (why: string) => `${why} (the list is read again)`,
		tabNone: (name: string) => `${name}'s tab was not found: it may have been closed or renamed.`, tabMany: (name: string) => `More than one tab looks like ${name}'s: nothing was switched.`,
	},
	"zh-TW": {
		usage: "用法：/boss wait [-w <workspace id | 名稱 | head>]",
		noUi: "/boss wait 只在有畫面的 pi session（有人在鍵盤前）裡按卡片：這個 session 沒有畫面。",
		none: "沒有等你處理的卡片。",
		title: (n: number) => `等你處理（${n}）`,
		needs: "需要你處理：", from: (who: string) => `・由 ${who}`, sep: "・", parked: "［已暫放］", replied: "（你已回覆）",
		ago: (ms: number) => (ms < 60_000 ? "剛剛" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} 分前` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} 小時前` : `${Math.floor(ms / 86_400_000)} 天前`),
		tag: (label: string) => `［${label}］`,
		happened: "發生了什麼", do: "你要做的", where: "在哪裡", run: "指令", after: "做完之後", secret: "密鑰", raised: "提出者", legacy: "舊式的自由文字等待：沒有按鈕。",
		stateParked: "已暫放，等你回來。", stateReplied: "你已回覆，塔台還沒結案。", statePressed: (what: string) => `已按下：${what}。`,
		done: "我做完了", skip: "略過", back: "返回", restate: (tower: string) => `請${tower}重寫成卡片`,
		secretStart: (name: string) => `開始輸入（請 ${name} 開啟輸入框）`, secretDone: "我輸入好了",
		reply: (tower: string) => `回覆${tower}`, switchTo: (name: string) => `切到 ${name} 的分頁`,
		tower: "塔台", head: "主塔台", raiserFallback: "提出者",
		autoSecret: "自動模式開著時不能開始輸入密鑰：先 /boss auto off。",
		reason: "原因（選填）", skipTitle: "確定略過？", skipBody: (tower: string, who: string | undefined) => `${tower}${who ? `和 ${who}` : ""}會知道你不做這件事。`,
		replyTitle: (tower: string) => `回覆${tower}`, replied2: (tower: string, answered: string, id: string) => `已交給${tower}。${answered === id ? `${id} 已標為回覆。` : `${id} 沒有標為回覆：記憶裡已經沒有這個等你的等待。`}`,
		didSecret: (name: string) => `請 ${name} 開啟輸入框`,
		noWorkspace: "這個 session 不在任何 Herdr workspace 裡：用 -w <workspace id | 名稱 | head> 指定。",
		noMatch: (q: string) => `沒有符合「${q}」的 workspace。`, many: (q: string) => `「${q}」對到不只一個 workspace，什麼都沒做：請指明 id。`,
		refused: (why: string) => `${why}（清單已重新讀取）`,
		tabNone: (name: string) => `找不到 ${name} 的分頁：它可能已關閉或改名。`, tabMany: (name: string) => `不只一個分頁像是 ${name} 的：什麼都沒切換。`,
	},
};

/** The words after `/boss wait`: an optional `-w <workspace id | label | head>`. `usage` when they are anything else. */
export function parseWaitArgs(input: string): { workspace?: string } | { usage: true } {
	const rest = input.trim();
	if (rest === "") return {};
	const m = /^-w\s+(\S+)$/.exec(rest);
	return m ? { workspace: m[1]! } : { usage: true };
}

/** `/boss wait <args>`. */
export async function runWaitCommand(args: string, d: WaitCmdDeps): Promise<void> {
	const w = WORDS[d.lang], parsed = parseWaitArgs(args);
	if ("usage" in parsed) return d.tell(w.usage, "warning");
	if (!d.interactive) return d.tell(w.noUi, "error");
	// The boss's mark outside, the here mark inside it: every dialog below opens under both (and is terminal-only).
	await asBoss(async () => {
		try {
			const only = parsed.workspace === undefined ? undefined : await resolveOnly(d, parsed.workspace);
			await d.here(() => picker(d, only));
		} catch (error) {
			d.tell((error as Error).message, "error");
		}
	});
}

/** The workspace a `-w` names, as `boss-waits` takes it: `head` for the head tower (also when its own Herdr workspace is named), else an id. */
async function resolveOnly(d: WaitCmdDeps, q: string): Promise<string> {
	const w = WORDS[d.lang];
	if (q === "head") return q;
	const all = await d.workspaces(), found = matchWorkspaces(all, q);
	if (found.length > 1) throw new Error(w.many(q));
	if (found.length < 1) throw new Error(`${w.noMatch(q)} ${all.map((x) => `${x.workspace_id} (${x.label})`).join(", ")}`);
	return found[0]!.tokens?.sb_head ? "head" : found[0]!.workspace_id;
}

/** The list read and cleaned again: what `boss-waits` says, as rows in the order the server gave (the pane's own tower first, then the head, then the towers). */
async function read(d: WaitCmdDeps, only: string | undefined): Promise<Listed> {
	const got = await d.ask({ cmd: "boss-waits", ...(only ? { workspace: only } : {}), ...(d.own ? { own: d.own } : {}) });
	if (!got.ok) throw new Error(String(got.error ?? "the sb server did not answer"));
	const towers = (got.towers as Tower[] | undefined) ?? [];
	// SAFETY: a `boss-waits` row is what `View` repeats (waitlist.ts); `tidy` cleans it once more, as `/boss memory` cleans what it prints.
	const rows = towers.flatMap((t) => tidy({ rev: 0, entries: t.waits.map((x) => ({ ...x, kind: "wait" as const })), proposals: [] } as View).entries.map((wait) => ({ tower: { ...t, label: clean(t.label, 200) }, wait })));
	return { auto: (got.auto as { on?: boolean } | undefined)?.on === true, rows };
}

const raiserOf = (e: ViewEntry) => e.card?.from?.name;
const towerWord = (d: WaitCmdDeps, t: Tower) => (t.head ? WORDS[d.lang].head : WORDS[d.lang].tower);

/** One row of the list: `［主塔台］需要你處理：<do>・由 <raiser>・12 分前`, with `［已暫放］` and `（你已回覆）` where they hold. */
function rowText(d: WaitCmdDeps, n: number, tower: Tower, e: ViewEntry): string {
	const w = WORDS[d.lang], ms = Math.max(0, d.now() - Date.parse(e.at ?? ""));
	const who = raiserOf(e), replied = e.state === "answered" && !e.press;
	return `${n}. ${w.tag(tower.label)}${e.parked ? w.parked : ""}${w.needs}${e.card?.do ?? e.text}${who ? w.from(who) : ""}${Number.isFinite(ms) ? `${w.sep}${w.ago(ms)}` : ""}${replied ? w.replied : ""}`;
}

/** The card as the title of its second select: what happened, what you do, where, after that, who raised it. */
function cardTitle(d: WaitCmdDeps, auto: boolean, tower: Tower, e: ViewEntry): string {
	const w = WORDS[d.lang], c = e.card, line = (k: string, v: string) => `${k}: ${v}`;
	const state = e.press && e.press.act !== "secret" ? [w.statePressed(pressedWord(d, e))] : e.state === "answered" ? [w.stateReplied] : [];
	const head = `${w.tag(tower.label).trim()} ${e.id}${e.parked ? ` ${w.parked.trim()}` : ""}`;
	if (!c) return [head, e.text, w.legacy, ...state].join("\n");
	return [
		head, ...(c.happened ? [line(w.happened, c.happened)] : []), line(w.do, c.do), ...(c.url ? [line(w.where, c.url)] : []),
		...(c.command ? [`${w.run}:`, ...c.command.split("\n").map((l) => `  ${l}`)] : []), ...(c.after ? [line(w.after, c.after)] : []), ...(c.secret ? [line(w.secret, c.secret.name)] : []),
		...(c.options ?? []).map((o, i) => `${i + 1}) ${o.label} — ${o.then}`), ...(c.from ? [line(w.raised, c.from.name)] : []),
		...(e.parked ? [w.stateParked] : []), ...state, ...(auto && c.type === "secret" && !e.press?.secretAsked ? [w.autoSecret] : []),
	].join("\n");
}
function pressedWord(d: WaitCmdDeps, e: ViewEntry): string {
	const m = memoryWords(d.lang), p = e.press!;
	return p.act === "choose" ? m.didChose(e.card?.options?.[p.option ?? -1]?.label ?? "?") : p.act === "decline" ? m.didDecline : p.act === "restate" ? m.didRestate : m.didDone;
}

type Act = { kind: "press"; json: Record<string, unknown>; what: string } | { kind: "skip" } | { kind: "reply" } | { kind: "switch"; from: ViewFrom } | { kind: "back" };
/** The acts the card offers, by its kind and state (the table of §2): a card already pressed keeps only the reply, the switch, and the way back. */
function actsOf(d: WaitCmdDeps, auto: boolean, tower: Tower, e: ViewEntry): { label: string; act: Act }[] {
	const w = WORDS[d.lang], m = memoryWords(d.lang), c = e.card, who = c?.from?.name ?? w.raiserFallback, tw = towerWord(d, tower);
	const pressed = e.press !== undefined && e.press.act !== "secret";
	const press = (label: string, json: Record<string, unknown>, what: string) => ({ label, act: { kind: "press" as const, json: { op: "press", id: e.id, ...json }, what } });
	const own: { label: string; act: Act }[] = [];
	if (!pressed) {
		if (!c) own.push(press(w.restate(tw), { act: "restate" }, m.didRestate));
		else if (c.type === "choice") (c.options ?? []).forEach((o, i) => own.push(press(`${i + 1}) ${o.label} — ${o.then}`, { act: "choose", option: i }, m.didChose(o.label))));
		else if (c.type === "secret") {
			if (e.press?.secretAsked) own.push(press(w.secretDone, { act: "done" }, m.didDone));
			else if (!auto) own.push(press(w.secretStart(who), { act: "secret" }, w.didSecret(who)));
		} else own.push(press(w.done, { act: "done" }, m.didDone));
		own.push({ label: w.skip, act: { kind: "skip" } });
	}
	const there = c?.from?.tab && !c.from.gone ? c.from : undefined;
	return [...own, { label: w.reply(tw), act: { kind: "reply" } }, ...(there ? [{ label: w.switchTo(who), act: { kind: "switch" as const, from: there } }] : []), { label: w.back, act: { kind: "back" } }];
}

/** The picker: the list, then the card and its acts, until the boss leaves it or nothing is left. Every dialog is terminal-only. */
async function picker(d: WaitCmdDeps, only: string | undefined): Promise<void> {
	const w = WORDS[d.lang], opts = terminalOnlyOpts();
	for (;;) {
		const { auto, rows } = await read(d, only);
		if (!rows.length) return d.tell(w.none);
		let at = 0;
		if (rows.length > 1) {
			const labels = rows.map((r, i) => rowText(d, i + 1, r.tower, r.wait)), pick = await d.ui.select(w.title(rows.length), labels, opts);
			at = pick === undefined ? -1 : labels.indexOf(pick);
			if (at < 0) return;
		}
		const { tower, wait } = rows[at]!;
		if (!(await card(d, auto, tower, wait, rows.length === 1, opts))) return;
	}
}

/**
 * One card: its acts, one chosen. False ends the picker; true reads the list again. A single card has no list to go back to, so what ends its dialog (Escape, the way back, a press that went through) ends the picker; a press the server
 * refused, and a skip or a reply the boss did not go through with, read the list again.
 */
async function card(d: WaitCmdDeps, auto: boolean, tower: Tower, e: ViewEntry, single: boolean, opts: { signal?: AbortSignal }): Promise<boolean> {
	const w = WORDS[d.lang], acts = actsOf(d, auto, tower, e), labels = acts.map((a) => a.label);
	const pick = await d.ui.select(cardTitle(d, auto, tower, e), labels, opts);
	const chosen = pick === undefined ? undefined : acts[labels.indexOf(pick)]?.act;
	if (!chosen || chosen.kind === "back") return !single;
	switch (chosen.kind) {
		case "switch": return await switchTo(d, chosen.from), false;
		case "press": return (await press(d, tower, e, chosen)) ? !single : true;
		case "skip": {
			const reason = await d.ui.input(w.reason, undefined, opts);
			if (reason === undefined) return true;
			if (!(await d.ui.confirm(w.skipTitle, w.skipBody(towerWord(d, tower), e.card?.from?.name), opts))) return true;
			const act = { kind: "press" as const, json: { op: "press", id: e.id, act: "decline", ...(reason.trim() ? { reason: reason.trim() } : {}) }, what: memoryWords(d.lang).didDecline };
			return (await press(d, tower, e, act)) ? !single : true;
		}
		case "reply": {
			const text = (await d.ui.input(w.replyTitle(towerWord(d, tower)), undefined, opts))?.trim();
			if (!text) return true;
			try {
				const r = await d.ask(tower.head ? { cmd: "head-event", text, answers: e.id } : { cmd: "tower-event", workspace: tower.workspace, text, present: true, answers: e.id });
				if (!r.ok) throw new Error(String(r.error ?? "no answer"));
				d.tell(w.replied2(towerWord(d, tower), String(r.answered ?? ""), e.id));
				return !single;
			} catch (error) {
				return d.tell(w.refused((error as Error).message), "error"), true;
			}
		}
	}
}

/** The raiser's tab, found by the labels the card keeps (its workspace and tab), and brought forward; nothing is written. One that cannot be found, or is not one, is said. */
async function switchTo(d: WaitCmdDeps, from: ViewFrom): Promise<void> {
	const w = WORDS[d.lang];
	try {
		const found: string[] = [];
		for (const ws of (await d.workspaces()).filter((x) => from.workspace === undefined || x.label === from.workspace)) found.push(...(await d.tabs(ws.workspace_id)).filter((t) => t.label === from.tab).map((t) => t.tab_id));
		if (found.length !== 1) return d.tell(found.length ? w.tabMany(from.name) : w.tabNone(from.name), "warning");
		await d.focus(found[0]!);
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}

/** One press, as `/boss memory` makes it: the result line names who was told; a refusal shows the server's reason. True when it went through. */
async function press(d: WaitCmdDeps, tower: Tower, e: ViewEntry, act: Extract<Act, { kind: "press" }>): Promise<boolean> {
	const m = memoryWords(d.lang), w = WORDS[d.lang], name = e.card?.from?.name ?? "";
	try {
		const r = await d.memory(tower.workspace, act.json);
		if (!r.ok) throw new Error(String(r.error ?? "no answer"));
		if (r.status !== 200) throw new Error(String(r.body?.reason ?? r.body?.error ?? r.status));
		const status = (r.body?.press as { main?: { status: string } } | undefined)?.main?.status;
		const note = !name || !status ? "" : status === "delivered" || status === "queued" ? m.told(name) : m.notReached(name, status);
		d.tell(m.pressed(e.id, act.what, note));
		return true;
	} catch (error) {
		d.tell(w.refused((error as Error).message), "error");
		return false;
	}
}
