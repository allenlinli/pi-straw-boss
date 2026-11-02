import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";

/** The confirm of a terminal's Enter or key, in the place of `note` (the pad's note, the card's status): its reason, then the pair, the button that sends (`label`; a click of the user's own) and Cancel, which takes the focus, never the one that sends: a second Enter, or a held one, on the key that asked must not confirm it. */
export function confirmBar(note: HTMLElement, why: string, label: string, yes: () => void, no: () => void) {
	const y = h("button", { type: "button", class: "pad-yes" }, label), n = h("button", { type: "button", class: "pad-no" }, m.cancel());
	y.onclick = (e) => e.isTrusted && yes();
	n.onclick = no;
	note.dataset.tone = "ask";
	note.replaceChildren(h("span", { class: "pad-ask-why" }, why), h("span", { class: "pad-ask-acts" }, y, n));
	n.focus();
}
