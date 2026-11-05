import type { ConfirmView } from "../src/link/holder.ts";
import type { MemoryProposal } from "../src/net.ts";
import { confirmActions, lanActions, lanReading, outcome, proposalActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { type PairRequest } from "./pairs.ts";
import { type Answer, post } from "./post.ts";
import { actionWhy } from "./towermodel.ts";

// The answer panels of Zen's cards for what the boss decides outside a unit's dialog (docs/specs/2026-11-01-zen-view.md, Link cards): Allow or Deny a teammate's tower, Confirm or Reject a memory proposal, and the number of a pair request with
// Allow and Deny. Each button runs the shared action of asks.ts (the call Standard's row makes), and Zen's `wrap` turns the reply into the knock or the low bowl; the words of a refusal are the server's. The panels draw the choices as text, as the wait card does.

interface Choice { label: string; run(): Promise<Answer>; /** Whether the choice can be made now (the pair card needs its four digits). */ ready?(): boolean }
interface DecideOptions { lead?: HTMLElement[]; choices: Choice[]; wrap(reply: Promise<Answer>): Promise<Answer>; words(r: Answer): string }
export interface DecidePanel { el: HTMLElement; sending(): boolean; update(live: boolean): void; /** The control that should take the focus when the card does (the pair card's field); none: the card takes it, so Enter cannot allow what the boss has not read. */ enter(): boolean }

function decide(o: DecideOptions, field?: HTMLInputElement): DecidePanel {
	const note = h("p", { class: "zen-head-note", role: "alert" }), buttons = o.choices.map((c) => Object.assign(h("button", { type: "button", class: "pair-btn" }, c.label) as HTMLButtonElement, { choice: c }));
	let live = true, busy = false, done = false;
	const draw = () => buttons.forEach((b) => (b.disabled = !live || busy || done || b.choice.ready?.() === false));
	const say = (text: string, tone = "error") => ((note.textContent = text), (note.dataset.tone = text ? tone : ""));
	async function pick(c: Choice) {
		if (busy || done || !live || c.ready?.() === false) return;
		busy = true;
		say("");
		draw();
		try {
			const r = await o.wrap(c.run());
			if (outcome(r) === "accepted") (done = true), say(m.answered(), "ok"); // the server took it: the card leaves by itself, and a second press would only be a second answer
			else say(o.words(r) || m.refused({ status: r.status }));
		} catch {
			say(m.zen_head_unreachable());
		}
		busy = false;
		draw();
	}
	for (const b of buttons) b.onclick = () => void pick(b.choice);
	field?.addEventListener("input", () => (say(""), draw()));
	field?.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		const first = buttons.find((b) => b.choice.ready);
		if (first) void pick(first.choice);
	});
	draw();
	return {
		el: h("div", { class: "wait-panel zen-decide" }, ...(o.lead ?? []), h("div", { class: "zen-decide-acts" }, ...buttons), note),
		sending: () => busy,
		update: (on) => ((live = on), draw()),
		enter: () => (field && !field.disabled ? (field.focus(), true) : false),
	};
}
const reason = (r: Answer) => String(r.body.reason ?? r.body.error ?? r.status);

/** A confirm a teammate's tower asked of this computer: the tool's full arguments, and Allow or Deny (`link/confirm-answer`). */
export function confirmPanel(c: ConfirmView, wrap: DecideOptions["wrap"]): DecidePanel {
	const acts = confirmActions(c);
	return decide({ lead: [h("pre", { class: "link-args zen-args" }, c.args)], choices: [{ label: m.link_allow(), run: acts.allow }, { label: m.link_deny(), run: acts.deny }], wrap, words: reason });
}

/** A memory proposal of a tower run: Confirm (naming the rev the snapshot carried) or Reject. */
export function proposalPanel(p: { ws: string; proposal: MemoryProposal; rev: number }, wrap: DecideOptions["wrap"]): DecidePanel {
	const acts = proposalActions({ ws: p.ws, id: p.proposal.id, rev: p.rev });
	return decide({ lead: p.proposal.cites ? [h("p", { class: "zen-meta" }, m.memory_cites({ text: p.proposal.cites }))] : [], choices: [{ label: m.memory_confirm(), run: acts.confirm }, { label: m.memory_reject(), run: acts.reject }], wrap, words: (r) => m.tower_action_failed({ reason: actionWhy(r) ?? reason(r) }) });
}

/** A pair request: the number the phone shows (four digits, which the server matches), Allow, and Deny for this request. The server keeps the budget of wrong numbers. */
export function pairPanel(p: PairRequest, wrap: DecideOptions["wrap"], send: (path: string, body: Record<string, unknown>) => Promise<Answer> = post): DecidePanel {
	const acts = lanActions(send);
	const field = h("input", { type: "text", inputmode: "numeric", pattern: "[0-9]{4}", maxlength: "4", autocomplete: "off", spellcheck: "false", class: "zen-head-box zen-pair-number", "aria-label": m.lan_number_ask(), placeholder: "0000" }) as HTMLInputElement;
	field.addEventListener("input", () => (field.value = field.value.replace(/\D/g, "").slice(0, 4)));
	const ready = () => /^\d{4}$/.test(field.value);
	return decide({ lead: [h("label", { class: "zen-pair-ask" }, m.lan_number_ask()), field], choices: [{ label: m.lan_allow(), run: () => acts.approve(field.value), ready }, { label: m.lan_deny_one(), run: () => acts.deny(p.id) }], wrap, words: (r) => { const said = lanReading(r); return [said.answer, said.verdict].filter(Boolean).join(" "); } }, field);
}
