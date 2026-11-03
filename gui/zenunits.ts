import type { Net } from "../src/net.ts";
import { type Row, rankOf, unitsOf } from "./units.ts";

// What Zen reads of a snapshot (its companion and its strip): apart from units.ts so the page's entry does not carry it.
/** A unit Zen's companion can be stepped to (`[` and `]`): its key and its base. */
export interface Candidate { key: string; ws: string }
/** The units the companion can be: live (the page can talk to them, their run is not over), not a subagent, and not waiting on the user (`rankOf` 0, a rested "maybe later" one too: Zen never lets a waiting unit show through). Towers and idle units come first, then the rest; each group keeps the net's order. */
export function companionsOf(net: Net | undefined): Candidate[] {
	const live = net ? unitsOf(net).filter(({ unit, sub }) => !sub && unit.control && rankOf(unit) === 1 && !("ended" in unit && unit.ended)) : [];
	const first = (r: Row) => r.base.tower === r.unit || r.unit.mark === "idle";
	return [...live.filter(first), ...live.filter((r) => !first(r))].map((r) => ({ key: r.unit.key, ws: r.base.id }));
}
/** How many units work and how many are idle, for Zen's strip. A unit that waits on the user (`rankOf` 0: the waiting mark, or a dialog pending on any mark) is in neither number, so what waits cannot be read back from them; errors, finished, ended, and unknown units are not counted. */
export function activityOf(net: Net | undefined): { working: number; idle: number } {
	const own = (net ? unitsOf(net) : []).map((r) => r.unit).filter((u) => rankOf(u) === 1 && !("ended" in u && u.ended));
	return { working: own.filter((u) => u.mark === "working").length, idle: own.filter((u) => u.mark === "idle").length };
}
