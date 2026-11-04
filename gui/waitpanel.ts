import { type Alert, unitOf } from "./alerts.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { type Answer, post } from "./post.ts";
import { aim, text } from "./render.ts";
import { guarded } from "./towermodel.ts";

// What the boss does with a wait the tower recorded on them (waits.ts): tell the tower (its comms, where the composer is) or dismiss it, which has the server drop it from the tower's memory (`drop` on the memory route,
// towermemory.ts). The dialog in the dock (layer.ts) and the card in Zen (zen.ts) both draw it.

export interface WaitPanelOptions {
	ws: string;
	id: string;
	/** What it waits for, when the panel is the one place that says so (the dialog; Zen's card has it above). */
	text?: string;
	/** Zen has no link to the comms: it gets a button that goes there. */
	reach?(): void;
	/** Zen wraps the request, so the card's outcome (the knock, the low bowl) follows the answer. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** The server took the dismissal. */
	done?(): void;
}
export function waitPanel(o: WaitPanelOptions) {
	const note = h("small", { class: "tnote-fail", role: "alert" }), dismiss = h("button", { type: "button", class: "pair-btn" }, m.wait_dismiss());
	const reach = o.reach && Object.assign(h("button", { type: "button", class: "pair-btn" }, m.tower_answer()), { onclick: o.reach });
	let busy = false;
	dismiss.onclick = () => {
		busy = true;
		void guarded(dismiss, (t) => (note.textContent = t ?? ""), async () => {
			// The memory route answers the memory, not an `outcome`: a taken dismissal is an accepted answer to Zen's card.
			const r = await (o.send ?? ((reply) => reply))(post(`tower/${encodeURIComponent(o.ws)}/memory`, { op: "drop", id: o.id }).then((a) => (a.ok ? { ...a, body: { ...a.body, outcome: "accepted" } } : a)));
			if (r.ok) o.done?.();
			return r;
		}, 0).finally(() => (busy = false));
	};
	return { el: h("div", { class: "wait-panel" }, o.text && h("p", { class: "wait-text" }, o.text), reach, dismiss, note), dismiss, sending: () => busy, /** Dismiss answers only while the stream is live. */ update: (live: boolean) => void (dismiss.disabled = !live || busy) };
}

const panels = new WeakMap<HTMLElement, ReturnType<typeof waitPanel>>();
/** A wait's dialog in the dock: what it waits for in the answer slot, the link to the comms as the act with Later and Dismiss after it in the footer's row, and none of the tower's old transmission; a wait that is over says so. */
export function waitDialog(el: HTMLElement, a: Alert, close: () => void) {
	const over = Boolean(a.gone), go = el.querySelector<HTMLElement>(".go")!;
	el.querySelector<HTMLElement>(".intel")!.hidden = true;
	go.textContent = m.tower_answer();
	aim(go, over ? undefined : { view: "session", ws: a.ws, key: unitOf(a) });
	text(el, ".tag", m.tag_question()); // the stack tags a gone unit GONE; the tower did not leave, the wait ended
	text(el, ".state", over ? m.tower_wait_over() : m.memory_wait_boss());
	let panel = panels.get(el);
	if (!panel) panels.set(el, (panel = waitPanel({ ws: a.ws, id: a.wait!.id, text: a.wait!.text, done: close })));
	if (!el.querySelector(".wait-panel")) el.querySelector(".ask-root")!.replaceChildren(panel.el);
	panel.el.hidden = over;
	// Handle, Later and Dismiss in one row of the dialog's footer, the quiet one last.
	el.querySelector("footer")!.insertBefore(panel.dismiss, el.querySelector(".queued"));
	panel.dismiss.hidden = over;
	panel.update(!over && document.body.dataset.stale !== "true");
}
