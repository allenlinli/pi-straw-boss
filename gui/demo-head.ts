import type { Item } from "../src/items.ts";
import type { TowerService } from "../src/net.ts";
import type { HeadUnit } from "../src/nethead.ts";

// The head tower of the demo (`?head=<state>`, docs/specs/2026-11-04-head-tower.md, Demo and pictures): `absent` (not open yet), `talk` (a conversation, no asks), `answers` (work handed to three towers, one answered), `waiting` (it waits for the boss).

export const HEAD_STATES = ["absent", "talk", "answers", "waiting"] as const;
export type HeadState = (typeof HEAD_STATES)[number];
export const isHeadState = (s: string | null): s is HeadState => HEAD_STATES.includes(s as HeadState);

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0), at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** The head unit of the net in one state; none of its times is older than the page, so the asks read "12m" and "3m". */
export function headDemo(state: HeadState, now = Date.now()): HeadUnit {
	if (state === "absent") return { key: "sb-head", name: "head tower", mark: "idle", state: "absent", asks: [] };
	const began = new Date(now - 50 * 60_000).toISOString(), idle = state !== "talk" && state !== "answers" ? true : false;
	const service: TowerService = {
		state: "running", queued: 0, notices: [], parked: [], allyRuns: [], run: { id: "h1", kind: "local", startedAt: began },
		conversation: { since: began, resumed: true, turns: 9, idle, ...(idle ? { idleAt: now + 8 * 60_000 } : {}), idleMs: 600_000, capAt: now + 3 * 3600_000 },
	};
	const asks = state === "answers"
		? [{ id: "H3", workspace: "w1", label: "Harbor API", at: now - 12 * 60_000, open: true }, { id: "H2", workspace: "w2", label: "Lighthouse Web", at: now - 3 * 60_000, open: false, last: "Checkout test is green on main." }, { id: "H1", workspace: "w3", label: "Orchard Data", at: now - 95 * 60_000, open: false, last: "ETL rerun done, 0 rows lost." }]
		: [];
	return { key: "sb-head", name: "head tower", mark: "idle", state: "running", service, asks, said: now - 60_000 };
}

/** The head's conversation: a chapter divider first, then the boss's words, the head's forwards, and the towers' answers. */
export function headHistory(state: HeadState): Item[] {
	if (state === "absent") return [];
	const out: Item[] = [
		{ id: "chapter-1", kind: "divider", type: "chapter", at: at(0), text: "the first conversation", code: "first" },
		{ id: "h-u1", kind: "user", text: "Ask Harbor API to fix the ledger rounding, and have Lighthouse Web rerun the checkout test.", at: at(2) },
		{ id: "h-a1", kind: "assistant", model: "head-1", at: at(3), text: "On it. I am handing the rounding fix to the Harbor API tower and the checkout rerun to Lighthouse Web.", ctx: 4000 },
	];
	if (state === "answers" || state === "waiting") out.push(
		{ id: "h-n1", kind: "notice", type: "intercom_message", from: "tower · Lighthouse Web", text: "Answer to H2: Checkout test is green on main.", at: at(9) },
		{ id: "h-a2", kind: "assistant", model: "head-1", at: at(10), text: "Lighthouse Web finished: the checkout test is green on main. Harbor API is still on the rounding fix.", ctx: 5200 },
	);
	if (state === "waiting") out.push({ id: "h-a3", kind: "assistant", model: "head-1", at: at(12), text: "Should I also ask Orchard Data to rerun the ETL tonight, or wait until the ledger fix lands?", ctx: 5600 });
	return out;
}
