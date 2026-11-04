import assert from "node:assert/strict";
import { test } from "node:test";
import { killSet, type Owned, type Place, type Protect } from "../src/procs/killset.ts";
import { refOf, type Proc } from "../src/procs/table.ts";

// The kill set of an ended owner and the set that is never touched: pure decisions over a process table, the cwd of each process, and the marker each carries.

const P = (pid: number, ppid: number, over: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, uid: 501, started: `t${pid}`, cpu: 0, comm: "node", zombie: false, ...over });
const ROOT = "/wt/feat-x";
const owner = (over: Partial<Owned> = {}): Owned => ({ id: "own-a", pid: 100, started: "t100", roots: [ROOT], snapshot: [], ...over });
const base = { live: [] as Owned[], places: new Map<number, Place>(), markers: new Map<number, string>(), protect: [] as Protect[], reapers: [] as number[], self: [9000] };
const pids = (d: ReturnType<typeof killSet>) => d.targets.map((t) => t.proc.pid).sort((a, b) => a - b);
const whyOf = (d: ReturnType<typeof killSet>, pid: number) => d.targets.find((t) => t.proc.pid === pid)?.why;

test("an orphan that the owner's snapshot named is a target, also when its parent died first and it now hangs under pid 1", () => {
	const table = [P(1, 0, { uid: 0 }), P(100, 50), P(200, 1), P(201, 1)];
	const d = killSet({ ...base, owner: owner({ snapshot: [refOf(table[2]!)] }), table });
	assert.deepEqual(pids(d), [200]);
	assert.equal(whyOf(d, 200), "snapshot");
});

test("pid reuse: a snapshot entry whose pid now has another start time is not a target; a zombie is not one either", () => {
	const table = [P(300, 1, { started: "later" }), P(301, 1, { zombie: true })];
	const d = killSet({ ...base, owner: owner({ snapshot: [{ pid: 300, started: "earlier" }, { pid: 301, started: "t301" }, { pid: 302, started: "gone" }] }), table });
	assert.deepEqual(pids(d), []);
});

test("a process that carries the owner's marker is a target; another live owner's marker spares it; an unknown marker is ignored", () => {
	const table = [P(400, 1), P(401, 1), P(402, 1)];
	const markers = new Map([[400, "own-a"], [401, "own-b"], [402, "own-zzz"]]);
	const live = [owner({ id: "own-b", pid: 150, started: "t150" })];
	const d = killSet({ ...base, owner: owner(), table, markers, live });
	assert.deepEqual(pids(d), [400]);
	assert.equal(whyOf(d, 400), "marker");
});

test("an orphan whose cwd is in the owner's linked worktree is a target; a process with a live parent, or an orphan elsewhere, is not", () => {
	const table = [P(500, 1), P(501, 77), P(502, 1), P(503, 1), P(77, 1)];
	const places = new Map<number, Place>([[500, { path: `${ROOT}/sub/dir`, removed: false }], [501, { path: ROOT, removed: false }], [502, { path: "/wt/feat-y", removed: false }], [503, { path: `${ROOT}-sibling`, removed: false }]]);
	const d = killSet({ ...base, owner: owner(), table, places });
	assert.deepEqual(pids(d), [500]);
	assert.equal(whyOf(d, 500), "cwd");
});

test("a removed checkout: an orphan whose vanished cwd was below the owner's root is a target; a vanished cwd elsewhere is not", () => {
	const table = [P(600, 1), P(601, 1)];
	const places = new Map<number, Place>([[600, { path: `${ROOT}/pkg`, removed: true }], [601, { path: "/wt/other/pkg", removed: true }]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places })), [600]);
});

test("an owner that works in the parent checkout (no roots) gets no cwd rule", () => {
	const table = [P(700, 1)];
	const places = new Map<number, Place>([[700, { path: "/repo/main", removed: false }]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner({ roots: [] }), table, places })), []);
});

test("a subreaper (systemd --user) counts as an orphan's parent", () => {
	const table = [P(800, 321), P(321, 1)];
	const places = new Map<number, Place>([[800, { path: ROOT, removed: false }]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places })), []);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places, reapers: [321] })), [800]);
});

test("children of a target go with it, but not through a protected process", () => {
	const table = [P(900, 1), P(901, 900), P(902, 901), P(903, 900), P(904, 903)];
	const d = killSet({ ...base, owner: owner({ snapshot: [refOf(table[0]!)] }), table, protect: [{ pid: 903, why: "pane" }] });
	assert.deepEqual(pids(d), [900, 901, 902]);
	assert.equal(whyOf(d, 901), "child");
	assert.deepEqual(d.spared.map((s) => [s.proc.pid, s.why]), [[903, "pane"]], "the spared child is reported, its own child (904) is not reached");
});

test("protected cases: the Herdr server and its tree, a live pane's shell, an sb server, the broker, a live owner and its tree, and this process are never targets", () => {
	const table = [
		P(1000, 1, { comm: "herdr" }), P(1001, 1000), // herdr server + its child (tree)
		P(1010, 1), // pane shell
		P(1020, 1), P(1021, 1020), // sb server + child (tree)
		P(1030, 1), // intercom broker
		P(150, 1), P(151, 150), P(152, 151), // live owner pi, its child, grandchild
		P(160, 1), // an orphan in a live owner's snapshot
		P(9000, 1), // this process
		P(1100, 1), // a plain target
	];
	const protect: Protect[] = [
		{ pid: 1000, why: "herdr", tree: true }, { pid: 1010, why: "pane" }, { pid: 1020, why: "sb-server", tree: true }, { pid: 1030, why: "broker" },
	];
	const live = [owner({ id: "own-b", pid: 150, started: "t150", snapshot: [refOf(table[9]!)] })];
	const everything = new Map<number, Place>(table.map((p) => [p.pid, { path: ROOT, removed: false }]));
	const markers = new Map(table.map((p) => [p.pid, "own-a"] as [number, string]));
	const snapshot = table.map(refOf);
	const d = killSet({ ...base, owner: owner({ snapshot }), table, places: everything, markers, protect, live });
	assert.deepEqual(pids(d), [1100]);
	const spared = new Map(d.spared.map((s) => [s.proc.pid, s.why]));
	assert.equal(spared.get(1000), "herdr");
	assert.equal(spared.get(1001), "herdr");
	assert.equal(spared.get(1010), "pane");
	assert.equal(spared.get(1021), "sb-server");
	assert.equal(spared.get(1030), "broker");
	assert.equal(spared.get(150), "live-owner");
	assert.equal(spared.get(152), "live-owner");
	assert.equal(spared.get(160), "live-owner");
	assert.equal(spared.get(9000), "self");
});

test("pid 1 and the owner's own account only: a table row of another account is never a target, and pid 1 is spared whatever else says", () => {
	const table = [P(1, 0, { uid: 0 }), P(2000, 1, { uid: 502 })];
	const markers = new Map([[1, "own-a"], [2000, "own-a"]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner({ snapshot: table.map(refOf) }), table, markers, ownUid: 501 })), []);
});

test("a protect entry with a start time spares only that process; a reused pid with another start time is not spared by it", () => {
	const table = [P(3000, 1, { started: "new" })];
	const d = killSet({ ...base, owner: owner({ snapshot: [{ pid: 3000, started: "new" }] }), table, protect: [{ pid: 3000, started: "old", why: "pane" }] });
	assert.deepEqual(pids(d), [3000]);
});

test("the ended owner's own pid is not special: a target set never contains it unless its snapshot or marker names it", () => {
	const table = [P(100, 1), P(101, 100)];
	const d = killSet({ ...base, owner: owner({ snapshot: [refOf(table[1]!)] }), table });
	assert.deepEqual(pids(d), [101]);
});

test("RV-F001: the cwd rule does not reach into a root that a live owner also holds, nor one a live pane of a main works in", () => {
	const table = [P(700, 1)];
	const places = new Map<number, Place>([[700, { path: `${ROOT}/x`, removed: false }]]);
	const other = owner({ id: "own-b", pid: 150, started: "t150", roots: [ROOT] });
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places })), [700], "alone in the root, the rule applies");
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places, live: [other] })), [], "a live owner holds the same root");
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places, live: [owner({ id: "own-b", pid: 150, started: "t150", roots: ["/wt"] })] })), [], "a live owner holds a folder above it");
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places, held: [ROOT] })), [], "an unregistered session works there");
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places, held: ["/wt/other"] })), [700], "another root does not hold it");
	const removed = new Map<number, Place>([[700, { path: `${ROOT}/x`, removed: true }]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, places: removed, live: [other] })), [], "also for a removed checkout");
	// the snapshot and marker rules are the owner's own, whatever others hold
	assert.deepEqual(pids(killSet({ ...base, owner: owner({ snapshot: [refOf(table[0]!)] }), table, places, live: [other] })), [700]);
});

test("a live owner under the same id (a new hello) spares the processes that carry the marker: the marker no longer tells the two apart", () => {
	const table = [P(400, 1)];
	const markers = new Map([[400, "own-a"]]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, markers })), [400]);
	assert.deepEqual(pids(killSet({ ...base, owner: owner(), table, markers, live: [owner({ pid: 200, started: "t200" })] })), []);
});
