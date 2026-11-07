import assert from "node:assert/strict";
import { test } from "node:test";
import { holders, holding, loadLimit, stepWaits, type FactStep, type TrainFacts, waitingTrains, waitMessage } from "../src/train/waits.ts";

// §3.4 and §7.3: what a train holds, who waits on whom, and the waits a step shows. Every wait is on a machine or an earlier train, never on a person.

const lane = (app: string) => ({ lane: app }), target = (name: string) => ({ target: name });
let nextId = 1;
const step = (status: FactStep["status"], extra: Partial<FactStep> = {}): FactStep => ({ id: nextId++, kind: "merge", status, round: 1, ...extra });
const train = (code: string, steps: FactStep[], extra: Partial<TrainFacts> = {}): TrainFacts => ({ project: "acme", code, state: "live", steps, ...extra });
const names = (list: { code: string }[]) => list.map((h) => h.code);
const A = "2026-11-06-a", B = "2026-11-06-b", C = "2026-11-06-c", Z = "2026-11-06-z", AA = "2026-11-06-aa";

test("a train holds a lane or target from the start of the first step that declares it until every step that declares it has completed", () => {
	const hold = (steps: FactStep[]) => holding(train(A, steps));
	assert.deepEqual(hold([step("pending", { holds: lane("web") })]), { lanes: [], targets: [], all: false }, "no step has started: nothing held");
	assert.deepEqual(hold([step("in_progress", { holds: lane("web") }), step("pending", { holds: lane("web") })]), { lanes: ["web"], targets: [], all: false }, "the first has started");
	assert.deepEqual(hold([step("completed", { holds: lane("web") }), step("pending", { holds: lane("web") })]), { lanes: ["web"], targets: [], all: false }, "a later declaring step is still to come");
	assert.deepEqual(hold([step("completed", { holds: lane("web") }), step("pending"), step("completed", { holds: lane("web") })]), { lanes: [], targets: [], all: false }, "every declaring step completed");
	assert.deepEqual(hold([step("completed", { holds: lane("web") }), step("in_progress", { holds: lane("web") })]).lanes, ["web"]);
	assert.deepEqual(hold([step("in_progress", { holds: target("t1") }), step("completed", { holds: lane("web") })]), { lanes: [], targets: ["t1"], all: false }, "lane and target are held apart");
	assert.deepEqual(hold([step("in_progress", { holds: { lane: "web", target: "t1" } })]), { lanes: ["web"], targets: ["t1"], all: false });
	assert.deepEqual(hold([step("in_progress", { holds: lane("web") }), step("in_progress", { holds: lane("api") })]).lanes, ["api", "web"], "sorted");
});

test("a re-assembly does not open a gap: the voided round's steps and the new round's pending ones keep the lane held", () => {
	const r1 = [step("completed", { kind: "assemble", holds: lane("web"), round: 1 }), step("completed", { kind: "merge", holds: lane("web"), round: 1 })];
	assert.deepEqual(holding(train(A, [...r1])).lanes, [], "round 1 merged");
	const redo = [step("completed", { kind: "assemble", holds: lane("web"), round: 1 }), step("completed", { kind: "merge", holds: lane("web"), round: 1 }), step("pending", { kind: "assemble", holds: lane("web"), round: 2 }), step("pending", { kind: "merge", holds: lane("web"), round: 2 })];
	assert.deepEqual(holding(train(A, redo)).lanes, ["web"], "round 2 is created before round 1's last step completes, and the hold never lapses");
	const mid = [step("completed", { kind: "assemble", holds: lane("web"), round: 1 }), step("pending", { kind: "merge", holds: lane("web"), round: 1 })];
	assert.deepEqual(holding(train(A, mid)).lanes, ["web"]);
});

test("an ended train holds nothing; a stale one holds what it held; an unreadable board holds everything; a clear releases", () => {
	const steps = () => [step("in_progress", { holds: lane("web") }), step("pending", { holds: target("t1") })];
	assert.deepEqual(holding(train(A, steps(), { state: "ended" })), { lanes: [], targets: [], all: false });
	assert.deepEqual(holding(train(A, steps(), { state: "stale" })), { lanes: ["web"], targets: [], all: false });
	assert.deepEqual(holding(train(A, [], { state: "unreadable" })), { lanes: [], targets: [], all: true });
	const started = [step("in_progress", { holds: lane("web") }), step("in_progress", { holds: target("t1") }), step("pending", { holds: target("t1") })];
	assert.deepEqual(holding(train(A, started, { state: "stale" })), { lanes: ["web"], targets: ["t1"], all: false });
	const cleared = train(A, started, { state: "stale", clears: [{ lane: "web", reason: "web is read back at 1.0", by: "boss", at: "2026-11-07T08:00:00Z" }] });
	assert.deepEqual(holding(cleared), { lanes: [], targets: ["t1"], all: false }, "a lane clear leaves the target held");
	assert.deepEqual(holding({ ...cleared, clears: [...cleared.clears!, { target: "t1", reason: "read back", by: "boss", at: "2026-11-07T08:01:00Z" }] }), { lanes: [], targets: [], all: false });
	assert.deepEqual(holding(train(A, [], { state: "unreadable", clears: [{ lane: "web", reason: "r", by: "b", at: "2026-11-07T08:00:00Z" }] })).all, true, "a clear does not release what cannot be read");
});

test("holders: the earlier trains of the project that hold a lane or target, in code order, saying why when stale or unreadable", () => {
	const web = (status: FactStep["status"]) => step(status, { holds: lane("web") });
	const trains = [
		train(C, [web("in_progress")]), train(A, [web("in_progress")]), train(B, [web("pending")]),
		train("2026-11-05-x", [web("in_progress")], { state: "stale" }), train("2026-11-04-y", [], { state: "unreadable" }),
		train(Z, [web("completed")]), train("2026-11-03-w", [web("in_progress")], { state: "ended" }), train(AA, [step("in_progress", { holds: target("t1") })]),
		{ ...train(A, [web("in_progress")]), project: "other", code: "2026-11-01-q" },
	];
	assert.deepEqual(holders(trains, { project: "acme", lane: "web" }), [
		{ code: "2026-11-04-y", why: "unreadable" }, { code: "2026-11-05-x", why: "stale" }, { code: A }, { code: C },
	]);
	assert.deepEqual(holders(trains, { project: "acme", lane: "web", before: C }), [{ code: "2026-11-04-y", why: "unreadable" }, { code: "2026-11-05-x", why: "stale" }, { code: A }], "only earlier trains");
	assert.deepEqual(holders(trains, { project: "acme", lane: "web", before: A }), [{ code: "2026-11-04-y", why: "unreadable" }, { code: "2026-11-05-x", why: "stale" }]);
	assert.deepEqual(names(holders(trains, { project: "acme", target: "t1" })), ["2026-11-04-y", AA], "an unreadable board holds every target too");
	assert.deepEqual(names(holders(trains, { project: "other", lane: "web" })), ["2026-11-01-q"], "projects are apart");
	assert.deepEqual(holders(trains, { project: "acme", lane: "api", before: "2026-11-01-a" }), []);
});

test("earlier is by departure order of the code, so one-letter codes come before two-letter ones and two trains never wait on each other", () => {
	const web = () => [step("in_progress", { holds: lane("web") })];
	const all = [train(AA, web()), train(Z, web()), train(A, web()), train(B, web())];
	assert.deepEqual(names(holders(all, { project: "acme", lane: "web", before: AA })), [A, B, Z]);
	// The wait graph (who waits on whom) over every ordering of the same trains has no cycle and a first train that waits on nobody.
	const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
	for (const order of orders) {
		const list = order.map((i) => all[i]!);
		const edges = list.map((t) => [t.code, names(holders(list, { project: "acme", lane: "web", before: t.code }))] as const);
		const first = edges.find(([, on]) => on.length === 0);
		assert.equal(first?.[0], A);
		for (const [code, on] of edges) for (const other of on) assert.ok(!edges.find(([c]) => c === other)![1].includes(code), `${code} and ${other} wait on each other`);
	}
});

test("a step's waits: load only above the limit, a lock with its holder, the lane and the target with the earlier train that holds them", () => {
	const merge = step("in_progress", { kind: "merge", holds: { lane: "web", target: "t1" }, load: { max: 30 }, lock: "heavy" });
	const mine = train(B, [merge]);
	const ahead = train(A, [step("in_progress", { holds: { lane: "web" } }), step("completed", { holds: target("t1") })]);
	const ctx = { trains: [mine, ahead], load: { now: 42, cores: 14 }, locks: { heavy: { train: A, step: 9 } } };
	assert.deepEqual(stepWaits(mine, merge, ctx), [
		{ load: { max: 30, now: 42 } }, { lock: { name: "heavy", holder: { train: A, step: 9 } } }, { lane: { app: "web", holder: A } },
	], "the earlier train started a step that holds the lane and has completed the only step that holds t1");
	assert.deepEqual(stepWaits(mine, merge, { ...ctx, load: { now: 30, cores: 14 }, locks: {} }), [{ lane: { app: "web", holder: A } }], "load at the limit is no wait; a free lock is none");
	assert.deepEqual(stepWaits(mine, merge, { ...ctx, trains: [mine] }).map((w) => Object.keys(w)[0]), ["load", "lock"], "alone on the lane");
	const own = step("in_progress", { lock: "heavy" });
	assert.deepEqual(stepWaits(train(B, [own]), own, { trains: [], locks: { heavy: { train: B, step: own.id } } }), [], "a lock this very step holds is no wait");
	assert.deepEqual(stepWaits(train(B, [own]), own, { trains: [], locks: { heavy: { train: B, step: own.id + 1 } } }).length, 1, "another step of the same train does");
	const perCore = step("in_progress", { load: { perCore: 2 } });
	assert.equal(loadLimit({ perCore: 2 }, 14), 28);
	assert.equal(loadLimit({ max: 30 }, 14), 30);
	assert.deepEqual(stepWaits(train(A, [perCore]), perCore, { trains: [], load: { now: 29, cores: 14 } }), [{ load: { max: 28, now: 29 } }]);
	assert.deepEqual(stepWaits(train(A, [perCore]), perCore, { trains: [] }), [], "no load reading: no load wait is invented");
	const target1 = train(A, [step("in_progress", { holds: target("t1") })]);
	const deploy = step("in_progress", { kind: "deploy", holds: target("t1") });
	assert.deepEqual(stepWaits(train(B, [deploy]), deploy, { trains: [target1, train(B, [deploy])] }), [{ target: { target: "t1", holder: A } }]);
	const stale = train(A, [step("in_progress", { holds: target("t1") })], { state: "stale" });
	assert.deepEqual(stepWaits(train(B, [deploy]), deploy, { trains: [stale] }), [{ target: { target: "t1", holder: A, why: "stale" } }], "the wait says why");
	assert.deepEqual(stepWaits(train(B, [deploy]), deploy, { trains: [train(A, [], { state: "unreadable" })] }), [{ target: { target: "t1", holder: A, why: "unreadable" } }]);
});

test("waitingTrains counts the trains with a lane or target wait held by another train, which the page calls waiting on each other", () => {
	const web = (status: FactStep["status"]) => step(status, { holds: lane("web") });
	const trains = [train(A, [web("in_progress")]), train(B, [web("in_progress")]), train(C, [web("pending")]), train(AA, [step("in_progress", { holds: lane("api") })]), train(Z, [step("in_progress", { load: { max: 1 } })])];
	assert.deepEqual(waitingTrains(trains), [B], "C has not started; Z waits for load only");
	assert.deepEqual(waitingTrains([...trains.slice(0, 2), train("2026-11-06-d", [web("in_progress")])]), [B, "2026-11-06-d"]);
	assert.deepEqual(waitingTrains([]), []);
	const done = [train(A, [web("in_progress")]), train(B, [web("completed"), web("completed")]), train(C, [web("in_progress")], { state: "ended" })];
	assert.deepEqual(waitingTrains(done), [], "a completed step waits for nothing, and an ended train is not waiting");
});

test("the English message of a wait is the monitor line's progress.message", () => {
	assert.equal(waitMessage([{ load: { max: 30, now: 42 } }]), "waiting: load <=30 (now 42)");
	assert.equal(waitMessage([{ lock: { name: "heavy", holder: { train: A, step: 9 } } }]), `waiting: lock heavy (held by ${A} #9)`);
	assert.equal(waitMessage([{ lock: { name: "heavy" } }]), "waiting: lock heavy");
	assert.equal(waitMessage([{ lane: { app: "web", holder: A } }, { target: { target: "t1", holder: B, why: "stale" } }]), `waiting: lane web (held by ${A}); target t1 (held by ${B}, stale)`);
	assert.equal(waitMessage([]), "");
});

test("F005: a clear releases a stale train's holds only; a live train that resumed holds again", () => {
	const clears = [{ lane: "web", reason: "read back", by: "boss", at: "2026-11-01T08:00:00Z" }];
	const steps = () => [step("completed", { holds: lane("web") }), step("in_progress", { holds: lane("web") })];
	assert.deepEqual(holding(train(A, steps(), { state: "stale", clears })).lanes, [], "stale and cleared");
	assert.deepEqual(holding(train(A, steps(), { state: "live", clears })).lanes, ["web"], "live: the clear is not honored");
	const ahead = train(A, steps(), { state: "live", clears }), mine = train(B, [step("in_progress", { holds: lane("web") })]);
	assert.deepEqual(holders([ahead, mine], { project: "acme", lane: "web", before: B }), [{ code: A }]);
});
