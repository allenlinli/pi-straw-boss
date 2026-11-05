import type { ConfirmView, LinkAlert, LinkSummary } from "../src/link/holder.ts";
import { h, nodes } from "./dom.ts";
import { alertLine, confirmLine, dialogState, urgentFirst } from "./linkmodel.ts";
import { m } from "./paraglide/messages.js";
import { byId, hang } from "./render.ts";

// The header's Link button and the notices under it (spec, GUI, Notices): a join request waiting, a roster mismatch or fork, a confirm a teammate's tower
// asked of this computer (`forward`), the relay unreachable, and a message waiting in the inbox for a tower. The button appears only while there is
// something to say, tinted by the worst of it, and opens a list; a forwarded confirm is answered right there (Allow or Deny, with the tool's full
// arguments), and a join request is reviewed in the team settings tile, where its words are.

/** The chime for new link notices: not while `quiet` (the view's `chime` rule is off, as in Zen, which makes no sound of its own accord). */
export const linkChime = (quiet: () => boolean, chime: () => void) => (count: number) => count && !quiet() && chime();

/** `open` shows the team settings tile; `news` hears how many notices that need the boss (a confirm or a join request) are new since the last snapshot. */
export function mountLinkBar(open: () => void, news: (count: number) => void) {
	const btn = byId("link-alerts", HTMLButtonElement), pop = byId("link-alerts-pop", HTMLElement), list = byId("link-alerts-list", HTMLElement);
	let sig = "", known = new Set<string>(), first = true;
	pop.addEventListener("toggle", (event) => (event as ToggleEvent).newState === "open" && hang(pop, btn));
	pop.setAttribute("aria-label", m.link_alerts_title());
	btn.title = m.link_alerts_title();
	const answer = (c: ConfirmView, allow: boolean, row: HTMLElement) => {
		const note = row.querySelector<HTMLElement>(".link-note")!;
		for (const b of row.querySelectorAll("button")) b.disabled = true;
		// The shared answer (asks.ts) loads with the first press, so the page's start does not carry it.
		void import("./asks.ts").then(({ confirmActions }) => confirmActions(c)[allow ? "allow" : "deny"]()).then((r) => {
			if (!r.ok) note.textContent = r.body.reason ?? m.refused({ status: r.status });
			for (const b of row.querySelectorAll("button")) b.disabled = false;
		}, () => {
			note.textContent = m.no_answer();
			for (const b of row.querySelectorAll("button")) b.disabled = false;
		});
	};
	const confirmRow = (c: ConfirmView) => {
		const row = h("li", { class: "link-alert", "data-level": "warning" });
		const allow = h("button", { type: "button", class: "pair-btn" }, m.link_allow()), deny = h("button", { type: "button", class: "pair-btn" }, m.link_deny());
		allow.onclick = () => answer(c, true, row);
		deny.onclick = () => answer(c, false, row);
		row.append(h("b", null, confirmLine(c)), h("pre", { class: "link-args" }, c.args), h("div", { class: "devices-acts" }, allow, deny), h("small", { class: "link-note", role: "status" }));
		return row;
	};
	// The cards of forwarded dialogs (linkdialogs.ts, with the question panel) load when the first one shows, so the page's start does not carry them; until then the notice's line stands in.
	let cards: ReturnType<typeof import("./linkdialogs.ts").mountDialogCards> | undefined, last: LinkSummary | undefined;
	const loadCards = () => void import("./linkdialogs.ts").then(({ mountDialogCards }) => ((cards = mountDialogCards()), (sig = ""), api.net(last)));
	/** The notices of unattended devices the boss cleared: forgotten here only, the holder keeps them for a day. */
	const cleared = new Set<string>();
	const api = {
		net(summary: LinkSummary | undefined) {
			last = summary;
			const alerts = urgentFirst((summary?.alerts ?? []).filter((a) => a.kind !== "confirm" && !cleared.has(a.id))), confirms = summary?.confirms ?? [];
			const next = JSON.stringify([alerts, confirms]);
			if (next === sig) return;
			sig = next;
			const need = new Set([...confirms.map((c) => `c/${c.dialogId}`), ...alerts.filter((a) => a.kind === "join-request" || (a.kind === "dialog" && dialogState(a) === "open")).map((a) => a.id)]);
			cards?.keep(new Set(alerts.map((a) => a.id)));
			if (!cards && alerts.some((a) => a.kind === "dialog")) loadCards();
			if (!first) news([...need].filter((k) => !known.has(k)).length);
			[known, first] = [need, false];
			const count = alerts.length + confirms.length;
			btn.hidden = count === 0;
			btn.textContent = m.link_alerts_button({ count: String(count) });
			btn.dataset.state = confirms.length || alerts.some((a) => a.level === "error") ? "error" : alerts.some((a) => a.level === "warning") ? "waiting" : "done";
			if (!count && pop.matches(":popover-open")) pop.hidePopover();
			list.replaceChildren(...nodes(...confirms.map(confirmRow), ...alerts.map((a) => {
				if (a.kind === "dialog" && cards) return cards.row(a);
				const row = h("li", { class: "link-alert", "data-level": a.level, "data-kind": a.kind }, h("span", null, alertLine(a)));
				if (a.kind === "join-request" || a.kind === "fork" || a.kind === "mismatch") {
					const go = h("button", { type: "button", class: "later" }, a.kind === "join-request" ? m.link_review() : m.link_open_teams());
					go.onclick = () => (pop.hidePopover(), open());
					row.append(go);
				}
				if (a.kind === "notice") {
					const clear = h("button", { type: "button", class: "later" }, m.link_notice_clear());
					clear.onclick = () => (cleared.add(a.id), (sig = ""), api.net(last));
					row.append(clear);
				}
				// A message that waits for an ally run is explained on the tower's card (held, a refused start), so the notice points there.
				if (a.kind === "served") {
					const go = h("a", { class: "later", href: "./", "data-route": "" }, m.link_show_towers());
					go.onclick = () => pop.hidePopover();
					row.append(go);
				}
				return row;
			})));
		},
	};
	return api;
}
