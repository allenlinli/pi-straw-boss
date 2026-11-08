import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import { formatRoute } from "./router.ts";
import { type CarView, type FormingView, type ProjectView, projectView, type TrainView } from "./trains.ts";
import { unitsOf } from "./units.ts";

// The yard (調車場, docs/specs/2026-11-07-train-workers.md §11.2): a sheet over the page, one section per project, drawn from the net's `yards` by the model in trains.ts. Everything a yard says is a model's own text, so this
// file makes elements and sets text and a few attributes only (`h`): never markup, never a link or a route made from the text. The one link, a train's code, is a route of the page built from the unit the net itself knows.

const car = (c: CarView) => h("li", { class: "yard-car" },
	h("span", { class: "yard-tickets" }, c.tickets),
	h("span", { class: "yard-chip", ...(c.accepted.title ? { title: c.accepted.title } : {}) }, c.accepted.text),
	...c.conditions.map((line) => h("span", { class: "yard-cond" }, line)),
	c.notice && h("p", { class: "yard-notice", "data-tone": c.notice.tone, ...(c.notice.title ? { title: c.notice.title } : {}) }, c.notice.text),
);
const cars = (list: CarView[]) => list.length ? h("ul", { class: "yard-cars" }, ...list.map(car)) : null;

const forming = (f: FormingView) => h("li", { class: "yard-row yard-forming-row", "data-status": f.status },
	h("div", { class: "yard-top" }, h("span", { class: "yard-code" }, f.short), h("span", { class: "yard-app" }, f.app), h("span", { class: "yard-state" }, f.word), f.condition && h("span", { class: "yard-depart" }, f.condition)),
	cars(f.cars),
);

const code = (t: TrainView) => t.route
	? h("a", { class: "yard-code", href: formatRoute({ view: "session", ws: t.route.ws, key: t.route.key }) || "./", "data-route": formatRoute({ view: "session", ws: t.route.ws, key: t.route.key }), "aria-label": m.yard_open_comms({ code: t.short }) }, t.short)
	: h("span", { class: "yard-code" }, t.short);
const train = (t: TrainView) => h("li", { class: "yard-row", "data-status": t.status },
	h("div", { class: "yard-top" }, code(t), h("span", { class: "yard-app" }, t.app), t.status === "stale" && h("span", { class: "yard-state" }, m.yard_state_stale()), t.status === "ended" && h("span", { class: "yard-state" }, m.yard_state_ended()), t.round && h("span", { class: "yard-round" }, t.round), t.tickets.length ? h("span", { class: "yard-tickets-line" }, t.tickets.join(m.yard_sep_list())) : null),
	t.reason && h("p", { class: "yard-reason" }, t.reason),
	t.pills.length ? h("ol", { class: "yard-pills" }, ...t.pills.map((p) => h("li", { class: "yard-pill", "data-state": p.state, "data-round": String(p.round), ...(p.current ? { "data-current": "" } : {}), title: p.title }, p.text))) : null,
	t.wait && h("p", { class: "yard-wait" }, t.wait),
	t.need && h("p", { class: "yard-need" }, t.need),
	t.cut && h("p", { class: "yard-cut" }, t.cut),
	cars(t.cars),
);

/** One project's section, drawn from its view. */
export function drawProject(v: ProjectView): HTMLElement {
	const integrator = v.integrator && (v.integrator.route
		? h("a", { class: "yard-integrator", href: formatRoute({ view: "session", ws: v.integrator.route.ws, key: v.integrator.route.key }) || "./", "data-route": formatRoute({ view: "session", ws: v.integrator.route.ws, key: v.integrator.route.key }) }, v.integrator.text)
		: h("span", { class: "yard-integrator" }, v.integrator.text));
	return h("section", { class: "yard-project", "data-project": v.project },
		h("header", { class: "yard-head" },
			h("h3", { class: "yard-title" }, v.title),
			h("p", { class: "yard-counts" }, h("span", { class: "yard-count" }, v.head), h("span", { class: "yard-load" }, v.load)),
			integrator,
		),
		v.problem && h("p", { class: "yard-problem", role: "alert" }, v.problem),
		v.empty && h("p", { class: "yard-empty" }, m.yard_empty()),
		v.forming.length ? h("ul", { class: "yard-list yard-forming" }, ...v.forming.map(forming)) : null,
		v.trains.length ? h("ul", { class: "yard-list yard-trains" }, ...v.trains.map(train)) : null,
		v.ended.length ? h("details", { class: "yard-ended" }, h("summary", null, m.yard_ended({ count: v.ended.length })), h("ul", { class: "yard-list" }, ...v.ended.map(train))) : null,
	);
}

export interface Yard { open(projects: string[]): void; net(net: Net): void; isOpen(): boolean }
/**
 * The sheet: a modal dialog (so the page's keys rest while it is open, Escape closes it), redrawn with each snapshot only when what it shows changed. `projects` are the sections it shows, by name; one the net no longer has shows as an empty yard.
 * A click on a train's link to its comms closes the sheet first; the router takes the click.
 */
export function mountYard(): Yard {
	const dialog = h("dialog", { class: "sheet yard", "aria-label": m.yard_open() }), body = h("div", { class: "yard-body" });
	const close = h("button", { type: "button", class: "pair-btn yard-close" }, m.close());
	let shown: string[] = [], last: Net | undefined, sig = "";
	const draw = () => {
		const net = last, at = new Map(net ? unitsOf(net).map((r) => [r.unit.key, r.base.id]) : []);
		const locate = (key: string | undefined) => (key && at.has(key) ? { ws: at.get(key)!, key } : undefined);
		const ctx = { now: Date.now(), ...(net?.load ? { load: net.load } : {}) };
		const views = shown.map((name) => projectView(net?.yards?.projects.find((p) => p.project === name) ?? { project: name, forming: [], trains: [], waiting: [] }, ctx, locate));
		const next = JSON.stringify([views, net?.yards?.truncated, net?.yards?.problems]);
		if (next === sig) return;
		sig = next;
		const open = new Set([...body.querySelectorAll("details.yard-ended[open]")].map((d) => (d.closest("[data-project]") as HTMLElement | null)?.dataset.project));
		const extra: HTMLElement[] = [...(net?.yards?.truncated ? [h("p", { class: "yard-problem" }, m.yard_truncated())] : []), ...(net?.yards?.problems ?? []).map((p) => h("p", { class: "yard-problem" }, m.yard_problem({ problem: p })))];
		body.replaceChildren(...views.map(drawProject), ...extra);
		for (const d of body.querySelectorAll("details.yard-ended")) if (open.has((d.closest("[data-project]") as HTMLElement | null)?.dataset.project)) d.setAttribute("open", "");
	};
	close.onclick = () => dialog.close();
	dialog.addEventListener("click", (e) => {
		const target = e.target as Element | null;
		if (target === dialog || target?.closest?.("a[data-route]")) dialog.close(); // a click on the backdrop (the dialog's own box) or on a link to a comms
	});
	dialog.addEventListener("close", () => { sig = ""; });
	dialog.append(h("div", { class: "yard-bar" }, close), body);
	document.body.append(dialog);
	return {
		open(projects) {
			shown = projects;
			sig = "";
			draw();
			if (!dialog.open) dialog.showModal();
			close.focus();
		},
		net(net) {
			last = net;
			if (dialog.open) draw();
		},
		isOpen: () => dialog.open,
	};
}
