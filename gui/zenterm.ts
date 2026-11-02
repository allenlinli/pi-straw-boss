import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { locate } from "./scene.ts";
import { termHold } from "./towerturns.ts";
import { ESC_MS, termStep } from "./zenkeys.ts";
import type { Term } from "./zentypes.ts";

// The terminal an answer (or a blocked prompt's button) opens, inside Zen (docs/specs/2026-11-01-zen-view.md, A terminal in Zen): one full-screen layer over the screen that was there, holding the page's own terminal
// (mirror.ts `embed`: the mirror, the key pad, the keyboard sink; this file only gives it ink and a host). It ends by the button, by Esc Esc with the focus outside the terminal, or by itself: a pane's mirror ended (the pane
// closed or its grant ended, or its attach was refused as gone), or the session started working after it idled when this layer had sent the Enter (the command waiting in its prompt was submitted here; a wake by an
// intercom, a report, or a tower is not that). Zen's own screen is never redrawn for it, so coming back shows what it showed.

export interface ZenTermDeps {
	/** The page's terminal embedded in `host` (the Terminals `embed`, behind the overlay chunk); the promise gives what takes it away. */
	embed(key: string, name: string, host: HTMLElement, o: { keys: boolean; end?: () => void; entered?: (sent: boolean) => void }): Promise<() => void>;
	now(): number;
	later(fn: () => void, ms: number): () => void;
	/** What lies under the layer takes no focus and no tab while it is on. */
	inert(on: boolean): void;
	/** The layer went away by the button, Esc Esc, or its own end: Zen has the page again. */
	closed(): void;
}
interface Open { name: string; key: string; armed: boolean; /** The unit idled since the layer opened (or since its work last ended). */ idled: boolean; /** This layer sent an Enter since then. */ entered: boolean; /** The unit's mark in the last snapshot. */ mark?: string; /** The sentence that stands for a tower with no run live; none while the terminal is embedded. */ held?: string; layer: HTMLElement; host: HTMLElement; hint: HTMLElement; back: HTMLElement; off?: () => void; shown: number }
const isPane = (key: string) => key.startsWith("grant:");

export function mountZenTerm(root: HTMLElement, deps: ZenTermDeps) {
	let cur: Open | undefined, escAt: number | undefined, stopEsc = () => {};
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), cur && (delete cur.hint.dataset.on, (cur.hint.textContent = "")));
	/** The layer goes and its terminal is let go; whether Zen is told is the caller's. */
	function drop() {
		if (!cur) return false;
		const c = cur;
		cur = undefined;
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
	/** The terminal in the host, or the sentence that stands for a tower with no run live; a new `shown` makes an embed still on its way let go on arrival. */
	function show(c: Open, net: Net | undefined) {
		const held = isPane(c.key) ? undefined : termHold(locate(net, c.key)?.u.service);
		if (c.shown && c.held === held) return;
		const mine = ++c.shown;
		c.held = held;
		c.off?.();
		c.off = undefined;
		if (held) return c.host.replaceChildren(h("p", { class: "term-hold", role: "status" }, held));
		c.host.replaceChildren();
		const end = isPane(c.key) ? { end: () => c === cur && close() } : {};
		void deps.embed(c.key, c.name, c.host, { keys: true, ...end, entered: (sent) => void (c.entered = sent) }).then((off) => (c === cur && mine === c.shown ? (c.off = off) : off()));
	}
	/** The unit the session's terminal is for has idled (its command waits in the prompt) or works again: work after an idle ends the step when this layer sent the Enter in between (an armed terminal: at its first work). */
	const watch = (net: Net | undefined) => {
		if (!cur) return;
		show(cur, net);
		if (isPane(cur.key)) return;
		const mark = locate(net, cur.key)?.u.mark, was = cur.mark;
		cur.mark = mark;
		if (mark === "idle" || mark === "done") {
			if (was !== "idle" && was !== "done") [cur.idled, cur.entered] = [true, false]; // an Enter before this idle was another command's
		} else if (mark === "working" && (cur.armed || (cur.idled && cur.entered))) close();
	};
	return {
		isOpen: () => cur !== undefined,
		/** Shows the terminal of `t.key` (a session's, or a pane an answer opened: `grant:<id>`), or brings the one on show forward. `armed`: the unit waits on this terminal now, so its next work ends the step. */
		open(t: Term, net: Net | undefined) {
			if (cur?.key === t.key) return;
			drop();
			const pane = isPane(t.key), name = pane ? m.pane_name() : (locate(net, t.key)?.u.name ?? t.key);
			const back = h("button", { type: "button", class: "zen-term-back" }, m.zen_back_title()), host = h("div", { class: "zen-term-host" }), hint = h("p", { class: "zen-term-esc", role: "status", "aria-live": "polite" });
			back.onclick = close;
			const layer = h("section", { class: "zen-term", "aria-label": m.terminal_title({ name }) }, h("header", { class: "zen-term-bar" }, h("h2", { class: "zen-who" }, name), back), host, hint);
			cur = { name, key: t.key, armed: Boolean(t.armed), idled: false, entered: false, layer, host, hint, back, shown: 0 };
			root.append(layer);
			deps.inert(true);
			watch(net);
			if (!globalThis.matchMedia?.("(pointer: fine)").matches) back.focus(); // a phone's keyboard comes with the terminal's own button: the focus goes into the layer now, where the card's button it came from has gone inert
		},
		/** A snapshot: a session's terminal ends when the unit starts working after it was idle. */
		follow: watch,
		close,
		/**
		 * Escape while the layer is on: the terminal's own while its keyboard sink has the focus and its pad can take the key (false: not taken, not prevented, so pi and vim get it), else Zen's two-press return. Shift+Esc in the sink (mirror.ts) lets the sink go. True when the key was the layer's.
		 */
		escape(e: { preventDefault(): void; repeat?: boolean }) {
			if (!cur) return false;
			const at = document.activeElement as HTMLElement | null, sink = Boolean(at && cur.host.contains(at) && (at.getAttribute?.("class") ?? "").split(" ").includes("term-sink")), typing = sink && at?.dataset?.pad !== "off"; // a dead terminal (stale, ended, paused) takes no Esc: it is the layer's
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
