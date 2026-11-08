import type { LinkAlert, LinkSummary } from "../src/link/holder.ts";
import { h } from "./dom.ts";
import { mountDialogCards } from "./linkdialogs.ts";
import { type AllyCard, dialogState, mergeAllies } from "./linkmodel.ts";
import { m } from "./sentences.ts";

// The questions an unattended device forwarded, answered on the card of its ally base (docs/how-it-works.md, Unattended devices: Asking back): under the card's rows a button says how many wait, and the card's waiting rows
// do the same; it opens the shared question panel (linkdialogs.ts), the one the Link notices and Zen's card draw, which answers through `link/dialog-answer`. The map draws a card on every snapshot, so the panel is made once per
// card and only updated; what was picked and typed stays across snapshots.

/** An ally card that waits on a question: its tower or one of its tabs is blocked. */
const waits = (a: Pick<AllyCard, "tower" | "tabs">) => a.tower === "blocked" || a.tabs.some((t) => t.state === "blocked");
/**
 * The forwarded questions each ally card hosts, by the card's id (`mergeAllies`): the dialogs of its device that still ask or are answered and not yet closed. A question names a device, not a workspace, so a device with several cards
 * gives them to the one that waits (else the first), among the cards of the team the question came on when it has any (a card is of the teams whose presence lists its workspace), and the question's own row says that team. A question with no card of its device stays in the Link notices alone.
 */
export function asksOf(link: Pick<LinkSummary, "allies" | "alerts"> | undefined): Map<string, LinkAlert[]> {
	const out = new Map<string, LinkAlert[]>();
	const cards = mergeAllies(link?.allies ?? []);
	for (const a of link?.alerts ?? []) {
		const state = a.kind === "dialog" ? dialogState(a) : undefined;
		if (state !== "open" && state !== "sent") continue;
		const ofDevice = cards.filter((x) => x.device === a.data.device), ofTeam = ofDevice.filter((x) => x.teams.some((t) => t.team === a.team)), mine = ofTeam.length ? ofTeam : ofDevice, host = mine.find(waits) ?? mine[0];
		if (host) out.set(host.id, [...(out.get(host.id) ?? []), a]);
	}
	return out;
}

interface Host { box: HTMLElement; btn: HTMLButtonElement; list: HTMLElement; cards: ReturnType<typeof mountDialogCards>; ids: string }

/** The rows of an ally card that wait on a question: pressing one opens the panel too (the button is the keyboard's way). */
export const WAITING_ROWS = '.ally-unit[data-state="blocked"], .ally-tab[data-state="blocked"]';

export function mountAllyAsks() {
	const hosts = new WeakMap<HTMLElement, Host>();
	const host = (card: HTMLElement): Host => {
		let x = hosts.get(card);
		if (x) return x;
		const btn = h("button", { type: "button", class: "ally-asks-btn", "aria-expanded": "false" }), list = h("ul", { class: "ally-asks-list" }), box = h("div", { class: "ally-asks" }, btn, list);
		x = { box, btn, list, cards: mountDialogCards(), ids: "" };
		hosts.set(card, x);
		btn.onclick = () => toggle(card);
		card.addEventListener("click", (event) => {
			const row = (event.target as Element | null)?.closest?.(WAITING_ROWS);
			if (row && card.contains(row) && card.dataset.asks && !(event.target as Element).closest("details")) toggle(card); // a fold inside the row (its report, a crash) opens itself
		});
		card.append(box);
		return x;
	};
	/** Opens or closes the panel of a card. */
	function toggle(card: HTMLElement) {
		const x = hosts.get(card);
		if (!x || !card.dataset.asks) return;
		const open = card.dataset.asking === undefined;
		if (open) card.dataset.asking = "";
		else delete card.dataset.asking;
		x.list.hidden = !open;
		x.btn.setAttribute("aria-expanded", String(open));
	}
	/** Draws the questions a card hosts (none: the card has no panel and no mark); called on every snapshot. */
	function fill(card: HTMLElement, asks: LinkAlert[]) {
		if (!asks.length && !hosts.has(card)) return;
		const x = host(card);
		x.box.hidden = !asks.length;
		if (!asks.length) {
			delete card.dataset.asks;
			delete card.dataset.asking;
			x.btn.setAttribute("aria-expanded", "false");
			x.cards.keep(new Set());
			x.list.replaceChildren();
			x.ids = "";
			return;
		}
		card.dataset.asks = String(asks.length);
		x.btn.textContent = m.ally_asks_button({ count: asks.length });
		x.list.hidden = card.dataset.asking === undefined;
		x.cards.keep(new Set(asks.map((a) => a.id)));
		const rows = asks.map((a) => x.cards.row(a)), ids = asks.map((a) => a.id).join("\n");
		if (ids !== x.ids) (x.list.replaceChildren(...rows), (x.ids = ids)); // the rows stay where they are while the same questions wait: re-appending them would take the focus from a field
	}
	return {
		toggle,
		fill,
		/** Draws the questions the card of `ally` hosts out of the Link summary (`asksOf`). */
		show: (card: HTMLElement, ally: Pick<AllyCard, "id">, link: LinkSummary | undefined) => fill(card, asksOf(link).get(ally.id) ?? []),
	};
}
