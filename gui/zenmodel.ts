import type { Net } from "../src/net.ts";
import { type Alert, rankOf } from "./alerts.ts";
import type { With } from "./zenwith.ts";

// What Zen shows, decided without a page (docs/specs/2026-11-01-zen-view.md): the one current item, the pause, or the companion. The view it hands out never says how many items wait.
export type Sound = "bowl" | "knock" | "low";
/** `outcome`: why the card is on its last 1.2 s; `held`: the card stays after a refused answer. */
export type Outcome = "answered" | "elsewhere" | "error";
export type Screen = { kind: "item"; item: Alert; outcome?: Outcome } | { kind: "pause" } | { kind: "companion" };
export const REST_MS = 10 * 60_000, OUTCOME_MS = 1200, HOLD_MS = 30_000, PAUSE_MS = 3000;
/** What changes a resting item's question: its dialog (and digest), else its tool call; a trust question has its digest in its key. */
const questionOf = (a: Alert) => `${a.key}|${a.pending?.answer ? `${a.pending.answer.dialog}:${a.pending.answer.digest}` : (a.pending?.callId ?? "")}`;

/** The session for company: the stored one while the net lists it live, else its base's tower, else the head base's tower. */
export function companionOf(net: Net | undefined, stored: With | undefined): { key: string; ws: string } | undefined {
	type U = { key: string; control: boolean; ended?: boolean; subs: U[] };
	const all = (u: U): U[] => [u, ...u.subs.flatMap(all)];
	const live = (k: string) => net?.bases.find((b) => [...(b.tower ? all(b.tower as U) : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => all(u as U))].some((u) => u.key === k && u.control && !u.ended))?.id;
	const ws = stored && live(stored.key);
	if (stored && ws !== undefined) return { key: stored.key, ws };
	const t = (id?: string) => ((b) => (b?.tower ? { key: b.tower.key, ws: b.id } : undefined))(net?.bases.find((x) => x.id === id));
	return t(stored?.ws) ?? t(net?.bases.find((b) => b.head)?.id);
}

export interface ZenDeps { now(): number; /** The companion's box has the focus and text. */ typing(): boolean }
export function createZen({ now, typing }: ZenDeps) {
	let alerts = new Map<string, Alert>(), screen: Screen = { kind: "companion" }, until = 0, hidden = false, quiet = false;
	const seen = new Map<string, number>(), rests = new Map<string, { until: number; q: string }>();
	let sound: Sound | undefined;
	const items = () => [...alerts.values()].filter((a) => rankOf(a) === 0 && a.mark !== "error");
	const age = (a: Alert) => a.since ?? seen.get(a.key) ?? now();
	const next = () => items().filter((a) => !rests.has(a.key)).sort((a, b) => age(a) - age(b) || (a.key < b.key ? -1 : 1))[0];
	const take = (item: Alert) => ((screen = { kind: "item", item }), (quiet = false), (sound = "bowl"));
	const pause = () => ((screen = { kind: "pause" }), (until = now() + PAUSE_MS));
	const leave = (outcome: Outcome | undefined, snd: Sound | undefined) => (outcome ? ((screen = { ...(screen as Extract<Screen, { kind: "item" }>), outcome }), (until = now() + OUTCOME_MS), snd && !quiet && (sound = snd)) : pause());
	/** Everything time and data change: the end of an outcome, a rest, or the pause, and the screen being free for an item. */
	function settle() {
		const open = new Map(items().map((x) => [x.key, x] as const));
		for (const [k, r] of rests) if (r.until <= now() || !open.has(k) || questionOf(open.get(k)!) !== r.q) rests.delete(k);
		if (screen.kind === "item" && !screen.outcome) {
			const cur = alerts.get(screen.item.key), live = cur && rankOf(cur) === 0 && cur.mark !== "error";
			if (live) screen = { kind: "item", item: cur };
			else {
				const elsewhere = cur ? !cur.closed : Boolean(screen.item.trust); // a trust question has no unit to leave: when it is gone it was settled
				leave(cur?.mark === "error" ? "error" : elsewhere ? "elsewhere" : undefined, cur?.mark === "error" ? "low" : elsewhere ? "knock" : undefined);
			}
		}
		if (screen.kind === "item" && screen.outcome && until <= now()) pause();
		if (screen.kind === "pause" && until <= now() && !hidden) screen = { kind: "companion" };
		if (screen.kind === "companion" && !typing()) { const n = next(); if (n) take(n); }
	}
	const out = () => { settle(); const s = sound; sound = undefined; return { screen, sound: s }; };
	return {
		/** A new snapshot's alerts. */
		update(a: Map<string, Alert>) { alerts = a; for (const x of items()) if (!seen.has(x.key)) seen.set(x.key, now()); for (const k of seen.keys()) if (!a.has(k)) seen.delete(k); return out(); },
		/** The clock moved, or the typing state changed. */
		tick: out,
		/** The accepted answer or cancel: the knock, the outcome for 1.2 s, then the pause. */
		accepted() { if (screen.kind === "item" && !screen.outcome) { quiet = false; leave("answered", "knock"); quiet = true; rests.set(screen.item.key, { until: now() + HOLD_MS, q: questionOf(screen.item) }); } return out(); },
		/** An answer that was refused, stale, busy, or unconfirmed: the low bowl, and the card stays; the item's later exit is silent. */
		refused() { if (screen.kind === "item" && !screen.outcome && !quiet) { sound = "low"; quiet = true; } return out(); },
		/** Not now: the item rests, and the pause starts. */
		skip() { if (screen.kind === "item") { rests.set(screen.item.key, { until: now() + REST_MS, q: questionOf(screen.item) }); pause(); } return out(); },
		/** A tap, Enter, or Space during the pause. */
		tap() { if (screen.kind === "pause") until = 0; return out(); },
		/** The page was hidden or shown: a pause that would have ended ends at once when shown. */
		visible(on: boolean) { hidden = !on; return out(); },
		/** The soonest moment ahead at which something may change, for the layer's one timer (a time already past is settled by the call that saw it). */
		due: () => [until, ...[...rests.values()].map((r) => r.until)].filter((t) => t > now()).sort((a, b) => a - b)[0],
	};
}
