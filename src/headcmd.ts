// `/boss head [status | leave | new | close | <message>]` (docs/specs/2026-11-04-head-tower.md, Reaching it): the boss's pi interface to what the head page's composer and buttons do, first among equals. A bare `/boss head`
// makes the head workspace and focuses its tab; any other words are a message for the head, a boss event as the page's composer posts it. Each is one control command the GUI's route reaches as well (`head-open`, `head-event`,
// `head-leave`, `head-new`, `head-close`; `status` carries the head's row for the read), so the refusals are the server's. A slash command is typed by the boss and nothing else reaches it: the server refuses all of these to a
// run token (rungate.ts). The writes need a pi with a screen. Its own words come in English and Traditional Chinese; the server's refusals stay as it wrote them.

import { clean } from "./board.ts";
import type { Lang } from "./memorycmd.ts";
import { runTowerCommand, type TowerArgs } from "./towercmd.ts";

export type HeadArgs = { op: "open" | "status" | "leave" | "new" | "close" | "retry" | "parked" } | { op: "deliver" | "drop"; id: string } | { op: "say"; text: string; answers?: string } | { op: "usage" };
/**
 * The words after `/boss head`: none opens it; exactly `status`, `leave`, `new`, `close`, `retry`, or `parked`, or `deliver`/`drop` with an event id, is a command; anything else is the message, so a message that is one of these
 * words alone is written with more words, or in the GUI. `--answers W3` first marks that wait answered once the head took the message; the rest is then always the message.
 */
export function parseHeadArgs(input: string): HeadArgs {
	const text = input.trim();
	const flag = /^--answers(?:\s+(\S+))?(?:\s+|$)/.exec(text);
	if (flag) {
		if (!flag[1] || !/^W\d+$/i.test(flag[1]) || !text.slice(flag[0].length)) return { op: "usage" };
		return { op: "say", text: text.slice(flag[0].length), answers: flag[1].toUpperCase() };
	}
	const rest = text.replace(/\s+/g, " ");
	if (!rest) return { op: "open" };
	if (/^(status|leave|new|close|retry|parked)$/i.test(rest)) return { op: rest.toLowerCase() as "status" };
	const m = /^(deliver|drop) ([A-Za-z0-9_.-]{1,64})$/i.exec(rest);
	return m ? { op: m[1]!.toLowerCase() as "deliver", id: m[2]! } : { op: "say", text };
}

/** The part of the server's `status` row for the head this command reads (towers.ts `TowerRow`, runs.ts `ServiceStatus`). */
interface Row {
	workspace: string;
	label: string;
	service?: { state: string; queued: number; run?: { kind: string; startedAt: string }; crashes?: number; lastRun?: { endedAt: string; outcome: string }; notices?: { id: string; level: string; text: string }[] };
}
const WORDS = {
	en: {
		usage: "Usage: /boss head [status | retry | parked | deliver <id> | drop <id> | leave | new | close | [--answers W<n>] <message for the head tower>]",
		answered: (id: string) => `${id} is marked answered.`, notAnswered: (id: string) => `${id} was not marked answered: the memory no longer has it as a wait for you.`,
		noUi: "/boss head acts only in a pi session with a screen (a person at the keyboard): this one has none, so only status is allowed.",
		absent: "The head tower is not open: its first message opens it.",
		states: { standing: "standing by", waking: "waking up", running: "running", closing: "closing", held: "held (a crash loop)" } as Record<string, string>,
		head: (label: string, state: string, queued: number) => `Head tower (${label}): ${state}${queued ? ` · ${queued} queued` : ""}`,
		run: (kind: string, at: string) => `run: ${kind === "ally" ? "an ally run" : "a local run"} since ${at}`,
		last: (at: string, outcome: string) => `last run ${at}: ${outcome}`,
		crashes: (n: number) => `${n} recent crash${n === 1 ? "" : "es"}`,
		notices: "Notices:",
		opened: "Opened the head tower and focused its tab.", already: "The head tower is open already: focused it.",
		handed: () => `Handed to the head tower: it reads the words as the boss's instruction in its one conversation and forwards the work to the towers.`,
		left: "Left the boss conversation: it ends with a note; what it did not take waits for the next run.", leftAlready: "The boss conversation is closing already.",
		fresh: (left: boolean) => (left ? "Started over: the conversation ended, and the next one is a new session." : "Started over: the next conversation is a new session."),
		closed: "Closed the head tower. Its conversation and memory are kept.", notOpen: "The head tower was not open.",
	},
	"zh-TW": {
		usage: "用法：/boss head [status | retry | parked | deliver <id> | drop <id> | leave | new | close | [--answers W<n>] <給主塔台的訊息>]",
		answered: (id: string) => `${id} 已標為回覆。`, notAnswered: (id: string) => `${id} 沒有標為回覆：記憶裡已經沒有這個等你的等待。`,
		noUi: "/boss head 只在有畫面的 pi session（有人在鍵盤前）裡動作：這個 session 沒有畫面，只能用 status。",
		absent: "主塔台還沒有開：第一則訊息會開啟它。",
		states: { standing: "待命中", waking: "喚醒中", running: "執行中", closing: "收尾中", held: "已擱置（連續當機）" } as Record<string, string>,
		head: (label: string, state: string, queued: number) => `主塔台（${label}）：${state}${queued ? `・${queued} 則待處理` : ""}`,
		run: (kind: string, at: string) => `執行：${kind === "ally" ? "盟友執行" : "本機執行"}，自 ${at}`,
		last: (at: string, outcome: string) => `上次執行 ${at}：${outcome}`,
		crashes: (n: number) => `近期當機 ${n} 次`,
		notices: "通知：",
		opened: "已開啟主塔台並切到它的分頁。", already: "主塔台已經開著：已切到它。",
		handed: () => "已交給主塔台：它會把這段話當成老闆的指示，在唯一的對話裡讀，再把工作轉給各塔台。",
		left: "已離開老闆對話：它會留下交接再結束，沒處理到的事件留給下一次執行。", leftAlready: "老闆對話已在收尾。",
		fresh: (left: boolean) => (left ? "已重新開始：對話已結束，下一次是新的工作階段。" : "已重新開始：下一次對話是新的工作階段。"),
		closed: "已關閉主塔台。對話和記憶都保留。", notOpen: "主塔台本來就沒開。",
	},
};

export interface HeadCmdDeps {
	lang: Lang;
	/** True when the pi session has a screen (`ctx.hasUI`). */
	interactive: boolean;
	/** One request to the sb server's control socket: its reply. `start` is whether a stopped server is started for it (`boss`) or not (`never`). */
	ask(request: Record<string, unknown>, start: "boss" | "never"): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
	/** Brings a Herdr tab forward. */
	focus(tab: string): Promise<void>;
	tell(text: string, level?: "info" | "warning" | "error"): void;
}
/** `/boss head <args>`. */
export async function runHeadCommand(parsed: HeadArgs, d: HeadCmdDeps): Promise<void> {
	const w = WORDS[d.lang];
	if (parsed.op === "usage") return d.tell(w.usage, "warning");
	if (parsed.op !== "status" && parsed.op !== "parked" && !d.interactive) return d.tell(w.noUi, "error");
	// The head's notices and parked events are a tower service's: towercmd.ts runs them with the head as target (`head-retry`, `head-deliver`, `head-drop`).
	if (parsed.op === "retry" || parsed.op === "parked" || parsed.op === "deliver" || parsed.op === "drop") {
		return runTowerCommand(parsed as TowerArgs, { lang: d.lang, own: undefined, interactive: d.interactive, tell: d.tell, ask: (request) => d.ask(request, "never"), confirm: async () => true }, "head");
	}
	try {
		const call = async (request: Record<string, unknown>, start: "boss" | "never" = "never") => {
			const r = await d.ask(request, start);
			if (!r.ok) throw new Error(r.error ?? "no answer");
			return r;
		};
		const clock = (v: number | string) => {
			const t = new Date(v);
			return Number.isFinite(t.getTime()) ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "?";
		};
		switch (parsed.op) {
			case "status": {
				const row = (await call({ cmd: "status" })).head as Row | null | undefined, s = row?.service;
				if (!row || !s) return d.tell(w.absent);
				const line = [
					w.head(clean(row.label, 80), w.states[s.state] ?? clean(s.state, 20), s.queued),
					...(s.run ? [w.run(s.run.kind, clock(s.run.startedAt))] : []),
					...(s.lastRun ? [w.last(clock(s.lastRun.endedAt), clean(s.lastRun.outcome, 20))] : []),
					...(s.crashes ? [w.crashes(s.crashes)] : []),
				].join(" · ");
				return d.tell([line, ...(s.notices?.length ? [w.notices, ...s.notices.map((n) => `  [${clean(n.level, 10)}] ${clean(n.text, 300)}`)] : [])].join("\n"));
			}
			case "open": {
				const r = await call({ cmd: "head-open" }, "boss");
				if (typeof r.tab === "string") await d.focus(r.tab);
				return d.tell(r.opened === true ? w.opened : w.already);
			}
			case "say": {
				const r = await call({ cmd: "head-event", text: parsed.text, ...(parsed.answers ? { answers: parsed.answers } : {}) }, "boss");
				return d.tell([w.handed(), ...(parsed.answers ? [r.answered === parsed.answers ? w.answered(parsed.answers) : w.notAnswered(parsed.answers)] : [])].join(" "));
			}
			case "leave": return d.tell((await call({ cmd: "head-leave" })).already === true ? w.leftAlready : w.left);
			case "new": return d.tell(w.fresh((await call({ cmd: "head-new" })).left === true));
			case "close": return d.tell((await call({ cmd: "head-close" })).closed === true ? w.closed : w.notOpen);
		}
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}
