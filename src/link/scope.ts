// Who an unattended box tells (docs/specs/2026-11-05-link-shared-box.md, Who is told). A question one of the box's units asks and a notice about one of its runs are for the controller that dispatched that run or
// unit, and for the team's admins. `{}` is a unit nobody dispatched (the box's own tower run, a session the boss opened there): the admins' alone. The signed policy names no other set, so there is none.

/** `"all"`: every controller of every team, as before this scope existed (an attended computer has none to tell). Otherwise the dispatching device, with its team when the unit's record names one. */
export type Scope = "all" | { device?: string; team?: string };
export const EVERYONE: Scope = "all";

/** Whether the controller `c` is told what `scope` covers; `admin` says whether a device is an admin of a team's roster now. */
export function reaches(scope: Scope, c: { team: string; device: string }, admin: (team: string, device: string) => boolean): boolean {
	if (scope === "all") return true;
	// An admin is the admin of a team: when the scope names one, the admins of other teams on the box are not told (g346-F001).
	if (admin(c.team, c.device) && (scope.team === undefined || scope.team === c.team)) return true;
	return scope.device !== undefined && scope.device === c.device && (scope.team === undefined || scope.team === c.team);
}
