import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperateMessage } from "../src/link/kinds.ts";
import type { Net } from "../src/net.ts";
import { createOperateHost } from "../src/server/operatehost.ts";
import { A, alice, dave, settle, world } from "./operate-box-world.ts";

// The controller's host (operatehost.ts) against the real box bridge (operatebox.ts), both real `OperateSession`s over a transport the test pumps: the wire between task 5 and task 6, which each task's own tests only hold from one side
// (OHR-F001: the host's watch stop named a target the box refuses, and the box's watches piled up until every new one got 429).

const LOCAL: Net = { bases: [] };
function both() {
	const w = world(), toBox: { team: string; message: OperateMessage }[] = [];
	const host = createOperateHost({ now: w.clock.now, device: () => alice.id, boxes: () => [{ team: A, teamName: "alpha", device: dave.id, short: "dave", label: "box" }], log: () => {}, interval: false, send: async (team, _d, message) => void toBox.push({ team, message }) });
	const pump = async () => {
		for (let i = 0; i < 10; i++) {
			let moved = false;
			for (const m of toBox.splice(0)) (moved = true, w.box.take({ team: m.team, from: alice.id, fromAttended: true, message: m.message, ts: w.clock.now(), dropped: 0 }));
			await settle();
			for (const m of w.out.splice(0)) (moved = true, host.receive({ team: m.team, from: dave.id, fromAttended: false, message: m.message, ts: w.clock.now(), dropped: 0 }));
			await settle();
			if (!moved) break;
		}
	};
	const run = async (ms: number) => { for (let t = 0; t < ms; t += 250) { w.clock.advance(250); host.tick(); await pump(); } };
	return { w, host, run };
}
const keyOf = (net: Net, name: string) => (name === "tower" ? net.bases[0]!.tower!.key : net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units)).find((u) => u.name === name)!.key);
/** The watches the box's seam holds now: started and not stopped. */
const running = (w: ReturnType<typeof world>) => { const on = new Set<string>(); for (const [id, , state] of w.fo.sessions[0]!.watches) state ? on.add(id) : on.delete(id); return on; };

test("WIRE OHR-F001: twelve views opened and left over a session leave no watch on the box, and none is refused", async () => {
	const { w, host, run } = both();
	host.page();
	await run(3000);
	const net = host.merge(LOCAL), got: [string, unknown][] = [];
	const targets = ["a-main", "box-main", "tower"].map((n) => keyOf(net, n));
	for (let i = 0; i < 12; i++) {
		const stops = [targets[i % 3]!, targets[(i + 1) % 3]!].map((k) => host.bridge.watch(k, (e, d) => void got.push([e, d]))!);
		await run(500);
		assert.equal(running(w).size, 2, `view ${i} is watching`);
		for (const s of stops) s.stop();
		await run(500);
		assert.equal(running(w).size, 0, `view ${i} left: the box's watches are gone`);
	}
	assert.equal(w.fo.sessions[0]!.watches.length, 48);
	assert.equal(got.filter(([, d]) => (d as { state?: string }).state === "unknown").length, 0, "no watch was refused (429 would blank the view)");
	assert.equal(w.logs.filter((l) => l.event === "operate-refused").length, 0);
});

test("WIRE OHR-F001: a workspace watch (`w:`) is stopped with its own target too", async () => {
	const { w, host, run } = both();
	host.page();
	await run(3000);
	const ws = host.bridge.watch(`w:${host.merge(LOCAL).bases[0]!.id}`, () => {})!;
	await run(500);
	assert.deepEqual(w.fo.sessions[0]!.watches.map((x) => [x[1], x[2]]), [["w:wA", true]]);
	ws.stop();
	await run(500);
	assert.deepEqual(w.fo.sessions[0]!.watches.map((x) => [x[1], x[2]]), [["w:wA", true], ["w:wA", false]]);
});

test("WIRE OHR-F002: the box's server stop greys its base for a reopen; it is not shown as a revoked grant", async () => {
	const { w, host, run } = both();
	host.page();
	await run(3000);
	w.box.stop();
	await run(500);
	const box = host.merge(LOCAL).bases[0]!.box!;
	assert.deepEqual([box.state, box.why], ["unreachable", undefined]);
});
