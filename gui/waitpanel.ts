import { joined, outcome, type WaitActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { towerWhy } from "./towerturns.ts";

// The card's answer box (docs/specs/2026-11-07-wait-cards.md, The card in the GUI): Reply to the tower unfolds a box under the card, and what is typed goes to the tower's session `input` with `answers: W9` (asks.ts `waitActions`). The card
// (waitcard.ts) owns every other button of a wait; the panel is only this fold. The dock dialog and the card in Zen both mount it through the card.

const MAX_TEXT = 16_384; // the session's input takes this many bytes (src/control.ts), as the composer counts them

export interface WaitPanelOptions {
	actions: Pick<WaitActions, "tell">;
	/** Zen wraps the request, so the card's outcome (the knock, the low bowl) follows the answer. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** The server took the answer; `said` is what happened in words, for a host that shows it beside the panel. */
	done?(said: string): void;
}
export function waitPanel(o: WaitPanelOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	let busy = false, live = true, open = false, over = false; // over: the question ended (Zen's card says so itself): the buttons are off and nothing says offline
	// The answer box: in Zen it takes the head strip's look (`zen-head-*` in zen.css: a hairline that turns vermilion on focus), in Standard and Geek the composer's (`wait-*` in style.css). Enter sends, and the note under it is the refusal.
	const go = h("button", { type: "button", class: "pair-btn wait-go" }, m.wc_b_reply()), send = h("button", { type: "button", class: "pair-btn wait-go" }, m.send()); // the dialog makes these its act (style.css)
	const box = h("textarea", { class: "wait-box zen-head-box", rows: "1", maxlength: String(MAX_TEXT), "aria-label": m.zen_wait_placeholder(), placeholder: m.zen_wait_placeholder(), enterkeyhint: "send" }) as HTMLTextAreaElement;
	const why = h("p", { class: "wait-note zen-head-note", role: "alert" }), form = h("form", { class: "wait-form zen-head-form" }, box, why);
	const say = (text: string) => ((why.textContent = text), (why.dataset.tone = text ? "error" : ""));
	const panel = h("div", { class: "wait-panel" }, form, send);
	const draw = () => {
		[go.hidden, send.hidden, form.hidden] = [open, !open, !open];
		[box.disabled, send.disabled, go.disabled] = [!live || busy, !live || busy, over]; // the fold is off for a card whose question ended only: an offline page keeps it, as Standard does, and says so in the box
		if (!live && open && !over) say(m.link_offline());
		else if (why.textContent === m.link_offline()) say("");
	};
	async function answer() {
		const text = box.value;
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
				[box.value, open] = ["", false]; // the tower has the words: the box folds and empties, so a second Enter cannot send them again
				draw();
				o.done?.(m.wait_sent());
			}
		} catch {
			say(m.zen_head_unreachable());
		}
		busy = false;
		draw();
		if (!taken) box.focus();
	}
	go.onclick = () => ((open = true), draw(), box.focus());
	send.onclick = () => void answer();
	box.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		void answer();
	});
	box.addEventListener("input", () => say(""));
	form.addEventListener("submit", (e) => (e.preventDefault(), void answer()));
	draw();
	return {
		/** The box and Send; the fold button (`go`) sits among the card's buttons. */
		el: panel,
		go,
		sending: () => busy,
		/** The answer box is unfolded. */
		isOpen: () => open,
		/** Folds the box, the draft kept; the fold button takes the focus back when asked (Esc). */
		fold(focus = false) {
			if (!open) return false;
			open = false;
			draw();
			if (focus) go.focus();
			return true;
		},
		/** The answer box takes the focus when it is open, else the fold button (Z-D20); false when neither can. */
		enter() {
			const to = open && !box.disabled ? box : !go.hidden ? go : undefined;
			return Boolean(to && (to.focus(), true));
		},
		/** The answer works only while the stream is live; `ended`: it is off because the question ended, not because the page is offline (Zen's card). */
		update(on: boolean, ended = false) {
			[live, over] = [on, ended];
			draw();
		},
	};
}
