import assert from "node:assert/strict";
import { test } from "node:test";
import type { Level, TeamPolicy } from "../src/link/config.ts";
import type { OperateGrant, Policy } from "../src/link/policy.ts";
import { admitOperate, checkOperate, type MemberOf, type Owner, REFUSALS, type Scope } from "../src/server/operatescope.ts";
import { DEVICES } from "./link/scenario.ts";

// The grant and the check of docs/specs/2026-11-07-link-operate.md §3: who may open an operate session on the box (checks 1 to 3, with the scope computed then), and what every request rechecks (all four,
// against the roster and the policy at that moment). The box here has two teams on one project, as agent-tower-01 does (`/srv/work` for both): a unit's team never comes from the folder.

const { alice, bob, carol, mallory } = DEVICES;
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
const tp = (name: string): TeamPolicy => ({ project: "/srv/work", share: "status", name });
const TEAMS = new Map([[A, tp("alpha")], [B, tp("beta")]]);

interface World {
	trust?: Record<string, Level>;
	operate?: Record<string, OperateGrant>;
	teams?: Map<string, TeamPolicy>;
	/** `team:device` → role and whether the device is attended; absent: not a member. */
	roster?: Record<string, { role: "admin" | "member"; attended?: boolean }>;
	owners?: Record<string, Owner>;
	policy?: Policy;
}
const ROSTER: Record<string, { role: "admin" | "member"; attended?: boolean }> = {
	[`${A}:${alice.id}`]: { role: "admin" }, [`${B}:${alice.id}`]: { role: "member" },
	[`${A}:${bob.id}`]: { role: "member" }, [`${B}:${bob.id}`]: { role: "admin" },
	[`${A}:${carol.id}`]: { role: "member" },
};
function world(w: World = {}) {
	const policy: Policy = w.policy ?? {
		mode: "unattended", teams: w.teams ?? TEAMS,
		trust: new Map(Object.entries(w.trust ?? { [alice.id]: "dispatch", [bob.id]: "dispatch", [carol.id]: "dispatch" })),
		operate: new Map(Object.entries(w.operate ?? { [alice.id]: "team", [bob.id]: "team", [carol.id]: "team" })),
	};
	const roster = w.roster ?? ROSTER;
	const member: MemberOf = (team, device) => {
		const m = roster[`${team}:${device}`];
		return m && { role: m.role, attended: m.attended ?? true };
	};
	const owners = w.owners ?? { "a-main": { team: A }, "b-main": { team: B }, "box-tower": { box: true } };
	return { policy, member, owner: (key: string) => owners[key] };
}
const scopeOf = (teams: string[], box = false): Scope => ({ teams, box });
const ok = <T extends { ok: boolean }>(r: T) => (assert.equal(r.ok, true, JSON.stringify(r)), r as Extract<T, { ok: true }>);
const no = <T extends { ok: boolean }>(r: T, reason: string) => (assert.equal(r.ok, false, JSON.stringify(r)), assert.equal((r as unknown as { reason: string }).reason, reason), r as Extract<T, { ok: false }>);

// ---- Open: checks 1 to 3, and the scope --------------------------------------------------------------------------------------------------------------

test("the refusal words are the five of the spec", () => {
	assert.deepEqual([...REFUSALS], ["not-granted", "not-admin", "out-of-scope", "local-only", "policy"]);
});

test("a granted admin opens: the scope is the teams it admins among the teams the policy names, and no box part for a team grant", () => {
	const r = ok(admitOperate(world(), { team: A, from: alice.id, want: "team" }));
	assert.deepEqual(r.scope, scopeOf([A]));
	assert.equal(r.grant, "team");
	assert.deepEqual(ok(admitOperate(world(), { team: B, from: bob.id, want: "team" })).scope, scopeOf([B]));
});

test("a team grant never gets the box part, whatever it asks for", () => {
	assert.deepEqual(ok(admitOperate(world(), { team: A, from: alice.id, want: "box" })).scope, scopeOf([A]), "want box, grant team: teams only");
});

test("the box grant gets the box part only when it asks for it; it needs no team to be admin of", () => {
	const w = world({ operate: { [alice.id]: "box", [carol.id]: "box" } });
	assert.deepEqual(ok(admitOperate(w, { team: A, from: alice.id, want: "box" })).scope, scopeOf([A], true));
	assert.deepEqual(ok(admitOperate(w, { team: A, from: alice.id, want: "team" })).scope, scopeOf([A]), "want team keeps the box part out");
	const carolOnly = ok(admitOperate(w, { team: A, from: carol.id, want: "box" }));
	assert.deepEqual(carolOnly.scope, scopeOf([], true), "a member that admins nothing still holds the box's own units");
	no(admitOperate(w, { team: A, from: carol.id, want: "team" }), "not-admin");
});

test("not-granted: no operate entry, an entry without dispatch in trust, no trust entry, not a member, not attended", () => {
	const q = (from: string, team = A) => ({ team, from, want: "team" as const });
	no(admitOperate(world({ operate: { [bob.id]: "team" } }), q(alice.id)), "not-granted");
	no(admitOperate(world({ trust: { [alice.id]: "forward" } }), q(alice.id)), "not-granted");
	no(admitOperate(world({ trust: { [alice.id]: "reply" } }), q(alice.id)), "not-granted");
	no(admitOperate(world({ trust: {} }), q(alice.id)), "not-granted");
	no(admitOperate(world(), q(mallory.id)), "not-granted");
	no(admitOperate(world({ operate: { ...{ [mallory.id]: "box" } }, trust: { [mallory.id]: "dispatch" } }), q(mallory.id)), "not-granted");
	no(admitOperate(world({ roster: { ...ROSTER, [`${A}:${alice.id}`]: { role: "admin", attended: false } } }), q(alice.id)), "not-granted");
});

test("not-admin: a member of the team with a team grant that admins nothing", () => {
	no(admitOperate(world(), { team: A, from: carol.id, want: "team" }), "not-admin");
	no(admitOperate(world({ roster: { ...ROSTER, [`${A}:${alice.id}`]: { role: "member" } } }), { team: A, from: alice.id, want: "team" }), "not-admin");
});

test("policy: attended, refused, malformed operate, or a team the policy does not name", () => {
	const q = { team: A, from: alice.id, want: "team" as const };
	no(admitOperate(world({ policy: { mode: "attended" } }), q), "policy");
	no(admitOperate(world({ policy: { mode: "refused", reason: "x" } }), q), "policy");
	const w = world();
	no(admitOperate({ ...w, policy: { ...(w.policy as Extract<Policy, { mode: "unattended" }>), operate: new Map(), operateRefused: "operate is malformed" } }, q), "policy");
	no(admitOperate(world({ teams: new Map([[B, tp("beta")]]) }), q), "policy");
});

test("both teams on one project: the folder decides nothing, a session reaches the team its open came on, and an admin of one team opens no session on the other", () => {
	const both = world({ roster: { ...ROSTER, [`${B}:${alice.id}`]: { role: "admin" } } });
	assert.deepEqual(ok(admitOperate(both, { team: A, from: alice.id, want: "team" })).scope, scopeOf([A]), "one session per (box, team): an admin of two reaches A on the A session");
	assert.deepEqual(ok(admitOperate(both, { team: B, from: alice.id, want: "team" })).scope, scopeOf([B]));
	assert.deepEqual(ok(admitOperate(world(), { team: A, from: alice.id, want: "team" })).scope, scopeOf([A]), "alice admins A and is a mere member of B");
	assert.deepEqual(ok(admitOperate(world(), { team: B, from: bob.id, want: "team" })).scope, scopeOf([B]));
	assert.equal(TEAMS.get(A)!.project, TEAMS.get(B)!.project, "the fixture really has one project for both");
});

// ---- A request: all four checks, again, now ----------------------------------------------------------------------------------------------------------

test("a request on a unit of the session's team passes; one with no unit (a list) passes the grant checks alone", () => {
	const w = world(), s = { team: A, from: alice.id, scope: scopeOf([A]) };
	ok(checkOperate(w, s, { unit: "a-main" }));
	ok(checkOperate(w, s, {}));
});

test("out-of-scope: another team's unit (g346-F001: the admin of team A has no reach into team B), a box unit without the box part, a unit nobody owns", () => {
	const w = world(), s = { team: A, from: alice.id, scope: scopeOf([A]) };
	no(checkOperate(w, s, { unit: "b-main" }), "out-of-scope");
	no(checkOperate(w, s, { unit: "box-tower" }), "out-of-scope");
	no(checkOperate(w, s, { unit: "no-such-unit" }), "out-of-scope");
	const bobS = { team: B, from: bob.id, scope: scopeOf([B]) };
	no(checkOperate(w, bobS, { unit: "a-main" }), "out-of-scope");
	ok(checkOperate(w, bobS, { unit: "b-main" }));
});

test("an admin who becomes admin of a second team after the open does not reach it until a new open: the scope is the one computed at the open", () => {
	const later = world({ roster: { ...ROSTER, [`${B}:${alice.id}`]: { role: "admin" } } });
	no(checkOperate(later, { team: A, from: alice.id, scope: scopeOf([A]) }, { unit: "b-main" }), "out-of-scope");
	ok(checkOperate(later, { team: A, from: alice.id, scope: scopeOf([A, B]) }, { unit: "b-main" }));
});

test("the box's units: reachable with the box part and a box grant, out-of-scope with a team grant", () => {
	const w = world({ operate: { [alice.id]: "box" } });
	ok(checkOperate(w, { team: A, from: alice.id, scope: scopeOf([A], true) }, { unit: "box-tower" }));
	no(checkOperate(w, { team: A, from: alice.id, scope: scopeOf([A], false) }, { unit: "box-tower" }), "out-of-scope");
	const team = world();
	no(checkOperate(team, { team: A, from: alice.id, scope: scopeOf([A], true) }, { unit: "box-tower" }), "not-granted", /* the grant was lowered to team since the open */);
});

test("local-only: a route the table keeps local, answered after the unit's scope so an unreachable unit learns nothing", () => {
	const w = world(), s = { team: A, from: alice.id, scope: scopeOf([A]) };
	no(checkOperate(w, s, { unit: "a-main", localOnly: true }), "local-only");
	no(checkOperate(w, s, { localOnly: true }), "local-only");
	no(checkOperate(w, s, { unit: "b-main", localOnly: true }), "out-of-scope");
});

test("not-admin: the operator was demoted after the open; the team leaves the reach, and the session ends when nothing is left", () => {
	const demoted = world({ roster: { ...ROSTER, [`${A}:${alice.id}`]: { role: "member" } } });
	const r = no(checkOperate(demoted, { team: A, from: alice.id, scope: scopeOf([A]) }, { unit: "a-main" }), "not-admin");
	assert.equal(r.ends, "roster", "the scope is empty now");
	const two = world({ roster: { ...ROSTER, [`${A}:${alice.id}`]: { role: "member" }, [`${B}:${alice.id}`]: { role: "admin" } } });
	const left = no(checkOperate(two, { team: A, from: alice.id, scope: scopeOf([A, B]) }, { unit: "a-main" }), "not-admin");
	assert.equal(left.ends, undefined, "team B is still in reach");
	ok(checkOperate(two, { team: A, from: alice.id, scope: scopeOf([A, B]) }, { unit: "b-main" }));
});

test("the grant checks run on every request and end the session: operate withdrawn, dispatch lost, the operator removed or unattended, the policy gone", () => {
	const s = { team: A, from: alice.id, scope: scopeOf([A]) };
	const ended = (w: ReturnType<typeof world>, reason: string, ends: "policy" | "roster") => assert.equal(no(checkOperate(w, s, { unit: "a-main" }), reason).ends, ends);
	ended(world({ operate: {} }), "not-granted", "policy");
	ended(world({ trust: { [alice.id]: "forward" } }), "not-granted", "policy");
	ended(world({ roster: {} }), "not-granted", "roster");
	ended(world({ roster: { ...ROSTER, [`${A}:${alice.id}`]: { role: "admin", attended: false } } }), "not-granted", "roster");
	ended(world({ policy: { mode: "attended" } }), "policy", "policy");
	ended(world({ policy: { mode: "refused", reason: "unreadable" } }), "policy", "policy");
	ended(world({ teams: new Map([[B, tp("beta")]]) }), "policy", "policy");
	const w = world();
	ended({ ...w, policy: { ...(w.policy as Extract<Policy, { mode: "unattended" }>), operate: new Map(), operateRefused: "bad" } }, "policy", "policy");
});

test("a refusal says only its word: no unit, team or device text rides on it", () => {
	const w = world(), s = { team: A, from: alice.id, scope: scopeOf([A]) };
	for (const unit of ["b-main", "box-tower", "no-such-unit"]) assert.deepEqual(Object.keys(no(checkOperate(w, s, { unit }), "out-of-scope")).sort(), ["ok", "reason"]);
});
