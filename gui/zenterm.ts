import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { locate } from "./scene.ts";
import { ESC_MS, termStep } from "./zenkeys.ts";
import type { Term } from "./zentypes.ts";

// The terminal an answer (or a blocked prompt's button) opens, inside Zen (docs/specs/2026-11-01-zen-view.md, A terminal in Zen): one full-screen layer over the screen that was there, holding the page's own terminal
// (mirror.ts `embed`: the mirror, the key pad, the keyboard sink; this file only gives it ink and a host). It ends by the button, by Esc Esc with the focus outside the terminal, or by itself: a pane's mirror ended (the pane
// closed or its grant ended), or the session started working after it idled (the command waiting in its prompt was submitted). Zen's own screen is never redrawn for it, so coming back shows what it showed.

export interface ZenTermDeps {
	/** The page's terminal embedded in `host` (the Terminals `embed`, behind the overlay chunk); the promise gives what takes it away. */
	embed(key: string, name: string, host: HTMLElement, o: { keys: boolean; end?: () => void }): Promise<() => void>;
	now(): number;
	later(fn: () => void, ms: number): () => void;
	/** What lies under the layer takes no focus and no tab while it is on. */
	inert(on: boolean): void;
	/** The layer went away by the button, Esc Esc, or its own end: Zen has the page again. */
	closed(): void;
}
interface Open { key: string; armed: boolean; layer: HTMLElement; host: HTMLElement; hint: HTMLElement; off?: () => void }
const isPane = (key: string) => key.startsWith("grant:");

export function mountZenTerm(root: HTMLElement, deps: ZenTermDeps) {
	let cur: Open | undefined, turn = 0, escAt: number | undefined, stopEsc = () => {};
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), cur && (delete cur.hint.dataset.on, (cur.hint.textContent = "")));
	/** The layer goes and its terminal is let go; whether Zen is told is the caller's. */
	function drop() {
		if (!cur) return false;
		const c = cur;
		[cur, turn] = [undefined, turn + 1];
		clearEsc();
		c.off?.();
		if (c.layer.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); // the button that was pressed goes with the layer: the focus is free for the card
		c.layer.remove();
		return true;
	}
	function close() {
		if (!drop()) return;
		deps.inert(false);
		deps.closed();
	}
	/** The unit the session's terminal is for has idled (its command waits in the prompt) or works again: the second after the first is the command going. */
	const watch = (net: Net | undefined) => {
		if (!cur || isPane(cur.key)) return;
		const mark = locate(net, cur.key)?.u.mark;
		if (mark === "idle" || mark === "done") cur.armed = true;
		else if (mark === "working" && cur.armed) close();
	};
	return {
		isOpen: () => cur !== undefined,
		/** Shows the terminal of `t.key` (a session's, or a pane an answer opened: `grant:<id>`), or brings the one on show forward. `armed`: the unit waits on this terminal now, so its next work ends the step. */
		open(t: Term, net: Net | undefined) {
			if (cur?.key === t.key) return;
			drop();
			const pane = isPane(t.key), name = pane ? m.pane_name() : (locate(net, t.key)?.u.name ?? t.key), mine = turn;
			const back = h("button", { type: "button", class: "zen-term-back" }, m.zen_back_title()), host = h("div", { class: "zen-term-host" }), hint = h("p", { class: "zen-term-esc", role: "status", "aria-live": "polite" });
			back.onclick = close;
			const layer = h("section", { class: "zen-term", "aria-label": m.terminal_title({ name }) }, h("header", { class: "zen-term-bar" }, h("h2", { class: "zen-who" }, name), back), host, hint);
			cur = { key: t.key, armed: Boolean(t.armed), layer, host, hint };
			root.append(layer);
			deps.inert(true);
			watch(net);
			void deps.embed(t.key, name, host, { keys: true, ...(pane && { end: () => mine === turn && close() }) }).then((off) => (cur && mine === turn ? (cur.off = off) : off()));
		},
		/** A snapshot: a session's terminal ends when the unit starts working after it was idle. */
		follow: watch,
		close,
		/**
		 * Escape while the layer is on: the terminal's own while its keyboard sink has the focus (false: not taken, not prevented, so pi and vim get it), else Zen's two-press return. True when the key was the layer's.
		 */
		escape(e: { preventDefault(): void; repeat?: boolean }) {
			if (!cur) return false;
			const at = document.activeElement as HTMLElement | null, typing = Boolean(at && cur.host.contains(at) && (at.getAttribute?.("class") ?? "").split(" ").includes("term-sink"));
			const step = termStep({ typing, armed: escAt !== undefined && deps.now() - escAt < ESC_MS, repeat: e.repeat });
			if (step === "pass") return false;
			e.preventDefault();
			if (step === "leave") close();
			else if (step === "hint") {
				clearEsc();
				escAt = deps.now();
				const { hint } = cur;
				hint.textContent = m.zen_term_esc_hint();
				hint.dataset.on = "";
				const fade = deps.later(() => delete hint.dataset.on, ESC_MS), gone = deps.later(clearEsc, ESC_MS + 400); // the line fades as the window closes (zen.css), and its words go after
				stopEsc = () => (fade(), gone());
			}
			return true;
		},
	};
}
