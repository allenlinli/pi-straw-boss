import type { Base, Net } from "../src/net.ts";
import type { AllyCard } from "./linkmodel.ts";

// The remote (operate) base as the page reasons about it (docs/specs/2026-11-07-link-operate.md §6.4, §8): the server's merge puts a box's session on the net as an ordinary base with a `box` field; what the page may offer on it, where it sits on the map, and what an ended one says
// are decided here, with no document. Everything a box says is untrusted: the controller's bridge has already held it to a schema, and this module still reads defensively.

/** The page actions a remote base's ⋯ menus and composer can offer. `box.can` lists what the box lets through (src/server/operatehost.ts `CAN`); `tower` only when the session has the box scope. */
export type Can = "close-unit" | "close-tab" | "dismiss" | "input" | "tower";

/** Whether `action` is on offer for the units of `base`: always on a local base; on a remote one only while the session is live and the box lists it (a greyed or ended base takes nothing). */
export const can = (base: Pick<Base, "box"> | undefined, action: Can): boolean => !base?.box || (base.box.state === "live" && base.box.can.includes(action));
/** The same from the base's element (`data-box`, `data-can`, which `fillBox` writes before the units are drawn), for a unit that is drawn without its base at hand. */
export const canIn = (el: Element, action: Can): boolean => {
	const base = el.closest<HTMLElement>(".base");
	return !base || base.dataset.box === undefined || (base.dataset.box === "live" && (base.dataset.can ?? "").split(" ").includes(action));
};
/** A base as a title says it: a remote base names the machine as well, since two boxes can both have a workspace "Work". */
export const baseTitle = (b: Pick<Base, "label" | "box">): string => (b.box ? `${b.label} · ${b.box.label}` : b.label);

/**
 * The map's order: the local bases, then the remote ones (each group as the net lists it), then the ally cards that no live remote base holds. A card whose device has a live remote base goes under that base (the one named like its workspace, else the device's first);
 * a card whose box is greyed or ended, or has no session, stays on the map.
 */
export function arrange(net: Net, cards: AllyCard[]): { bases: Base[]; loose: AllyCard[]; under: Map<string, AllyCard[]> } {
	const remote = net.bases.filter((b) => b.box), under = new Map<string, AllyCard[]>(), loose: AllyCard[] = [];
	for (const c of cards) {
		const mine = remote.filter((b) => b.box!.device === c.device && b.box!.state === "live"), home = mine.find((b) => b.label === c.workspace) ?? mine[0];
		if (home) under.set(home.id, [...(under.get(home.id) ?? []), c]);
		else loose.push(c);
	}
	return { bases: [...net.bases.filter((b) => !b.box), ...remote], loose, under };
}
