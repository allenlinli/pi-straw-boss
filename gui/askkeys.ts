// The answer form's keys (ask.ts), so a question is answered from the keyboard alone. In a question's options the arrows (and Left/Right) move
// between them, and a single choice selects as the focus moves (a radio group); Tab and Shift+Tab move between questions; Enter (and Space, on a
// single choice) confirms the option and goes on to the next unanswered question, then to Send; Enter on a multiple choice only goes on, and Space
// toggles. Down past the last option reaches the question's own-words box, Up goes back to the last option and Down on to its note (from the box's start and end: elsewhere they are the caret's), and Enter in it goes on like Enter on an option (Shift+Enter is a new line). Tab walks a question's own words and note the browser's way
// and leaves its last box for the next question's option (Shift+Tab from an option goes back to the last box of the question before); it leaves the last question the browser's way (Send). A move into another question tells the form first (`ask-reveal`), for a layer that folds the questions it is not on (Zen).
// The rest, including Escape and the text caret's own keys, stays the browser's and the page's.

export type Part = "opt" | "own" | "note";
/** A place in the form: the question, the part of it, and for an option its index (a missing one is the chosen option, or the first). */
export interface Spot { q: number; part: Part; o?: number }
export interface Shape { options: number; multiple: boolean; own: boolean; note: boolean }
/** What a key asks for: focus `to` (Send, or a place), choosing the option `pick` first. */
export interface Move { to: Spot | "send"; pick?: number }
const ARROWS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/** The key's move from a place, or undefined when the key is the browser's. `answered` says which questions have an answer already. */
export function route(key: string, shift: boolean, at: Spot, shapes: Shape[], answered: boolean[]): Move | undefined {
	const { q } = at, s = shapes[q]!, dir = ARROWS[key] ?? 0, up = key === "ArrowUp", vertical = up || key === "ArrowDown";
	/** The next unanswered question after this one, wrapping round; Send when none is left. */
	const onward = (): Move => ({ to: shapes.map((_, i) => ({ q: (q + 1 + i) % shapes.length, part: "opt" as const })).find((x) => x.q !== q && !answered[x.q]) ?? "send" });
	if (key === "Tab") {
		const before = shapes[q - 1], inQuestion = at.part === "opt" ? s.own || s.note : at.part === "own" && s.note; // a box of this question comes next in the browser's order
		if (!shift) return inQuestion || q === shapes.length - 1 ? undefined : { to: { q: q + 1, part: "opt" } };
		return at.part === "opt" && before ? { to: { q: q - 1, part: before.note ? "note" : before.own ? "own" : "opt" } } : undefined;
	}
	if (shift) return;
	if (at.part === "opt") {
		const o = at.o! + dir;
		if (dir) return o >= 0 && o < s.options ? { to: { q, part: "opt", o }, ...(s.multiple ? {} : { pick: o }) } : { to: dir > 0 && s.own ? { q, part: "own" } : at };
		if (key === "Enter" || (key === " " && !s.multiple)) return { ...onward(), ...(s.multiple ? {} : { pick: at.o }) };
	} else if (at.part === "own") {
		if (key === "Enter") return onward();
		if (vertical) return { to: up ? { q, part: "opt", o: s.options - 1 } : { q, part: "note" } };
	} else if (up) return { to: { q, part: "own" } };
}

/** One question's controls: its options, its own-words and note boxes, and whether it has an answer. */
export interface Group { opts: HTMLButtonElement[]; multiple: boolean; own?: HTMLTextAreaElement; note?: HTMLInputElement; answered(): boolean }

/** Wires the keys onto the form's element; `send` is Send's button. Options keep one tab stop each (the chosen one, or the one last focused). Returns where the focus goes on entering the form. */
export function wire(el: HTMLElement, groups: Group[], send: () => HTMLButtonElement | undefined) {
	const chosen = (g: Group) => Math.max(0, g.opts.findIndex((b) => b.getAttribute("aria-checked") === "true"));
	const rove = (g: Group, k: number) => g.opts.forEach((b, n) => b.setAttribute("tabindex", n === k ? "0" : "-1"));
	const where = (t: EventTarget | null): Spot | undefined => {
		for (const [q, g] of groups.entries()) {
			const o = g.opts.indexOf(t as HTMLButtonElement);
			if (o >= 0) return { q, part: "opt", o };
			if (t === g.own || t === g.note) return { q, part: t === g.own ? "own" : "note" };
		}
	};
	groups.forEach((g) => rove(g, chosen(g)));
	const landed = (e: Event) => {
		const at = where(e.target);
		if (at?.part === "opt") rove(groups[at.q]!, at.o!); // a click too: Safari does not focus a button it was clicked on
	};
	el.addEventListener("focusin", landed);
	el.addEventListener("click", landed);
	let spaced = false;
	/** The form saw this Space go down. A release it did not see pressed (the Zen card was inert then, zen.ts `inert`) is swallowed too (zbf-rr-F001). */
	let pressed = false;
	el.addEventListener("keydown", (e) => {
		if (e.key === " ") pressed = true;
		const at = where(e.target);
		if (!at || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
		const box = e.target as HTMLInputElement | HTMLTextAreaElement;
		if (at.part !== "opt" && (e.key === "ArrowUp" ? box.selectionStart !== 0 : e.key === "ArrowDown" && box.selectionEnd !== box.value.length)) return; // the caret's own: Up and Down leave a box only from its start and its end
		const move = route(e.key, e.shiftKey, at, groups.map((g) => ({ options: g.opts.length, multiple: g.multiple, own: Boolean(g.own), note: Boolean(g.note) })), groups.map((g) => g.answered()));
		if (!move) return;
		e.preventDefault();
		if (e.repeat && ["Enter", " "].includes(e.key)) return; // a held key would carry on through every question
		spaced = e.key === " ";
		if (move.pick !== undefined) {
			const b = groups[at.q]!.opts[move.pick]!;
			if (b.getAttribute("aria-checked") !== "true") b.click();
		}
		const g = move.to === "send" ? undefined : groups[move.to.q]!;
		const to = move.to === "send" ? send() : move.to.part === "opt" ? g!.opts[move.to.o ?? chosen(g!)] : move.to.part === "own" ? g!.own : g!.note;
		if (to && !to.disabled) (el.dispatchEvent(new CustomEvent("ask-reveal", { detail: to })), to.focus());
	});
	el.addEventListener("keyup", (e) => {
		if (e.key !== " ") return;
		if (spaced || !pressed) e.preventDefault(); // Firefox clicks on Space's release, whichever control has the focus then
		spaced = pressed = false;
	});
	return () => groups[0]?.opts[chosen(groups[0])];
}
