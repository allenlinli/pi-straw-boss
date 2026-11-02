import { ENDING } from "../src/probe.ts";
import { type CardFacts, type CardState, type Kind, NO_MASK, cardState, maskStep, maskToggle, secretPrompt, stepRule, tail } from "./cardmodel.ts";
import { h } from "./dom.ts";
import { keywriter, type Write } from "./keywriter.ts";
import type { Conn, Post, TermState } from "./mirrorconn.ts";
import { m } from "./paraglide/messages.js";

// The terminal card (docs/specs/2026-11-02-terminal-card.md): the small card an accepted answer leaves for its terminal step, shared by Standard, Geek, and Zen (each skins it in CSS). It holds the command the
// answer put there, for a pane the last rows of its screen, one line with a mask, and one button (执行 for a prompt, Send Enter for a pane). It sends what the key pad sends, through the same writes (keywriter.ts)
// and under the same server checks, and asks cardmodel.ts for everything it decides: its state, the mask, and when its step is over. A prompt's card is over when its own Enter is taken, a pane's when the pane is gone.

/** `key`: a session's, or `grant:<id>` for a pane an answer opened; `name`: the unit that asked. */
export interface Step { kind: Kind; key: string; name: string; command?: string }
export interface CardDeps {
	step: Step;
	/** The page's connection to the step's terminal without a screen (mirror.ts `watch`); `taken`: an Enter a pad on the same key got taken. */
	watch(w: { rows(rows: string[]): void; state(s: TermState, c: Conn): void; end(): void; taken(): void }): { conn: Conn; stop(): void };
	post: Post;
	stream(): string;
	/** The sentence that stands for a tower with no run live, or none. */
	held(): string | undefined;
	/** The card is over: its step is done (`taken`), its pane is `gone`, the boss `closed` it, or asked for the `full` terminal. The owner takes it away. */
	over(why: "taken" | "gone" | "closed" | "full"): void;
	/** Esc inside the card closes it (Standard); Zen's layer owns Esc. */
	escape?: boolean;
	/** A × in the header (Standard); Zen's layer has its own way back. */
	close?: boolean;
}
const OK: CardState[] = ["live", "secret", "running", "refused"], WORDS: Partial<Record<CardState, () => string>> = { connecting: m.connecting, secret: m.card_secret, sending: m.card_sending, stale: m.card_stale, paused: m.paused_hidden, hidden: m.mirror_hidden };
let ids = 0;

export function termCard({ step, watch, post, stream, held, over, escape = true, close = true }: CardDeps) {
	const pane = step.kind === "pane", id = `tcard-${++ids}`, fine = () => Boolean(globalThis.matchMedia?.("(pointer: fine)").matches);
	let name = step.name, mask = NO_MASK, ended = false, refusal = "", confirm: { token: string; said: string } | undefined, sent = false, after: string[] | undefined, kept = "", shown = "";
	const title = h("h2", { id, tabindex: "-1" }), command = h("pre", { class: "tcard-cmd" }, step.command), cmdOut = h("div", { class: "tcard-cmdbox" }, command);
	const tailEl = h("pre", { class: "tcard-tail", "aria-live": "off" }), wait = h("p", { class: "tcard-wait" });
	const input = h("input", { type: "text", class: "tcard-input", id: `${id}-in`, autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "send" });
	const label = h("label", { class: "tcard-label", for: `${id}-in` }, m.card_input()), maskBtn = h("button", { type: "button", class: "tcard-mask", "aria-pressed": "false" }, m.card_mask());
	const go = h("button", { type: "button", class: "tcard-go" }), status = h("p", { class: "tcard-status pad-note", role: "status" });
	const full = h("button", { type: "button", class: "cmp-link tcard-full" }, m.card_full()), x = h("button", { type: "button", class: "x tcard-x", "aria-label": m.close() }, "×");
	const el = h("section", { class: "tcard", role: "dialog", "aria-modal": "false", "aria-labelledby": id, tabindex: "-1", "data-kind": step.kind }, h("header", { class: "tcard-head" }, title, close && x), step.command ? cmdOut : null, pane ? tailEl : wait, pane ? h("div", { class: "tcard-row" }, label, input, maskBtn, go) : h("div", { class: "tcard-row" }, go), status, full);
	const isEnter = (w: Write) => "key" in w && w.key === "enter";
	const writer = keywriter({
		post,
		stream,
		busy: () => draw(),
		taken: (w) => isEnter(w) && onTaken(),
		failed: (w, r) => {
			if (kept && !input.value) input.value = kept;
			kept = "";
			if (r && stepRule(step.kind, { type: "refused", status: r.status, error: r.body.error }) === "close") over("gone");
		},
		ask: (_, said, token) => ((confirm = { token, said }), draw()),
		error: (text) => ((refusal = text), draw()),
	});
	// The connection is made when the terminal can be had: at once, and for a tower with no run live when it has one.
	let conn: Conn = { key: step.key, post, rows: [], cols: 0, seen: 0, phase: "connecting", why: "", hidden: false, ended: false, parked: false, watchers: new Set(), state: () => "off", stale: () => false }, link: ReturnType<typeof watch> | undefined;
	function attach() {
		link = watch({ rows: () => draw(), state: () => draw(), end: () => (stepRule(step.kind, { type: "end" }) === "close" ? over("gone") : ((ended = true), draw())), taken: () => onTaken() });
		conn = link.conn;
	}
	function onTaken() {
		kept = "";
		if (stepRule(step.kind, { type: "taken" }) === "close") return over("taken");
		[sent, after, mask] = [true, tail(conn.rows), NO_MASK]; // a hand mask is for the prompt it answered
		draw();
	}
	const busy = () => writer.busy() || writer.queued() > 0;
	const state = () => cardState({ kind: step.kind, phase: conn.phase, stale: conn.stale(), rows: conn.rows, held: held(), ended, sending: busy(), refused: Boolean(refusal), confirm: confirm?.token, after } satisfies CardFacts);
	/** The server's confirm in the page's words by its token (Enter's only), and the server's own for a token it does not know. */
	const sentence = ({ token, said }: { token: string; said: string }) => (token === "command" ? m.card_confirm_command({ name }) : token === "unread" ? m.card_confirm_unread({ name }) : ENDING.test(`/${token}`) ? m.card_confirm_ending({ command: token }) : said);
	function ask() {
		const yes = h("button", { type: "button", class: "pad-yes" }, m.card_confirm_yes()), not = h("button", { type: "button", class: "pad-no" }, m.cancel()), token = confirm!.token;
		yes.onclick = (e) => e.isTrusted && ((confirm = undefined), writer.confirm("enter", token), draw());
		not.onclick = () => ((confirm = undefined), draw(), focus());
		status.dataset.tone = "ask"; // the pad's note and its confirm pair
		status.replaceChildren(h("span", { class: "pad-ask-why" }, sentence(confirm!)), h("span", { class: "pad-ask-acts" }, yes, not));
		not.focus(); // never the confirm: a second Enter, or a held one, on the key that asked must not confirm it
	}
	function draw() {
		if (!link && !held()) attach();
		const s = state(), secret = pane && conn.phase === "live" && secretPrompt(conn.rows);
		const next = pane ? maskStep(mask, { secret, empty: input.value === "" }) : mask;
		if (next.on && !mask.on && !next.hand && fine()) input.focus();
		mask = next;
		title.textContent = m.terminal_title({ name });
		wait.textContent = m.card_waits({ name });
		tailEl.textContent = s === "connecting" ? "" : tail(conn.rows).join("\n");
		input.type = mask.on ? "password" : "text";
		maskBtn.setAttribute("aria-pressed", String(mask.on));
		go.textContent = s === "sending" ? m.card_sending() : pane ? m.send_enter() : m.card_run();
		go.disabled = !OK.includes(s) || s === "confirm";
		el.dataset.state = s;
		el.classList.toggle("stale", s === "stale");
		const words = s === "held" ? held() : s === "refused" ? refusal || conn.why : s === "ended" ? conn.why : (WORDS[s]?.() ?? (sent ? m.card_sent() : ""));
		const key = s === "confirm" ? `ask:${confirm?.token}` : `${s}:${words}`;
		if (key !== shown) ((shown = key), s === "confirm" ? ask() : (status.replaceChildren(words ?? ""), (status.dataset.tone = s === "refused" ? "error" : "")));
	}
	function press() {
		if (!OK.includes(state()) || busy()) return;
		[refusal, confirm, sent] = ["", undefined, false];
		if (!pane) writer.push({ key: "enter" });
		else (([kept] = [mask.on ? "" : input.value]), writer.text(input.value), (input.value = ""), writer.push({ key: "enter" }));
		draw();
	}
	go.onclick = (e) => e.isTrusted && press();
	go.addEventListener("keydown", (e) => e.key === "Enter" && e.repeat && e.preventDefault()); // a held Enter from the answer must not run the command
	input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), e.isTrusted && !e.repeat && !e.isComposing && press()));
	maskBtn.onclick = (e) => e.isTrusted && ((mask = maskToggle(mask)), draw());
	x.onclick = () => over("closed");
	full.onclick = () => over("full");
	el.addEventListener("keydown", (e) => escape && e.key === "Escape" && !e.isComposing && (e.preventDefault(), over("closed")));
	function focus() {
		const target = confirm ? status.querySelector<HTMLElement>(".pad-no") : !fine() ? title : pane ? input : el;
		target?.focus({ preventScroll: true });
	}
	draw();
	return {
		el,
		/** The unit's name changed, or a snapshot came (a tower's held sentence). */
		update(next?: string) {
			if (next) name = next;
			draw();
		},
		focus,
		stop: () => link?.stop(),
		state,
	};
}
