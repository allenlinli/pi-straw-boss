import type { Net } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { rankOf, unitsOf, waitingOf } from "./units.ts";

// What Zen shows, decided without a page (docs/specs/2026-11-01-zen-view.md): the one current item, the pause, or the companion. The view it hands out never says how many items wait.
export type Sound = "bowl" | "knock" | "low";
/** `outcome`: why the card is on its last 1.2 s; `held`: the card stays after a refused answer. */
export type Outcome = "answered" | "elsewhere" | "error";
export type Screen = { kind: "item"; item: Alert; outcome?: Outcome } | { kind: "pause" } | { kind: "companion" };
export const REST_MS = 10 * 60_000, OUTCOME_MS = 1200, HOLD_MS = 30_000, PAUSE_MS = 3000;
/** What changes a resting item's question: its dialog (and digest), else its tool call; a trust question has its digest in its key. */
const questionOf = (a: Alert) => `${a.key}|${a.pending?.answer ? `${a.pending.answer.dialog}:${a.pending.answer.digest}` : (a.pending?.callId ?? "")}`;

/**
 * Whether an item blocks an agent that cannot go on until the boss answers (Z-D18, docs/specs/2026-11-01-zen-view.md, Blocking first): a unit that waits or has a dialog, a trust question, a question a box forwarded, a teammate's confirm. A tower's wait, a pair request, and a memory
 * proposal block no one: they rank below, and an untouched one yields the screen to a blocking question.
 */
export const blocks = (a: Alert) => !a.wait && (!a.card || a.card.kind === "dialog" || a.card.kind === "confirm");

/** A session Zen keeps company with: its key and its base. */
export interface With { key: string; ws: string }
/** The session for company: the asked one while the net lists it live with control; else none, and the breathing circle shows (Z-D12: no tower stands in). */
export function companionOf(net: Net | undefined, asked: With | undefined): With | undefined {
	const ws = asked && net && unitsOf(net).find(({ unit: u }) => u.key === asked.key && u.control && !("ended" in u && u.ended))?.base.id;
	return asked && ws !== undefined ? { key: asked.key, ws } : undefined;
}

export interface ZenDeps { now(): number; /** The companion's box has text and a real input (tap, drag, wheel, key, or text input) in the last DRAFT_MS. */ typing(): boolean; /** The card on the screen is being answered (zentouch.ts): a blocking question does not take the screen from it. */ touched(): boolean }
export function createZen({ now, typing, touched }: ZenDeps) {
	let alerts = new Map<string, Alert>(), screen: Screen = { kind: "companion" }, until = 0, hidden = false, quiet = false, back = false;
	const seen = new Map<string, number>(), rests = new Map<string, { until: number; q: string }>();
	let sound: Sound | undefined;
	const items = () => waitingOf(alerts.values()).filter((a) => a.mark !== "error");
	const age = (a: Alert) => a.since ?? seen.get(a.key) ?? now();
	const next = () => items().filter((a) => !rests.has(a.key)).sort((a, b) => Number(blocks(b)) - Number(blocks(a)) || age(a) - age(b) || (a.key < b.key ? -1 : 1))[0]; // blocking first, then the one that has waited longest
	/** The blocking question waiting for a lower card on the screen to be let go of. */
	const yielding = () => { const n = screen.kind === "item" && !screen.outcome && !blocks(screen.item) ? next() : undefined; return n && blocks(n) ? n : undefined; };
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
		const urgent = yielding(); // a card that blocks no one and is not being answered gives up the screen; it stays eligible, in its place by age, and is no Later
		if (urgent && !touched()) take(urgent);
		// A pause is for a boss who is there to breathe: a page that is not shown has none, so an item that waits ends it at once (its card is drawn and the page reminds, as on any hidden page). With nothing waiting it is kept until the page is shown.
		if (screen.kind === "pause" && ((until <= now() && !hidden) || (hidden && next()))) screen = { kind: "companion" };
		if (screen.kind === "companion" && !typing()) { const n = next(); if (n) take(n); }
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
		/** A tap, Enter, or Space during the pause. */
		tap() { if (screen.kind === "pause") until = 0; return out(); },
		/** The page was hidden or shown: a pause that would have ended ends at once when shown. */
		visible(on: boolean) { hidden = !on; return out(); },
		/** Why the waiting item `key` is not what the screen shows now (the page's console line), or nothing when it is or is no item. */
		why(key: string): string | undefined {
			if (screen.kind === "item" && screen.item.key === key) return undefined;
			if (!items().some((x) => x.key === key)) return undefined;
			if (rests.has(key)) return "it was put aside (Maybe later), or just answered";
			if (yielding()?.key === key) return "the card on the screen is being answered";
			if (screen.kind === "item") return `${screen.item.key} is on the screen and was waiting first`;
			if (screen.kind === "pause") return hidden ? "a pause holds the page, which is hidden" : "the pause after a card is on";
			return typing() ? "the boss is typing in the companion's box" : "it is next";
		},
		/** A blocking question waits behind a card the boss is answering: the layer looks again soon, as it does at a draft. */
		deferred: () => Boolean(yielding()),
		/** The soonest moment ahead at which something may change, for the layer's one timer (a time already past is settled by the call that saw it). */
		due: () => [until, ...[...rests.values()].map((r) => r.until)].filter((t) => t > now()).sort((a, b) => a - b)[0],
	};
}
