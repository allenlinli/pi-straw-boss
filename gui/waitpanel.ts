import { joined, outcome, type WaitActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import type { Answer } from "./post.ts";
import { towerWhy } from "./towerturns.ts";

// The card's answer box (docs/specs/2026-11-07-wait-cards.md, The card in the GUI; docs/specs/2026-11-10-wait-cards-tui.md, section 4): Reply to the tower is a row of the card's question panel, and when it is picked the box under it takes the words. Send (the card's
// own) hands them to `send()` here, which posts them to the tower's session `input` with `answers: W9` (asks.ts `waitActions`) and says whether the server took them. The card (waitcard.ts) owns the rows, Send, and the status line.

const MAX_TEXT = 16_384; // the session's input takes this many bytes (src/control.ts), as the composer counts them

export interface ReplyOptions {
	actions: Pick<WaitActions, "tell">;
	/** Zen wraps the request, so the card's outcome (the knock, the low bowl) follows the answer. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** The wait is the head tower's: the box says so. */
	head?: boolean;
}
export function replyBox(o: ReplyOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	let busy = false;
	const words = o.head ? m.zen_wait_placeholder_head() : m.zen_wait_placeholder();
	// The box wears the question panel's own-words look (`.ask-own`, every view's); `wait-box` names it for the card's rules.
	const box = h("textarea", { class: "ask-own wait-box", rows: "1", maxlength: String(MAX_TEXT), "aria-label": words, placeholder: words, enterkeyhint: "send" }) as HTMLTextAreaElement;
	return {
		box,
		/** There are words to send. */
		ready: () => box.value.trim() !== "",
		sending: () => busy,
		/** Sends what is typed: `taken` once the tower has the words (the box empties, so a second Send cannot repeat them), else `why` in the page's language. */
		async send(): Promise<{ taken: boolean; why?: string }> {
			const text = box.value;
			if (!text.trim() || busy) return { taken: false };
			if (new TextEncoder().encode(text).length > MAX_TEXT) return { taken: false, why: m.too_long() };
			busy = true;
			try {
				const r = await wrap(o.actions.tell(text));
				if (outcome(r) !== "accepted") return { taken: false, why: m.zen_wait_refused({ reason: joined(towerWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status)) }) };
				box.value = "";
				return { taken: true };
			} catch {
				return { taken: false, why: m.zen_head_unreachable() };
			} finally {
				busy = false;
			}
		},
	};
}
