import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Answer } from "../gui/post.ts";
import { companionOf } from "../gui/zenmodel.ts";
import { recall, recording, sendTarget, WITH } from "../gui/zenwith.ts";

const store = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const unit = (key: string, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle" as Mark, subs: [], ...o });
const base = (id: string, head: boolean, tower: string | null, units: Unit[], outside: Unit[] = []) => ({ id, label: id, mark: "idle" as Mark, head, tower: tower ? { name: tower, mark: "idle" as Mark, key: tower, control: true, subs: [] } : null, tabs: [{ id: "t", label: "t", units }], outposts: [], outside });
const ok = { ok: true, status: 200, body: {} } as Answer, no = { ok: false, status: 409, body: {} } as Answer;
const net = (...bases: ReturnType<typeof base>[]): Net => ({ bases });

test("an accepted input records {key, ws, at}; a refused one, a dialog answer, and other actions do not", async () => {
	const s = store();
	let reply = ok;
	const send = recording(async () => reply, () => ({ key: "u", ws: "w" }), () => 42, s);
	await send("answer", {});
	await send("keys", {});
	assert.equal(recall(s), undefined);
	reply = no;
	await send("input", {});
	assert.equal(recall(s), undefined);
	reply = ok;
	await send("input", { text: "hi" });
	assert.deepEqual(recall(s), { key: "u", ws: "w", at: 42 });
});

test("a damaged record reads as none", () => {
	const s = store();
	s.setItem(WITH, "{nope");
	assert.equal(recall(s), undefined);
	s.setItem(WITH, JSON.stringify({ key: 1 }));
	assert.equal(recall(s), undefined);
});

test("an ally or event run (no unit in the net) records its base's tower; a unit records itself", () => {
	const n = net(base("w", true, "tw", [unit("u")]));
	assert.deepEqual(sendTarget(n, "u", "w"), { key: "u", ws: "w" });
	assert.deepEqual(sendTarget(n, "tw", "w"), { key: "tw", ws: "w" });
	assert.deepEqual(sendTarget(n, "ally/run1", "w"), { key: "tw", ws: "w" });
	assert.equal(sendTarget(n, "ally/run1", "zz"), undefined);
});

test("the companion falls back in order: the stored unit, its base's tower, the head base's tower, none", () => {
	const stored = { key: "u", ws: "w2", at: 1 };
	const full = net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u")]));
	assert.deepEqual(companionOf(full, stored), { key: "u", ws: "w2" });
	assert.deepEqual(companionOf(net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u", { control: false })])), stored), { key: "t2", ws: "w2" }, "listed without control");
	assert.deepEqual(companionOf(net(base("w1", true, "t1", []), base("w2", false, "t2", [unit("u", { ended: true })])), stored), { key: "t2", ws: "w2" }, "ended");
	assert.deepEqual(companionOf(net(base("w1", true, "t1", []), base("w2", false, null, [])), stored), { key: "t1", ws: "w1" }, "its base has no tower");
	assert.deepEqual(companionOf(net(base("w1", true, "t1", [])), stored), { key: "t1", ws: "w1" }, "its base is gone");
	assert.deepEqual(companionOf(net(base("w1", true, "t1", [])), undefined), { key: "t1", ws: "w1" }, "nothing stored");
	assert.equal(companionOf(net(base("w1", true, null, [])), stored), undefined);
	assert.equal(companionOf(undefined, stored), undefined);
});

test("a companion that leaves the net is replaced at the next snapshot, and one in a subagent or outside slot is found", () => {
	const stored = { key: "u", ws: "w", at: 1 };
	assert.equal(companionOf(net(base("w", true, "t", [unit("u")])), stored)?.key, "u");
	assert.equal(companionOf(net(base("w", true, "t", [])), stored)?.key, "t");
	assert.equal(companionOf(net(base("w", true, "t", [unit("x", { subs: [unit("u")] })])), stored)?.key, "u");
	assert.equal(companionOf(net(base("w", true, "t", [], [unit("u")])), stored)?.key, "u");
});
