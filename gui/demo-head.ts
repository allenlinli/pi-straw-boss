import type { Item } from "../src/items.ts";
import type { TowerService } from "../src/net.ts";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { lapsedWait } from "../src/waitlapse.ts";
import { getLocale } from "./paraglide/runtime.js";
import type { Answer } from "./post.ts";

// The head tower of the demo (`?head=<state>`, docs/specs/2026-11-04-head-tower.md, Demo and pictures): `absent` (not open yet), `talk` (a conversation, no asks), `answers` (work handed to three towers, one answered), `waiting` (it waits for the boss),
// and `busy` (as `talk`, but it refuses what the boss sends: the strip's refusal). `?zen=head`, `head-open`, `head-history`, and `head-rest` (an unasked report six seconds after the page starts: the strip is at rest, as every visit begins, and stays so) show the strip in Zen (fixture.ts); they take `answers` unless `?head=` says another.

export const HEAD_STATES = ["absent", "talk", "answers", "waiting", "busy"] as const;
export type HeadState = (typeof HEAD_STATES)[number];
export const isHeadState = (s: string | null): s is HeadState => HEAD_STATES.includes(s as HeadState);

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0), at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const HOUR = 3_600_000;
/** The five broadcasts of the demo's asks (newest first): when each went out, and which towers answered what (the fourth workspace, Quarry Tools, has no tower). */
const BROADCASTS = [
	{ ago: 2 * HOUR, key: "b1", replies: { w1: "a1", w3: "a3" } },
	{ ago: 5 * HOUR, key: "b2", replies: { w2: "a2" } },
	{ ago: 29 * HOUR, key: "b3", replies: { w1: "a1", w2: "a2", w3: "a3" } },
	{ ago: 40 * HOUR, key: "b4", replies: {} },
	{ ago: 55 * HOUR, key: "b5", replies: { w2: "a2" } },
] as const;
const WORKSPACES = [["w1", "Harbor API"], ["w2", "Lighthouse Web"], ["w3", "Orchard Data"], ["w4", "Quarry Tools"]] as const;

/** The head words its message to each tower after the boss's quote, so the first lines of one broadcast differ (the boss's own file does: docs/specs/2026-11-06-head-page-minimal.md, Asks). */
const TAILS = ["Pass it to your mains.", "No reply needed.", "Check your mains for processes.", "Report when it is done."] as const;
/**
 * The chain of the boss's screenshot (todo #124): an order, its correction, and the correction of that, each a broadcast to three towers with the boss's own words kept; the towers took it, acted on it and answered someone else, or answered the head.
 * `ago` is how long ago it went out; `says` what each of the three towers did (an answer, `handled`, `received`, or `waiting`), `over` the index of the broadcast it replaces.
 */
const CHAIN = [
	{ ago: 40 * 60_000, says: ["answered", "received", "waiting"], over: undefined },
	{ ago: 20 * 60_000, says: ["answered", "handled", "waiting"], over: 0 },
	{ ago: 11 * 60_000, says: ["answered", "handled", "received"], over: 1 },
] as const;
/** The head's asks for the page: five broadcasts to four workspaces, in the rows the server writes (src/server/headnet.ts): a state that says answered only with an answer, and silent after a day without one. */
export function headAsks(now: number): HeadAskRow[] {
	const w = words();
	const chain = CHAIN.flatMap((c, g): HeadAskRow[] => WORKSPACES.slice(0, 3).map(([workspace, label], i) => {
		const id0 = 21 + g * 3, since = now - c.ago, says = c.says[i]!, answered = says === "answered", sent = w.chain[g]!.sent;
		// A copy equal to the first tower's is left out, as the server does (src/server/headnet.ts).
		return {
			id: `H${id0 + i}`, group: `H${id0}`, workspace, label, since, at: answered ? since + 4 * 60_000 : since, first: sent.split("\n")[0]!, ...(i === 1 ? { sent: w.chain[g]!.other } : i === 0 ? { sent } : {}),
			state: says, answers: answered ? 1 : 0, ...(answered ? { last: w.chain[g]!.reply } : {}),
			...(i === 0 ? { boss: w.chain[g]!.boss } : {}), ...(c.over !== undefined ? { supersedes: `H${21 + c.over * 3}` } : {}),
		};
	}));
	return [...[...BROADCASTS].reverse().flatMap((b, g) => {
		const first = w.broadcasts[b.key], id0 = g * 4 + 1, since = now - b.ago;
		return WORKSPACES.map(([workspace, label], i): HeadAskRow => {
			const said = (b.replies as Record<string, string>)[workspace], answered = said !== undefined, state = answered ? "answered" : b.ago < 24 * HOUR ? "waiting" : "silent";
			return { id: `H${id0 + i}`, group: `H${id0}`, workspace, label, since, at: answered ? since + 20 * 60_000 : since, first: `${first} ${TAILS[i]}`, state, answers: answered ? 1 : 0, ...(answered ? { last: w.answers[said as "a1" | "a2" | "a3"] } : {}) };
		});
	}), ...chain];
}

/** The head's waits for the boss as the demo's memory holds them (`due`, when it has one, is what the server filters by): one past its due and one still fresh. */
const demoWaits = (began: string, now: number) => [
	{ id: "w0", text: words().wait_old, at: new Date(now - 30 * HOUR).toISOString(), due: new Date(now - 20 * HOUR).toISOString() },
	{ id: "w1", text: words().wait, at: began, due: new Date(now + 6 * HOUR).toISOString() },
];

/** The head unit of the net in one state; none of its times is older than the page, so the asks read "2h" and "5h". */
export function headDemo(state: HeadState, now = Date.now()): HeadUnit {
	if (state === "absent") return { key: "sb-head", name: "head tower", mark: "idle", state: "absent", asks: [] };
	const began = new Date(now - 50 * 60_000).toISOString(), idle = state === "waiting";
	// What the server's summary of the head does (towermemory.ts `memorySummary`): the waits past their due are left out. The footer shows for a standing instruction or a decision (`answers`), not for waits alone (`waiting`).
	const waits = state === "waiting" ? demoWaits(began, now) : [];
	const service: TowerService = {
		state: "running", queued: 0, notices: [], parked: [], allyRuns: [], run: { id: "h1", kind: "local", startedAt: began },
		conversation: { since: began, resumed: true, turns: 9, idle, ...(idle ? { idleAt: now + 8 * 60_000 } : {}), idleMs: 600_000, capAt: now + 3 * 3600_000 },
		localRuns: [{ id: "e1", kind: "event", startedAt: new Date(now - 4 * HOUR).toISOString(), outcome: "done", note: "reported the answer" }, { id: "e2", kind: "event", startedAt: new Date(now - 3 * HOUR).toISOString(), outcome: "done" }],
		...(state === "waiting" ? { memory: { rev: 1, standing: 0, decisions: 0, waits: waits.length, bossWaits: waits.filter((x) => !lapsedWait(x, now)).map(({ id, text, at }) => ({ id, text, at })), proposals: [] } } : state === "answers" ? { memory: { rev: 2, standing: 1, decisions: 2, waits: 0, bossWaits: [], proposals: [] } } : {}),
	};
	return { key: "sb-head", name: "head tower", mark: "idle", state: "running", service, asks: state === "answers" || state === "waiting" ? headAsks(now) : [], said: now - 60_000, line: words().a4 };
}

/** The demo's words by page language (the lines are the conversation's own, so the pictures in Traditional Chinese read in it). */
const WORDS = {
	en: { first: "the first conversation", u1: "Ask Harbor API to fix the ledger rounding, and have Lighthouse Web rerun the checkout test.", a1: "On it. I am handing the rounding fix to the Harbor API tower and the checkout rerun to Lighthouse Web.", n1: "Answer to H2: Checkout test is green on main.", a2: "Lighthouse Web finished: the checkout test is green on main. Harbor API is still on the rounding fix.", a3: "Should I also ask Orchard Data to rerun the ETL tonight, or wait until the ledger fix lands?", busy: "The head tower is busy with another message.", n2: "Answer to H3: The ledger rounding fix is merged.", a4: "Harbor API merged the rounding fix on its own; nothing is needed from you.", wait: "Rerun the Orchard ETL tonight?", reply: "Handed to Harbor API. I will say when it answers." , wait_old: "Roll the ledger fix out tonight, or wait for Friday?", chain: [
		{ boss: "Keep the machine awake and keep working until about six", sent: "Boss: \u300cKeep the machine awake and keep working until about six\u300d. Keep working until 06:00 if you have anything to do.", other: "Boss: \u300cKeep the machine awake and keep working until about six\u300d. Keep the caffeinate running to 06:00 and pass it to your mains.", reply: "caffeinate -dims -t 58150 started (PID 26822), until 06:00." },
		{ boss: "I never said I would be away. You misled everyone, and I meant six in the evening", sent: "Boss CORRECTION: \u300cI never said I would be away. You misled everyone, and I meant six in the evening\u300d. My earlier message was wrong: the boss is present, the deadline is 18:00 today.", other: "Boss CORRECTION: \u300cI never said I would be away. You misled everyone, and I meant six in the evening\u300d. Tell your mains the boss is present; deadline 18:00 today.", reply: "Told 4 mains the boss is present; deadline 18:00 today." },
		{ boss: "I did not ask for a safe stop; I only wanted to be sure it never sleeps by itself. Why did you add a time limit?", sent: "Boss CORRECTION 2: \u300cI did not ask for a safe stop; I only wanted to be sure it never sleeps by itself. Why did you add a time limit?\u300d. Remove the time limit.\nKeep the machine awake until the boss says stop; report the new PID.", other: "Boss CORRECTION 2: \u300cI did not ask for a safe stop; I only wanted to be sure it never sleeps by itself. Why did you add a time limit?\u300d. Remove the time limit; report the new PID.", reply: "New caffeinate PID 55235, until 18:00 today. The old PID 26822 is gone." },
	], broadcasts: { b1: "I'm up, tell me what needs me", b2: "Going out for lunch, keep the builds going", b3: "Continue, I'm studying", b4: "I'm back", b5: "Going to sleep, only wake me for blockers" }, answers: { a1: "Nothing needs you; the rounding fix is in review.", a2: "Checkout test is green on main.", a3: "ETL rerun done, 0 rows lost." } },
	zh: { first: "第一次對話", u1: "請 Harbor API 修掉帳本的進位問題，再請 Lighthouse Web 重跑結帳測試。", a1: "收到。進位問題我交給 Harbor API 塔台，結帳重跑交給 Lighthouse Web。", n1: "H2 的回覆：main 上的結帳測試全綠。", a2: "Lighthouse Web 做完了：main 上的結帳測試全綠。Harbor API 還在修進位問題。", a3: "晚上要不要也請 Orchard Data 重跑 ETL？還是等帳本修好再說？", busy: "主塔台正在處理另一則訊息。", n2: "H3 的回覆：帳本進位的修正已合併。", a4: "Harbor API 自己把進位修正合併了，不需要你處理。", wait: "今晚要重跑 Orchard 的 ETL 嗎？", reply: "已轉給 Harbor API 塔台，它回覆了我再告訴你。" , wait_old: "帳本修正今晚上線，還是等到週五？", chain: [
		{ boss: "幫我打個咖啡因吧，大概到六點以前都要持續工作", sent: "Boss: \u300c幫我打個咖啡因吧，大概到六點以前都要持續工作\u300d. Keep working until 06:00 if you have anything to do.", other: "Boss: \u300c幫我打個咖啡因吧，大概到六點以前都要持續工作\u300d. Keep the caffeinate running to 06:00 and pass it to your mains.", reply: "caffeinate -dims -t 58150 已啟動（PID 26822），到 06:00。" },
		{ boss: "我沒說我人不會在……你讓大家誤會了，而且我是說晚上六點", sent: "Boss CORRECTION: \u300c我沒說我人不會在……你讓大家誤會了，而且我是說晚上六點\u300d. My earlier message was wrong: the boss is present, the deadline is 18:00 today.", other: "Boss CORRECTION: \u300c我沒說我人不會在……你讓大家誤會了，而且我是說晚上六點\u300d. Tell your mains the boss is present; deadline 18:00 today.", reply: "已告知 4 個 main：老闆在場，期限今天 18:00。" },
		{ boss: "我沒說要道安全點收尾，我只是要確定不會自動休眠。到底為什麼你幫我加了時間限制？", sent: "Boss CORRECTION 2: \u300c我沒說要道安全點收尾，我只是要確定不會自動休眠。到底為什麼你幫我加了時間限制？\u300d. Remove the time limit.\nKeep the machine awake until the boss says stop; report the new PID.", other: "Boss CORRECTION 2: \u300c我沒說要道安全點收尾，我只是要確定不會自動休眠。到底為什麼你幫我加了時間限制？\u300d. Remove the time limit; report the new PID.", reply: "新的 caffeinate PID 55235，到今天 18:00；舊的 PID 26822 已停止。" },
	], broadcasts: { b1: "我起床了，告訴我有什麼要我處理", b2: "我出門吃午餐，繼續跑建置", b3: "繼續，我在讀書", b4: "我回來了", b5: "我要睡了，只有卡住才叫醒我" }, answers: { a1: "沒有事要你處理，進位修正在審查中。", a2: "main 上的結帳測試全綠。", a3: "ETL 重跑完成，沒有漏資料。" } },
};
const words = () => WORDS[getLocale() === "zh-TW" ? "zh" : "en"];

/** Earlier exchanges for `&talk=<n>` (the strip with a long history, as a morning of work leaves it): the boss's question and the head's answer, cycling through these. */
const EARLIER = {
	en: [["Is the staging deploy of Harbor API done yet?", "Yes. It went out ten minutes ago and the health check is green."], ["Which towers are idle?", "Lighthouse Web and Orchard Data. Quarry Tools is working."], ["Ask Orchard Data to rebuild the nightly report and tell me when it is ready, and if the numbers differ from yesterday's by more than a few percent, say why before you send it on.", "Sent. It will answer here; I will check the totals against yesterday's before I pass it on."], ["Thanks.", "Anytime."]],
	zh: [["Harbor API 的 staging 部署好了嗎？", "好了，十分鐘前上去的，健康檢查是綠的。"], ["哪些塔台現在是閒的？", "Lighthouse Web 和 Orchard Data。Quarry Tools 還在忙。"], ["請 Orchard Data 重建夜間報表，好了再跟我說；如果數字跟昨天差超過幾個百分點，先講原因再轉給我。", "已轉給它，它回覆後我會先對過昨天的總數再轉達。"], ["謝謝。", "不客氣。"]],
} as const;
/** How many earlier exchanges `?talk=<n>` asks for. */
const talk = () => Math.max(0, Math.min(40, Number(new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("talk")) || 0));

/** The head's conversation: a chapter divider first, then the boss's words, the head's forwards, and the towers' answers. */
export function headHistory(state: HeadState): Item[] {
	if (state === "absent") return [];
	const w = words();
	const out: Item[] = [
		{ id: "chapter-1", kind: "divider", type: "chapter", at: at(0), text: w.first, code: "first" },
		...Array.from({ length: talk() }, (_, i) => {
			const [q, a] = EARLIER[getLocale() === "zh-TW" ? "zh" : "en"][i % 4]!;
			return [{ id: `h-eu${i}`, kind: "user" as const, text: q, at: at(0.5 + i * 0.01) }, { id: `h-ea${i}`, kind: "assistant" as const, model: "head-1", at: at(0.505 + i * 0.01), text: a, ctx: 1000 }];
		}).flat(),
		{ id: "h-u1", kind: "user", text: w.u1, at: at(2) },
		{ id: "h-a1", kind: "assistant", model: "head-1", at: at(3), text: w.a1, ctx: 4000, tools: ["Harbor API", "Lighthouse Web"].map((to, i) => ({ id: `h-t${i}`, name: "tower_send", summary: `(workspace: ${to})`, args: JSON.stringify({ workspace: to, message: w.u1 }) })) },
	];
	// What the head page leaves out (docs/specs/2026-11-06-head-page-minimal.md): the sb server's notice and a turn of one tool call alone.
	if (state === "answers" || state === "waiting") out.push(
		{ id: "h-n0", kind: "notice", type: "straw-tower", event: "notice", text: "[notice from the sb server]\nThe run has been open for 40 minutes.", at: at(5) },
		{ id: "h-done", kind: "assistant", model: "head-1", at: at(6), ctx: 4400, tools: [{ id: "h-td", name: "tower_done", summary: "(note: 11/06 morning: boss woke…)", args: JSON.stringify({ note: "11/06 morning: boss woke" }) }] },
	);
	if (state === "answers" || state === "waiting") out.push(
		{ id: "h-n1", kind: "notice", type: "straw-tower", event: "intercom", from: "tower · Lighthouse Web", text: `[intercom from tower · Lighthouse Web (demo-lh)]\n[straw net from="tower · Lighthouse Web" id=demo-lh role=tower workspace="Lighthouse Web" kind=tower_send scope=one to="head tower" reply=none in-reply-to=H2] ${w.n1}`, at: at(9) },
		{ id: "h-a2", kind: "assistant", model: "head-1", at: at(10), text: w.a2, ctx: 5200 },
	);
	if (state === "waiting") out.push({ id: "h-a3", kind: "assistant", model: "head-1", at: at(12), text: w.a3, ctx: 5600 });
	return out;
}

/** What the head says by itself, with no message of the boss's behind it (`?zen=head-rest` sends it a few seconds after the page starts): a tower's answer, then the head's report of it. A rested strip stays at rest for it. */
export function headReport(n: number): Item[] {
	const w = words();
	return [
		{ id: `h-n-r${n}`, kind: "notice", type: "straw-tower", event: "intercom", from: "tower · Harbor API", text: `[intercom from tower · Harbor API (demo-ha)]\n[straw net from="tower · Harbor API" id=demo-ha role=tower workspace="Harbor API" kind=tower_send scope=one to="head tower" reply=none in-reply-to=H3] ${w.n2}`, at: new Date().toISOString() },
		{ id: `h-a-r${n}`, kind: "assistant", model: "head-1", text: w.a4, at: new Date().toISOString() },
	];
}

/** The draft `?zen=head-open` types into the unfolded box. */
export const headDraft = () => (getLocale() === "zh-TW" ? "也請 Orchard Data 今晚重跑 ETL" : "Also ask Orchard Data to rerun the ETL tonight");

/** What the demo does with a message to the head: `busy` refuses it; any other state takes it, shows it as the boss's line a moment later, works on it, and answers (the strip shows the working line meanwhile). */
export function headInput(state: HeadState | undefined, text: string, io: { send(type: string, payload: unknown): void; mark(working: boolean): void }, n: number): Answer {
	if (state === "busy") return { ok: false, status: 409, body: { error: "refused", reason: words().busy } };
	const item = (id: string, kind: "user" | "assistant", body: string): Item => ({ id, kind, text: body, at: new Date().toISOString(), ...(kind === "assistant" ? { model: "head-1" } : {}) });
	setTimeout(() => (io.send("history", { key: "sb-head", reset: false, items: [item(`h-you-${n}`, "user", text)] }), io.mark(true)), 500);
	setTimeout(() => (io.send("history", { key: "sb-head", reset: false, items: [item(`h-say-${n}`, "assistant", words().reply)] }), io.mark(false)), 6000);
	return { ok: true, status: 200, body: { accepted: true, woke: true } };
}
