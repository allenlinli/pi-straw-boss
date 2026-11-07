// `/boss tower status | retry | parked | deliver <id> | drop <id> | leave | new` (docs/specs/2026-10-26-sb-backend.md, The boss conversation): the boss's pi interface to what the tower page's card and composer do, first
// among equals; the GUI only mirrors it. Each is one request to a control command the GUI's route calls as well (`tower-retry`, `tower-deliver`, `tower-drop`, `tower-leave`, `tower-new`; `status` for the reads), so
// the refusals are the server's. A slash command is typed by the boss and nothing else reaches it: no tool of a run exposes it, and the server refuses all of these to a run token (rungate.ts). The writes need a pi
// with a screen, as `/boss memory` does. Its own words come in English and Traditional Chinese; the server's refusals stay as it wrote them.

import { clean } from "./board.ts";
import { HEAD_KEY } from "./headkey.ts";
import { type Lang, matchWorkspaces } from "./memorycmd.ts";

export type TowerArgs = { op: "status" | "retry" | "parked" | "leave" | "new" } | { op: "deliver" | "drop"; id: string };
/**
 * The words after `/boss tower` that are a command: exactly `status`, `retry`, `parked`, `leave`, `new`, or `deliver`/`drop` with an event id. Anything else is a prompt for the tower (`/boss tower <prompt>`), so a
 * prompt that is one of these words alone is a command: write it with more words, or in the GUI.
 */
export function parseTowerArgs(input: string): TowerArgs | undefined {
	const rest = input.trim().replace(/\s+/g, " ");
	if (/^(status|retry|parked|leave|new)$/i.test(rest)) return { op: rest.toLowerCase() as "status" };
	const m = /^(deliver|drop) ([A-Za-z0-9_.-]{1,64})$/i.exec(rest);
	return m ? { op: m[1]!.toLowerCase() as "deliver", id: m[2]! } : undefined;
}

/** The flags before a tower message or command: `-w <workspace id | label | head>` names another tower, `--answers W3` marks that wait answered once the tower took the message. */
export interface TowerLine { workspace?: string; answers?: string; rest: string }
/**
 * `/boss tower [-w <workspace>] [--answers W<n>] <words>`: the flags in either order, only at the front. `usage` when a flag has no value or the id is no wait's, or when nothing follows the flags. With `--answers` the
 * rest is always the message (a command word is a message then); without it the rest is a command when `parseTowerArgs` knows it, else a message.
 */
export function parseTowerLine(input: string): TowerLine | { usage: true } {
	let rest = input.trim(), workspace: string | undefined, answers: string | undefined;
	for (;;) {
		const w = /^-w(?:\s+(\S+))?(?:\s+|$)/.exec(rest), a = /^--answers(?:\s+(\S+))?(?:\s+|$)/.exec(rest), m = w ?? a;
		if (!m) break;
		if (!m[1] || (w ? workspace : answers) !== undefined) return { usage: true };
		if (w) workspace = m[1];
		else if (/^W\d+$/i.test(m[1])) answers = m[1].toUpperCase();
		else return { usage: true };
		rest = rest.slice(m[0].length);
	}
	if (!rest) return { usage: true };
	return { ...(workspace ? { workspace } : {}), ...(answers ? { answers } : {}), rest };
}

/** The usage line, in the boss's language. */
export const towerUsage = (lang: Lang): string => WORDS[lang].usage;

/** The part of the server's `status` row for a tower this command reads (runs.ts `ServiceStatus`, as the control socket answers it). */
interface Row {
	workspace: string;
	label: string;
	service?: {
		state: string; queued: number; run?: { kind: string; startedAt: string }; crashes?: number;
		conversation?: { since: string; resumed: boolean; why?: string; turns: number; idle: boolean; idleAt?: number; idleMs: number; capAt: number; closing?: true };
		lastRun?: { endedAt: string; outcome: string };
		allyRuns?: { label: string }[];
		notices?: { id: string; level: string; text: string }[];
		parked?: { id: string; kind: string; from?: string; first: string }[];
		localRuns?: { kind: string; startedAt: string; outcome?: string; note?: string }[];
	};
}
const WORDS = {
	en: {
		usage: "Usage: /boss tower [-w <workspace id | label | head>] [--answers W<n>] [status | retry | parked | deliver <id> | drop <id> | leave | new | <message for the tower>]",
		noMatch: (q: string, all: string) => `No workspace matches "${q}". Workspaces: ${all}`,
		confirm: "Act on another tower?", confirmBody: (what: string, label: string, id: string) => `${what} for the tower of ${label} (${id}).`,
		declined: "Nothing was done.", noConfirm: "Acting on another tower needs the pi screen to confirm it.",
		what: { retry: "Wake it again", deliver: "Deliver a parked event again", drop: "Drop a parked event", leave: "Leave the boss conversation", new: "Start the boss conversation over", say: "Write to it as the boss" } as Record<string, string>,
		said: (label: string) => `Handed to the tower of ${label}: it reads the prompt as the boss's instruction (it was not opened or focused).`,
		answered: (id: string) => `${id} is marked answered.`, notAnswered: (id: string) => `${id} was not marked answered: the memory no longer has it as a wait for you.`,
		noUi: "/boss tower retry, deliver, drop, leave, and new act only in a pi session with a screen (a person at the keyboard): this one has none, so only status and parked are allowed.",
		noWorkspace: "This session is not in a Herdr workspace, so it has no tower here.",
		noTower: (ws: string, why: string) => `No tower service for ${ws}: ${why}`,
		states: { standing: "standing by", waking: "waking up", running: "running", closing: "closing", held: "held (a crash loop: retry wakes it)" } as Record<string, string>,
		head: (label: string, state: string, queued: number) => `Tower (${label}): ${state}${queued ? ` · ${queued} queued` : ""}`,
		run: (kind: string, at: string) => `run: ${kind === "ally" ? "an ally run" : "a local run"} since ${at}`,
		conv: (c: NonNullable<NonNullable<Row["service"]>["conversation"]>, at: (ms: number | string) => string) =>
			`Boss conversation: ${c.resumed ? `resumed session, ${c.turns} boss turns` : `new session (${c.why ?? "no earlier session"})`} · since ${at(c.since)} · ${c.closing ? "closing" : c.idle ? `waiting for you${c.idleAt ? `; ends at ${at(c.idleAt)} if you stay quiet` : ""}` : `working; ends after ${Math.round(c.idleMs / 60_000)} min idle`} · hard cap ${at(c.capAt)}`,
		last: (at: string, outcome: string) => `last run ${at}: ${outcome}`,
		allies: (n: number) => `${n} ally run${n === 1 ? "" : "s"} live`,
		crashes: (n: number) => `${n} recent crash${n === 1 ? "" : "es"}`,
		notices: "Notices:", parked: (n: number) => `Parked events (${n}): /boss tower deliver <id> · drop <id>`, noParked: "No parked events.",
		parkedRow: (p: { id: string; kind: string; from?: string; first: string }) => `${p.id}  ${p.kind}${p.from ? ` · ${p.from}` : ""}: ${p.first}`,
		runs: "Recent runs:",
		retried: "Retried: the tower wakes again when events wait.", delivered: (id: string) => `${id} will be delivered again.`, dropped: (id: string) => `${id} dropped.`,
		left: "Left the boss conversation: it ends with a note; what it did not take waits for the next run.", leftAlready: "The boss conversation is closing already.",
		fresh: (left: boolean) => (left ? "Started over: the conversation ended, and the next one is a new session." : "Started over: the next conversation is a new session."),
	},
	"zh-TW": {
		usage: "用法：/boss tower [-w <workspace id | 名稱 | head>] [--answers W<n>] [status | retry | parked | deliver <id> | drop <id> | leave | new | <給塔台的訊息>]",
		noMatch: (q: string, all: string) => `沒有符合「${q}」的 workspace。現有：${all}`,
		confirm: "要對另一個塔台動作嗎？", confirmBody: (what: string, label: string, id: string) => `對 ${label}（${id}）的塔台：${what}。`,
		declined: "什麼都沒做。", noConfirm: "對另一個塔台動作需要 pi 畫面來確認。",
		what: { retry: "重新喚醒", deliver: "重新送出擱置的事件", drop: "丟棄擱置的事件", leave: "離開老闆對話", new: "重新開始老闆對話", say: "以老闆的身分寫給它" } as Record<string, string>,
		said: (label: string) => `已交給 ${label} 的塔台：它會把這段話當成老闆的指示（沒有開啟或切換分頁）。`,
		answered: (id: string) => `${id} 已標為回覆。`, notAnswered: (id: string) => `${id} 沒有標為回覆：記憶裡已經沒有這個等你的等待。`,
		noUi: "/boss tower 的 retry、deliver、drop、leave、new 只在有畫面的 pi session（有人在鍵盤前）裡動作：這個 session 沒有畫面，只能用 status 和 parked。",
		noWorkspace: "這個 session 不在任何 Herdr workspace 裡，這裡沒有塔台。",
		noTower: (ws: string, why: string) => `${ws} 沒有塔台服務可用：${why}`,
		states: { standing: "待命中", waking: "喚醒中", running: "執行中", closing: "收尾中", held: "已擱置（連續當機：retry 可重新喚醒）" } as Record<string, string>,
		head: (label: string, state: string, queued: number) => `塔台（${label}）：${state}${queued ? `・${queued} 則待處理` : ""}`,
		run: (kind: string, at: string) => `執行：${kind === "ally" ? "盟友執行" : "本機執行"}，自 ${at}`,
		conv: (c: NonNullable<NonNullable<Row["service"]>["conversation"]>, at: (ms: number | string) => string) =>
			`老闆對話：${c.resumed ? `接續舊工作階段，已有 ${c.turns} 輪` : `新的工作階段（${c.why ?? "沒有舊的"}）`}・自 ${at(c.since)}・${c.closing ? "收尾中" : c.idle ? `等你說話${c.idleAt ? `；你若不說話，${at(c.idleAt)} 結束` : ""}` : `處理中；閒置 ${Math.round(c.idleMs / 60_000)} 分鐘後結束`}・上限 ${at(c.capAt)}`,
		last: (at: string, outcome: string) => `上次執行 ${at}：${outcome}`,
		allies: (n: number) => `${n} 個盟友執行中`,
		crashes: (n: number) => `近期當機 ${n} 次`,
		notices: "通知：", parked: (n: number) => `擱置的事件（${n}）：/boss tower deliver <id>・drop <id>`, noParked: "沒有擱置的事件。",
		parkedRow: (p: { id: string; kind: string; from?: string; first: string }) => `${p.id}  ${p.kind}${p.from ? `・${p.from}` : ""}：${p.first}`,
		runs: "最近的執行：",
		retried: "已重試：有事件等待時塔台會再醒來。", delivered: (id: string) => `${id} 會重新送出。`, dropped: (id: string) => `${id} 已丟棄。`,
		left: "已離開老闆對話：它會留下交接再結束，沒處理到的事件留給下一次執行。", leftAlready: "老闆對話已在收尾。",
		fresh: (left: boolean) => (left ? "已重新開始：對話已結束，下一次是新的工作階段。" : "已重新開始：下一次對話是新的工作階段。"),
	},
};

export interface TowerCmdDeps {
	lang: Lang;
	/** This session's workspace id; undefined when it is in none. */
	own: string | undefined;
	/** One request to the sb server's control socket: its reply. */
	ask(request: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
	/** True when the pi session has a screen (`ctx.hasUI`). */
	interactive: boolean;
	tell(text: string, level?: "info" | "warning" | "error"): void;
	/** The workspaces Herdr has, for `-w <id | label>`. */
	workspaces?(): Promise<{ workspace_id: string; label: string }[]>;
	/** Asks the boss on the pi screen; false when declined. Needed for a write at another tower (`-w`). */
	confirm?(title: string, body: string): Promise<boolean>;
}
const WRITES = new Set(["retry", "deliver", "drop", "leave", "new"]);
interface Target { ws: string | undefined; label: string; head: boolean; other: boolean }
/** The tower a command acts on: this session's own, or what `-w` names (`head` is the head tower). */
async function resolveTarget(d: TowerCmdDeps, at: string | undefined): Promise<Target> {
	const w = WORDS[d.lang];
	if (at === undefined) return { ws: d.own, label: d.own ?? "", head: false, other: false };
	if (at === "head") return { ws: HEAD_KEY, label: "head", head: true, other: true };
	const all = (await d.workspaces?.()) ?? [], found = matchWorkspaces(all, at);
	if (found.length !== 1) throw new Error(w.noMatch(at, all.map((x) => `${x.workspace_id} (${x.label})`).join(", ")));
	return { ws: found[0]!.workspace_id, label: found[0]!.label, head: false, other: found[0]!.workspace_id !== d.own };
}
/** A write at another tower names it in the confirm; false when the boss declines (and says so). */
async function confirmed(d: TowerCmdDeps, target: Target, what: string): Promise<boolean> {
	const w = WORDS[d.lang];
	if (!target.other) return true;
	if (!d.confirm) return d.tell(w.noConfirm, "error"), false;
	if (await d.confirm(w.confirm, w.confirmBody(w.what[what] ?? what, target.label, target.head ? "head" : target.ws!))) return true;
	return d.tell(w.declined), false;
}
/** `/boss tower -w <workspace> [--answers W3] <message>`: the boss's words to another tower, the control command the GUI's composer reaches (`tower-event`); the head tower's are `/boss head` (`head-event`). */
export async function sayToTower(text: string, at: string, answers: string | undefined, d: TowerCmdDeps): Promise<void> {
	const w = WORDS[d.lang];
	if (!d.interactive) return d.tell(w.noUi, "error");
	try {
		const target = await resolveTarget(d, at);
		if (!target.ws) throw new Error(w.noWorkspace);
		if (!(await confirmed(d, target, "say"))) return;
		const r = await d.ask({ cmd: "tower-event", workspace: target.ws, text, present: true, ...(answers ? { answers } : {}) });
		if (!r.ok) throw new Error(r.error ?? "no answer");
		d.tell([w.said(target.label), ...(answers ? [r.answered === answers ? w.answered(answers) : w.notAnswered(answers)] : [])].join(" "));
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}
/** `/boss tower <args>` for the words `parseTowerArgs` knows; `at` is the `-w` target (`head` for the head tower). */
export async function runTowerCommand(parsed: TowerArgs, d: TowerCmdDeps, at?: string): Promise<void> {
	const w = WORDS[d.lang];
	if (WRITES.has(parsed.op) && !d.interactive) return d.tell(w.noUi, "error");
	try {
		const target = await resolveTarget(d, at), ws = target.ws;
		if (!ws) throw new Error(w.noWorkspace);
		if (WRITES.has(parsed.op) && !(await confirmed(d, target, parsed.op))) return;
		// The head tower's service has its own control commands (headcmds.ts); a workspace tower's carry the workspace.
		const call = async (request: Record<string, unknown>) => {
			const r = await d.ask(target.head ? { ...request, cmd: String(request.cmd).replace(/^tower-/, "head-") } : { ...request, workspace: ws });
			if (!r.ok) throw new Error(r.error ?? "no answer");
			return r;
		};
		const clock = (v: number | string) => {
			const t = new Date(v);
			return Number.isFinite(t.getTime()) ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "?";
		};
		switch (parsed.op) {
			case "status": case "parked": {
				const status = await d.ask({ cmd: "status" }), row = target.head ? (status.head as Row | null | undefined) ?? undefined : (status.towers as Row[] | undefined)?.find((x) => x.workspace === ws);
				const s = row?.service;
				if (!row || !s) throw new Error(w.noTower(target.head ? "head" : ws, "the sb server runs no tower service for it"));
				const parked = s.parked ?? [], list = parked.length ? [w.parked(parked.length), ...parked.map((p) => `  ${w.parkedRow({ ...p, id: clean(p.id, 64), kind: clean(p.kind, 20), first: clean(p.first, 160), ...(p.from ? { from: clean(p.from, 60) } : {}) })}`)] : [w.noParked];
				if (parsed.op === "parked") return d.tell(list.join("\n"));
				const line = [
					w.head(clean(row.label, 80), w.states[s.state] ?? clean(s.state, 20), s.queued),
					...(s.run ? [w.run(s.run.kind, clock(s.run.startedAt))] : []),
					...(s.lastRun ? [w.last(clock(s.lastRun.endedAt), clean(s.lastRun.outcome, 20))] : []),
					...(s.allyRuns?.length ? [w.allies(s.allyRuns.length)] : []),
					...(s.crashes ? [w.crashes(s.crashes)] : []),
				].join(" · ");
				d.tell([
					line,
					...(s.conversation ? [w.conv(s.conversation, clock)] : []),
					...(s.notices?.length ? [w.notices, ...s.notices.map((n) => `  [${clean(n.level, 10)}] ${clean(n.text, 300)}`)] : []),
					...list,
					...(s.localRuns?.length ? [w.runs, ...s.localRuns.map((r) => `  ${clock(r.startedAt)} ${clean(r.kind, 20)}${r.outcome ? ` · ${clean(r.outcome, 20)}` : " · live"}${r.note ? `: ${clean(r.note, 160)}` : ""}`)] : []),
				].join("\n"));
				return;
			}
			case "retry": return void (await call({ cmd: "tower-retry" }), d.tell(w.retried));
			case "deliver": return void (await call({ cmd: "tower-deliver", id: parsed.id }), d.tell(w.delivered(parsed.id)));
			case "drop": return void (await call({ cmd: "tower-drop", id: parsed.id }), d.tell(w.dropped(parsed.id)));
			case "leave": return d.tell(((await call({ cmd: "tower-leave" })).already === true) ? w.leftAlready : w.left);
			case "new": return d.tell(w.fresh((await call({ cmd: "tower-new" })).left === true));
		}
	} catch (error) {
		d.tell((error as Error).message, "error");
	}
}
