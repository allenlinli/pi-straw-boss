import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { alertsOf, rankOf } from "../gui/alerts.ts";
import { activityOf, companionsOf, unitsOf, waitingOf } from "../gui/units.ts";

const unit = (key: string, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle" as Mark, subs: [], ...o });
const base = (id: string, tower: { key: string; subs?: Unit[]; mark?: Mark } | null, units: Unit[], outside: Unit[] = [], extra: Unit[] = []) => ({
	id, label: id, mark: "idle" as Mark, head: true, outposts: [], outside,
	tower: tower ? { name: tower.key, mark: tower.mark ?? ("idle" as Mark), key: tower.key, control: true, subs: tower.subs ?? [] } : null,
	tabs: [{ id: "t1", label: "t1", units }, { id: "t2", label: "t2", units: extra }],
});
const net = (...bases: ReturnType<typeof base>[]): Net => ({ bases });

test("unitsOf lists the tower, its subagents, each tab's units with their subagents, then the outside units, base by base", () => {
	const n = net(
		base("w1", { key: "tw1", subs: [unit("ts", { role: "subagent" })] }, [unit("a", { subs: [unit("a1", { role: "subagent" }), unit("a2", { role: "subagent" })] })], [unit("o", { role: "outside" })], [unit("b")]),
		base("w2", null, [unit("c")]),
	);
	const rows = unitsOf(n);
	assert.deepEqual(rows.map((r) => [r.base.id, r.unit.key, r.sub]), [
		["w1", "tw1", false], ["w1", "ts", true], ["w1", "a", false], ["w1", "a1", true], ["w1", "a2", true], ["w1", "b", false], ["w1", "o", false],
		["w2", "c", false],
	]);
});

test("unitsOf reaches a subagent of a subagent, marks every subagent, and is empty for no bases", () => {
	const deep = unit("a", { subs: [unit("a1", { subs: [unit("a11")] })] });
	assert.deepEqual(unitsOf(net(base("w", null, [deep]))).map((r) => [r.unit.key, r.sub]), [["a", false], ["a1", true], ["a11", true]]);
	assert.deepEqual(unitsOf({ bases: [] }), []);
	assert.deepEqual(unitsOf(net(base("w", null, []))), []);
});

test("a row hands out the net's own objects, so a reader sees a tower's service and a unit's documents as they are", () => {
	const a = unit("a"), n = net(base("w", { key: "tw" }, [a]));
	const [tower, first] = unitsOf(n);
	assert.equal(tower!.unit, n.bases[0]!.tower);
	assert.equal(first!.unit, a);
	assert.equal(first!.base, n.bases[0]);
});

test("waitingOf keeps what rankOf puts first: a unit that waits, or has a dialog pending, in order", () => {
	const items = [
		{ key: "a", mark: "working" as Mark }, { key: "b", mark: "waiting" as Mark }, { key: "c", mark: "idle" as Mark, pending: { callId: "c1" } as never },
		{ key: "d", mark: "error" as Mark }, { key: "e", mark: "done" as Mark }, { key: "f", mark: "waiting" as Mark },
	];
	assert.deepEqual(waitingOf(items).map((x) => x.key), ["b", "c", "f"]);
	assert.ok(waitingOf(items).every((x) => rankOf(x) === 0));
	assert.deepEqual(waitingOf(new Map(items.map((x) => [x.key, x])).values()).map((x) => x.key), ["b", "c", "f"], "any iterable, as an alert map's values");
	assert.deepEqual(waitingOf([]), []);
});

test("the tab icon's count is what waitingOf finds over unitsOf: a tower, a subagent, and an outside unit count once each", () => {
	const n = net(base("w", { key: "tw", mark: "waiting" }, [unit("a", { subs: [unit("a1", { role: "subagent", mark: "waiting" })] }), unit("b", { mark: "working" })], [unit("o", { role: "outside", mark: "waiting" })]));
	assert.equal(waitingOf(unitsOf(n).map((r) => r.unit)).length, 3);
});

test("alertsOf gives a tower the alert role 'tower' (the net gives a tower no role of its own) and every other unit its own role", () => {
	const n = net(base("w", { key: "tw", subs: [unit("ts", { role: "subagent" })] }, [unit("a", { role: "member" })], [unit("o", { role: "outside" })]));
	const roles = Object.fromEntries([...alertsOf(n, 1).values()].map((a) => [a.key, a.role]));
	assert.deepEqual(roles, { tw: "tower", ts: "subagent", a: "member", o: "outside" });
});

// Z4b: who the companion can be stepped to ([ and ]), and the strip's counts (working, idle).
test("companionsOf: live units that answer to the page, idle ones and towers first, each group in the net's order; no ended unit, no unit the page cannot control", () => {
	const n = net(
		base("w1", { key: "tw1", mark: "working" }, [unit("a", { mark: "working" }), unit("b", { mark: "idle" }), unit("c", { mark: "waiting" }), unit("gone", { mark: "idle", ended: true }), unit("lost", { mark: "idle", control: false })], [unit("o", { role: "outside", mark: "idle" })], [unit("d", { mark: "error" })]),
		base("w2", null, [unit("e", { mark: "idle" }), unit("f", { mark: "working" })]),
	);
	assert.deepEqual(companionsOf(n).map((c) => [c.key, c.ws]), [["tw1", "w1"], ["b", "w1"], ["o", "w1"], ["e", "w2"], ["a", "w1"], ["c", "w1"], ["d", "w1"], ["f", "w2"]]);
	assert.deepEqual(companionsOf(undefined), []);
	assert.deepEqual(companionsOf({ bases: [] }), []);
});

test("companionsOf: a subagent under a unit is never a candidate, whatever its mark", () => {
	const n = net(base("w", null, [unit("a", { subs: [unit("a1", { role: "subagent", mark: "idle", subs: [unit("a11", { mark: "idle" })] })] })]));
	assert.deepEqual(companionsOf(n).map((c) => c.key), ["a"]);
});

test("activityOf counts the working and the idle units and nothing else: what waits (a waiting mark, or a dialog pending on any mark), errors, finished, ended and unknown units change neither number, and the result has no other field", () => {
	const quiet = net(base("w", { key: "tw", mark: "working" }, [unit("a", { mark: "working" }), unit("b", { mark: "idle" }), unit("c", { mark: "idle", subs: [unit("c1", { role: "subagent", mark: "working" })] })], [unit("o", { mark: "idle" })]));
	assert.deepEqual(activityOf(quiet), { working: 3, idle: 3 }, "the tower, a, and the subagent work; b, c, and the outside unit are idle");
	const noisy = net(base("w", { key: "tw", mark: "working" }, [
		unit("a", { mark: "working" }), unit("b", { mark: "idle" }), unit("c", { mark: "idle", subs: [unit("c1", { role: "subagent", mark: "working" })] }),
		unit("w1", { mark: "waiting" }), unit("w2", { mark: "waiting" }), unit("w3", { mark: "idle", pending: { callId: "x" } as never }), unit("w4", { mark: "working", pending: { callId: "y" } as never }),
		unit("e", { mark: "error" }), unit("d", { mark: "done" }), unit("u", { mark: "unknown" }), unit("m", { mark: "commanding" }), unit("end", { mark: "idle", ended: true }),
	], [unit("o", { mark: "idle" })]));
	assert.deepEqual(activityOf(noisy), activityOf(quiet), "more waiting changes neither number: a count of what waits cannot be read back from them");
	assert.deepEqual(Object.keys(activityOf(noisy)).sort(), ["idle", "working"]);
	assert.deepEqual(activityOf(undefined), { working: 0, idle: 0 });
});
