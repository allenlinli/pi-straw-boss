import type { HeadUnit } from "../src/nethead.ts";
import { askGroups, headLine, sentLine } from "./headpage.ts";
import { m } from "./paraglide/messages.js";
import { noun } from "./nouns.ts";

// What the head band on the map's top says (docs/specs/2026-11-07-head-band.md, "The band"), and the geometry its wires need: the band's content from the net's head, the gutter of a column, and the keyframes of a packet that travels a route.
// Pure: render.ts draws the band and the wires from these.

type Spot = readonly [number, number];

/** The waits for the boss, counted as the head page's rows are (towermodel.ts `noticeRows`): the server leaves the lapsed ones out of the head's `bossWaits`, and a wait that has a state has no row. */
export const bossWaits = (head: HeadUnit | undefined) => (head?.service?.memory?.bossWaits ?? []).filter((w) => !w.state).length;

/** The newest broadcast's one-line summary (the card's own line, headpage.ts `sentLine`) while it has had activity in the last day; none otherwise. */
export function newestLine(head: HeadUnit, now: number): string {
	const newest = askGroups(head.asks, now, undefined).recent[0];
	return newest ? sentLine(newest) : "";
}

export interface Band { absent: boolean; name: string; state: string; line: string; waits: number; /** The accessible name and the hover: the name, the state, the waits, and the whole line the band ellipsises. */ label: string }
/** The band's words for one head: while the head is not open the line is the state ("not open") and there is no chip. */
export function bandModel(head: HeadUnit, now = Date.now()): Band {
	const absent = head.state === "absent", name = noun("head_tower"), state = headLine(head), waits = absent ? 0 : bossWaits(head), line = absent ? state : newestLine(head, now);
	const label = [name, state, waits ? `${waits} · ${m.memory_wait_boss()}` : "", absent ? "" : line].filter(Boolean).join(" · ");
	return { absent, name, state, line, waits, label };
}

/** The x of the gutter on the left of a column of cards, in the map's coordinates: the middle of the map's padding for the first column (`first` is the left of its cards), half the column gap before the others. */
export const gutter = (left: number, first: number, gap: number) => Math.round(left <= first ? left / 2 : left - gap / 2);

/**
 * The keyframes of a packet on a route (a list of corners): one at each corner, at the share of the route's length reached there, so a linear timing keeps one pace on every stretch. The compositor interpolates between them, as for the old curves
 * (packets.ts); a route of one point has none.
 */
export function routeFrames(points: readonly Spot[]): { at: number; x: number; y: number }[] {
	if (points.length < 2) return [];
	const reach = points.reduce<number[]>((sum, p, i) => (sum.push(i ? sum[i - 1]! + Math.hypot(p[0] - points[i - 1]![0], p[1] - points[i - 1]![1]) : 0), sum), []), total = reach.at(-1)! || 1;
	return points.map(([x, y], i) => ({ at: Math.round((reach[i]! / total) * 10_000) / 100, x, y }));
}

/** The keyframes (in a `<style>`) and a dot for each route; none when `still`. */
export function routePackets(routes: readonly (readonly Spot[])[], still: boolean): HTMLElement[] {
	if (still || !routes.length) return [];
	const css = document.createElement("style");
	css.textContent = routes.map((r, i) => `@keyframes pk${i}{${routeFrames(r).map(({ at, x, y }) => `${at}%{transform:translate(${x}px,${y}px)}`).join("")}}`).join("");
	return [css, ...routes.map((_, i) => ((dot) => ((dot.className = "packet"), (dot.style.animationName = `pk${i}`), dot))(document.createElement("i")))];
}
