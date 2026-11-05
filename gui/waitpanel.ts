import { type Alert, unitOf } from "./alerts.ts";
import type { SessionPost } from "./answer.ts";
import { joined, type WaitActions, waitActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { aim, text } from "./render.ts";
import { guarded } from "./towermodel.ts";
import { towerWhy } from "./towerturns.ts";

// What the boss does with a wait the tower recorded on them (waits.ts): tell the tower (an answer box on the panel; the actions are asks.ts `waitActions`) or dismiss it, which has the server drop it from the tower's memory (`drop` on the
// memory route, towermemory.ts). The dialog in the dock (layer.ts) and the card in Zen (zen.ts) both draw it.

const MAX_TEXT = 16_384; // the session's input takes this many bytes (src/control.ts), as the composer counts them

export interface WaitPanelOptions {
	actions: WaitActions;
	/** What it waits for, when the panel is the one place that says so (the dialog; Zen's card has it above). */
	text?: string;
	/** The panel answers in place: Handle unfolds a box under the question, Enter or Send tells the tower, and the panel never leaves the page. */
	reply?: boolean;
	/** Zen wraps the request, so the card's outcome (the knock, the low bowl) follows the answer. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** The server took the dismissal or the answer. */
	done?(): void;
}
export function waitPanel(o: WaitPanelOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	const note = h("small", { class: "tnote-fail", role: "alert" }), dismiss = h("button", { type: "button", class: "pair-btn" }, m.wait_dismiss());
	let busy = false, live = true, open = false;
	// The answer box is Zen's input (the head strip's classes, zen.css): a hairline that turns vermilion on focus, Enter sends, and the note under it is the refusal.
	const go = o.reply ? h("button", { type: "button", class: "pair-btn" }, m.tower_answer()) : undefined, send = o.reply ? h("button", { type: "button", class: "pair-btn" }, m.send()) : undefined;
	const box = o.reply ? (h("textarea", { class: "zen-head-box", rows: "1", maxlength: String(MAX_TEXT), "aria-label": m.zen_wait_placeholder(), placeholder: m.zen_wait_placeholder(), enterkeyhint: "send" }) as HTMLTextAreaElement) : undefined;
	const why = h("p", { class: "zen-head-note", role: "alert" }), form = box && h("form", { class: "zen-head-form" }, box, why);
	const say = (text: string) => ((why.textContent = text), (why.dataset.tone = text ? "error" : ""));
	const draw = () => {
		dismiss.disabled = !live || busy;
		if (!go || !send || !box || !form) return;
		[go.hidden, send.hidden, form.hidden] = [open, !open, !open];
		[box.disabled, send.disabled] = [!live || busy, !live || busy];
		if (!live && open) say(m.link_offline());
		else if (why.textContent === m.link_offline()) say("");
	};
	dismiss.onclick = () => {
		busy = true;
		draw();
		void guarded(dismiss, (t) => (note.textContent = t ?? ""), async () => {
			const r = await wrap(o.actions.dismiss());
			if (r.ok) o.done?.();
			return r;
		}, 0).finally(() => ((busy = false), draw()));
	};
	async function answer() {
		const text = box!.value;
		if (!text.trim() || busy || !live) return;
		if (new TextEncoder().encode(text).length > MAX_TEXT) return say(m.too_long());
		[busy, open] = [true, true];
		say("");
		draw();
		let taken = false;
		try {
			const r = await wrap(o.actions.tell(text));
			if (!(taken = r.ok)) say(m.zen_wait_refused({ reason: joined(towerWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status)) }));
			else o.done?.();
		} catch {
			say(m.zen_head_unreachable());
		}
		busy = false;
		draw();
		if (!taken) box!.focus();
	}
	if (go && send && box && form) {
		go.onclick = () => ((open = true), draw(), box.focus());
		send.onclick = () => void answer();
		box.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
			e.preventDefault();
			void answer();
		});
		box.addEventListener("input", () => say(""));
		form.addEventListener("submit", (e) => (e.preventDefault(), void answer()));
	}
	draw();
	return {
		el: h("div", { class: "wait-panel" }, o.text && h("p", { class: "wait-text" }, o.text), form, go, send, dismiss, note),
		dismiss,
		sending: () => busy,
		/** The answer box is unfolded. */
		isOpen: () => open,
		/** Folds the box, the draft kept; Handle takes the focus back when asked (Esc). */
		fold(focus = false) {
			if (!open) return false;
			open = false;
			draw();
			if (focus) go?.focus();
			return true;
		},
		/** Dismiss and the answer work only while the stream is live. */
		update(on: boolean) {
			live = on;
			draw();
		},
	};
}

const panels = new WeakMap<HTMLElement, ReturnType<typeof waitPanel>>();
/** A wait's dialog in the dock: what it waits for in the answer slot, the link to the comms as the act with Later and Dismiss after it in the footer's row, and none of the tower's old transmission; a wait that is over says so. */
export function waitDialog(el: HTMLElement, a: Alert, close: () => void, send: SessionPost) {
	const over = Boolean(a.gone), go = el.querySelector<HTMLElement>(".go")!;
	el.querySelector<HTMLElement>(".intel")!.hidden = true;
	go.textContent = m.tower_answer();
	aim(go, over ? undefined : { view: "session", ws: a.ws, key: unitOf(a) });
	text(el, ".tag", m.tag_question()); // the stack tags a gone unit GONE; the tower did not leave, the wait ended
	text(el, ".state", over ? m.tower_wait_over() : m.memory_wait_boss());
	let panel = panels.get(el);
	if (!panel) panels.set(el, (panel = waitPanel({ actions: waitActions({ ws: a.ws, id: a.wait!.id, tower: unitOf(a) }, send), text: a.wait!.text, done: close })));
	if (!el.querySelector(".wait-panel")) el.querySelector(".ask-root")!.replaceChildren(panel.el);
	panel.el.hidden = over;
	// Handle, Later and Dismiss in one row of the dialog's footer, the quiet one last.
	el.querySelector("footer")!.insertBefore(panel.dismiss, el.querySelector(".queued"));
	panel.dismiss.hidden = over;
	panel.update(!over && document.body.dataset.stale !== "true");
}
