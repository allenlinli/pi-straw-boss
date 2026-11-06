import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";

const PASS = ["Tab", "Shift", "Escape", "Control", "Alt", "Meta"]; // the keys that move or leave and are not typing: they stay on the button
/**
 * The confirm of a terminal's Enter or key, in the place of `note` (the pad's note, the card's status): its reason, then the pair, the button that sends (`label`; a click of the user's own) and Cancel.
 * Standard and Geek: Cancel takes the focus, never the one that sends, so a second Enter, or a held one, on the key that asked confirms nothing.
 * `enter` (Zen, Z-D20): the one that sends takes the focus, and Enter on it confirms, as Enter presses the primary control of every Zen card. A held key must not confirm: a keydown that repeats is ignored, and so is one that began before the bar appeared; only a fresh press confirms.
 * Space does nothing there: a character typed while the confirm appears must not send a command. Nor does any key that is typing (ZNI-F001): the boss was typing in the terminal when the bar took the focus, so the first key that is not Enter, Tab, Shift, Escape, or a modifier is kept from the button, the focus goes to Cancel, and an Enter that ends the line cancels, as it does in Standard.
 */
export function confirmBar(note: HTMLElement, why: string, label: string, yes: () => void, no: () => void, o: { enter?: boolean } = {}) {
	const y = h("button", { type: "button", class: "pad-yes" }, label), n = h("button", { type: "button", class: "pad-no" }, m.cancel());
	y.onclick = (e) => e.isTrusted && yes();
	n.onclick = no;
	note.dataset.tone = "ask";
	note.replaceChildren(h("span", { class: "pad-ask-why" }, why), h("span", { class: "pad-ask-acts" }, y, n));
	if (!o.enter) return n.focus();
	const born = globalThis.performance?.now?.() ?? 0;
	let typed = false;
	y.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" ? typed || e.repeat || e.timeStamp < born : !PASS.includes(e.key)) e.preventDefault();
		if (e.key !== "Enter" && !PASS.includes(e.key)) (typed = true, n.focus());
	});
	y.addEventListener("keyup", (e: KeyboardEvent) => e.key === " " && e.preventDefault()); // Firefox clicks on Space's release
	y.focus();
}
