import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Level, TeamPolicy } from "../src/link/config.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { type OperateGrant, type Policy, watchPolicy } from "../src/link/policy.ts";
import { removeEntry, roleEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { createOperateGuard, type GuardSession } from "../src/server/operateguard.ts";
import type { EndReason, MemberOf, Owner } from "../src/server/operatescope.ts";
import { fakeClock } from "./fake-clock.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, carol, clientFor, netOf, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, TEAM, teamKey } from "./link/scenario.ts";

// Teardown (docs/specs/2026-11-07-link-operate.md §5.6): the box ends an operate session at once when the grant it stands on goes: a policy edit within the next 2 s poll, a refused or unreadable policy, a roster
// change when it arrives. One bad read ends: ending a view loses no work, and a session that outlives its grant is the one failure that must not happen. The session layer (task 5) gives the guard its `end`;
// here `end` records what it was told. Nothing in this file sleeps: the poll runs on a clock the test moves.

const A = "a".repeat(32), B = "b".repeat(32);
const tp = (name: string): TeamPolicy => ({ project: "/srv/work", share: "status", name });
type Un = Extract<Policy, { mode: "unattended" }>;

interface State { policy: Policy | "throws"; roster: Record<string, { role: "admin" | "member"; attended?: boolean }>; stamp: number; reads: number; membersThrow: boolean }
function world(over: { trust?: Record<string, Level>; operate?: Record<string, OperateGrant> } = {}) {
	const clock = fakeClock(1_000_000);
	const state: State = {
		policy: {
			mode: "unattended", teams: new Map([[A, tp("alpha")], [B, tp("beta")]]),
			trust: new Map(Object.entries(over.trust ?? { [alice.id]: "dispatch", [bob.id]: "dispatch", [carol.id]: "dispatch" })),
			operate: new Map(Object.entries(over.operate ?? { [alice.id]: "box", [bob.id]: "team", [carol.id]: "team" })),
		},
		roster: { [`${A}:${alice.id}`]: { role: "admin" }, [`${A}:${bob.id}`]: { role: "member" }, [`${B}:${bob.id}`]: { role: "admin" }, [`${A}:${carol.id}`]: { role: "admin" }, [`${B}:${carol.id}`]: { role: "admin" } },
		stamp: 1, reads: 0, membersThrow: false,
	};
	const ended: [string, EndReason][] = [], logs: Record<string, unknown>[] = [];
	const member: MemberOf = (team, device) => {
		if (state.membersThrow) return undefined;
		const m = state.roster[`${team}:${device}`];
		return m && { role: m.role, attended: m.attended ?? true };
	};
	const owners: Record<string, Owner> = { "a-main": { team: A }, "b-main": { team: B }, tower: { box: true } };
	const guard = createOperateGuard({
		policy: () => { state.reads++; if (state.policy === "throws") throw new Error("EIO: policy unreadable"); return state.policy; },
		member, owner: (key) => owners[key], now: clock.now,
		end: (s: GuardSession, reason) => void ended.push([s.id, reason]), log: (entry) => void logs.push(entry),
	});
	return { clock, state, guard, ended, logs, edit: (fn: (p: Un) => void) => { const p = state.policy as Un; fn(p); state.stamp++; } };
}
type World = ReturnType<typeof world>;
const open = (w: World, id: string, team: string, from: string, want: "team" | "box" = "team") => {
	const r = w.guard.admit({ id, team, from, want });
	assert.equal(r.ok, true, `${id}: ${JSON.stringify(r)}`);
	return r;
};
const ids = (w: World) => w.guard.sessions().map((s) => s.id).sort();

/** The poll and the file watcher of the policy, on the test's clock and a watcher the test fires. */
function watched(w: World) {
	let fire: (() => void) | undefined, closed = 0, cancelled = 0;
	const after = (ms: number, fn: () => void) => {
		let live = true;
		w.clock.at(w.clock.elapsed() + ms, () => live && fn());
		return () => ((live = false), void cancelled++);
	};
	const watcher = watchPolicy(() => w.guard.onPolicy(), {
		path: "/etc/straw-link/policy.json", stamp: () => String(w.state.stamp), after, pollMs: 2000,
		watch: (_path, cb) => ((fire ??= cb), { close: () => void closed++ }),
	});
	return { watcher, fire: () => fire?.(), closed: () => closed, cancelled: () => cancelled };
}

// ---- A policy edit -------------------------------------------------------------------------------------------------------------------------------------

test("a policy edit that withdraws a device's operate ends its sessions within the 2 s poll, and leaves the others", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	open(w, "s-bob", B, bob.id);
	w.clock.advance(500);
	w.edit((policy) => policy.operate.delete(alice.id));
	const editedAt = w.clock.elapsed();
	w.clock.advance(1499);
	assert.deepEqual(w.ended, [], "the poll has not come round yet");
	w.clock.advance(1);
	assert.deepEqual(w.ended, [["s-alice", "policy"]], "the poll found the edit inside 2 s of it");
	assert.ok(w.clock.elapsed() - editedAt <= 2000);
	assert.deepEqual(ids(w), ["s-bob"]);
	w.clock.advance(60_000);
	assert.deepEqual(w.ended, [["s-alice", "policy"]], "nothing ends twice");
	p.watcher.stop();
});

test("the file watcher ends it at once, with no poll", () => {
	const w = world(), p = watched(w);
	open(w, "s-bob", B, bob.id);
	w.edit((policy) => policy.trust.set(bob.id, "forward"));
	assert.deepEqual(w.ended, [], "nothing until a change is seen");
	p.fire();
	assert.deepEqual(w.ended, [["s-bob", "policy"]]);
	p.watcher.stop();
});

test("an edit that touches nobody's grant ends nothing, and a calm file is not read again", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	const before = w.state.reads;
	w.clock.advance(20_000);
	assert.equal(w.state.reads, before, "no change, no read");
	w.edit((policy) => policy.trust.set("zzzzzzzzzzzzzzzzzzzzzzzzzz", "reply"));
	w.clock.advance(2000);
	assert.equal(w.state.reads, before + 1, "one read for the one change");
	assert.deepEqual(w.ended, []);
	assert.deepEqual(ids(w), ["s-alice"]);
	p.watcher.stop();
});

test("a policy that is refused now ends every session, whoever holds what", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	open(w, "s-bob", B, bob.id);
	w.state.policy = { mode: "refused", reason: "/etc/straw-link is writable by this device's own user" };
	w.state.stamp++;
	w.clock.advance(2000);
	assert.deepEqual(w.ended.sort(), [["s-alice", "policy"], ["s-bob", "policy"]]);
	assert.deepEqual(ids(w), []);
	p.watcher.stop();
});

test("a policy file that vanishes (attended again) ends every session", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	w.state.policy = { mode: "attended" };
	w.state.stamp++;
	w.clock.advance(2000);
	assert.deepEqual(w.ended, [["s-alice", "policy"]]);
	p.watcher.stop();
});

test("a malformed operate turns operate off for the whole box: every session ends, trust and teams untouched", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	open(w, "s-bob", B, bob.id);
	w.edit((policy) => ((policy as { operate: Map<string, OperateGrant> }).operate = new Map(), (policy as { operateRefused?: string }).operateRefused = "operate has to be an object"));
	w.clock.advance(2000);
	assert.deepEqual(w.ended.sort(), [["s-alice", "policy"], ["s-bob", "policy"]]);
	p.watcher.stop();
});

test("a device that falls below dispatch in trust ends", () => {
	const w = world(), p = watched(w);
	open(w, "s-carol", A, carol.id);
	w.edit((policy) => policy.trust.set(carol.id, "forward"));
	w.clock.advance(2000);
	assert.deepEqual(w.ended, [["s-carol", "policy"]]);
	p.watcher.stop();
});

test("one bad read ends: a policy that cannot be read once, with no second look", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	w.state.policy = "throws";
	w.state.stamp++;
	w.clock.advance(2000);
	assert.deepEqual(w.ended, [["s-alice", "policy"]]);
	assert.ok(w.logs.some((l) => l.event === "operate-policy-unreadable"), "said once");
	p.watcher.stop();
});

test("a box grant lowered to team keeps the session but drops its box part", () => {
	const w = world(), p = watched(w);
	open(w, "s-alice", A, alice.id, "box");
	assert.deepEqual(w.guard.sessions()[0]!.scope, { teams: [A], box: true });
	w.edit((policy) => policy.operate.set(alice.id, "team"));
	w.clock.advance(2000);
	assert.deepEqual(w.ended, []);
	assert.deepEqual(w.guard.sessions()[0]!.scope, { teams: [A], box: false });
	const r = w.guard.check("s-alice", { unit: "tower" });
	assert.equal(r.ok, false);
	assert.equal(w.guard.check("s-alice", { unit: "a-main" }).ok, true);
	p.watcher.stop();
});

test("the watcher's poll and file watches stop with it", () => {
	const w = world(), p = watched(w);
	assert.equal(p.closed(), 0);
	p.watcher.stop();
	assert.ok(p.closed() >= 1, "the file watch is closed");
	const reads = w.state.reads;
	w.state.stamp++;
	w.clock.advance(10_000);
	assert.equal(w.state.reads, reads, "the poll no longer runs");
});

test("a stamp that differs is a change, the same stamp again is not", () => {
	let stamp = "1", changes = 0, timer: (() => void) | undefined;
	const watcher = watchPolicy(() => void changes++, { path: "/etc/straw-link/policy.json", stamp: () => stamp, pollMs: 2000, after: (_ms, fn) => ((timer = fn), () => void (timer = undefined)), watch: () => ({ close() {} }) });
	timer?.();
	assert.equal(changes, 0);
	stamp = "gone";
	timer?.();
	assert.equal(changes, 1);
	timer?.();
	assert.equal(changes, 1, "the same stamp again is no change");
	watcher.stop();
	assert.equal(timer, undefined, "the poll is cancelled");
});

test("on a real file: a rewrite, a replacement by rename and a removal each reach onChange, and stop closes the watches", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-operate-watch-")), path = join(dir, "policy.json");
	try {
		writeFileSync(path, "{}");
		let changes = 0;
		const watcher = watchPolicy(() => void changes++, { path, pollMs: 50 });
		const seen = async (from: number, what: string) => (await until(() => changes > from, 5000, what), changes);
		writeFileSync(path, '{"unattended":true}');
		let n = await seen(0, "the rewrite");
		writeFileSync(join(dir, "next.json"), "{}");
		renameSync(join(dir, "next.json"), path);
		n = await seen(n, "the replacement");
		rmSync(path);
		n = await seen(n, "the removal");
		watcher.stop();
		const after = changes;
		writeFileSync(path, "{}");
		await until(() => existsSync(path), 1000, "the file");
		assert.equal(changes, after, "a stopped watcher says nothing more");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- A roster change -----------------------------------------------------------------------------------------------------------------------------------

test("an admin demoted ends its session when its only team goes, and loses just that team when it has two", () => {
	const w = world();
	open(w, "s-bob", B, bob.id);
	open(w, "s-carol", A, carol.id);
	assert.deepEqual(w.guard.sessions().find((s) => s.id === "s-carol")!.scope.teams.sort(), [A, B]);
	w.state.roster[`${B}:${bob.id}`] = { role: "member" };
	w.guard.onRoster(B);
	assert.deepEqual(w.ended, [["s-bob", "roster"]]);
	assert.deepEqual(w.guard.sessions().find((s) => s.id === "s-carol")!.scope.teams, [A, B], "carol is still admin of B");
	w.state.roster[`${B}:${carol.id}`] = { role: "member" };
	w.guard.onRoster(B);
	assert.deepEqual(w.ended, [["s-bob", "roster"]], "carol keeps A");
	assert.deepEqual(w.guard.sessions().find((s) => s.id === "s-carol")!.scope.teams, [A], "B left carol's reach");
	assert.equal(w.guard.check("s-carol", { unit: "b-main" }).ok, false);
	assert.equal(w.guard.check("s-carol", { unit: "a-main" }).ok, true);
	w.state.roster[`${A}:${carol.id}`] = { role: "member" };
	w.guard.onRoster(A);
	assert.deepEqual(w.ended, [["s-bob", "roster"], ["s-carol", "roster"]]);
});

test("a removed member ends; so does one that is no longer attended", () => {
	const w = world();
	open(w, "s-alice", A, alice.id, "box");
	open(w, "s-bob", B, bob.id);
	delete w.state.roster[`${B}:${bob.id}`];
	w.guard.onRoster(B);
	assert.deepEqual(w.ended, [["s-bob", "roster"]]);
	w.state.roster[`${A}:${alice.id}`] = { role: "admin", attended: false };
	w.guard.onRoster(A);
	assert.deepEqual(w.ended, [["s-bob", "roster"], ["s-alice", "roster"]]);
});

test("the box removed from the team (members read as nobody) ends every session of that team at once", () => {
	const w = world();
	open(w, "s-alice", A, alice.id, "box");
	open(w, "s-bob", B, bob.id);
	w.state.membersThrow = true;
	w.guard.onRoster(A);
	assert.deepEqual(w.ended, [["s-alice", "roster"]], "a bad read ends; another team's session is not looked at");
	w.guard.onRoster(B);
	assert.deepEqual(w.ended, [["s-alice", "roster"], ["s-bob", "roster"]]);
});

test("a roster change of one team does not look at, let alone end, another team's session", () => {
	const w = world();
	open(w, "s-bob", B, bob.id);
	w.state.roster[`${A}:${alice.id}`] = { role: "member" };
	w.guard.onRoster(A);
	assert.deepEqual(w.ended, []);
	assert.deepEqual(ids(w), ["s-bob"]);
});

test("a request rechecks everything and ends the session itself when the grant is gone, without waiting for a poll or an event", () => {
	const w = world();
	open(w, "s-alice", A, alice.id, "box");
	assert.deepEqual(w.guard.check("s-alice", { unit: "a-main" }), { ok: true });
	w.state.roster[`${A}:${alice.id}`] = { role: "member" };
	const r = w.guard.check("s-alice", { unit: "a-main" });
	assert.equal(r.ok, false);
	assert.equal(r.ok === false && r.reason, "not-admin");
	assert.deepEqual(w.ended, [], "the box part is still there: the session stays for the box's units");
	assert.equal(w.guard.check("s-alice", { unit: "tower" }).ok, true);
	w.edit((policy) => policy.operate.delete(alice.id));
	const gone = w.guard.check("s-alice", { unit: "tower" });
	assert.equal(gone.ok === false && gone.reason, "not-granted");
	assert.deepEqual(w.ended, [["s-alice", "policy"]]);
	assert.equal(w.guard.check("s-alice", { unit: "tower" }).ok, false, "an ended session answers nothing");
	assert.equal(w.guard.check("nope", {}).ok, false, "an unknown session id answers nothing");
});

test("an end callback that throws does not keep the others from ending, and what it threw is not logged", () => {
	const clock = fakeClock();
	const policy = { mode: "unattended", teams: new Map([[A, tp("alpha")]]), trust: new Map([[alice.id, "dispatch" as Level], [bob.id, "dispatch" as Level]]), operate: new Map([[alice.id, "team" as OperateGrant], [bob.id, "team" as OperateGrant]]) } satisfies Policy;
	let current: Policy = policy;
	const ended: string[] = [], logs: Record<string, unknown>[] = [];
	const guard = createOperateGuard({
		policy: () => current, member: (_t, d) => (d === alice.id || d === bob.id ? { role: "admin", attended: true } : undefined), owner: () => undefined, now: clock.now,
		end: (s) => { ended.push(s.id); throw new Error("typed text: secret marker"); }, log: (entry) => void logs.push(entry),
	});
	for (const [id, from] of [["s1", alice.id], ["s2", bob.id]] as const) assert.equal(guard.admit({ id, team: A, from, want: "team" }).ok, true);
	current = { mode: "attended" };
	guard.onPolicy();
	assert.deepEqual(ended.sort(), ["s1", "s2"]);
	assert.deepEqual(guard.sessions(), []);
	assert.ok(logs.some((l) => l.event === "operate-end-failed"));
	assert.ok(!JSON.stringify(logs).includes("secret marker"), "the log carries no text of the error");
});

test("release forgets a session the operator closed: nothing ends it later", () => {
	const w = world();
	open(w, "s-bob", B, bob.id);
	w.guard.release("s-bob");
	w.state.policy = { mode: "attended" };
	w.guard.onPolicy();
	assert.deepEqual(w.ended, []);
});

test("an admit that is refused registers nothing", () => {
	const w = world();
	w.state.roster[`${A}:${alice.id}`] = { role: "member" };
	assert.deepEqual(w.guard.admit({ id: "s-x", team: A, from: alice.id, want: "team" }), { ok: false, reason: "not-admin" });
	assert.deepEqual(w.guard.admit({ id: "s-y", team: A, from: DEVICES.mallory.id, want: "team" }), { ok: false, reason: "not-granted" });
	assert.deepEqual(ids(w), []);
});

// ---- The holder's roster hook ------------------------------------------------------------------------------------------------------------------------

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-operate-teardown-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

/** Bob is the box (an unattended holder); alice is the founder and admin, carol a member. `hook` is what the holder's `onRoster` option does. */
function box(hook: (team: string, holder: LinkHolder) => void) {
	const entries = rosterOf(["bob", "carol"]), dir = join(root, "box", "link"), project = join(root, "project");
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, bob, "ci-box");
	writeTeam(store, entries, bob);
	const holder: LinkHolder = new LinkHolder({
		store, isHolder: () => true, attended: () => false, net: async () => netOf([]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: 5,
		onRoster: (team) => hook(team, holder),
	});
	cleanup.push(() => holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id], entries);
	return { holder, store, entries, dir };
}
const teamEntries = (dir: string) => (JSON.parse(readFileSync(join(dir, "teams", `${TEAM_HEX}.json`), "utf8")) as { entries: string[] }).entries.length;
const logOf = (dir: string) => readFileSync(join(dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("holder: member() reads the roster now, and the onRoster hook runs after each applied entry with the roster already changed", async () => {
	const seen: { team: string; carol: string; alice: string }[] = [];
	const b = box((team, holder) => void seen.push({ team, carol: JSON.stringify(holder.member(team, carol.id) ?? null), alice: JSON.stringify(holder.member(team, alice.id) ?? null) }));
	await b.holder.start();
	assert.deepEqual(b.holder.member(TEAM_HEX, alice.id), { role: "admin", attended: true });
	assert.deepEqual(b.holder.member(TEAM_HEX, carol.id), { role: "member", attended: true });
	assert.equal(b.holder.member(TEAM_HEX, DEVICES.mallory.id), undefined, "not a member");
	assert.equal(b.holder.member("f".repeat(32), alice.id), undefined, "not a team of this holder");
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, role: "admin" }));
	await until(() => seen.length === 1, 3000, "the hook after the promotion");
	assert.deepEqual(seen[0], { team: TEAM_HEX, carol: JSON.stringify({ role: "admin", attended: true }), alice: JSON.stringify({ role: "admin", attended: true }) });
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, role: "member" }));
	await until(() => seen.length === 2, 3000, "the hook after the demotion");
	assert.equal(JSON.parse(seen[1]!.carol).role, "member", "the demotion is visible when the hook runs");
	relay.pushRoster(TEAM, removeEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, newKey: teamKey(2) }));
	await until(() => seen.length === 3, 3000, "the hook after the removal");
	assert.equal(seen[2]!.carol, "null", "the removal is visible when the hook runs");
	assert.equal(teamEntries(b.dir), b.entries.length, "the hook ran after the entries were stored");
});

test("holder: an entry already known does not call the hook again", async () => {
	let calls = 0;
	const b = box(() => void calls++);
	await b.holder.start();
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, role: "admin" }));
	await until(() => calls === 1, 3000, "the hook");
	relay.dropStreams();
	await until(() => relay.streams.some((s) => !s.closed), 3000, "the stream again");
	assert.equal(calls, 1);
});

test("holder: a hook that throws stops nothing, and what it threw is not in the log", async () => {
	let calls = 0;
	const b = box(() => { calls++; throw new Error("typed text: secret marker"); });
	await b.holder.start();
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, role: "admin" }));
	await until(() => calls === 1, 3000, "the hook");
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: carol.id, role: "member" }));
	await until(() => calls === 2, 3000, "the hook again: the team still takes entries");
	assert.ok(logOf(b.dir).some((e) => e.event === "operate-roster-hook-failed"));
	assert.ok(!readFileSync(join(b.dir, "link.log"), "utf8").includes("secret marker"));
	assert.ok(!logOf(b.dir).some((e) => e.event === "team-stopped"));
});

test("holder: the box itself removed from the team stops the team, and the hook runs with every member reading as nobody", async () => {
	const seen: string[] = [];
	const b = box((team, holder) => void seen.push(JSON.stringify(holder.member(team, alice.id) ?? null)));
	await b.holder.start();
	assert.equal(b.holder.member(TEAM_HEX, alice.id)?.role, "admin");
	relay.pushRoster(TEAM, removeEntry({ state: stateOf(b.entries, alice), signer: alice, subjectId: bob.id, newKey: teamKey(2) }));
	await until(() => seen.length >= 1, 3000, "the hook after the box's removal");
	assert.equal(seen[0], "null", "a stopped team has no members to trust");
	assert.equal(b.holder.member(TEAM_HEX, alice.id), undefined);
});
