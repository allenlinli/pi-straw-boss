// Zen's Esc, as one table (docs/specs/2026-11-01-zen-view.md, Leaving and coming back). The layer gathers the facts and acts on the answer (zen.ts); nothing else in Zen reads the key, so the views-core
// refactor moves this file whole.
//
//   menu     the corner menu is open: Esc closes it and does nothing else.
//   history  the item's context is open on its card, or the head tower's whole conversation on the circle: Esc closes it and does nothing else.
//   reply    the wait card's answer box is unfolded: Esc folds it (the draft stays) and does nothing else.
//   head     the head tower's input is unfolded under the circle: Esc folds it (the draft stays) and does nothing else.
//   blur     a field holds the focus and has text in it (any screen), or is focused on the companion's screen, the pause, or the empty state: Esc only lets go of it.
//   item     an item is on the page and can still be answered: Esc cancels its question when it is cancellable (the card's Cancel), else "Not now" (the next card).
//   rest     the head tower's lines are clear under the circle: Esc sends them away (the maxim comes back) and does nothing else. After an empty field and an item, so it is the first Esc that nothing above took.
//   leave    nothing above took the key and the last one that took none was less than ESC_MS ago: back to Standard for this page.
//   hint     nothing took the key and it is the first: the quiet line "Press Esc again for Standard" shows, and the next such Esc within ESC_MS leaves.
// A key that repeats (held down) is no second press: it changes nothing.

export const ESC_MS = 600;
export type EscStep = "menu" | "history" | "reply" | "head" | "blur" | "item" | "rest" | "leave" | "hint" | "none";
export interface EscFacts {
	/** The corner menu is open. */
	menu: boolean;
	/** The item's context (its session log) is open on the card, or the head tower's history on the circle: Esc closes it before anything else. */
	history?: boolean;
	/** The answer box of a wait's card is unfolded. */
	reply?: boolean;
	/** The head tower's input is unfolded under the circle. */
	head?: boolean;
	/** The head tower's lines are on show under the circle and can be sent away (zenhead.ts `restable`). */
	rest?: boolean;
	/** The focus is in a text field of the layer: `text` with something typed, `empty` without, `none` elsewhere. */
	field: "text" | "empty" | "none";
	/** An item is on the page with no outcome yet (its card can still be cancelled or skipped). */
	item: boolean;
	/** An Esc that nothing took came less than ESC_MS ago. */
	armed: boolean;
	/** The key is held down and repeats. */
	repeat?: boolean;
}

export function escStep(f: EscFacts): EscStep {
	if (f.repeat) return "none";
	if (f.menu) return "menu";
	if (f.history) return "history";
	if (f.reply) return "reply";
	if (f.head) return "head";
	if (f.field === "text") return "blur";
	if (f.item) return "item";
	if (f.field === "empty") return "blur";
	if (f.rest) return "rest";
	return f.armed ? "leave" : "hint";
}

// The terminal layer's Esc (zenterm.ts): pi interrupts on Esc and vim leaves insert mode on it, so while the terminal has the keyboard (its sink has the focus) every Esc is the terminal's:
// `pass`, not taken and not prevented. With the focus anywhere else in the layer the same two-press window as above returns to Zen: `hint` for the first, `leave` for a second within ESC_MS.
export type TermStep = "pass" | "hint" | "leave" | "none";
export const termStep = (f: { typing: boolean; armed: boolean; repeat?: boolean }): TermStep => (f.typing ? "pass" : f.repeat ? "none" : f.armed ? "leave" : "hint");
