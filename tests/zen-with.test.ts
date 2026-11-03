import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { companionOf } from "../gui/zenmodel.ts";

const unit = (key: string, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle" as Mark, subs: [], ...o });
const base = (id: string, head: boolean, tower: string | null, units: Unit[], outside: Unit[] = []) => ({ id, label: id, mark: "idle" as Mark, head, tower: tower ? { name: tower, mark: "idle" as Mark, key: tower, control: true, subs: [] } : null, tabs: [{ id: "t", label: "t", units }], outposts: [], outside });
const net = (...bases: ReturnType<typeof base>[]): Net => ({ bases });

test("the companion is the stored unit while it is live, and else none (the breathing circle), towers or not (Z-D12)", () => {
	const stored = { key: "u", ws: "w2" };
	const full = net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u")]));
	assert.deepEqual(companionOf(full, stored), { key: "u", ws: "w2" });
	assert.equal(companionOf(net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u", { control: false })])), stored), undefined, "listed without control");
	assert.equal(companionOf(net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u", { ended: true })])), stored), undefined, "ended");
	assert.equal(companionOf(net(base("w1", true, "t1", []), base("w2", false, null, [])), stored), undefined, "its base has no tower");
	assert.equal(companionOf(net(base("w1", true, "t1", [])), stored), undefined, "its base is gone");
	assert.equal(companionOf(net(base("w1", true, "t1", [])), undefined), undefined, "nothing stored");
	assert.equal(companionOf(net(base("w1", true, null, [])), stored), undefined);
	assert.equal(companionOf(undefined, stored), undefined);
	assert.deepEqual(companionOf(net(base("w1", true, "t1", [])), { key: "t1", ws: "w1" }), { key: "t1", ws: "w1" }, "a tower the boss talked to (an ally or event run records it) is a companion");
});

test("a companion that leaves the net gives the circle at the next snapshot, and one in a subagent or outside slot is found", () => {
	const stored = { key: "u", ws: "w" };
	assert.equal(companionOf(net(base("w", true, "t", [unit("u")])), stored)?.key, "u");
	assert.equal(companionOf(net(base("w", true, "t", [])), stored), undefined);
	assert.equal(companionOf(net(base("w", true, "t", [unit("x", { subs: [unit("u")] })])), stored)?.key, "u");
	assert.equal(companionOf(net(base("w", true, "t", [], [unit("u")])), stored)?.key, "u");
});
