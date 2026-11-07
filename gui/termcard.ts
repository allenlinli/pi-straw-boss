import { ENDING } from "../src/ending.ts";
import { type CardFacts, type CardState, type Kind, NO_MASK, cardState, maskStep, maskToggle, secretPrompt, stepRule, tail } from "./cardmodel.ts";
import { confirmBar } from "./confirmbar.ts";
import { h } from "./dom.ts";
import { keepFocus } from "./focusback.ts";
import { keywriter, type Write } from "./keywriter.ts";
import type { Conn, Post, TermState } from "./mirrorconn.ts";
import { m } from "./paraglide/messages.js";

// The terminal card (docs/specs/2026-11-02-terminal-card.md): the small card an accepted answer leaves for its terminal step, shared by Standard, Geek, and Zen (each skins it in CSS). It holds the command the
// answer put there, for a pane the last rows of its screen, one line with a mask, and one button (執行 for a prompt, Send Enter for a pane). It sends what the key pad sends, through the same writes (keywriter.ts)
// and under the same server checks, and asks cardmodel.ts for everything it decides: its state, the mask, and when its step is over. A prompt's card is over when its own Enter is taken, a pane's when the pane is gone.

/** `key`: a session's, or `grant:<id>` for a pane an answer opened; `name`: the unit that asked. */
export interface Step { kind: Kind; key: string; name: string; command?: string; /** A prompt step's one-tap grant: the answer id its first Enter names (once; a refusal leaves the usual confirm). */ run?: string }
export interface CardDeps {
	step: Step;
	/** The page's connection to the step's terminal without a screen (mirror.ts `watch`); `taken`: an Enter a pad on the same key got taken; `retry`: attach again after a refusal or a failure. */
	watch(w: { rows(rows: string[]): void; state(s: TermState, c: Conn): void; end(): void; taken(): void }): { conn: Conn; stop(): void; retry(): void };
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
	/** Zen's card (Z-D20): Enter acts on the primary control. The focus goes to Run, and to the confirm's yes (never held or repeated Enter: confirmbar.ts), not to Cancel. */
	enter?: boolean;
	/** The unit is a remote base's and its box takes no input now (unreachable, ended, or no `input`): the card is off and says why, like the key pad. Read at every draw. */
	away?(): boolean;
}
const OK: CardState[] = ["live", "secret", "running", "refused"], WORDS: Partial<Record<CardState, () => string>> = { connecting: m.connecting, secret: m.card_secret, sending: m.card_sending, stale: m.card_stale, paused: m.paused_hidden, hidden: m.mirror_hidden };
let ids = 0;

export function termCard({ step, watch, post, stream, held, over: owner, escape = true, close = true, enter = false, away }: CardDeps) {
	const pane = step.kind === "pane", id = `tcard-${++ids}`, fine = () => Boolean(globalThis.matchMedia?.("(pointer: fine)").matches);
	let stopped = false, tries = 0, nextAt = 0, retrying: ReturnType<typeof setTimeout> | undefined, focused = false;
	// A card that is gone says nothing more: a late reply to what it sent must not close the card or layer that took its place.
	const over: CardDeps["over"] = (why) => stopped || owner(why);
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
		taken: (w) => ("text" in w ? (kept = "") : isEnter(w) && onTaken()), // text that landed is in the pane's line: a refused Enter must not put it back
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
		[sent, after] = [true, tail(conn.rows)];
		if (stepRule(step.kind, { type: "taken" }) === "close") return (draw(), over("taken")); // drawn before the owner hears of it: Zen's layer keeps the card after its step, and it says what was sent, not that the command waits (ZNR-F003)
		mask = input.value ? { on: mask.on, hand: false } : NO_MASK; // a hand mask is for the prompt it answered; characters typed meanwhile stay hidden
		draw();
	}
	const busy = () => writer.busy() || writer.queued() > 0;
	const state = () => cardState({ kind: step.kind, phase: retrying ? "connecting" : conn.phase, stale: conn.stale(), rows: conn.rows, held: held(), ended, sending: busy(), refused: Boolean(refusal), confirm: confirm?.token, after } satisfies CardFacts);
	/** The server's confirm in the page's words by its token (Enter's only), and the server's own for a token it does not know. */
	const sentence = ({ token, said }: { token: string; said: string }) => (token === "command" ? m.card_confirm_command({ name }) : token === "unread" ? m.card_confirm_unread({ name }) : ENDING.test(`/${token}`) ? m.card_confirm_ending({ command: token }) : said);
	const ask = () => confirmBar(status, sentence(confirm!), m.card_confirm_yes(), () => (writer.confirm("enter", confirm!.token), (confirm = undefined), draw()), () => ((confirm = undefined), draw(), focus()), { enter });
	function draw() {
		if (!link && !held()) attach();
		if (away?.()) confirm = undefined; // a confirm bar would post its Enter: it goes with the box
		const s = state(), secret = pane && conn.phase === "live" && secretPrompt(conn.rows);
		const next = pane ? maskStep(mask, { secret, empty: input.value === "" }) : mask;
		if (conn.phase === "live") [tries, nextAt] = [0, 0];
		const at = document.activeElement; // the boss typing in another field keeps the focus: the status line says it
		if (next.on && !mask.on && !next.hand && fine() && (!at || at === document.body || el.contains(at))) input.focus();
		mask = next;
		title.textContent = m.terminal_title({ name });
		wait.textContent = sent ? "" : m.card_waits({ name });
		wait.hidden = sent;
		tailEl.textContent = s === "connecting" ? "" : tail(conn.rows, step.command).join("\n");
		input.type = mask.on ? "password" : "text";
		maskBtn.setAttribute("aria-pressed", String(mask.on));
		go.textContent = s === "sending" ? m.card_sending() : pane ? m.send_enter() : m.card_run();
		const gone = away?.() === true;
		const switches = () => {
			go.disabled = !OK.includes(s) || s === "confirm" || gone;
			input.disabled = maskBtn.disabled = gone;
		};
		if (away) keepFocus(el, switches); // a remote base's card gives the focus back when its box returns; a local one is as it was
		else switches();
		if (enter && !pane && !go.disabled && !focused && fine()) {
			focused = true; // the card's primary control takes the focus once, when it can act (Zen's Enter presses it)
			if (!at || at === document.body || el.contains(at)) go.focus();
		}
		el.dataset.state = s;
		el.classList.toggle("stale", s === "stale");
		const words = gone ? m.box_keys_blocked() : s === "held" ? held() : s === "refused" ? refusal || conn.why : s === "ended" ? conn.why : (WORDS[s]?.() ?? (sent ? m.card_sent() : ""));
		const key = s === "confirm" ? `ask:${confirm?.token}` : `${s}:${words}`;
		if (key !== shown) ((shown = key), s === "confirm" && !gone ? ask() : (status.replaceChildren(words ?? ""), (status.dataset.tone = s === "refused" ? "error" : "")));
	}
	/** A refused attach is tried again from the button, at most once a second and doubling to 8 s while it keeps failing; the card says it is connecting meanwhile. */
	function reattach() {
		[refusal, confirm] = ["", undefined];
		const again = () => {
			retrying = undefined;
			nextAt = Date.now() + Math.min(1000 * 2 ** tries++, 8000);
			if (link) link.retry();
			else attach();
			draw();
		}, wait = nextAt - Date.now();
		if (wait > 0) retrying = setTimeout(again, wait);
		else again();
		draw();
	}
	function press() {
		if (away?.() || !OK.includes(state()) || busy()) return;
		if (conn.phase === "refused") return reattach();
		[refusal, confirm, sent] = ["", undefined, false];
		if (!pane) (writer.push({ key: "enter", ...(step.run ? { run: step.run } : {}) }), (step.run = undefined));
		else (([kept] = [mask.on ? "" : input.value]), writer.text(input.value), (input.value = ""), writer.push({ key: "enter" }));
		draw();
	}
	go.onclick = (e) => e.isTrusted && press();
	go.addEventListener("keydown", (e) => e.key === "Enter" && e.repeat && e.preventDefault()); // a held Enter from the answer must not run the command
	input.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && (e.preventDefault(), e.isTrusted && !e.repeat && press()));
	maskBtn.onclick = (e) => e.isTrusted && ((mask = maskToggle(mask)), draw());
	x.onclick = () => over("closed");
	full.onclick = () => over("full");
	el.addEventListener("keydown", (e) => escape && e.key === "Escape" && !e.isComposing && (e.preventDefault(), over("closed")));
	function focus() {
		const target = confirm ? status.querySelector<HTMLElement>(enter ? ".pad-yes" : ".pad-no") : !fine() ? title : pane ? input : enter && !go.disabled ? go : el;
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
		stop() {
			stopped = true;
			clearTimeout(retrying);
			link?.stop();
		},
		state,
	};
}
