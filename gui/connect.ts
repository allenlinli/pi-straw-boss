import { m } from "./paraglide/messages.js";
import type { Status } from "./stream.ts";

// The overlay for a page that has no live state: before the stream's first snapshot, and while it reconnects. It is a modal <dialog> over the whole page, so the browser
// itself keeps the rest of the document (the drawer, the minimap, a dialog or lightbox opened earlier) out of reach, and the app root (.shell, #dock) is inert as well; the keys
// and taps that still reach the window are stopped before any handler of the page sees them. index.html ships the overlay open and the root inert, so nothing can be tapped
// before this script runs. `live` takes it away at once; a stream that gave up shows its error with a Try again, and an address the server refuses shows why.

export type Kind = "connecting" | "reconnecting" | "offline" | "replaced";
/** What the overlay is for: the stream's state, or nothing while the stream is live. */
export const connectOf = (status: Status): Kind | undefined => (status.state === "live" ? undefined : status.state);

const SAY: Record<Kind, (status: Status) => string> = {
	connecting: m.connect_connecting,
	reconnecting: m.connect_reconnecting,
	offline: (status) => m.banner_offline({ tries: status.attempt - 1 }),
	replaced: m.banner_replaced,
};
/** Everything that acts on the page, so a click or key is stopped before a handler of the page has it; the overlay's own button is the one exception. */
const BLOCKED = ["click", "dblclick", "auxclick", "contextmenu", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "keydown", "keyup", "keypress", "submit", "dragstart"];

const ACTIVATING = new Set(["click", "dblclick", "auxclick", "contextmenu", "submit"]);

export interface Parts {
	win: Pick<Window, "addEventListener">;
	dialog: HTMLDialogElement;
	text: HTMLElement;
	retry: HTMLButtonElement;
	/** The app root: what the overlay covers. */
	guarded: HTMLElement[];
}
const byId = (id: string) => document.getElementById(id)!;
const pageParts = (): Parts => ({ win: window, dialog: byId("connect") as HTMLDialogElement, text: byId("connect-text"), retry: byId("connect-retry") as HTMLButtonElement, guarded: [document.querySelector<HTMLElement>(".shell")!, byId("dock"), byId("zen")] });

/** Mounts the overlay on the page's markup and returns what each stream status is told to. `retry` asks the stream for another attempt. */
export function mountConnect(retry: () => void, parts: Parts = pageParts()) {
	const { win, dialog, text, guarded } = parts;
	let kind: Kind | undefined, modal = false, closing = false;
	const close = () => {
		closing = true; // a close of its own is no Escape to put back
		dialog.close();
		closing = false;
	};
	const show = () => {
		if (!modal) {
			if (dialog.open) close(); // the markup's own, which is open but not yet modal
			dialog.showModal();
			modal = true;
		}
		for (const root of guarded) root.inert = true; // after showModal, which notes the focus it has to give back
	};
	const hide = () => {
		for (const root of guarded) root.inert = false;
		if (dialog.open) close();
		modal = false;
	};
	// Escape asks the browser to close it; the first is refused, and a second that gets through (Chrome allows it) is put back.
	dialog.addEventListener("cancel", (event) => event.preventDefault());
	dialog.addEventListener("close", () => {
		if (closing || dialog.open) return;
		modal = false;
		if (kind) show();
	});
	for (const type of BLOCKED) {
		win.addEventListener(type, (event) => {
			// A sheet or dialog opened while the overlay is up sits above it as the top modal (only it takes hits), so it stays usable.
			if (!kind || dialog.contains(event.target as Node | null) || (event.target as Element | null)?.closest?.("dialog:modal")) return;
			event.stopPropagation();
			if (ACTIVATING.has(type)) event.preventDefault(); // a clicked link would still navigate; keys keep their default, so Tab moves inside the overlay, and touches are passive
		}, true);
		dialog.addEventListener(type, (event) => event.stopPropagation()); // what happens in the overlay stays there; its button has already run
	}
	parts.retry.addEventListener("click", retry);
	return (status: Status) => {
		kind = connectOf(status);
		if (!kind) return hide();
		dialog.dataset.state = kind;
		text.textContent = SAY[kind](status);
		parts.retry.hidden = kind !== "offline";
		show();
	};
}
