import type { OperateGrant, Policy } from "../link/policy.ts";
import type { Role } from "../link/roster.ts";
import type { Pane } from "../herdr.ts";
import type { Ref } from "../net.ts";
import { readRoutes } from "./allyroute.ts";
import type { Slot } from "./record.ts";
import { readRun } from "./towerrunstore.ts";

// Who may operate what on an unattended box (docs/specs/2026-11-07-link-operate.md §3 and §4), as pure functions over facts the caller reads: the policy, the roster, and the box's own records of who started a unit.
//
// The check (§3.2) has four parts, made at the box on every request: this device is unattended and its policy reads so now; the sender is a current, attended member of the team the session came on; the sender is at `dispatch`
// in `trust` and `operate` names it; and the unit the request names is in the session's scope, for a team's unit with the sender a roster admin of that team now. A session is admitted by the first three and its scope
// (the teams it admins among the teams the policy names, and the box part) is computed then; a request is rechecked against the scope of the open, narrowed by what the roster and the policy say now, never widened by it.
//
// A unit belongs to a team only through the box's records of who started it, and the real box has two teams on one project, so the folder, the workspace and the unit's name decide nothing. Everything not attributed is the box's.
// The residual of the shared-box spec stands: this decides whom the box shows a unit to over the link, and is no wall between two users of one Unix account.

/** The words a refusal carries to the controller, and into link.log: no unit, team or device text rides on them. */
export const REFUSALS = ["not-granted", "not-admin", "out-of-scope", "local-only", "policy"] as const;
export type Refusal = (typeof REFUSALS)[number];
/** Why the box ends a session on its own: the policy (the operator's grant, or the policy itself) or the roster (membership, role). It is the reason word of the `close` and of `operate-close` in link.log. */
export type EndReason = "policy" | "roster";

/** What a session reaches: the teams (ids) whose units it may see and drive, and whether the box's own units are in. */
export interface Scope { teams: string[]; box: boolean }
/** The owner of a unit: a team, or the box. */
export type Owner = { team: string } | { box: true };
/** A device's place on a team's roster now (`LinkHolder.member`). */
export type MemberOf = (team: string, device: string) => { role: Role | string; attended: boolean } | undefined;

type Unattended = Extract<Policy, { mode: "unattended" }>;
interface Standing { policy: Unattended; grant: OperateGrant; teams: string[] }

/**
 * Checks 1 to 3 of §3.2 for `from` on the team the session came on: the word and the end reason when one fails, else the grant and the teams `from` is an attended admin of among the teams the policy names (in the policy's order).
 * A malformed `operate` has turned operate off for the box, so every device reads as `policy`.
 */
function standing(d: { policy: Policy; member: MemberOf }, team: string, from: string): ({ ok: true } & Standing) | { ok: false; reason: Refusal; ends: EndReason } {
	const policy = d.policy;
	if (policy.mode !== "unattended" || policy.operateRefused !== undefined || !policy.teams.has(team)) return { ok: false, reason: "policy", ends: "policy" };
	const me = d.member(team, from);
	if (!me || !me.attended) return { ok: false, reason: "not-granted", ends: "roster" };
	const grant = policy.operate.get(from);
	if (grant === undefined || policy.trust.get(from) !== "dispatch") return { ok: false, reason: "not-granted", ends: "policy" };
	const teams = [...policy.teams.keys()].filter((t) => { const m = d.member(t, from); return m?.role === "admin" && m.attended; });
	return { ok: true, policy, grant, teams };
}

/** A session is admitted by checks 1 to 3: its scope is the team its `open` came on when `from` admins it (one session per (box, team), §5.6), plus the box part only for a `box` grant that asked for it. Nothing to reach (`not-admin`) is a refusal. */
export function admitOperate(d: { policy: Policy; member: MemberOf }, q: { team: string; from: string; want: "team" | "box" }): { ok: true; grant: OperateGrant; scope: Scope } | { ok: false; reason: Refusal } {
	const st = standing(d, q.team, q.from);
	if (!st.ok) return { ok: false, reason: st.reason };
	const scope: Scope = { teams: st.teams.filter((t) => t === q.team), box: q.want === "box" && st.grant === "box" };
	return scope.teams.length || scope.box ? { ok: true, grant: st.grant, scope } : { ok: false, reason: "not-admin" };
}

/** What `checkOperate` answers: ok, or a word. `ends` is set when the failure is the grant and not the unit (§5.6: the session closes then): the policy, or the roster. */
export type Verdict = { ok: true } | { ok: false; reason: Refusal; ends?: EndReason };

/**
 * All four checks of §3.2 for one request of a session, against the roster and the policy now. `unit` is the box key the request names (none for a list or the like); `localOnly` is the route table's word that the route stays on the
 * box's console (task 4), answered last so a unit out of reach learns nothing from it. The reach is the session's own scope, narrowed by what the grant is now.
 */
export function checkOperate(d: { policy: Policy; member: MemberOf; owner(key: string): Owner | undefined }, s: { team: string; from: string; scope: Scope }, q: { unit?: string; localOnly?: boolean }): Verdict {
	const st = standing(d, s.team, s.from);
	if (!st.ok) return { ok: false, reason: st.reason, ends: st.ends };
	const teams = s.scope.teams.filter((t) => st.teams.includes(t)), box = s.scope.box && st.grant === "box";
	if (!teams.length && !box) return s.scope.box && st.grant !== "box" ? { ok: false, reason: "not-granted", ends: "policy" } : { ok: false, reason: "not-admin", ends: "roster" };
	const refuse = (reason: Refusal, ends?: EndReason): Verdict => ({ ok: false, reason, ...(ends ? { ends } : {}) });
	if (q.unit !== undefined) {
		let owner: Owner | undefined;
		try {
			owner = d.owner(q.unit);
		} catch {
			owner = undefined;
		}
		if (!owner) return refuse("out-of-scope");
		if ("team" in owner) {
			if (!s.scope.teams.includes(owner.team)) return refuse("out-of-scope");
			if (!teams.includes(owner.team)) return refuse("not-admin");
		} else {
			if (!s.scope.box) return refuse("out-of-scope");
			if (!box) return refuse("not-granted");
		}
	}
	return q.localOnly ? refuse("local-only") : { ok: true };
}

/** The session's scope after a recheck: the teams it still admins and the box part while the grant is `box`; the end reason when nothing is left (the policy when the box part was all it had and the grant was lowered). */
export function narrow(d: { policy: Policy; member: MemberOf }, s: { team: string; from: string; scope: Scope }): { ok: true; scope: Scope } | { ok: false; ends: EndReason } {
	const st = standing(d, s.team, s.from);
	if (!st.ok) return { ok: false, ends: st.ends };
	const scope: Scope = { teams: s.scope.teams.filter((t) => st.teams.includes(t)), box: s.scope.box && st.grant === "box" };
	if (scope.teams.length || scope.box) return { ok: true, scope };
	return { ok: false, ends: s.scope.box && st.grant !== "box" ? "policy" : "roster" };
}

// ---- Whose unit is it (§4) ---------------------------------------------------------------------------------------------------------------------------

/** The facts the owner of a unit is read from. The registry's `Ref` is what the net knows of a key (role, workspace as `base`, pane); `panes` is Herdr's listing now. */
export interface OwnerWorld {
	ref(key: string): Ref | undefined;
	refs(): Iterable<Ref>;
	/** Herdr's listing now, or nothing when it could not be read (never read, or the last read failed): a unit whose tab is unknown is then nobody's. */
	panes(): Pane[] | undefined;
	/** The panes of the live ally runs, with the device and team each serves (runs.ts `allyPanes`). */
	allyPanes(): { pane: string; device: string; team?: string }[];
	/** The run record of `id` in `workspace`, live or finished. */
	run(workspace: string, id: string): { kind: "local" | "ally"; team?: string } | undefined;
	/** The `opened` route rows of `workspace`: the mains ally runs opened, with the device and team they were opened for, and the pane the row kept as a second witness. */
	opened(workspace: string): { to: string; device: string; team: string; pane?: string }[];
}

const BOX: Owner = { box: true };
const DEVICE_ID = /^[a-z2-7]{26}$/;
/** The device a pane token names, as `dispatcherOf` reads it: `link:<device>`, the prefix possibly doubled; nothing for another token. */
const claimed = (token: string | undefined): string | undefined => (typeof token === "string" && token.startsWith("link:") ? token.replace(/^(link:)+/, "") : undefined);

/**
 * The owner of the unit with box key `key`, or nothing when the net does not know the key. The rows of §4:
 *   - an ally run (`ally-<run>`): its record's team, live or finished; no record or no team: the box's;
 *   - a live ally pane: matched by pane id, its record's team;
 *   - a main an ally run opened, and the member or subagent panes in its tab: the `opened` row's team, only when the pane token (`sb_opened_by=link:<device>`) of the tab names the row's device: two witnesses. Any disagreement (a row for
 *     another device, two panes naming two devices, a token that is no device) makes the unit nobody's, which is the box's. One witness alone attributes nothing;
 *   - the tower service, its runs, a session opened at the box, a worker in a tab of its own, anything else: the box's;
 *   - a main, member or subagent when Herdr's listing could not be read: nobody's (no scope holds it, the box part included) until a read succeeds. An ally run's key and a live ally pane need no listing.
 */
export function ownerOf(w: OwnerWorld, key: string): Owner | undefined {
	const ref = w.ref(key);
	if (!ref) return undefined;
	if (ref.role === "ally") {
		const id = ref.key.startsWith("ally-") ? ref.key.slice("ally-".length) : undefined, run = id ? w.run(ref.base, id) : undefined;
		return run?.kind === "ally" && run.team ? { team: run.team } : BOX;
	}
	if ((ref.role !== "main" && ref.role !== "member" && ref.role !== "subagent") || !ref.pane) return BOX;
	const ally = w.allyPanes().find((a) => a.pane === ref.pane);
	if (ally) return ally.team ? { team: ally.team } : BOX;
	const panes = w.panes();
	if (!panes) return undefined; // no listing, no witness: neither a team's nor the box's, so no session's scope holds it (the ally cases above need none)
	const mine = panes.find((p) => p.pane_id === ref.pane);
	if (!mine) return BOX;
	const tab = panes.filter((p) => p.tab_id === mine.tab_id), tabIds = new Set(tab.map((p) => p.pane_id));
	const named = tab.flatMap((p) => { const token = p.tokens?.sb_opened_by; return typeof token === "string" && token.startsWith("link:") ? [claimed(token)] : []; });
	const devices = new Set(named);
	const device = devices.size === 1 ? [...devices][0] : undefined;
	if (device === undefined || !DEVICE_ID.test(device)) return BOX;
	const mains = new Set([...w.refs()].filter((r) => r.role === "main" && r.base === ref.base && r.pane !== undefined && tabIds.has(r.pane)).map((r) => r.key));
	const rows = w.opened(ref.base).filter((r) => mains.has(r.to) || (r.pane !== undefined && tabIds.has(r.pane)));
	if (!rows.length || rows.some((r) => r.device !== device || !r.team || r.team !== rows[0]!.team)) return BOX;
	return { team: rows[0]!.team };
}

/** The facts as the box's own files give them: run records and the route table under `slot`, and what the caller reads live (the registry, Herdr's listing, the live ally panes). */
export function storeOwnerWorld(d: { slot: Slot; now(): number; refs(): Iterable<Ref>; panes(): Pane[] | undefined; allyPanes(): { pane: string; device: string; team?: string }[] }): OwnerWorld {
	return {
		ref: (key) => [...d.refs()].find((r) => r.key === key),
		refs: d.refs,
		panes: d.panes,
		allyPanes: d.allyPanes,
		run: (workspace, id) => { const run = readRun(d.slot, workspace, id); return run && { kind: run.kind, ...(run.team ? { team: run.team } : {}) }; },
		opened: (workspace) => readRoutes(d.slot, workspace, d.now()).flatMap((r) => (r.kind === "opened" ? [{ to: r.to, device: r.device, team: r.team, ...(r.pane ? { pane: r.pane } : {}) }] : [])),
	};
}
