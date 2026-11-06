import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";

/**
 * The confirm of a terminal's Enter or key, in the place of `note` (the pad's note, the card's status): its reason, then the pair, the button that sends (`label`; a click of the user's own) and Cancel.
 * Standard and Geek: Cancel takes the focus, never the one that sends, so a second Enter, or a held one, on the key that asked confirms nothing.
 * `enter` (Zen, Z-D20): the one that sends takes the focus, and Enter on it confirms, as Enter presses the primary control of every Zen card. A held key must not confirm: a keydown that repeats is ignored, and so is one that began before the bar appeared; only a fresh press confirms.
 * Space does nothing there: a character typed while the confirm appears must not send a command.
 */
export function confirmBar(note: HTMLElement, why: string, label: string, yes: () => void, no: () => void, o: { enter?: boolean } = {}) {
	const y = h("button", { type: "button", class: "pad-yes" }, label), n = h("button", { type: "button", class: "pad-no" }, m.cancel());
	y.onclick = (e) => e.isTrusted && yes();
	n.onclick = no;
	note.dataset.tone = "ask";
	note.replaceChildren(h("span", { class: "pad-ask-why" }, why), h("span", { class: "pad-ask-acts" }, y, n));
	if (!o.enter) return n.focus();
	const born = globalThis.performance?.now?.() ?? 0;
	y.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === " ") e.preventDefault();
		else if (e.key === "Enter" && (e.repeat || e.timeStamp < born)) e.preventDefault();
	});
	y.addEventListener("keyup", (e: KeyboardEvent) => e.key === " " && e.preventDefault()); // Firefox clicks on Space's release
	y.focus();
}
