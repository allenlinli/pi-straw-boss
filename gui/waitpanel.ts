import { type Alert, unitOf } from "./alerts.ts";
import type { SessionPost } from "./answer.ts";
import { joined, outcome, type WaitActions, waitActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { aim, text, waitTitle } from "./render.ts";
import { formatRoute } from "./router.ts";
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
	/** Offers the tower's comms as a link, beside the other buttons: the one action that navigates (the dialog has its own in its footer). */
	goto?: boolean;
	/** The server took the dismissal or the answer; `said` is what happened in words, for a host that shows it beside the panel. */
	done?(said: string): void;
	/** Says what happened (the towers' notes): a dismissal folds the panel until the next snapshot drops the row, and a stale stream says why the buttons are off. The dialog closes on `done` and Zen's card has its own outcome, so neither sets it. */
	report?: boolean;
}
export function waitPanel(o: WaitPanelOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	const note = h("small", { class: "tnote-fail", role: "alert" }), stale = o.report ? h("small", { class: "tnote-fail", role: "status" }) : undefined, dismiss = h("button", { type: "button", class: "pair-btn" }, m.wait_dismiss());
	let busy = false, live = true, open = false;
	// The answer box: in Zen it takes the head strip's look (`zen-head-*` in zen.css: a hairline that turns vermilion on focus), in Standard and Geek the composer's (`wait-*` in style.css). Enter sends, and the note under it is the refusal.
	const go = o.reply ? h("button", { type: "button", class: "pair-btn wait-go" }, m.tower_answer()) : undefined, send = o.reply ? h("button", { type: "button", class: "pair-btn wait-go" }, m.send()) : undefined; // the dialog makes these its act (style.css)
	const box = o.reply ? (h("textarea", { class: "wait-box zen-head-box", rows: "1", maxlength: String(MAX_TEXT), "aria-label": m.zen_wait_placeholder(), placeholder: m.zen_wait_placeholder(), enterkeyhint: "send" }) as HTMLTextAreaElement) : undefined;
	const why = h("p", { class: "wait-note zen-head-note", role: "alert" }), form = box && h("form", { class: "wait-form zen-head-form" }, box, why);
	const say = (text: string) => ((why.textContent = text), (why.dataset.tone = text ? "error" : ""));
	const link = o.goto ? h("a", { class: "pair-btn", href: formatRoute(o.actions.goto) || "./", "data-route": formatRoute(o.actions.goto) }, m.wait_goto()) : undefined;
	const panel = h("div", { class: "wait-panel" }, o.text && h("p", { class: "wait-text" }, o.text), form, go, send, dismiss, link, note, stale);
	// A dismissal that went through folds the whole panel away (a reporting panel), until the next snapshot drops the row; the host says it in words (`done`). An answer keeps Handle: the wait stays on the card, marked answered.
	let gone = false;
	const fold = () => {
		gone = true;
		panel.dataset.gone = "";
		for (const el of [dismiss, go, send, form, link]) if (el) el.hidden = true;
	};
	const draw = () => {
		if (gone) return;
		dismiss.disabled = !live || busy;
		if (stale) stale.textContent = live ? "" : m.wait_stream_stale(); // a disabled button says why; a status, not an alert: the page banner already says offline, and every card would announce it
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
			if (outcome(r) === "accepted") {
				if (o.report) fold();
				o.done?.(m.wait_dismissed());
			}
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
			if (!(taken = outcome(r) === "accepted")) say(m.zen_wait_refused({ reason: joined(towerWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status)) }));
			else {
				[box!.value, open] = ["", false]; // the tower has the words: the box folds and empties, so a second Enter cannot send them again
				draw();
				o.done?.(m.wait_sent());
			}
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
		el: panel,
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
/** A wait's dialog in the dock: what it waits for and the answer box in the answer slot, the link to the comms, Later and Dismiss in the footer's row, and none of the tower's old transmission; a wait that is over says so. */
export function waitDialog(el: HTMLElement, a: Alert, place: string, close: () => void, send: SessionPost) {
	const over = Boolean(a.gone), go = el.querySelector<HTMLElement>(".go")!;
	el.dataset.wait = ""; // the footer's link is the secondary act here (style.css): the panel's Handle and Send answer
	el.querySelector<HTMLElement>(".intel")!.hidden = true;
	text(el, "h3", waitTitle(a.role, place)); // the title says the role and the place once, so the header's place and the role under the title would repeat it
	for (const dup of [".where", ".role"]) el.querySelector<HTMLElement>(dup)!.hidden = true;
	go.textContent = m.wait_goto(); // the answer box is on the panel; the footer's link is the way to the tower's comms
	aim(go, over ? undefined : { view: "session", ws: a.ws, key: unitOf(a) });
	text(el, ".tag", m.tag_question()); // the stack tags a gone unit GONE; the tower did not leave, the wait ended
	text(el, ".state", over ? m.tower_wait_over() : m.memory_wait_boss());
	let panel = panels.get(el);
	if (!panel) panels.set(el, (panel = waitPanel({ actions: waitActions({ ws: a.ws, id: a.wait!.id, tower: unitOf(a) }, send), text: a.wait!.text, reply: true, done: close })));
	if (!el.querySelector(".wait-panel")) el.querySelector(".ask-root")!.replaceChildren(panel.el);
	panel.el.hidden = over;
	// The comms link, Later and Dismiss in one row of the dialog's footer, the quiet one last.
	el.querySelector("footer")!.insertBefore(panel.dismiss, el.querySelector(".queued"));
	panel.dismiss.hidden = over;
	panel.update(!over && document.body.dataset.stale !== "true");
}
