import type { Pending } from "../src/ask.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";

// Who is on the net and who waits on the user: the one walk over a snapshot's units (alerts, tab icon, Zen's companion, documents, finished subagents).
/** `sub`: a subagent of the tower, of a unit, or of another subagent. */
export interface Row { base: Base; unit: Unit | NonNullable<Base["tower"]>; sub: boolean }
/** Every unit of a net, base by base: the tower, the tabs' units, then the units outside the net, each before its subagents. */
export function unitsOf(net: Net): Row[] {
	const rows: Row[] = [];
	const add = (base: Base, unit: Row["unit"], sub: boolean) => (rows.push({ base, unit, sub }), unit.subs.forEach((s) => add(base, s, true)));
	for (const b of net.bases) [...(b.tower ? [b.tower] : []), ...b.tabs.flatMap((t) => t.units), ...b.outside].forEach((u) => add(b, u, false));
	return rows;
}
/** 0 for what waits on the user (mark waiting, or a dialog pending): the only prominent alert. 1 for the rest (an error, a failed monitor, a finished unit): notices, never opened by themselves. */
export const rankOf = (a: { mark: Mark; pending?: Pending }) => (a.mark === "waiting" || a.pending ? 0 : 1);
/** What waits on the user, in order: the alerts the HUD and the dialogs show, the units the tab icon counts. */
export const waitingOf = <T extends { mark: Mark; pending?: Pending }>(all: Iterable<T>): T[] => [...all].filter((a) => rankOf(a) === 0);
/** A unit Zen's companion can be stepped to (`[` and `]`): its key and its base. */
export interface Candidate { key: string; ws: string }
/** The units the companion can be: live (the page can talk to them, their run is not over) and not a subagent. Towers and idle units come first, then the rest; each group keeps the net's order. */
export function companionsOf(net: Net | undefined): Candidate[] {
	const live = net ? unitsOf(net).filter(({ unit, sub }) => !sub && unit.control && !("ended" in unit && unit.ended)) : [];
	const first = (r: Row) => r.base.tower === r.unit || r.unit.mark === "idle";
	return [...live.filter(first), ...live.filter((r) => !first(r))].map((r) => ({ key: r.unit.key, ws: r.base.id }));
}
/** How many units work and how many are idle, for Zen's strip. A unit that waits on the user (`rankOf` 0: the waiting mark, or a dialog pending on any mark) is in neither number, so what waits cannot be read back from them; errors, finished, ended, and unknown units are not counted. */
export function activityOf(net: Net | undefined): { working: number; idle: number } {
	const own = (net ? unitsOf(net) : []).map((r) => r.unit).filter((u) => rankOf(u) === 1 && !("ended" in u && u.ended));
	return { working: own.filter((u) => u.mark === "working").length, idle: own.filter((u) => u.mark === "idle").length };
}
