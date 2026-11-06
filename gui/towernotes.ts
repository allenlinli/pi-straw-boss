import { HEAD_KEY } from "../src/headkey.ts";
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
const panels = new WeakMap<HTMLElement, Map<string, Panel>>(), newest = new WeakMap<HTMLElement, [string, TowerService | undefined, string | undefined, boolean]>();

// What the boss just did to a wait, said under the rows for a few seconds: the row itself goes when the next snapshot arrives, and with it its own confirmation.
const FLASH_MS = 4000, flashes = new WeakMap<HTMLElement, { text: string; at: number }>();
const flashEl = (text: string) => h("p", { class: "tnote-flash", role: "status" }, text);
function flash(box: HTMLElement, text: string) {
	const at = Date.now();
	flashes.set(box, { text, at });
	box.querySelector(".tnote-flash")?.remove();
	box.append(flashEl(text));
	const timer: unknown = setTimeout(() => {
		if (flashes.get(box)?.at !== at) return;
		flashes.delete(box);
		box.querySelector(".tnote-flash")?.remove();
	}, FLASH_MS);
	(timer as { unref?(): void }).unref?.(); // a test process does not wait for it
}

/** Redrawn only when the rows change, so a click never lands on a button that was replaced; the wait panels outlive a redraw (an answer being typed stays). */
/** `here`: the box sits on that tower's own comms, so a link to them would lead to the page it is on. */
export function fillNotices(box: HTMLElement, ws: string, service: TowerService | undefined, key?: string, here = false) {
	newest.set(box, [ws, service, key, here]); // the panel's load redraws this, not the snapshot that started it
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
				const id = `${ws}\u001f${r.wait}`, panel = before.get(id) ?? kit.waitPanel({ actions: kit.waitActions({ ws, id: r.wait, tower: key }, kit.answerPost(key)), reply: true, goto: !here && ws !== HEAD_KEY, done: (said) => flash(box, said) });
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
	const said = flashes.get(box);
	if (said) box.append(flashEl(said.text));
	panels.set(box, kept);
	held?.focus();
}
