import { allyLabel } from "../boardauto.ts";
import type { Pane } from "../herdr.ts";

// Whose unit a pane is (docs/specs/2026-11-05-link-shared-box.md, Who is told): the controller that dispatched the work done in it, and what the controller is told the unit is called (`unitLabel`). The box has two kinds of unit that a controller starts: an ally run, whose pane the
// server itself split off (and keeps in its own record), and a main a run opened with `boss_open_main`, in a tab of its own whose pane carries `sb_opened_by=link:<device id>` from before its pi starts. Everything else
// (the tower's own runs, a session the boss opened on the box) is nobody's. The token is Herdr state any process of the box's user can write, the same trust the main's close and the route table already place in it;
// this scope is a matter of whom the box bothers and whom it believes, not a wall between users of one account.

/** The device (and its team, when the server's record names it) that dispatched the unit in `pane`. A pane Herdr does not list is nobody's. */
export function dispatcherOf(pane: string, listed: Pane[], allyPanes: { pane: string; device: string; team?: string }[]): { device: string; team?: string } | undefined {
	const mine = listed.find((p) => p.pane_id === pane);
	if (!mine) return undefined;
	const ally = allyPanes.find((a) => a.pane === pane);
	if (ally) return { device: ally.device, ...(ally.team ? { team: ally.team } : {}) };
	const device = listed.find((p) => p.tab_id === mine.tab_id && p.tokens?.sb_opened_by?.startsWith("link:"))?.tokens?.sb_opened_by?.replace(/^(link:)+/, "");
	return device && /^[a-z2-7]{26}$/.test(device) ? { device } : undefined;
}

/** The lookup the dialog forwarder asks: the dispatcher of the unit whose dialogs the hub files under `key`. One Herdr listing serves every lookup of a pass (it is a Herdr call), so it is kept two seconds. */
export function dispatcherLookup(d: { paneOf(key: string): string | undefined; list(): Promise<Pane[]>; allyPanes(): { pane: string; device: string; team?: string }[]; now(): number }) {
	let listed: { at: number; panes: Promise<Pane[] | undefined> } | undefined;
	return async (key: string): Promise<{ device: string; team?: string } | undefined> => {
		const pane = d.paneOf(key);
		if (!pane) return undefined;
		if (!listed || d.now() - listed.at > 2000) listed = { at: d.now(), panes: d.list().catch(() => undefined) };
		const panes = await listed.panes;
		return panes ? dispatcherOf(pane, panes, d.allyPanes()) : undefined;
	};
}

/**
 * The roles whose name alone does not say what the unit is: `main - docs`, `subagent - scout`. The others (a tower, an outside pi) are their name. The separator is ASCII because the controller's holder writes the label into its notice through
 * `restrictLabel` (letters, digits, space, `.`, `_`, `-`; anything else becomes `_`, cut at 40), so the separator survives it. The name does not always: the card shows it whole, the notice restricted.
 */
const KIND: Record<string, string> = { main: "main", member: "member", subagent: "subagent", ally: "ally run", run: "run" };

/** The unit's name for a controller, or nothing when the unit has none left after the scrub (a name that was all path or token is a bare mark). `found` is what the net's registry holds for the unit's key. */
export function unitLabel(found: { name: string; role: string } | undefined): string | undefined {
	const name = allyLabel(found?.name);
	if (!found || !/[\p{L}\p{N}]/u.test(name)) return undefined;
	const kind = KIND[found.role];
	return kind ? `${kind} - ${name}` : name;
}
