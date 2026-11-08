import type { TowerService } from "../src/net.ts";
import { h } from "./dom.ts";
import { moreButton } from "./menu.ts";
import { m } from "./sentences.ts";
import { post } from "./post.ts";
import { formatRoute } from "./router.ts";
import { conversationFacts, guarded, towerRoute } from "./towermodel.ts";

// The boss conversation of a tower the sb server runs (src/server/runs.ts `ConversationStatus`), in the tower's comms: how it began, what it does and when the boss's silence ends it, the Leave and New buttons, and a chip
// for each recent event run (a read-only unit of the net while its session file is known, with the note it left in the tooltip). Leave and New post to the routes whose pi twins are `/boss tower leave` and
// `/boss tower new`: the same server functions. Redrawn only when what it shows changes, so a click never lands on a button that was replaced.

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export function fillConversation(box: HTMLElement, ws: string, service: TowerService | undefined) {
	const c = service?.conversation, inRun = !c ? service?.bossIn : undefined, events = (service?.localRuns ?? []).filter((r) => r.kind === "event"), sig = JSON.stringify([ws, c, inRun, events.map((r) => [r.id, r.key, r.outcome, r.note])]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	// A redraw (Leave or New changed the conversation) replaces the `⋯` panel; one the boss has open stays open, with the result it shows, and the focus lands in it again.
	const open = box.querySelector(".menu-pop")?.matches(":popover-open") === true, kept = open ? [box.querySelector(".tnote-fail")?.textContent, box.querySelector(".conv-done")?.textContent] : [];
	box.hidden = !c && !inRun && !events.length;
	if (box.hidden) return box.replaceChildren();
	const fail = h("small", { class: "tnote-fail", role: "alert" }), done = h("small", { class: "conv-done", role: "status" }), live = (cls: string, own: HTMLElement) => box.querySelector<HTMLElement>(`.${cls}`) ?? own, say = (text?: string) => ((live("tnote-fail", fail).textContent = text ?? ""), (live("conv-done", done).textContent = ""));
	[fail.textContent, done.textContent] = [kept[0] ?? "", kept[1] ?? ""];
	const button = (label: string, title: string, path: "leave" | "new", ok: () => string) => {
		const b = h("button", { type: "button", class: "pair-btn", title, "data-menu-keep": "" }, label);
		b.onclick = () => void guarded(b, say, async () => { const r = await post(`${towerRoute(ws)}/${path}`, {}); if (r.ok) live("conv-done", done).textContent = ok(); return r; }, 0);
		return b;
	};
	// A phone shows the line alone, in one row, with a `⋯` for what acts: Leave, New and their notes, the event runs' chips, and the facts the line cuts (style.css, "A phone's menus"). Above 640 px the menu is `display: contents` and the rows are as they were.
	const rows: Node[] = [], inMenu: Node[] = [];
	let acts: HTMLElement | undefined;
	const sep = () => h("span", { class: "conv-sep" }, " · ");
	if (c) {
		const facts = conversationFacts(c);
		rows.push(h("p", { class: "conv-line" }, h("b", null, m.conv_title()), " ", h("span", { class: "conv-began", ...(facts.why ? { title: facts.why } : {}) }, facts.began), sep(), h("span", { class: "conv-now" }, facts.now), sep(), h("span", { class: "conv-cap" }, facts.cap)));
		acts = h("p", { class: "conv-acts" }, ...(c.closing ? [] : [button(m.conv_leave(), m.conv_leave_title(), "leave", m.conv_left)]), button(m.conv_new_button(), m.conv_new_title(), "new", m.conv_fresh), fail, done);
		inMenu.push(h("p", { class: "conv-facts" }, `${facts.began} · ${facts.cap}`), acts);
	}
	if (inRun) rows.push(h("p", { class: "conv-line conv-in-run" }, h("b", null, m.conv_in_run({ id: inRun.id, time: clock(service?.run?.startedAt ?? inRun.since) }))));
	if (events.length) {
		if (!c && !inRun) rows.push(h("p", { class: "conv-line conv-runs-bar" }, h("b", null, m.conv_runs_bar({ count: events.length }))));
		inMenu.push(h("p", { class: "conv-runs" }, ...events.map((r) => {
			const label = m.conv_event_run({ time: clock(r.startedAt) }), tip = r.note ? m.conv_event_run_note({ outcome: r.outcome ?? "…", note: r.note }) : (r.outcome ?? "");
			if (!r.key) return h("span", { class: "ally-chip", title: tip || m.conv_event_run_unseen() }, label);
			const route = formatRoute({ view: "session", ws, key: r.key });
			return h("a", { class: "ally-chip", href: route || "./", "data-route": route, title: tip || m.conv_event_run_open() }, label);
		})));
	}
	let panel: HTMLElement | undefined;
	if (inMenu.length) {
		panel = h("div", { class: "menu-pop hud-pop", popover: "auto", role: "group", "aria-label": m.menu_more() }, ...inMenu);
		rows.push(h("span", { class: "menu" }, moreButton(panel), panel));
	}
	box.replaceChildren(...rows);
	if (open && panel?.isConnected) panel.showPopover();
}
