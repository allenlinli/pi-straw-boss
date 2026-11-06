import type { Net } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { rankOf, unitsOf, waitingOf } from "./units.ts";

// What Zen shows, decided without a page (docs/specs/2026-11-01-zen-view.md): the one current item, the pause, or the companion. The view it hands out never says how many items wait; the cue above the head strip's input is the one place that does (Z-D19, `queued`).
export type Sound = "bowl" | "knock" | "low";
/** `outcome`: why the card is on its last 1.2 s; `held`: the card stays after a refused answer. */
export type Outcome = "answered" | "elsewhere" | "error";
export type Screen = { kind: "item"; item: Alert; outcome?: Outcome } | { kind: "pause" } | { kind: "companion" };
export const REST_MS = 10 * 60_000, OUTCOME_MS = 1200, HOLD_MS = 30_000, PAUSE_MS = 3000;
/** What changes a resting item's question: its dialog (and digest), else its tool call; a trust question has its digest in its key. */
const questionOf = (a: Alert) => `${a.key}|${a.pending?.answer ? `${a.pending.answer.dialog}:${a.pending.answer.digest}` : (a.pending?.callId ?? "")}`;

/**
 * Whether an item blocks an agent that cannot go on until the boss answers (Z-D18, docs/specs/2026-11-01-zen-view.md, Blocking first): a unit that waits or has a dialog, a trust question, a question a box forwarded, a teammate's confirm. A tower's wait, a pair request, and a memory
 * proposal block no one: they rank below, and the order of the cards that wait is blocking first (Z-D19: the cards wait for Enter, so the rank only says which comes next). A kind of card nobody ranked fails the type check (`unranked`), and one that is unknown at run time blocks: a question that waits is not buried.
 */
const unranked = (_kind: never): true => true;
export function blocks(a: Alert): boolean {
	if (a.wait) return false;
	const kind = a.card?.kind;
	switch (kind) {
		case undefined: case "dialog": case "confirm": return true;
		case "pair": case "proposal": return false;
		default: return unranked(kind);
	}
}

/** A session Zen keeps company with: its key and its base. */
export interface With { key: string; ws: string }
/** The session for company: the asked one while the net lists it live with control; else none, and the breathing circle shows (Z-D12: no tower stands in). */
export function companionOf(net: Net | undefined, asked: With | undefined): With | undefined {
	const ws = asked && net && unitsOf(net).find(({ unit: u }) => u.key === asked.key && u.control && !("ended" in u && u.ended))?.base.id;
	return asked && ws !== undefined ? { key: asked.key, ws } : undefined;
}

export interface ZenDeps { now(): number; /** The companion's box has text and a real input (tap, drag, wheel, key, or text input) in the last DRAFT_MS. */ typing(): boolean; /** Zen rests on the breathing circle (no session for company, no history open): no card takes the screen then, it waits for Enter (Z-D19). */ breathing(): boolean }
export function createZen({ now, typing, breathing }: ZenDeps) {
	let alerts = new Map<string, Alert>(), screen: Screen = { kind: "companion" }, until = 0, hidden = false, quiet = false, back = false;
	const seen = new Map<string, number>(), rests = new Map<string, { until: number; q: string }>();
	let sound: Sound | undefined;
	const items = () => waitingOf(alerts.values()).filter((a) => a.mark !== "error");
	const age = (a: Alert) => a.since ?? seen.get(a.key) ?? now();
	const eligible = () => items().filter((a) => !rests.has(a.key)).sort((a, b) => Number(blocks(b)) - Number(blocks(a)) || age(a) - age(b) || (a.key < b.key ? -1 : 1)); // blocking first, then the one that has waited longest
	const next = () => eligible()[0];
	/** The cards that wait for Enter: the eligible ones, with no card on the screen. */
	const queued = () => (screen.kind === "item" ? [] : eligible());
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
			else if (back && cur?.mark !== "error") screen = { kind: "companion" }; // the item was on the screen when Zen was left and is gone now (answered in Standard, or closed): no card, no knock, and no line about it
			else {
				const elsewhere = cur ? !cur.closed : Boolean(screen.item.trust || screen.item.card); // a trust question or a card (a link confirm, a pair request, a proposal) has no unit to leave: when the server stops listing it, it was settled
				leave(cur?.mark === "error" ? "error" : elsewhere ? "elsewhere" : undefined, cur?.mark === "error" ? "low" : elsewhere ? "knock" : undefined);
			}
		}
		if (screen.kind === "item" && screen.outcome && until <= now()) pause();
		// A pause is for a boss who is there to breathe: a page that is not shown has none, so an item that waits ends it at once (its card is drawn and the page reminds, as on any hidden page). With nothing waiting it is kept until the page is shown.
		if (screen.kind === "pause" && ((until <= now() && !hidden) || (hidden && next()))) screen = { kind: "companion" };
		if (screen.kind === "companion" && !typing() && !breathing()) { const n = next(); if (n) take(n); } // on the breathing circle a card waits for Enter (`take`, Z-D19); with a session for company it still takes the screen
	}
	const out = () => { settle(); const s = sound; sound = undefined; return { screen, sound: s }; };
	return {
		/** A new snapshot's alerts; `returning`: Zen is shown again after Standard had the page, so an item the screen still held from before and the snapshot no longer has is dropped silently. */
		update(a: Map<string, Alert>, returning = false) { back = returning; alerts = a; for (const x of items()) if (!seen.has(x.key)) seen.set(x.key, now()); for (const k of seen.keys()) if (!a.has(k)) seen.delete(k); try { return out(); } finally { back = false; } },
		/** The clock moved, or the typing state changed. */
		tick: out,
		/** The accepted answer or cancel of the item with this key: the knock, the outcome for 1.2 s, then the pause. */
		accepted(key: string) { if (screen.kind !== "item" || screen.item.key !== key) return out(); // a reply that comes after the boss moved on belongs to an item that is no longer on screen
			if (screen.outcome === "elsewhere") screen = { ...screen, outcome: "answered" }; // the server's snapshot came ahead of its reply: this answer settled it, and the knock already rang
			else if (!screen.outcome) { quiet = false; leave("answered", "knock"); quiet = true; rests.set(screen.item.key, { until: now() + HOLD_MS, q: questionOf(screen.item) }); } return out(); },
		/** An answer of the item with this key that was refused, stale, busy, or unconfirmed: the low bowl, and the card stays; the item's later exit is silent. */
		refused(key: string) { if (screen.kind === "item" && screen.item.key === key && !screen.outcome && !quiet) { sound = "low"; quiet = true; } return out(); },
		/** Not now: the item rests, and the pause starts. */
		skip() { if (screen.kind === "item") { rests.set(screen.item.key, { until: now() + REST_MS, q: questionOf(screen.item) }); pause(); } return out(); },
		/** Enter, or a tap on the cue (Z-D19): the next card takes the screen, the pause ending with it. False (no change) when none waits or one is on the screen. */
		take() { if (screen.kind !== "item") { const n = next(); if (n) take(n); } return out(); },
		/** The cards that wait for Enter, in the order they come (the cue above the head strip's input says how many). */
		queued,
		/** The keys of every card the server lists as waiting, the one on the screen and the ones set aside included (what a reminder is counted against, so one card is reminded once). */
		listed: () => items().map((x) => x.key),
		/** A tap, Enter, or Space during the pause. */
		tap() { if (screen.kind === "pause") until = 0; return out(); },
		/** The page was hidden or shown: a pause that would have ended ends at once when shown. */
		visible(on: boolean) { hidden = !on; return out(); },
		/** Why the waiting item `key` is not what the screen shows now (the page's console line), or nothing when it is or is no item. */
		why(key: string): string | undefined {
			if (screen.kind === "item" && screen.item.key === key) return undefined;
			if (!items().some((x) => x.key === key)) return undefined;
			if (rests.has(key)) return "it was put aside (Maybe later), or just answered";
			if (screen.kind === "item") return `${screen.item.key} is on the screen`;
			if (screen.kind === "pause") return hidden ? "a pause holds the page, which is hidden" : "the pause after a card is on";
			return typing() ? "the boss is typing in the companion's box" : breathing() ? "it waits for Enter: the breathing circle takes no card by itself" : "it is next";
		},
		/** The soonest moment ahead at which something may change, for the layer's one timer (a time already past is settled by the call that saw it). */
		due: () => [until, ...[...rests.values()].map((r) => r.until)].filter((t) => t > now()).sort((a, b) => a - b)[0],
	};
}
