import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { type Act, guarded, noticeRows, towerRoute } from "./towermodel.ts";

// The tower service's notices and parked events with their buttons, drawn in the map's base card and again in the tower's comms, so a held tower shows its Retry wherever the boss looks.

const LABEL: Record<Act, () => string> = { retry: m.tower_notice_retry, deliver: m.tower_deliver, drop: m.tower_drop, answer: m.tower_answer, dismiss: m.wait_dismiss, confirm: m.memory_confirm, reject: m.memory_reject };

// A wait for the boss is the tower's question: its row mounts the wait panel (waitpanel.ts: Handle unfolds the answer box, Dismiss, and the link to the comms), which is loaded with the first such row, so the map's chunk does not carry it.
type Panel = ReturnType<typeof import("./waitpanel.ts").waitPanel>;
type Kit = { waitPanel: typeof import("./waitpanel.ts").waitPanel; waitActions: typeof import("./asks.ts").waitActions; answerPost: typeof import("./answer.ts").answerPost };
let kit: Kit | undefined, loading: Promise<Kit> | undefined;
const load = () => (loading ??= Promise.all([import("./waitpanel.ts"), import("./asks.ts"), import("./answer.ts")]).then(([w, a, r]) => (kit = { waitPanel: w.waitPanel, waitActions: a.waitActions, answerPost: r.answerPost })));
const panels = new WeakMap<HTMLElement, Map<string, Panel>>(), newest = new WeakMap<HTMLElement, [string, TowerService | undefined, string | undefined]>();

/** Redrawn only when the rows change, so a click never lands on a button that was replaced; the wait panels outlive a redraw (an answer being typed stays). */
export function fillNotices(box: HTMLElement, ws: string, service: TowerService | undefined, key?: string) {
	newest.set(box, [ws, service, key]); // the panel's load redraws this, not the snapshot that started it
	const rows = noticeRows(service), sig = JSON.stringify([ws, rows]), live = document.body.dataset.stale !== "true";
	for (const panel of panels.get(box)?.values() ?? []) panel.update(live);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	if (!kit && key && rows.some((r) => r.wait)) void load().then(() => ((box.dataset.sig = ""), fillNotices(box, ...newest.get(box)!)));
	const before = panels.get(box) ?? new Map<string, Panel>(), kept = new Map<string, Panel>();
	const focused = document.activeElement as HTMLElement | null; // a kept panel moves into a new row, which takes the focus off the box being typed in
	const held = focused && [...before.values()].some((p) => p.el.contains(focused)) ? focused : undefined;
	box.replaceChildren(...rows.map((r) => {
		const fail = h("small", { class: "tnote-fail", role: "alert" }), row = h(r.wait ? "div" : "p", { class: `tnote ${r.level}` }, h("span", null, r.text));
		if (r.wait) {
			if (kit && key) {
				const id = `${ws}\u001f${r.wait}`, panel = before.get(id) ?? kit.waitPanel({ actions: kit.waitActions({ ws, id: r.wait, tower: key }, kit.answerPost(key)), reply: true, goto: true });
				panel.update(live);
				kept.set(id, panel);
				row.append(panel.el);
			}
			return row;
		}
		for (const action of r.actions) {
			const button = h("button", { type: "button", class: "pair-btn" }, LABEL[action]());
			// A run's proposal is answered at the memory route, by its id (a confirm names the rev the snapshot carried): asks.ts `proposalActions`, which Zen's card calls too.
			const run = async () => (r.proposal && (action === "confirm" || action === "reject") ? (await import("./asks.ts")).proposalActions({ ws, id: r.proposal, rev: () => r.rev! })[action]() : post(`${towerRoute(ws)}/${action}`, r.event ? { id: r.event } : {}));
			button.onclick = () => void guarded(button, (text) => (fail.textContent = text ?? ""), run);
			row.append(button);
		}
		row.append(fail);
		return row;
	}));
	panels.set(box, kept);
	held?.focus();
}
