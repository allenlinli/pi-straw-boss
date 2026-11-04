import type { Net } from "../src/net.ts";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { ago, LABEL } from "./render.ts";
import { formatRoute } from "./router.ts";
import { statusLine } from "./towermodel.ts";

// What the head tower's page and its entries show of the net's `head` (docs/specs/2026-11-04-head-tower.md, Standard: the head page and its entries): the header's crown button with its dot, the title and state line,
// the asks as chips under the conversation box, and the line for a head that is not open yet. The page itself is the session view on the head's key (session.ts); this file fills what differs.

type Opts = { locale?: "en" | "zh-TW" };
/** The key of this device's record of how far the head's words were read: the time (ms) of the newest assistant text the head page showed. */
export const SEEN = "sb.head.seen";

/** The time this device has read the head up to; none (0) for a device that never opened the page. */
export function seenAt(): number {
	try {
		const n = Number(localStorage.getItem(SEEN));
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}
/** The head page showed the head's newest words: this device has read up to `said` (never back). */
export function remember(said: number) {
	try {
		if (said > seenAt()) localStorage.setItem(SEEN, String(said));
	} catch {} // a device that cannot store it shows the dot again: harmless
}
/** Whether the head said something this device has not read. */
export const headDot = (head: HeadUnit | undefined, seen: number) => Boolean(head?.said && head.said > seen);

/** The header's crown button: there while the net has a head (its page opens even before the head exists), with the head's state for its colour and a dot (no number) while there is news and the head page is not the page. */
export function fillHeadButton(button: HTMLElement, head: HeadUnit | undefined, seen: number, here: boolean) {
	button.hidden = !head;
	if (!head) return;
	button.dataset.mark = head.mark;
	button.dataset.state = head.state;
	button.title = m.head_tower();
	button.setAttribute("aria-label", head.said && headDot(head, seen) && !here ? `${m.head_tower()}: ${m.head_new()}` : m.head_tower());
	button.toggleAttribute("aria-current", here);
	if (here) button.setAttribute("aria-current", "page");
	const dot = button.querySelector<HTMLElement>(".dot");
	if (dot) dot.hidden = here || !headDot(head, seen);
}

/** The state line under the title: the service's own word as a workspace tower's, or that the head is not open. */
export const headLine = (head: HeadUnit, o?: Opts) => (head.state === "absent" ? m.head_state_absent({}, o) : statusLine(head.service, head.mark, (mk) => LABEL[mk](), o));
/** The page header: the crown where the comms logo is, the title, the state line, and the one line a head that is not open shows. */
export function fillHeadTitle(root: HTMLElement, head: HeadUnit) {
	const set = (sel: string, text: string) => { const el = root.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
	root.querySelector(".head-icon")?.setAttribute("href", "#i-crown");
	set(".head-kicker", "");
	set(".head-title", m.head_tower());
	set(".head-line", headLine(head));
	const absent = root.querySelector<HTMLElement>(".head-absent");
	if (absent) (absent.hidden = head.state !== "absent", set(".head-absent", m.head_absent()));
}

export interface Chip { id: string; text: string; open: boolean; route?: string; title?: string }
/** The head's asks as chips, newest first as the server keeps them: `MP Center · 12m · open`, or `answered`; a chip links to that tower's comms when the net knows the tower. */
export function askChips(asks: HeadAskRow[], now: number, net: Net | undefined, o?: Opts): Chip[] {
	return asks.map((a) => {
		const key = net?.bases.find((b) => b.id === a.workspace)?.tower?.key, args = { workspace: a.label, age: ago(a.at, Math.max(0, now - a.at) / 1000) };
		return { id: a.id, text: (a.open ? m.head_ask : m.head_ask_done)(args, o), open: a.open, ...(key ? { route: formatRoute({ view: "session", ws: a.workspace, key }) } : {}), ...(a.last ? { title: a.last } : {}) };
	});
}
/** The chips under the conversation box; redrawn only when they change, so a click never lands on a chip that was replaced. */
export function fillHeadAsks(box: HTMLElement, head: HeadUnit | undefined, net: Net | undefined, now = Date.now()) {
	const chips = head ? askChips(head.asks, now, net) : [], sig = JSON.stringify(chips);
	box.hidden = !chips.length;
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.setAttribute("aria-label", m.head_asks_label());
	box.replaceChildren(...chips.map((c) => h(c.route ? "a" : "span", { class: "head-ask", "data-open": String(c.open), ...(c.route ? { href: c.route || "./", "data-route": c.route } : {}), ...(c.title ? { title: c.title } : {}) }, c.text)));
}
