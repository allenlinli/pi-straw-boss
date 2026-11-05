import type { Pending } from "../src/ask.ts";
import type { LinkAlert } from "../src/link/holder.ts";
import { forwardedAnswer } from "./asks.ts";
import { mountAsk } from "./ask.ts";
import { h } from "./dom.ts";
import { dialogStateLine, remoteDialog } from "./linkdialogmodel.ts";
import { alertLine, dialogState } from "./linkmodel.ts";
import { m } from "./paraglide/messages.js";

// The cards of the dialogs an unattended device forwarded (spec, Unattended devices: Asking back), in the Link notices. Loaded when the first one shows, with the
// shared question panel (ask.ts): select, confirm, and several questions are answered as anywhere else, and the answer goes to `link/dialog-answer`.

interface Card { row: HTMLElement; line: HTMLElement; status: HTMLElement; ask: ReturnType<typeof mountAsk>; digest: string }

/** A forwarded dialog keeps its row (and the question panel in it, with what was picked and typed) while it lives, however often the list is drawn again. */
export function mountDialogCards() {
	const cards = new Map<string, Card>();
	const make = (a: LinkAlert): Card => {
		const device = String(a.data.device), dialogId = String(a.data.dialogId), digest = String(a.data.digest);
		const row = h("li", { class: "link-alert", "data-kind": "dialog" }), line = h("b", null), root = h("div", { class: "link-dialog" }), status = h("small", { class: "link-note", role: "status" });
		const send = forwardedAnswer({ device, dialogId, digest }); // the holder checks the dialog and digest again (answerDialog); the panel only says which choice or words
		row.append(line, root, status);
		return { row, line, status, ask: mountAsk(root, send, true), digest };
	};
	return {
		/** The card of an alert, drawn for its state: the panel while the dialog asks, then the words of how it ended. */
		row(a: LinkAlert): HTMLElement {
			let c = cards.get(a.id);
			if (c && c.digest !== String(a.data.digest)) (cards.delete(a.id), (c = undefined)); // the same id asking something else: a fresh panel
			if (!c) cards.set(a.id, (c = make(a)));
			const state = dialogState(a), pending: Pending | undefined = remoteDialog(a), open = state === "open" && pending !== undefined;
			c.row.dataset.level = a.level;
			c.row.dataset.state = state;
			c.line.textContent = alertLine(a);
			c.ask.update(open ? pending : undefined, open); // an answered or ended question leaves the panel (a panel just answered shows its outcome for a few seconds)
			c.status.textContent = state === "open" ? (pending ? "" : m.link_dialog_unreadable()) : dialogStateLine(state);
			return c.row;
		},
		/** Forgets the cards of alerts that are gone. */
		keep(ids: Set<string>) {
			for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
		},
	};
}
