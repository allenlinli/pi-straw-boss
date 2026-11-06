import type { Net } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { cardSig } from "./cardalerts.ts";
import { rankOf, unitsOf, waitingOf } from "./units.ts";

// What Zen shows, decided without a page (docs/specs/2026-11-01-zen-view.md): the one current item, the pause, or the companion. The view it hands out never says how many items wait; the cue is the one place that does (Z-D19, `queued`).
// No card ever takes the screen by itself, and a card on the screen is never replaced or pulled away (Z-D20): a card is taken by the boss (`take`) and leaves by the boss's own answer, Not now, or closing it.
export type Sound = "bowl" | "knock" | "low";
/** `outcome`: why the card is no longer answerable. `answered` (the boss's own answer) shows for 1.2 s and then the pause; `elsewhere` (the question ended, or is gone) and `error` (the unit failed) are held: the card stays, saying so, until the boss closes it (`skip`). */
export type Outcome = "answered" | "elsewhere" | "error";
export type Screen = { kind: "item"; item: Alert; outcome?: Outcome } | { kind: "pause" } | { kind: "companion" };
export const REST_MS = 10 * 60_000, OUTCOME_MS = 1200, HOLD_MS = 30_000, PAUSE_MS = 3000;
/** What changes an item's question: its dialog (and digest), else its tool call; a trust question has its digest in its key, a Link confirm its request. An item that changes it is another question: a rest ends, and a card on the screen is settled, not swapped. */
const questionOf = (a: Alert) => `${a.key}|${a.pending?.answer ? `${a.pending.answer.dialog}:${a.pending.answer.digest}` : (a.pending?.callId ?? "")}|${cardSig(a)}`;

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

export interface ZenDeps { now(): number }
export function createZen({ now }: ZenDeps) {
	let alerts = new Map<string, Alert>(), screen: Screen = { kind: "companion" }, until = 0, hidden = false, quiet = false, back = false;
	const seen = new Map<string, number>(), rests = new Map<string, { until: number; q: string }>();
	let sound: Sound | undefined;
	const items = () => waitingOf(alerts.values()).filter((a) => a.mark !== "error");
	const age = (a: Alert) => a.since ?? seen.get(a.key) ?? now();
	const eligible = () => items().filter((a) => !rests.has(a.key)).sort((a, b) => Number(blocks(b)) - Number(blocks(a)) || age(a) - age(b) || (a.key < b.key ? -1 : 1)); // blocking first, then the one that has waited longest
	const next = () => eligible()[0];
	/** The cards that wait for the boss to take them: the eligible ones but the one on the screen (a card that is shown, even one that has just ended, is not counted behind itself). */
	const queued = () => eligible().filter((a) => screen.kind !== "item" || a.key !== screen.item.key);
	const take = (item: Alert) => ((screen = { kind: "item", item }), (quiet = false), (sound = "bowl"));
	const pause = () => ((screen = { kind: "pause" }), (until = now() + PAUSE_MS));
	/** The card on the screen is settled: it stays (`outcome`), and only the boss's answer, Not now, or Esc takes it away. `answered` runs for 1.2 s, the others until closed (`until` 0: no timer). */
	const settled = (outcome: Outcome, snd: Sound | undefined) => ((screen = { ...(screen as Extract<Screen, { kind: "item" }>), outcome }), (until = outcome === "answered" ? now() + OUTCOME_MS : 0), snd && !quiet && (sound = snd));
	/** Everything time and data change: the end of an outcome, a rest, or the pause, and a card on the screen whose question ended. Nothing here puts a card on the screen: the boss takes it. */
	function settle() {
		const open = new Map(items().map((x) => [x.key, x] as const));
		for (const [k, r] of rests) if (r.until <= now() || !open.has(k) || questionOf(open.get(k)!) !== r.q) rests.delete(k);
		if (screen.kind === "item") {
			const cur = alerts.get(screen.item.key), live = Boolean(cur && rankOf(cur) === 0 && cur.mark !== "error" && questionOf(cur) === questionOf(screen.item)); // the same question, still asked
			if (screen.outcome === "answered") { if (until <= now()) pause(); }
			else if (live && screen.outcome !== "error") screen = { kind: "item", item: cur! }; // a held card whose question is listed again (a snapshot that missed it) is live again
			else if (back) screen = { kind: "companion" }; // the item was on the screen when Zen was left and has ended since (answered in Standard, or closed): no card, no knock, and no line about it
			else if (!screen.outcome) {
				const elsewhere = cur ? !cur.closed : Boolean(screen.item.trust || screen.item.card); // a trust question or a card (a link confirm, a pair request, a proposal) has no unit to leave: when the server stops listing it, it was settled; a unit that left or closed is a silent end
				settled(cur?.mark === "error" ? "error" : "elsewhere", cur?.mark === "error" ? "low" : elsewhere ? "knock" : undefined);
			}
		}
		// A pause is for a boss who is there to breathe: a page that is not shown has none, so an item that waits ends it at once (the page reminds, as on any hidden page). With nothing waiting it is kept until the page is shown.
		if (screen.kind === "pause" && ((until <= now() && !hidden) || (hidden && next()))) screen = { kind: "companion" };
	}
	const out = () => { settle(); const s = sound; sound = undefined; return { screen, sound: s }; };
	return {
		/** A new snapshot's alerts; `returning`: Zen is shown again after Standard had the page, so an item the screen still held from before and the snapshot no longer has is dropped silently. */
		update(a: Map<string, Alert>, returning = false) { back = returning; alerts = a; for (const x of items()) if (!seen.has(x.key)) seen.set(x.key, now()); for (const k of seen.keys()) if (!a.has(k)) seen.delete(k); try { return out(); } finally { back = false; } },
		/** The clock moved. */
		tick: out,
		/** The accepted answer or cancel of the item with this key: the knock, the outcome for 1.2 s, then the pause. */
		accepted(key: string) { if (screen.kind !== "item" || screen.item.key !== key) return out(); // a reply that comes after the boss moved on belongs to an item that is no longer on screen
			if (screen.outcome === "elsewhere") settled("answered", undefined); // the server's snapshot came ahead of its reply: this answer settled it, and the knock already rang
			else if (!screen.outcome) { quiet = false; settled("answered", "knock"); quiet = true; rests.set(screen.item.key, { until: now() + HOLD_MS, q: questionOf(screen.item) }); } return out(); },
		/** An answer of the item with this key that was refused, stale, busy, or unconfirmed: the low bowl, and the card stays; the item's later exit is silent. */
		refused(key: string) { if (screen.kind === "item" && screen.item.key === key && !screen.outcome && !quiet) { sound = "low"; quiet = true; } return out(); },
		/** Not now, or closing a card that ended (`elsewhere`, `error`): the pause starts. A card that is still asked rests; one that ended does not, so the unit's next question (or the same one, listed again) is in the queue. */
		skip() { if (screen.kind === "item" && screen.outcome !== "answered") { if (!screen.outcome) rests.set(screen.item.key, { until: now() + REST_MS, q: questionOf(screen.item) }); pause(); } return out(); },
		/** Enter, or a tap on the cue (Z-D19): the next card takes the screen, the pause ending with it. False (no change) when none waits or one is on the screen. */
		take() { if (screen.kind !== "item") { const n = next(); if (n) take(n); } return out(); },
		/** The cards that wait for Enter, in the order they come (the cue says how many): those behind the card on the screen included. */
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
			return "it waits for Enter: no card takes the screen by itself";
		},
		/** The soonest moment ahead at which something may change, for the layer's one timer (a time already past is settled by the call that saw it). */
		due: () => [until, ...[...rests.values()].map((r) => r.until)].filter((t) => t > now()).sort((a, b) => a - b)[0],
	};
}
