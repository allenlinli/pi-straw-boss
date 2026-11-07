import type { Mark } from "./netdata.ts";
import type { Base, Net, Unit } from "./net.ts";
import type { OperateScope } from "./operateroutes.ts";

// What the box shows an operate session (docs/specs/2026-11-07-link-operate.md §6.2): its net, cut down to the units in the session's scope before anything leaves the box. A unit is shown by its own key (`scope.has`); a unit
// out of scope takes everything under it with it. A base whose tower is not in scope keeps its in-scope tabs and units with `tower: null`. Never shown: `link` (the box's own allies, alerts and confirms), `stashed`, `trust`, `head`
// (box-wide), the events of units out of scope, and every shelf document entry (decision 12: a document's capability is never given out, and nothing here serves one). An outpost (a sub workspace) belongs to nobody: the box part only.

/** A unit or tower without its shelf: the document entries carry the capabilities that open them. */
const bare = <T extends { docs?: unknown; docsCut?: unknown }>({ docs: _docs, docsCut: _cut, ...rest }: T): Omit<T, "docs" | "docsCut"> => rest;
const keep = (scope: OperateScope) => function unit(u: Unit): Unit[] {
	return scope.has(u.key) ? [{ ...bare(u), subs: u.subs.flatMap(unit) }] : [];
};
const marksOf = (b: Pick<Base, "tower" | "tabs" | "outposts">): Mark[] => [...(b.tower?.subs.map((c) => c.mark) ?? []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...b.outposts.map((o) => o.mark)];

export function sliceNet(net: Net, scope: OperateScope): Net {
	const units = keep(scope);
	const bases = net.bases.flatMap((b): Base[] => {
		const tower = b.tower && scope.has(b.tower.key) ? { ...bare(b.tower), subs: b.tower.subs.flatMap(units) } : null;
		const tabs = b.tabs.flatMap((t) => ((u) => (u.length ? [{ ...t, units: u }] : []))(t.units.flatMap(units)));
		const outside = b.outside.flatMap(units), outposts = scope.box ? b.outposts : [];
		if (!tower && !tabs.length && !outside.length && !outposts.length) return [];
		// The base's mark is the one that needs attention most among what it holds: what is left decides it, so another team's waiting unit does not show through. With nothing taken out it is the net's own.
		const left = marksOf({ tower, tabs, outposts }), mark: Mark = left.length === marksOf(b).length ? b.mark : left.includes("waiting") ? "waiting" : left.includes("working") ? "working" : b.mark === "waiting" || b.mark === "working" ? "idle" : b.mark;
		return [{ ...b, mark, tower, tabs, outposts, outside }];
	});
	const events = net.events?.filter((e) => (e.key === undefined ? scope.box : scope.has(e.key)));
	return { bases, ...(events?.length ? { events } : {}) };
}
