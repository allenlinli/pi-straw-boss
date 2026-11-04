import type { Item } from "../src/items.ts";
import type { TowerService } from "../src/net.ts";
import type { HeadUnit } from "../src/nethead.ts";
import { getLocale } from "./paraglide/runtime.js";
import type { Answer } from "./post.ts";

// The head tower of the demo (`?head=<state>`, docs/specs/2026-11-04-head-tower.md, Demo and pictures): `absent` (not open yet), `talk` (a conversation, no asks), `answers` (work handed to three towers, one answered), `waiting` (it waits for the boss),
// and `busy` (as `talk`, but it refuses what the boss sends: the strip's refusal). `?zen=head`, `head-open`, and `head-history` show the strip in Zen (fixture.ts); they take `answers` unless `?head=` says another.

export const HEAD_STATES = ["absent", "talk", "answers", "waiting", "busy"] as const;
export type HeadState = (typeof HEAD_STATES)[number];
export const isHeadState = (s: string | null): s is HeadState => HEAD_STATES.includes(s as HeadState);

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0), at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** The head unit of the net in one state; none of its times is older than the page, so the asks read "12m" and "3m". */
export function headDemo(state: HeadState, now = Date.now()): HeadUnit {
	if (state === "absent") return { key: "sb-head", name: "head tower", mark: "idle", state: "absent", asks: [] };
	const began = new Date(now - 50 * 60_000).toISOString(), idle = state === "waiting";
	const service: TowerService = {
		state: "running", queued: 0, notices: [], parked: [], allyRuns: [], run: { id: "h1", kind: "local", startedAt: began },
		conversation: { since: began, resumed: true, turns: 9, idle, ...(idle ? { idleAt: now + 8 * 60_000 } : {}), idleMs: 600_000, capAt: now + 3 * 3600_000 },
		...(state === "waiting" ? { memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "w1", text: "Rerun the Orchard ETL tonight?", at: began }], proposals: [] } } : {}),
	};
	const asks = state === "answers"
		? [{ id: "H3", workspace: "w1", label: "Harbor API", at: now - 12 * 60_000, open: true }, { id: "H2", workspace: "w2", label: "Lighthouse Web", at: now - 3 * 60_000, open: false, last: "Checkout test is green on main." }, { id: "H1", workspace: "w3", label: "Orchard Data", at: now - 95 * 60_000, open: false, last: "ETL rerun done, 0 rows lost." }]
		: [];
	return { key: "sb-head", name: "head tower", mark: "idle", state: "running", service, asks, said: now - 60_000 };
}

/** The demo's words by page language (the lines are the conversation's own, so the pictures in Traditional Chinese read in it). */
const WORDS = {
	en: { first: "the first conversation", u1: "Ask Harbor API to fix the ledger rounding, and have Lighthouse Web rerun the checkout test.", a1: "On it. I am handing the rounding fix to the Harbor API tower and the checkout rerun to Lighthouse Web.", n1: "Answer to H2: Checkout test is green on main.", a2: "Lighthouse Web finished: the checkout test is green on main. Harbor API is still on the rounding fix.", a3: "Should I also ask Orchard Data to rerun the ETL tonight, or wait until the ledger fix lands?", busy: "The head tower is busy with another message.", reply: "Handed to Harbor API. I will say when it answers." },
	zh: { first: "第一次對話", u1: "請 Harbor API 修掉帳本的進位問題，再請 Lighthouse Web 重跑結帳測試。", a1: "收到。進位問題我交給 Harbor API 塔台，結帳重跑交給 Lighthouse Web。", n1: "H2 的回覆：main 上的結帳測試全綠。", a2: "Lighthouse Web 做完了：main 上的結帳測試全綠。Harbor API 還在修進位問題。", a3: "晚上要不要也請 Orchard Data 重跑 ETL？還是等帳本修好再說？", busy: "主塔台正在處理另一則訊息。", reply: "已轉給 Harbor API 塔台，它回覆了我再告訴你。" },
};
const words = () => WORDS[getLocale() === "zh-TW" ? "zh" : "en"];

/** The head's conversation: a chapter divider first, then the boss's words, the head's forwards, and the towers' answers. */
export function headHistory(state: HeadState): Item[] {
	if (state === "absent") return [];
	const w = words();
	const out: Item[] = [
		{ id: "chapter-1", kind: "divider", type: "chapter", at: at(0), text: w.first, code: "first" },
		{ id: "h-u1", kind: "user", text: w.u1, at: at(2) },
		{ id: "h-a1", kind: "assistant", model: "head-1", at: at(3), text: w.a1, ctx: 4000, tools: ["Harbor API", "Lighthouse Web"].map((to, i) => ({ id: `h-t${i}`, name: "tower_send", summary: `(workspace: ${to})`, args: JSON.stringify({ workspace: to, message: w.u1 }) })) },
	];
	if (state === "answers" || state === "waiting") out.push(
		{ id: "h-n1", kind: "notice", type: "straw-tower", event: "intercom", from: "tower · Lighthouse Web", text: `[intercom from tower · Lighthouse Web (demo-lh)]\n[straw net from="tower · Lighthouse Web" id=demo-lh role=tower workspace="Lighthouse Web" kind=tower_send scope=one to="head tower" reply=none in-reply-to=H2] ${w.n1}`, at: at(9) },
		{ id: "h-a2", kind: "assistant", model: "head-1", at: at(10), text: w.a2, ctx: 5200 },
	);
	if (state === "waiting") out.push({ id: "h-a3", kind: "assistant", model: "head-1", at: at(12), text: w.a3, ctx: 5600 });
	return out;
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
