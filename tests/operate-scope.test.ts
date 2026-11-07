import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Pane } from "../src/herdr.ts";
import type { Ref } from "../src/net.ts";
import { addRoute, type Route } from "../src/server/allyroute.ts";
import { ownerOf, type OwnerWorld, storeOwnerWorld } from "../src/server/operatescope.ts";
import { slotOf } from "../src/server/record.ts";
import { type RunRecord, writeRun } from "../src/server/towerrunstore.ts";
import { DEVICES } from "./link/scenario.ts";

// Whose unit is it (docs/specs/2026-11-07-link-operate.md §4): one test per row of the table. A unit belongs to a team only through the box's own records of who started it, and the real box has two teams on one
// project (`/srv/work`), so the folder, the workspace and the unit's name decide nothing. Everything not attributed is the box's.

const { alice, bob } = DEVICES;
const A = "a".repeat(32), B = "b".repeat(32), WS = "w1";
const pane = (id: string, tab: string, tokens: Record<string, string> = {}): Pane => ({ pane_id: id, tab_id: tab, workspace_id: WS, cwd: "/srv/work", tokens });
const ref = (key: string, role: string, p?: string, base = WS): Ref => ({ key, base, name: key, role, ...(p ? { pane: p } : {}) });
const opened = (to: string, device: string, team: string, over: Partial<Route> = {}): Route => ({ to, device, team, kind: "opened", at: Date.now(), name: to, label: "x", short: "x", teamName: "x", ...over });
const by = (device: string) => ({ sb_opened_by: `link:${device}` });

interface Facts { refs: Ref[]; panes: Pane[]; /** Herdr's listing could not be read (a failed `pane list`): `panes()` answers nothing. */ unread?: true; ally?: { pane: string; device: string; team?: string }[]; runs?: Record<string, Partial<RunRecord>>; rows?: Route[] }
const world = (f: Facts): OwnerWorld => ({
	ref: (key) => f.refs.find((r) => r.key === key),
	refs: () => f.refs,
	panes: () => (f.unread ? undefined : f.panes),
	allyPanes: () => f.ally ?? [],
	run: (workspace, id) => (workspace === WS ? (f.runs?.[id] as RunRecord | undefined) : undefined),
	opened: (workspace) => (workspace === WS ? (f.rows ?? []).filter((r) => r.kind === "opened") : []),
});
const own = (f: Facts, key: string) => ownerOf(world(f), key);

test("row 1: an ally run, live or finished, belongs to its record's team", () => {
	const f: Facts = { refs: [ref("ally-r1", "ally"), ref("ally-r2", "ally")], panes: [], runs: { r1: { kind: "ally", team: A, device: alice.id }, r2: { kind: "ally", team: B, device: bob.id, endedAt: "2026-11-07T00:00:00Z", outcome: "done" } } };
	assert.deepEqual(own(f, "ally-r1"), { team: A });
	assert.deepEqual(own(f, "ally-r2"), { team: B }, "a finished run keeps the owner it had");
});

test("row 1: an ally run's record with no team, or no record any more, is not attributed: the box's", () => {
	const f: Facts = { refs: [ref("ally-r1", "ally"), ref("ally-r9", "ally")], panes: [], runs: { r1: { kind: "ally", device: alice.id } } };
	assert.deepEqual(own(f, "ally-r1"), { box: true });
	assert.deepEqual(own(f, "ally-r9"), { box: true });
});

test("row 1: a live ally pane is matched by its pane id, as dispatcherOf does", () => {
	const f: Facts = { refs: [ref("s-ally", "main", "p-ally")], panes: [pane("p-ally", "t-ally")], ally: [{ pane: "p-ally", device: alice.id, team: A }] };
	assert.deepEqual(own(f, "s-ally"), { team: A });
	assert.deepEqual(own({ ...f, ally: [{ pane: "p-ally", device: alice.id }] }, "s-ally"), { box: true }, "an ally pane whose record names no team");
});

test("row 2: a main an ally run opened belongs to the opened row's team, when the pane token names the row's device", () => {
	const f: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(f, "s-main"), { team: A });
	const g: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", { sb_opened_by: `link:link:${alice.id}` })], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(g, "s-main"), { team: A }, "the doubled prefix dispatcherOf strips");
});

test("row 3: a member or subagent pane in the tab of such a main is that main's team", () => {
	const f: Facts = {
		refs: [ref("s-main", "main", "p1"), ref("s-member", "member", "p2"), ref("s-sub", "subagent", "p3"), ref("s-other-tab", "subagent", "p4")],
		panes: [pane("p1", "t1", by(alice.id)), pane("p2", "t1"), pane("p3", "t1"), pane("p4", "t2")],
		rows: [opened("s-main", alice.id, A)],
	};
	assert.deepEqual(own(f, "s-member"), { team: A });
	assert.deepEqual(own(f, "s-sub"), { team: A });
	assert.deepEqual(own(f, "s-other-tab"), { box: true }, "a pane in a tab with no marked main");
});

test("row 3: the row may name the main by its pane when its session id changed", () => {
	const f: Facts = { refs: [ref("s-new", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-old", alice.id, A, { pane: "p1" })] };
	assert.deepEqual(own(f, "s-new"), { team: A });
});

test("row 4: the tower service, its standing pane, a local run, an event run: the box's, whatever workspace or folder they work in", () => {
	const f: Facts = { refs: [ref("tower-1", "tower", "pt"), ref("run-e1", "run"), ref("s-out", "outside", "po")], panes: [pane("pt", "t0", { sb_role: "tower" }), pane("po", "t9")] };
	for (const key of ["tower-1", "run-e1", "s-out"]) assert.deepEqual(own(f, key), { box: true }, key);
});

test("row 5: a worker in a tab of its own, a session opened at the box, anything else: the box's, not attributed", () => {
	const f: Facts = { refs: [ref("s-worker", "member", "p5"), ref("s-box", "main", "p6"), ref("s-nopane", "subagent")], panes: [pane("p5", "t5"), pane("p6", "t6"), pane("p7", "t5")] };
	for (const key of ["s-worker", "s-box", "s-nopane"]) assert.deepEqual(own(f, key), { box: true }, key);
});

test("a key the net does not know has no owner at all", () => {
	assert.equal(own({ refs: [], panes: [] }, "nope"), undefined);
});

test("two witnesses disagree: the row names one device and the pane token another, so the main is nobody's (the box's)", () => {
	const f: Facts = { refs: [ref("s-main", "main", "p1"), ref("s-member", "member", "p2")], panes: [pane("p1", "t1", by(bob.id)), pane("p2", "t1")], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(f, "s-main"), { box: true });
	assert.deepEqual(own(f, "s-member"), { box: true }, "its tab's main is contested");
});

test("one witness alone is not enough: a token with no row, a row with no token", () => {
	const tokenOnly: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [] };
	assert.deepEqual(own(tokenOnly, "s-main"), { box: true });
	const rowOnly: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1")], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(rowOnly, "s-main"), { box: true });
	const otherRow: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-else", alice.id, A)] };
	assert.deepEqual(own(otherRow, "s-main"), { box: true }, "a row for another session");
});

test("two panes of one tab naming two devices, a token that is no device id, and an expect row: all the box's", () => {
	const two: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id)), pane("p9", "t1", by(bob.id))], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(two, "s-main"), { box: true });
	const junk: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", { sb_opened_by: "link:not-a-device" })], rows: [opened("s-main", "not-a-device", A)] };
	assert.deepEqual(own(junk, "s-main"), { box: true });
	const expect: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [{ ...opened("s-main", alice.id, A), kind: "expect" }] };
	assert.deepEqual(own(expect, "s-main"), { box: true }, "only an opened row attributes a main");
	const noTeam: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-main", alice.id, "")] };
	assert.deepEqual(own(noTeam, "s-main"), { box: true }, "a row with no team");
});

test("two opened rows of one device in one tab naming two teams: the unit is the box's, never the first row's team (OAR-F002 M17)", () => {
	const f: Facts = { refs: [ref("s-main", "main", "p1")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-main", alice.id, A), opened("s-old", alice.id, B, { pane: "p1" })] };
	assert.deepEqual(own(f, "s-main"), { box: true });
});

test("both teams on one project: two mains in the same folder belong to the teams their rows say, and a third marked for a device with no row belongs to neither", () => {
	const f: Facts = {
		refs: [ref("m-a", "main", "pa"), ref("m-b", "main", "pb"), ref("m-x", "main", "px")],
		panes: [pane("pa", "ta", by(alice.id)), pane("pb", "tb", by(bob.id)), pane("px", "tx", by(bob.id))],
		rows: [opened("m-a", alice.id, A), opened("m-b", bob.id, B)],
	};
	assert.ok(f.panes.every((p) => p.cwd === "/srv/work"), "one folder for all of them");
	assert.deepEqual(own(f, "m-a"), { team: A });
	assert.deepEqual(own(f, "m-b"), { team: B });
	assert.deepEqual(own(f, "m-x"), { box: true });
});

test("a row of another workspace says nothing about a unit of this one", () => {
	const f: Facts = { refs: [ref("s-main", "main", "p1", "w2")], panes: [pane("p1", "t1", by(alice.id))], rows: [opened("s-main", alice.id, A)] };
	assert.deepEqual(own(f, "s-main"), { box: true });
});

test("OBX-F002: a listing that could not be read makes a main, member or subagent nobody's, not the box's; ally runs and live ally panes, which need no listing, keep their team", () => {
	const f: Facts = {
		refs: [ref("s-main", "main", "p1"), ref("s-member", "member", "p2"), ref("s-sub", "subagent", "p3"), ref("s-ally", "main", "p-ally"), ref("ally-r1", "ally"), ref("tower-1", "tower", "pt")],
		panes: [pane("p1", "t1", by(alice.id)), pane("p2", "t1"), pane("p3", "t1"), pane("p-ally", "t-ally"), pane("pt", "t0")],
		rows: [opened("s-main", alice.id, A)], ally: [{ pane: "p-ally", device: alice.id, team: A }], runs: { r1: { kind: "ally", team: B, device: bob.id } },
	};
	assert.deepEqual(own(f, "s-main"), { team: A }, "with a listing it is the team's");
	assert.deepEqual(own({ ...f, unread: true }, "s-main"), undefined, "a team's main: nobody's");
	assert.deepEqual(own({ ...f, unread: true }, "s-member"), undefined);
	assert.deepEqual(own({ ...f, unread: true }, "s-sub"), undefined);
	assert.deepEqual(own({ ...f, unread: true }, "s-ally"), { team: A }, "a live ally pane is matched without the listing");
	assert.deepEqual(own({ ...f, unread: true }, "ally-r1"), { team: B }, "an ally run is read from its record");
	assert.deepEqual(own({ ...f, unread: true }, "tower-1"), { box: true }, "the tower never needed the listing");
});

// ---- The records on disk -------------------------------------------------------------------------------------------------------------------------------

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-operate-scope-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("storeOwnerWorld reads the run records and the route table of the box's own files", () => {
	const slot = slotOf(root, {}, "linux"), now = Date.now();
	const run: RunRecord = { id: "r1", workspace: WS, kind: "ally", device: alice.id, team: A, pane: "pp", agent: "a", startedAt: "2026-11-07T00:00:00Z", events: [], outcome: "done" };
	writeRun(slot, run);
	writeRun(slot, { ...run, id: "r2", kind: "local", team: undefined, device: undefined });
	addRoute(slot, WS, { ...opened("s-main", alice.id, A), at: now }, now);
	addRoute(slot, WS, { ...opened("s-exp", bob.id, B), kind: "expect", at: now }, now);
	const refs = [ref("ally-r1", "ally"), ref("ally-r2", "ally"), ref("s-main", "main", "p1"), ref("s-exp", "main", "p2")];
	const w = storeOwnerWorld({ slot, now: () => now, refs: () => refs, panes: () => [pane("p1", "t1", by(alice.id)), pane("p2", "t2", by(bob.id))], allyPanes: () => [] });
	assert.deepEqual(ownerOf(w, "ally-r1"), { team: A });
	assert.deepEqual(ownerOf(w, "ally-r2"), { box: true }, "a local run is not an ally run, whatever its key says");
	assert.deepEqual(ownerOf(w, "s-main"), { team: A });
	assert.deepEqual(ownerOf(w, "s-exp"), { box: true });
});
