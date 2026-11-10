import { h } from "./dom.ts";
import { m } from "./sentences.ts";

// The question panel's parts (docs/specs/2026-11-10-wait-cards-tui.md, section 4), drawn once for the two things that ask the boss to pick and then send: a unit's dialog (ask.ts, whose answer lifecycle sits on top of them) and a wait card (waitcard.ts, whose
// press lifecycle is its own). Every view already styles `.ask`, `.ask-opt`, `.ask-acts`, `.ask-note` (style.css, geek.css, raven.css, zen.css), so a card built of these wears each theme's look with no rules of its own. The keys (arrows move and pick, Enter goes on
// to Send) are askkeys.ts's, exported from here with the parts.

export { type Group, wire } from "./askkeys.ts";

/** A question longer than this many characters is marked `data-long`, so a view that sets questions as titles (Zen) can set it as text instead. */
export const LONG_Q = 90;
/** The question's own words. */
export const question = (text: string, extra: Record<string, string> = {}) => h("p", { class: "ask-q", ...extra, ...(text.length > LONG_Q ? { "data-long": "" } : {}) }, text);
/** One choice row of a radiogroup (`role` "radio") or a checkbox group: a bold title and small lines under it; `n` numbers it as the terminal does. */
export function option(role: string, title: string, small: (string | undefined)[], on: () => void, n?: number): HTMLButtonElement {
	const b = h("button", { type: "button", class: "ask-opt", role, "aria-checked": "false" }, h("b", n ? { "data-n": String(n) } : null, title), ...small.filter(Boolean).map((s) => h("small", null, s!)));
	b.onclick = on;
	return b;
}
/** The group the rows sit in. */
export const choices = (role: "radiogroup" | "group", label: string, ...rows: HTMLElement[]) => h("div", { class: "ask-opts", role, "aria-label": label }, ...rows);
/** The row of Send (and whatever is quiet beside it). */
export const actions = (...kids: (HTMLElement | false | undefined)[]) => h("div", { class: "ask-acts" }, ...kids);
/** Send, a button that stays off until something is picked. */
export const sendButton = (label: string = m.send_answer()) => h("button", { type: "button", class: "ask-send" }, label);
/** The status line under the panel, read aloud as it changes. */
export const statusLine = () => h("p", { class: "ask-note", role: "status", "aria-live": "polite" });
/** Writes the status line: its tone (`ok`, `error`, or none), its text, and any control that follows it (Check again). */
export const say = (note: HTMLElement, tone: string, text: string, ...kids: HTMLElement[]) => ((note.dataset.tone = tone), note.replaceChildren(text, ...kids));
/** The one place a picked row's mark is set. */
export const mark = (b: HTMLElement, on: boolean) => b.setAttribute("aria-checked", String(on));
