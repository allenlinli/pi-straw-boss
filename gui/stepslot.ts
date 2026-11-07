import type { Net } from "../src/net.ts";
import { can } from "./boxmodel.ts";
import { locate } from "./scene.ts";
import { termCard } from "./termcard.ts";
import type { StepOpen } from "./terminalthen.ts";
import { termHold } from "./towerturns.ts";
import type { TermKit } from "./zentypes.ts";

// The terminal card's place in Standard and Geek (docs/specs/2026-11-02-terminal-card.md, section 3): the dock's other box, one at a time. A newer step replaces it. It is not in the alert stack (overlay.ts), so no queue
// rule closes or buries it, and a dialog the user opens over it covers it (style.css). It closes by its own rules (cardmodel.ts), its ×, or Esc inside it, and the focus goes back to where it was.

export interface SlotDeps {
	dock: HTMLElement;
	kit: TermKit;
	/** The session's terminal mode, for a prompt's Full terminal. */
	showTerminal(ws: string, key: string): void;
	/** The tile of a pane with the keyboard in it, for a pane's Full terminal. */
	openPane(key: string, name: string): void;
}
interface Shown { el: HTMLElement; asker: string; from?: HTMLElement; update(name?: string): void; stop(): void; focus(): void }

export function mountStepSlot({ dock, kit, showTerminal, openPane }: SlotDeps) {
	let card: Shown | undefined, last: Net | undefined;
	const nameOf = (asker: string) => locate(last, asker)?.u.name ?? asker;
	function end(restore = true) {
		const c = card;
		card = undefined;
		if (!c) return;
		c.stop();
		c.el.remove();
		if (restore && c.from?.isConnected && !c.from.closest("[inert]")) c.from.focus();
	}
	/** Today's full terminal takes the step over: a session's in the session view's terminal mode, a pane's as a tile. */
	function full(s: StepOpen) {
		const ws = locate(last, s.asker)?.base.id;
		if (s.kind === "pane") openPane(s.key, nameOf(s.asker));
		else if (ws) showTerminal(ws, s.key);
	}
	return {
		step(s: StepOpen, net?: Net) {
			last = net ?? last;
			const name = nameOf(s.asker), at = document.activeElement, from = at instanceof HTMLElement && at !== document.body ? at : undefined;
			end(false);
			const c = termCard({
				step: { kind: s.kind, key: s.key, name, command: s.command, run: s.run },
				watch: (w) => kit.watch(s.key, name, w),
				post: kit.post(s.key),
				stream: kit.stream,
				away: () => !can(locate(last, s.asker)?.base, "input"), // a remote base's box takes no input unreachable or ended, as the pad does (layer.ts)
				held: () => (s.key.startsWith("grant:") ? undefined : termHold(locate(last, s.key)?.u.service)),
				over: (why) => (why === "full" && full(s), end(why !== "full")),
			});
			card = { el: c.el, asker: s.asker, from, update: c.update, stop: c.stop, focus: c.focus };
			dock.prepend(c.el);
			c.focus();
		},
		/** A snapshot: the unit's name and a tower's held sentence. */
		follow(net: Net) {
			last = net;
			card?.update(nameOf(card.asker));
		},
		/** The card takes the focus back (a closing dialog gave it elsewhere). */
		focus: () => card?.focus(),
	};
}
