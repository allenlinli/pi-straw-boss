import { readFileSync, statSync } from "node:fs";
import type { GuiRecord } from "./handover.ts";
import { firstWord, folderOf } from "./bossopen.ts";
import type { Here } from "./heremark.ts";
import { hereOnlyOpts } from "./intercept.ts";
import { line, plain } from "./safetext.ts";
import { decodeInvite } from "./link/join.ts";
import type { LinkView } from "./link/holder.ts";
import type { Lang } from "./memorycmd.ts";
import { readSecret, showScreen } from "./secretscreen.ts";
import type { Kit } from "./state.ts";

// The boss's typed twins of the Straw Link operations the page alone could do (`/boss link confirms | confirm | asks | answer | invite show|cancel | join | join cancel | create | leave`; the first of `link status` and
// `link decide` are bossopen.ts's). Like bosspaths.ts each posts to the route the page posts to (`link/confirm-answer`, `dialog-answer`, `invite-text`, `invite-cancel`, `join-start`, `join-project`, `join-cancel`,
// `create`, `leave`), so the holder keeps every check (the digest, the device, the level, the folder, the relay); this side parses the line, shows the whole question in pi, and asks hereOnly (hereOnlyOpts) before
// anything that lets a teammate's tower run a call, answers for an unattended box, or changes who may command this computer. They are the boss's typed input only: boss.ts refuses them in a tower run or an ally run,
// control.ts keeps a paired device's composer from typing them, and no tool reaches this module. Two things here are secrets: the relay's token goes from a masked screen (secretscreen.ts) into the request and nowhere else
// (pi's `ctx.ui.input` echoes it), and an invite's text is drawn on a screen of its own, never as a notice. Whatever a teammate's device wrote (arguments, questions, labels) is shown with control and bidi characters as
// escapes, so it cannot repaint what the boss approves.

const MIN_ID = 4, SHOWN_ID = 8, FULL_ID = 64, MAX_INVITE_FILE = 16 * 1024;
type Reply = { status: number; body: Record<string, unknown> };
type Post = (record: GuiRecord, path: string, json: Record<string, unknown>, timeoutMs: number) => Promise<Reply>;
type Share = "status" | "presence";

export type LinkMore =
	| { action: "confirms" } | { action: "confirm"; id: string; verdict: "allow" | "deny" } | { action: "asks" } | { action: "answer"; id: string; cancel: boolean; text: string }
	| { action: "operate" | "operate-off" } | { action: "invite-cancel" | "invite-show"; hash: string } | { action: "join-cancel" } | { action: "leave"; team: string; force: boolean }
	| { action: "create"; relay: string; project: string; share?: Share; label?: string } | { action: "join"; source: string; project?: string; share?: Share; label?: string };

const VERBS = ["confirms", "confirm", "asks", "answer", "invite", "join", "create", "leave", "operate"];
/** What Tab completes for these (boss.ts adds them after the page's `link status` and `link decide`). */
export const LINK_ARGUMENTS = Object.entries({ "link confirms": "List the confirms teammates' towers wait on (the call's arguments in full)", "link confirm": "Allow or deny a teammate tower's call: link confirm <id> allow|deny", "link asks": "List the questions unattended devices forwarded to you", "link answer": "Answer a forwarded question: link answer <id> <choice number | text> (or --cancel)", "link invite show": "Show an open invite's text on this screen only: link invite show <hash>", "link invite cancel": "Cancel an open invite: link invite cancel <hash>", "link join": "Join a team: link join <invite text | @file> [--project <dir>] [--share status|presence] [--label <name>]", "link join cancel": "Cancel the join in progress", "link create": "Create a team: link create <relay> <dir> [--share status|presence] [--label <name>] (asks for the relay's token privately)", "link leave": "Leave a team on this computer: link leave <team> [--force]", "link operate": "List the operate sessions this computer holds on unattended boxes", "link operate off": "End every operate session this computer holds", "link units": "List the units and mains the unattended boxes reported: link units [box]", "link stop": "Ask a box to stop one of its mains: link stop <box> <main | handle start> [--interrupt] [reason]" }).map(([value, description]) => ({ value, label: value, description }));

/** The words of a typed line (a quoted run is one word), flags `--name value` or `--name=value` split off; undefined for a flag that is not allowed or has no value. */
function split(text: string, allowed: readonly string[], bare: readonly string[] = []): { pos: string[]; flag: Record<string, string> } | undefined {
	const all: string[] = [];
	for (let rest = text.trim(); rest;) {
		const w = firstWord(rest);
		all.push(w.word);
		rest = w.rest;
	}
	const pos: string[] = [], flag: Record<string, string> = {};
	for (let i = 0; i < all.length; i++) {
		const word = all[i]!, named = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(word);
		if (!named) { pos.push(word); continue; }
		const name = named[1]!;
		if (bare.includes(name)) { flag[name] = "1"; continue; }
		const value = named[2] ?? all[++i];
		if (!allowed.includes(name) || !value) return undefined;
		flag[name] = value;
	}
	return { pos, flag };
}

/** A line after `/boss link` that is one of these subcommands: its parts, "usage" when it is one of them but malformed, undefined when it is not (`status`, `decide`, anything else are bossopen.ts's). */
export function parseLinkMore(rest: string | undefined): LinkMore | "usage" | undefined {
	const text = (rest ?? "").trim(), verb = /^(\S+)/.exec(text)?.[1] ?? "";
	if (!VERBS.includes(verb)) return undefined;
	if (verb === "answer") {
		const m = /^answer\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text), said = (m?.[2] ?? "").trim();
		return m ? { action: "answer", id: m[1]!, cancel: said === "--cancel", text: said === "--cancel" ? "" : said } : "usage";
	}
	const share = (v: string | undefined): { share?: Share } | undefined => (v === undefined ? {} : v === "status" || v === "presence" ? { share: v } : undefined);
	if (verb === "operate") return text === "operate" ? { action: "operate" } : /^operate\s+off$/.test(text) ? { action: "operate-off" } : "usage";
	if (verb === "leave") {
		const p = split(text, [], ["force"]);
		return p && p.pos.length === 2 ? { action: "leave", team: p.pos[1]!, force: p.flag.force === "1" } : "usage";
	}
	const p = split(text, verb === "join" ? ["project", "share", "label"] : verb === "create" ? ["share", "label"] : []);
	if (!p) return "usage";
	const [, a, b] = p.pos, shared = share(p.flag.share), extra = { ...shared, ...(p.flag.label ? { label: p.flag.label } : {}) };
	if (!shared) return "usage";
	switch (verb) {
		case "confirms": return p.pos.length === 1 ? { action: "confirms" } : "usage";
		case "asks": return p.pos.length === 1 ? { action: "asks" } : "usage";
		case "confirm": return p.pos.length === 3 && (b === "allow" || b === "deny") ? { action: "confirm", id: a!, verdict: b } : "usage";
		case "invite": return p.pos.length === 3 && (a === "cancel" || a === "show") ? { action: a === "cancel" ? "invite-cancel" : "invite-show", hash: b! } : "usage";
		case "create": return p.pos.length === 3 ? { action: "create", relay: a!, project: b!, ...extra } : "usage";
		default: return a === "cancel" ? (p.pos.length === 2 && !Object.keys(p.flag).length ? { action: "join-cancel" } : "usage") : p.pos.length === 2 ? { action: "join", source: a!, ...(p.flag.project ? { project: p.flag.project } : {}), ...extra } : "usage";
	}
}

// ---- What a teammate's device wrote, as the boss reads it (`plain` and `line` are safetext.ts) ----------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
interface Question { question: string; multiple: boolean; options: string[] }
type Dlg = { kind: "select"; title: string; choices: string[]; cancel: boolean } | { kind: "questions"; qs: Question[]; cancel: boolean };
/** A forwarded dialog as the page's panel takes it (a select with labelled choices, or questions with titled options), or undefined when the sender's JSON is neither: another computer wrote it, so its shape is checked. */
function readDialog(json: unknown): Dlg | undefined {
	let d: unknown;
	try { d = JSON.parse(String(json)); } catch { return undefined; }
	if (!isRecord(d)) return undefined;
	const { select, questions } = d, cancel = d.cancel === true;
	if (isRecord(select) && isText(select.title) && Array.isArray(select.choices) && select.choices.length > 0 && select.choices.every((c) => isRecord(c) && isText(c.label))) return { kind: "select", title: select.title, choices: select.choices.map((c) => (c as { label: string }).label), cancel };
	if (Array.isArray(questions) && questions.length > 0 && questions.every((q) => isRecord(q) && isText(q.question) && Array.isArray(q.options) && q.options.every((o) => isRecord(o) && isText(o.title)))) return { kind: "questions", qs: questions.map((q) => ({ question: (q as { question: string }).question, multiple: (q as { multiple?: unknown }).multiple === true, options: ((q as { options: { title: string }[] }).options).map((o) => o.title) })), cancel };
	return undefined;
}

const WORDS = {
	en: {
		usage: { confirms: "/boss link confirms", confirm: "/boss link confirm <id> allow|deny", asks: "/boss link asks", answer: "/boss link answer <id> <choice number | text> | answer <id> (asks in pi) | answer <id> --cancel", invite: "/boss link invite show|cancel <hash>", join: "/boss link join <invite text | @file> [--project <dir>] [--share status|presence] [--label <name>] | join cancel", create: "/boss link create <relay> <dir> [--share status|presence] [--label <name>]", leave: "/boss link leave <team> [--force]", operate: "/boss link operate [off]" } as Record<string, string>,
		off: "Straw Link is not on in this server",
		noScreen: "This needs the pi screen to ask you first",
		noPrivate: "This screen cannot take a secret without showing it (it has no private screen); do this in a pi terminal",
		declined: "Nothing was decided",
		none: { confirm: (q: string) => `No confirm is waiting under "${q}": /boss link confirms lists them`, ask: (q: string) => `No forwarded question is waiting under "${q}": /boss link asks lists them`, invite: (q: string) => `No open invite starts with "${q}": /boss link lists them`, team: (q: string) => `No team is named or starts with "${q}": /boss link lists them` },
		many: { confirm: (q: string, list: string) => `More than one confirm starts with "${q}"; nothing was done. Name one by more of its id:\n${list}`, ask: (q: string, list: string) => `More than one forwarded question starts with "${q}"; nothing was done. Name one by more of its id:\n${list}`, invite: (q: string, list: string) => `More than one open invite starts with "${q}"; nothing was done. Name one by more of its hash:\n${list}`, team: (q: string, list: string) => `More than one team is named or starts with "${q}"; nothing was done. Name one by more of its id:\n${list}` },
		ago: (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`),
		left: (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`),
		noConfirms: "No confirm is waiting",
		operateNone: "No operate session is open from this computer (one opens while a GUI page is connected, to a box whose policy lets this device operate it)",
		operateHead: "Operate sessions held from this computer (end them with /boss link operate off):",
		operateLine: (box: string, short: string, team: string, scope: string, state: string, since: string, pages: number) => `  ${box} (${short}) in ${team}: ${scope} scope, ${state}${since ? `, open ${since}` : ""}, ${pages} page${pages === 1 ? "" : "s"} connected`,
		operateOff: "Every operate session from this computer was ended; none opens again for a minute",
		confirmsHead: "Confirms waiting for you (answer with /boss link confirm <id> allow|deny):",
		confirmLine: (id: string, label: string, short: string, team: string, tool: string, age: string) => `  ${id}  ${label} (${short}) · team ${team} · tool ${tool} · ${age}`,
		args: "arguments:",
		askTitle: "Let this tower run it?",
		askBody: (label: string, short: string, team: string, tool: string, tower: string, age: string, args: string) => `${label} (${short}) in team ${team} asks to run a ${tool} call from its tower ${tower} (asked ${age}). If you allow it, that call runs on that computer. Its arguments, in full:\n\n${args}`,
		allowed: (tool: string, label: string) => `Allowed the ${tool} call from ${label}`,
		denied: (tool: string, label: string) => `Denied the ${tool} call from ${label}`,
		noAsks: "No forwarded question is waiting",
		asksHead: "Questions forwarded to you (answer with /boss link answer <id> <choice number | text>):",
		askLine: (id: string, label: string, short: string, team: string, owner: string) => `  ${id}  ${label} (${short}) · team ${team} · ${owner}`,
		askNoShow: "(this question cannot be shown here: answer it in the GUI or at the device)",
		severalTag: "(several)",
		cancelLine: (id: string) => `(cancel it: /boss link answer ${id} --cancel)`,
		badChoice: (n: number) => `This question takes a choice number from 1 to ${n}`,
		oneQuestion: "This question takes one choice, not several",
		parts: (n: number) => `It has ${n} questions; give no text and pi asks each in turn: /boss link answer <id>`,
		noCancel: "This question takes no cancel",
		own: "Write my own answer",
		ownHint: "Your own answer",
		numbersHint: "Numbers separated by commas, or your own words",
		sendTitle: "Send this answer?",
		sendBody: (label: string, short: string, team: string, owner: string, question: string, answer: string) => `${label} (${short}) in team ${team} asked (${owner}):\n${question}\n\nYour answer: ${answer}\n\nIt is sent to that device, which acts on it.`,
		cancelWord: "(cancel the question)",
		sent: (label: string) => `Answer sent to ${label}`,
		notSent: "Nothing was sent",
		invCancelTitle: "Cancel this invite?",
		invCancelBody: (team: string, hash: string, device: string) => `The open invite for ${team} (${hash}${device ? `, only for ${device}` : ""}) stops working: nobody can join with its text any more.`,
		invCancelled: (team: string) => `Cancelled the invite for ${team}`,
		invTitle: (team: string, device: string) => `Invite for ${team}${device ? ` (only for ${device})` : ""}`,
		invValid: (left: string) => `Valid for ${left}`,
		invFooter: "Enter or Esc closes this screen. The text is a credential: it is shown here and nowhere else.",
		joinCancelled: "Cancelled the join",
		leaveTitle: "Leave this team?",
		leaveBody: (name: string, id: string, force: boolean) => `${name} (${id}): this computer forgets the team (its team file and config entry). The roster at the relay is untouched; an admin removes this device.${force ? " Leave even if this device is the team's only attended admin: nobody could remove a device or rotate the key." : ""}`,
		leftTeam: (name: string) => `Left ${name}`,
		notLeft: "Nothing was left",
		createTitle: "Create a team?",
		createBody: (relay: string, dir: string, share: string, label: string) => `Create a new team on the relay ${relay}. Project folder: ${dir}. Shares: ${share}. Label: ${label}. The relay's token is asked next on a private screen, used once, and kept nowhere.`,
		thisLabel: "this device's label",
		tokenTitle: "The relay's team token",
		tokenHint: (relay: string) => `Paste the one-time team token the operator of ${relay} gave you. It is not shown and not kept; it goes to the relay once.`,
		tokenFooter: "Enter sends it. Esc cancels.",
		noToken: "No token was given",
		noFolder: (d: string) => `"${d}" is not a folder`,
		created: (name: string) => `Created the team ${name}`,
		notCreated: "Nothing was created",
		joinTitle: "Join this team?",
		joinBody: (team: string, relay: string, inviter: string, pinned: boolean, dir: string, own: boolean, share: string, label: string) => `Join the team ${team} on the relay ${relay}, invited by the device ${inviter}${pinned ? " (an invite pinned to one device)" : ""}. Project folder: ${dir}${own ? " (this session's folder; --project picks another)" : ""}. Shares: ${share}. Label: ${label}. This computer then shows four words: the inviter picks that set on their screen.`,
		notInvite: "That is not a Straw Link invite: it starts with strawlink1:",
		noFile: (f: string) => `"${f}" is not a readable file of at most 16 KB`,
		notJoined: "Nothing was joined",
		joinStarted: (words: string, left: string) => `Joining. Read these four words to whoever invited you; they pick this set on their screen: ${words}\nIt waits ${left}. /boss link shows how it stands, and /boss link join cancel ends it.`,
		joinFolder: (why: string) => `The join started, but its folder was not set: ${why}. Cancel it with /boss link join cancel and try again.`,
		invitesHead: "Open invites (/boss link invite show|cancel <hash>):",
		inviteLine: (hash: string, team: string, device: string, left: string) => `  ${hash}  ${team}${device ? ` · for ${device}` : ""} · expires in ${left}`,
		joining: (state: string, words: string, error: string, project: boolean) => `Joining: ${state}${words ? ` · the words: ${words}` : ""}${project ? " · its folder is not set" : ""}${error ? ` · ${error}` : ""}`,
		confirmsWait: (n: number) => `${n} confirm${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""}: /boss link confirms`,
		asksWait: (n: number) => `${n} forwarded question${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""}: /boss link asks`,
	},
	"zh-TW": {
		usage: { confirms: "/boss link confirms", confirm: "/boss link confirm <id> allow|deny", asks: "/boss link asks", answer: "/boss link answer <id> <選項編號 | 文字> | answer <id>（在 pi 裡逐題問）| answer <id> --cancel", invite: "/boss link invite show|cancel <hash>", join: "/boss link join <邀請文字 | @檔案> [--project <資料夾>] [--share status|presence] [--label <名稱>] | join cancel", create: "/boss link create <中繼站> <資料夾> [--share status|presence] [--label <名稱>]", leave: "/boss link leave <團隊> [--force]", operate: "/boss link operate [off]" } as Record<string, string>,
		off: "這個伺服器沒有開 Straw Link",
		noScreen: "這個動作需要 pi 畫面，才能先問你",
		noPrivate: "這個畫面沒有私密螢幕，不能在不顯示的情況下輸入機密；請在 pi 終端機裡做",
		declined: "什麼都沒有決定",
		none: { confirm: (q: string) => `沒有以「${q}」開頭的待確認項目：/boss link confirms 會列出`, ask: (q: string) => `沒有以「${q}」開頭的轉送問題：/boss link asks 會列出`, invite: (q: string) => `沒有以「${q}」開頭的未用邀請：/boss link 會列出`, team: (q: string) => `沒有名為或以「${q}」開頭的團隊：/boss link 會列出` },
		many: { confirm: (q: string, list: string) => `不只一個待確認項目的 id 以「${q}」開頭，什麼都沒做。請多給幾碼，指明其中一個：\n${list}`, ask: (q: string, list: string) => `不只一個轉送問題的 id 以「${q}」開頭，什麼都沒做。請多給幾碼，指明其中一個：\n${list}`, invite: (q: string, list: string) => `不只一個未用邀請的 hash 以「${q}」開頭，什麼都沒做。請多給幾碼，指明其中一個：\n${list}`, team: (q: string, list: string) => `不只一個團隊名為或 id 以「${q}」開頭，什麼都沒做。請多給幾碼，指明其中一個：\n${list}` },
		ago: (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} 秒前` : `${Math.round(ms / 60_000)} 分鐘前`),
		left: (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分鐘`),
		noConfirms: "沒有等待中的確認",
		operateNone: "這台電腦沒有開著的操作連線（有 GUI 頁面連著、而且這部裝置在某台無人值守機器的政策裡獲准操作時才會開）",
		operateHead: "這台電腦握有的操作連線（用 /boss link operate off 全部結束）：",
		operateLine: (box: string, short: string, team: string, scope: string, state: string, since: string, pages: number) => `  ${box}（${short}）在 ${team}：${scope === "box" ? "整台機器" : "團隊"}範圍，${state}${since ? `，已開 ${since}` : ""}，${pages} 個頁面連著`,
		operateOff: "這台電腦的操作連線都已結束；一分鐘內不會再開",
		confirmsHead: "等待你回答的確認（用 /boss link confirm <id> allow|deny 回答）：",
		confirmLine: (id: string, label: string, short: string, team: string, tool: string, age: string) => `  ${id}  ${label}（${short}）· 團隊 ${team} · 工具 ${tool} · ${age}`,
		args: "參數：",
		askTitle: "要讓這個塔台執行嗎？",
		askBody: (label: string, short: string, team: string, tool: string, tower: string, age: string, args: string) => `${label}（${short}）在團隊 ${team} 要求從它的塔台 ${tower} 執行一個 ${tool} 呼叫（${age}提出）。你允許的話，這個呼叫會在那台電腦上執行。完整參數如下：\n\n${args}`,
		allowed: (tool: string, label: string) => `已允許 ${label} 的 ${tool} 呼叫`,
		denied: (tool: string, label: string) => `已拒絕 ${label} 的 ${tool} 呼叫`,
		noAsks: "沒有等待中的轉送問題",
		asksHead: "轉送來的問題（用 /boss link answer <id> <選項編號 | 文字> 回答）：",
		askLine: (id: string, label: string, short: string, team: string, owner: string) => `  ${id}  ${label}（${short}）· 團隊 ${team} · ${owner}`,
		askNoShow: "（這個問題無法在這裡顯示：請在網頁或那台裝置上回答）",
		severalTag: "（可複選）",
		cancelLine: (id: string) => `（取消這個問題：/boss link answer ${id} --cancel）`,
		badChoice: (n: number) => `這個問題要 1 到 ${n} 的選項編號`,
		oneQuestion: "這個問題只能選一個，不能複選",
		parts: (n: number) => `它有 ${n} 個問題；不要給文字，pi 會逐題問你：/boss link answer <id>`,
		noCancel: "這個問題不能取消",
		own: "寫我自己的答案",
		ownHint: "你自己的答案",
		numbersHint: "用逗號分隔的編號，或你自己的話",
		sendTitle: "要送出這個答案嗎？",
		sendBody: (label: string, short: string, team: string, owner: string, question: string, answer: string) => `${label}（${short}）在團隊 ${team} 問了（${owner}）：\n${question}\n\n你的答案：${answer}\n\n答案會送到那台裝置，由它照辦。`,
		cancelWord: "（取消這個問題）",
		sent: (label: string) => `已把答案送給 ${label}`,
		notSent: "什麼都沒有送出",
		invCancelTitle: "要取消這個邀請嗎？",
		invCancelBody: (team: string, hash: string, device: string) => `${team} 的未用邀請（${hash}${device ? `，只給 ${device}` : ""}）會失效：之後沒有人能用它的文字加入。`,
		invCancelled: (team: string) => `已取消 ${team} 的邀請`,
		invTitle: (team: string, device: string) => `${team} 的邀請${device ? `（只給 ${device}）` : ""}`,
		invValid: (left: string) => `還有效 ${left}`,
		invFooter: "按 Enter 或 Esc 關閉這個畫面。這段文字是憑證：只在這裡顯示，不會出現在別處。",
		joinCancelled: "已取消加入",
		leaveTitle: "要離開這個團隊嗎？",
		leaveBody: (name: string, id: string, force: boolean) => `${name}（${id}）：這台電腦會忘掉這個團隊（它的團隊檔與設定項目）。中繼站上的名冊不變，要由管理員移除這台裝置。${force ? "即使這台裝置是團隊唯一有人值守的管理員也離開：之後沒有人能移除裝置或輪替金鑰。" : ""}`,
		leftTeam: (name: string) => `已離開 ${name}`,
		notLeft: "什麼都沒有離開",
		createTitle: "要建立團隊嗎？",
		createBody: (relay: string, dir: string, share: string, label: string) => `在中繼站 ${relay} 建立新團隊。專案資料夾：${dir}。分享：${share}。名稱：${label}。接著會在私密畫面請你輸入中繼站的團隊 token；它只用一次，不會存在任何地方。`,
		thisLabel: "本裝置的名稱",
		tokenTitle: "中繼站的團隊 token",
		tokenHint: (relay: string) => `貼上 ${relay} 的營運者給你的一次性團隊 token。它不會顯示、也不會留存；只會送給中繼站一次。`,
		tokenFooter: "Enter 送出，Esc 取消。",
		noToken: "沒有給 token",
		noFolder: (d: string) => `「${d}」不是資料夾`,
		created: (name: string) => `已建立團隊 ${name}`,
		notCreated: "什麼都沒有建立",
		joinTitle: "要加入這個團隊嗎？",
		joinBody: (team: string, relay: string, inviter: string, pinned: boolean, dir: string, own: boolean, share: string, label: string) => `加入中繼站 ${relay} 上的團隊 ${team}，邀請人是裝置 ${inviter}${pinned ? "（只給一台裝置的邀請）" : ""}。專案資料夾：${dir}${own ? "（本工作階段的資料夾；用 --project 指定別的）" : ""}。分享：${share}。名稱：${label}。接著這台電腦會顯示四個單字：邀請人要在他的畫面上選這一組。`,
		notInvite: "這不是 Straw Link 邀請：它以 strawlink1: 開頭",
		noFile: (f: string) => `「${f}」不是可讀的檔案，或超過 16 KB`,
		notJoined: "什麼都沒有加入",
		joinStarted: (words: string, left: string) => `加入中。請把這四個單字念給邀請你的人，他要在螢幕上選這一組：${words}\n會等 ${left}。/boss link 會顯示進度，/boss link join cancel 可以結束它。`,
		joinFolder: (why: string) => `加入已開始，但資料夾沒有設定好：${why}。請用 /boss link join cancel 取消後重來。`,
		invitesHead: "未用的邀請（/boss link invite show|cancel <hash>）：",
		inviteLine: (hash: string, team: string, device: string, left: string) => `  ${hash}  ${team}${device ? ` · 給 ${device}` : ""} · ${left}後到期`,
		joining: (state: string, words: string, error: string, project: boolean) => `加入中：${state}${words ? ` · 單字：${words}` : ""}${project ? " · 還沒有設定資料夾" : ""}${error ? ` · ${error}` : ""}`,
		confirmsWait: (n: number) => `${n} 個確認在等：/boss link confirms`,
		asksWait: (n: number) => `${n} 個轉送問題在等：/boss link asks`,
	},
} as const;

export interface LinkDeps {
	/** The server's recorded GUI, or the refusal in the boss's words. */
	record(): Promise<GuiRecord>;
	post: Post;
	why(reply: Reply): string;
	/** Asked on this computer only when `here` is set: a paired device cannot answer it (`hereOnly`). */
	confirm(title: string, body: string, here?: boolean): Promise<boolean>;
	lang(): Lang;
	/** Holds the pane's local-only mark while a screen that only this computer may answer waits (heremark.ts). */
	here: Here;
}

export function createBossLink({ s, tell }: Pick<Kit, "s" | "tell">, { record, post, why, confirm, lang, here }: LinkDeps) {
	const t = () => WORDS[lang()];
	const teamOf = (view: LinkView, team: string) => view.teams.find((x) => x.team === team)?.name ?? team.slice(0, 6);
	const asksOf = (view: LinkView) => view.alerts.filter((a) => a.kind === "dialog" && !a.data.closed && a.data.answered !== 1);
	/**
	 * The one of `list` named by `q`: a request whose key is exactly `q`, or whose id starts with `q` (four or more characters), as the boss reads it (`plain`) or as it is. The two are never ranked: an id a teammate chose to equal the start of
	 * another's would shadow it, so more than one is ambiguous, and all of them are returned for the boss to tell apart.
	 */
	function lookup<T>(list: T[], q: string, keys: (x: T) => string[], id: (x: T) => string): { one: T } | { error: "none" } | { error: "many"; hits: T[] } {
		const low = q.toLowerCase(), hits = list.filter((x) => keys(x).some((k) => k.toLowerCase() === low) || (q.length >= MIN_ID && (id(x).startsWith(q) || plain(id(x)).startsWith(q))));
		return hits.length === 1 ? { one: hits[0]! } : hits.length ? { error: "many", hits } : { error: "none" };
	}
	/** Ids as a listing shows them: the first eight characters as the boss reads them, and the whole id (to 64) where another listed id starts with those eight, so two ids that look alike are told apart. */
	const shownIds = (ids: string[]): string[] => {
		const read = ids.map(plain);
		return read.map((id, i) => (read.some((other, j) => j !== i && other.startsWith(id.slice(0, SHOWN_ID))) ? id.slice(0, FULL_ID) : id.slice(0, SHOWN_ID)));
	};
	/** The page's state, or an error told. */
	async function state(): Promise<{ r: GuiRecord; view: LinkView } | undefined> {
		const r = await record(), reply = await post(r, "link/state", {}, 10_000);
		if (reply.status !== 200) return void tell(why(reply), "error");
		const view = reply.body.view as LinkView | undefined;
		if (!view) return void tell(t().off, "warning");
		return { r, view };
	}
	/** A refusal of the server in the boss's words, with `secrets` (a token, an invite) taken out of whatever it echoed. */
	const refusal = (reply: Reply, secrets: string[] = []) => secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("…"), why(reply));
	const needScreen = () => (s.ui ? true : (tell(t().noScreen, "error"), false));
	const needPrivate = () => (s.ui && typeof s.ui.custom === "function" ? true : (tell(s.ui ? t().noPrivate : t().noScreen, "error"), false));
	/** A typed folder that exists, or an error told. */
	function folder(typed: string, cwd: string): string | undefined {
		const dir = folderOf(typed, cwd);
		if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false) return dir;
		tell(t().noFolder(dir), "error");
	}
	const pick = <T>(found: ReturnType<typeof lookup<T>>, kind: "confirm" | "ask" | "invite" | "team", q: string, show: (x: T) => string): T | undefined => {
		if ("one" in found) return found.one;
		tell(found.error === "none" ? t().none[kind](q) : t().many[kind](q, found.hits.map(show).join("\n")), "error");
	};

	// ---- Confirms (G1) --------------------------------------------------------------------------------------------------------------------

	async function confirms() {
		const got = await state();
		if (!got) return;
		const list = got.view.confirms ?? [], now = Date.now(), ids = shownIds(list.map((c) => c.dialogId));
		if (!list.length) return tell(t().noConfirms);
		tell([t().confirmsHead, ...list.flatMap((c, i) => [t().confirmLine(ids[i]!, line(c.fromLabel), line(c.fromShort), line(teamOf(got.view, c.team)), line(c.tool), t().ago(now - c.at)), `    ${t().args}`, ...plain(c.args).split("\n").map((row) => `      ${row}`)])].join("\n"));
	}
	async function answerConfirm(id: string, allow: boolean) {
		const got = await state();
		if (!got) return;
		const c = pick(lookup(got.view.confirms ?? [], id, (x) => [x.dialogId], (x) => x.dialogId), "confirm", id, (x) => `  ${plain(x.dialogId).slice(0, FULL_ID)}  ${line(x.fromLabel)} (${line(x.fromShort)})`);
		if (!c) return;
		if (allow) {
			if (!needScreen()) return;
			if (!(await confirm(t().askTitle, t().askBody(line(c.fromLabel), line(c.fromShort), line(teamOf(got.view, c.team)), line(c.tool), line(c.tower), t().ago(Date.now() - c.at), plain(c.args).split("\n").map((row) => `  ${row}`).join("\n")), true))) return tell(t().declined);
		}
		// The digest is the request's as it was read above and shown: the holder refuses it when the held request has since been replaced.
		const reply = await post(got.r, "link/confirm-answer", { dialogId: c.dialogId, digest: c.digest, allow }, 30_000);
		if (reply.status !== 200) return tell(refusal(reply), "error");
		tell(allow ? t().allowed(line(c.tool), line(c.fromLabel)) : t().denied(line(c.tool), line(c.fromLabel)));
	}

	// ---- Forwarded questions (G2) ---------------------------------------------------------------------------------------------------------

	const numbered = (options: string[]) => options.map((o, i) => `${i + 1}. ${line(o)}`);
	async function asks() {
		const got = await state();
		if (!got) return;
		const list = asksOf(got.view), ids = shownIds(list.map((a) => String(a.data.dialogId)));
		if (!list.length) return tell(t().noAsks);
		tell([t().asksHead, ...list.flatMap((a, i) => {
			const id = ids[i]!, d = readDialog(a.data.dialog);
			const head = t().askLine(id, line(String(a.data.label)), line(String(a.data.short)), line(a.teamName), line(String(a.data.owner)));
			if (!d) return [head, `    ${t().askNoShow}`];
			const body = d.kind === "select" ? [`    ${plain(d.title)}`, ...numbered(d.choices).map((o) => `      ${o}`)] : d.qs.flatMap((q, i) => [`    ${d.qs.length > 1 ? `${i + 1}) ` : ""}${plain(q.question)}${q.multiple ? ` ${t().severalTag}` : ""}`, ...numbered(q.options).map((o) => `      ${o}`)]);
			return [head, ...body, ...(d.cancel ? [`    ${t().cancelLine(id)}`] : [])];
		})].join("\n"));
	}
	/** Numbers from a typed answer to a question (`1`, `1, 3`) as option indexes, "no" when it is words, or a refusal's text. */
	function numbersOf(text: string, q: Question): number[] | "no" | string {
		if (!/^\d+(?:\s*,\s*\d+)*$/.test(text)) return "no";
		const picks = [...new Set(text.split(",").map((n) => Number(n.trim()) - 1))];
		if (picks.some((p) => p < 0 || p >= q.options.length)) return t().badChoice(q.options.length);
		return picks.length > 1 && !q.multiple ? t().oneQuestion : picks;
	}
	/** The answer the boss gave, as the holder takes it, and how to say it; a string is a refusal to tell, undefined a prompt left. */
	async function build(d: Dlg, text: string): Promise<{ answer: Record<string, unknown>; said: string } | string | undefined> {
		const ui = s.ui!;
		if (d.kind === "select") {
			let n = /^\d+$/.test(text) ? Number(text) : 0;
			if (!text) {
				const picked = await here(async () => ui.select(plain(d.title), numbered(d.choices), hereOnlyOpts()));
				n = picked === undefined ? 0 : numbered(d.choices).indexOf(picked) + 1;
				if (!n) return undefined;
			}
			return n >= 1 && n <= d.choices.length ? { answer: { choice: n - 1 }, said: numbered(d.choices)[n - 1]! } : t().badChoice(d.choices.length);
		}
		if (text && d.qs.length > 1) return t().parts(d.qs.length);
		const answers: Record<string, unknown>[] = [], said: string[] = [];
		for (const q of d.qs) {
			let typed = text, own = false;
			if (!typed && q.multiple) typed = ((await ui.input([plain(q.question), ...numbered(q.options)].join("\n"), t().numbersHint)) ?? "").trim();
			else if (!typed) {
				const picked = await here(async () => ui.select(plain(q.question), [...numbered(q.options), t().own], hereOnlyOpts()));
				if (picked === undefined) return undefined;
				own = picked === t().own;
				typed = own ? ((await ui.input(plain(q.question), t().ownHint)) ?? "").trim() : String(numbered(q.options).indexOf(picked) + 1);
			}
			if (!typed) return undefined;
			const picks = own ? "no" : numbersOf(typed, q);
			if (typeof picks === "string" && picks !== "no") return picks;
			answers.push(picks === "no" ? { text: typed } : { choices: picks });
			said.push(Array.isArray(picks) ? picks.map((p) => numbered(q.options)[p]).join(", ") : plain(typed));
		}
		return { answer: { answers }, said: said.join(" | ") };
	}
	async function answer(id: string, cancel: boolean, text: string) {
		if (!needScreen()) return;
		const got = await state();
		if (!got) return;
		const a = pick(lookup(asksOf(got.view), id, (x) => [String(x.data.dialogId)], (x) => String(x.data.dialogId)), "ask", id, (x) => `  ${plain(String(x.data.dialogId)).slice(0, FULL_ID)}  ${line(String(x.data.label))} (${line(String(x.data.short))})`);
		if (!a) return;
		const d = readDialog(a.data.dialog);
		if (!d) return tell(t().askNoShow, "error");
		if (cancel && !d.cancel) return tell(t().noCancel, "error");
		const built = cancel ? { answer: { cancel: true }, said: t().cancelWord } : await build(d, text);
		if (built === undefined) return tell(t().notSent);
		if (typeof built === "string") return tell(built, "error");
		const label = line(String(a.data.label)), question = d.kind === "select" ? plain(d.title) : d.qs.map((q) => plain(q.question)).join("\n");
		if (!(await confirm(t().sendTitle, t().sendBody(label, line(String(a.data.short)), line(a.teamName), line(String(a.data.owner)), question, built.said), true))) return tell(t().notSent);
		const reply = await post(got.r, "link/dialog-answer", { device: String(a.data.device), dialogId: String(a.data.dialogId), digest: String(a.data.digest), answer: built.answer }, 30_000);
		if (reply.status !== 200) return tell(refusal(reply), "error");
		tell(t().sent(label));
	}

	// ---- Invites, joining, leaving (G7) and Create / Join (G3) -------------------------------------------------------------------------

	async function invite(hash: string, show: boolean) {
		if (show && !needPrivate()) return;
		const got = await state();
		if (!got) return;
		const i = pick(lookup(got.view.invites, hash, (x) => [x.hash], (x) => x.hash), "invite", hash, (x) => `  ${plain(x.hash)}  ${line(x.teamName)}`);
		if (!i) return;
		if (!show) {
			if (!needScreen()) return;
			if (!(await confirm(t().invCancelTitle, t().invCancelBody(line(i.teamName), i.hash.slice(0, SHOWN_ID), line(i.forDevice.slice(0, 6))), true))) return tell(t().declined);
			const reply = await post(got.r, "link/invite-cancel", { hash: i.hash }, 10_000);
			return reply.status === 200 ? tell(t().invCancelled(line(i.teamName))) : tell(refusal(reply), "error");
		}
		const reply = await post(got.r, "link/invite-text", { hash: i.hash }, 10_000), text = reply.body.text;
		if (reply.status !== 200 || typeof text !== "string") return tell(refusal(reply), "error");
		const left = typeof reply.body.expires === "number" ? reply.body.expires - Date.now() : 0;
		const ui = s.ui!;
		await here(() => showScreen(ui, { title: t().invTitle(line(i.teamName), line(i.forDevice.slice(0, 6))), lines: [text, "", t().invValid(t().left(Math.max(0, left)))], footer: t().invFooter }));
	}
	async function leave(team: string, force: boolean) {
		if (!needScreen()) return;
		const got = await state();
		if (!got) return;
		const x = pick(lookup(got.view.teams, team, (y) => [y.team, y.name], (y) => y.team), "team", team, (y) => `  ${plain(y.team).slice(0, FULL_ID)}  ${line(y.name)}`);
		if (!x) return;
		if (!(await confirm(t().leaveTitle, t().leaveBody(line(x.name), x.team.slice(0, 6), force), true))) return tell(t().notLeft);
		const reply = await post(got.r, "link/leave", { team: x.team, force }, 30_000);
		reply.status === 200 ? tell(t().leftTeam(line(x.name))) : tell(refusal(reply), "error");
	}
	async function create(p: Extract<LinkMore, { action: "create" }>, cwd: string) {
		if (!needPrivate()) return;
		const dir = folder(p.project, cwd);
		if (!dir) return;
		const share = p.share ?? "status";
		if (!(await confirm(t().createTitle, t().createBody(line(p.relay), dir, share, line(p.label ?? t().thisLabel)), true))) return tell(t().notCreated);
		const ui = s.ui!, token = ((await here(() => readSecret(ui, { title: t().tokenTitle, hint: t().tokenHint(line(p.relay)), footer: t().tokenFooter }))) ?? "").trim();
		if (!token) return tell(t().notSent);
		const reply = await post(await record(), "link/create", { relay: p.relay, token, project: dir, share, ...(p.label ? { label: p.label } : {}) }, 60_000);
		if (reply.status !== 200) return tell(refusal(reply, [token]), "error");
		tell(t().created(line(String(reply.body.name ?? ""))));
	}
	async function join(p: Extract<LinkMore, { action: "join" }>, cwd: string) {
		if (!needScreen()) return;
		let text = p.source;
		if (text.startsWith("@")) {
			const file = folderOf(text.slice(1), cwd), st = statSync(file, { throwIfNoEntry: false });
			if (!st?.isFile() || st.size > MAX_INVITE_FILE) return tell(t().noFile(file), "error");
			text = readFileSync(file, "utf8");
		}
		text = text.trim();
		const invite = decodeInvite(text);
		if (!invite) return tell(t().notInvite, "error");
		const dir = folder(p.project ?? ".", cwd);
		if (!dir) return;
		const share = p.share ?? "status";
		if (!(await confirm(t().joinTitle, t().joinBody(invite.team.toString("hex").slice(0, 6), line(invite.relay), line(invite.inviterId.slice(0, 6)), invite.forDevice !== "", dir, p.project === undefined, share, line(p.label ?? t().thisLabel)), true))) return tell(t().notJoined);
		const r = await record(), started = await post(r, "link/join-start", { text, ...(p.label ? { label: p.label } : {}) }, 60_000);
		if (started.status !== 200) return tell(refusal(started, [text]), "error");
		const words = Array.isArray(started.body.words) ? started.body.words.map(String).join(" ") : "", left = typeof started.body.expires === "number" ? started.body.expires - Date.now() : 0;
		tell(t().joinStarted(line(words), t().left(Math.max(0, left))));
		const set = await post(r, "link/join-project", { project: dir, share }, 30_000);
		if (set.status !== 200) tell(t().joinFolder(refusal(set)), "error");
	}

	/** `/boss link operate`: the sessions this computer holds (the host's `status`, through the page's route; a teammate's labels are read through `line`). */
	async function operate() {
		const r = await record(), reply = await post(r, "link/operate", {}, 10_000);
		if (reply.status !== 200) return tell(refusal(reply), "error");
		const list = Array.isArray(reply.body.sessions) ? (reply.body.sessions as Record<string, unknown>[]) : [], now = Date.now();
		if (!list.length) return tell(t().operateNone);
		tell([t().operateHead, ...list.map((x) => t().operateLine(line(String(x.label ?? "")), line(String(x.short ?? "")), line(String(x.teamName ?? String(x.team ?? "").slice(0, 6))), x.scope === "box" ? "box" : "team", line(String(x.state ?? "")), typeof x.since === "number" ? t().left(Math.max(0, now - x.since)) : "", Number(x.pages) || 0))].join("\n"));
	}

	return {
		/** Whether `rest` (after `/boss link`) is one of these subcommands, malformed or not. */
		handles: (rest: string | undefined) => parseLinkMore(rest) !== undefined,
		async run(rest: string, cwd: string) {
			const parsed = parseLinkMore(rest);
			if (parsed === undefined) return;
			if (parsed === "usage") return tell(t().usage[/^(\S+)/.exec(rest.trim())![1]!]!, "error");
			switch (parsed.action) {
				case "operate": return operate();
				case "operate-off": {
					const reply = await post(await record(), "link/operate-off", {}, 10_000);
					return reply.status === 200 ? tell(t().operateOff) : tell(refusal(reply), "error");
				}
				case "confirms": return confirms();
				case "confirm": return answerConfirm(parsed.id, parsed.verdict === "allow");
				case "asks": return asks();
				case "answer": return answer(parsed.id, parsed.cancel, parsed.text);
				case "invite-cancel": return invite(parsed.hash, false);
				case "invite-show": return invite(parsed.hash, true);
				case "join-cancel": {
					const reply = await post(await record(), "link/join-cancel", {}, 10_000);
					return reply.status === 200 ? tell(t().joinCancelled) : tell(refusal(reply), "error");
				}
				case "leave": return leave(parsed.team, parsed.force);
				case "create": return create(parsed, cwd);
				case "join": return join(parsed, cwd);
			}
		},
		/** What `link status` adds: the open invites, the join in progress, and how many confirms and forwarded questions wait. */
		status(view: LinkView): string[] {
			const now = Date.now(), w = t(), asking = asksOf(view).length, confirming = (view.confirms ?? []).length;
			return [
				...(view.invites.length ? [w.invitesHead, ...view.invites.map((i) => w.inviteLine(i.hash.slice(0, SHOWN_ID), line(i.teamName), line(i.forDevice.slice(0, 6)), w.left(Math.max(0, i.expires - now))))] : []),
				...(view.join ? [w.joining(view.join.state, view.join.words.map(line).join(" "), line(view.join.error ?? ""), view.join.needsProject)] : []),
				...(confirming ? [w.confirmsWait(confirming)] : []),
				...(asking ? [w.asksWait(asking)] : []),
			];
		},
	};
}
