import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { operateOff } from "../src/server/operateoff.ts";
import { createOperateHost } from "../src/server/operatehost.ts";
import { baseOf, hostWorld, netOf, unit } from "./operate-host-world.ts";

// The boss's switch for operate (todo #121 wiring, review OW-F003, docs/specs/2026-11-07-link-operate.md §8 and decision 14): `/boss link operate off` stays off until `/boss link operate on`, across a GUI and a server that start again.
// Its state is the file `link/operate-off.json`, mode 600; the host opens nothing while it says off, and its clock stops when no session is left.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-operate-off-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(scratch, `s${n++}`, "link", "operate-off.json");

test("OW-F003: operate is on with no file; off writes {since} with mode 600, and a new instance reads it back", () => {
	const file = fresh();
	assert.equal(operateOff(file, () => 5).since(), undefined);
	const sw = operateOff(file, () => 5);
	assert.deepEqual(sw.off(1234), { saved: true });
	assert.equal(sw.since(), 1234);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { since: 1234 });
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(operateOff(file, () => 99).since(), 1234, "a server that starts again finds it off, since the same moment");
});

test("OW-F003: on removes the file and stays removed for the next instance", () => {
	const file = fresh(), sw = operateOff(file, () => 5);
	sw.off(10);
	assert.deepEqual(sw.on(), { saved: true });
	assert.equal(sw.since(), undefined);
	assert.equal(operateOff(file, () => 5).since(), undefined);
	assert.deepEqual(sw.on(), { saved: true }, "on again is no error");
});

test("OW-F003: a file that is there but cannot be read as {since} still means off, since the moment it was found (the switch fails closed)", () => {
	for (const text of ["", "{", "[]", '{"since":"x"}', '{"since":-1}', "null", '{"since":1.5}']) {
		const file = fresh();
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, text);
		assert.equal(operateOff(file, () => 777).since(), 777, JSON.stringify(text));
	}
});

test("OW-F003: a switch that cannot be written is off for this server and says so; one that cannot be removed stays off and says so", () => {
	const file = join(scratch, "blocker", "link", "operate-off.json");
	mkdirSync(join(scratch, "blocker"), { recursive: true });
	writeFileSync(join(scratch, "blocker", "link"), "a file where the folder should be");
	const sw = operateOff(file, () => 5);
	assert.deepEqual(sw.off(42), { saved: false });
	assert.equal(sw.since(), 42, "off all the same until the server stops");
	const stuck = fresh(), held = operateOff(stuck, () => 5);
	held.off(7);
	chmodSync(join(stuck, ".."), 0o500);
	try {
		if (process.getuid?.() !== 0) {
			assert.deepEqual(held.on(), { saved: false });
			assert.equal(held.since(), 7, "it stays off");
		}
	} finally {
		chmodSync(join(stuck, ".."), 0o700);
	}
});

// ---- the host ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const SNAP = () => netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" }));

test("OW-F003: while operate is off no session opens for a page that stays, however long, and it opens again at the tick after on", async () => {
	const w = hostWorld();
	await w.page();
	w.box().snap(SNAP());
	await w.pump();
	assert.equal(w.stats.opens, 1);
	w.paused.on = true;
	w.host.off();
	await w.pump();
	assert.deepEqual(w.host.status(), []);
	await w.run(10 * 60_000, 5000);
	assert.equal(w.stats.opens, 1, "ten minutes of a connected page open nothing");
	w.paused.on = false;
	w.host.on();
	await w.run(5000);
	await w.pump();
	assert.equal(w.stats.opens, 2, "and on opens it again");
});

test("OW-F003: a server that starts with the switch already off opens nothing for a page that connects", async () => {
	const w = hostWorld();
	w.paused.on = true;
	await w.page();
	await w.run(30_000, 1000);
	assert.equal(w.stats.opens, 0);
});

test("OW-F003: while operate is off the host's clock does not run for a connected page, and it runs again after on", () => {
	const timers = { set: 0, cleared: 0 };
	const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
	globalThis.setInterval = ((fn: () => void, ms?: number) => { timers.set++; return realSet(fn, ms); }) as typeof setInterval;
	globalThis.clearInterval = ((t: Parameters<typeof clearInterval>[0]) => { timers.cleared++; return realClear(t); }) as typeof clearInterval;
	let off = false;
	const host = createOperateHost({ now: () => 1_800_000_000_000, device: () => undefined, boxes: () => [], paused: () => off, log: () => undefined, send: async () => ({}), interval: 50 });
	try {
		const left = host.page();
		assert.deepEqual([timers.set, timers.cleared], [1, 0], "a connected page runs the clock");
		off = true;
		host.off();
		assert.deepEqual([timers.set, timers.cleared], [1, 1], "off stops it, though the page stays");
		const again = host.page();
		assert.deepEqual([timers.set, timers.cleared], [1, 1], "a page that connects while off does not start it");
		off = false;
		host.on();
		assert.equal(timers.set, 2, "on starts it for the pages that are connected");
		left();
		again();
	} finally {
		host.stop();
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
});

test("OW-F008: a computer that cannot operate a box (no Link holder, or an unattended device) arms no clock for a connected page, and arms it once it can", async () => {
	const timers = { set: 0, cleared: 0 };
	const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
	globalThis.setInterval = ((fn: () => void, ms?: number) => { timers.set++; return realSet(fn, ms); }) as typeof setInterval;
	globalThis.clearInterval = ((t: Parameters<typeof clearInterval>[0]) => { timers.cleared++; return realClear(t); }) as typeof clearInterval;
	let enabled = false, reads = 0;
	const host = createOperateHost({ now: () => 1_800_000_000_000, device: () => undefined, boxes: () => (reads++, []), enabled: () => enabled, log: () => undefined, send: async () => ({}), interval: 50 });
	try {
		const left = host.page();
		await new Promise<void>((r) => queueMicrotask(r));
		await new Promise<void>((r) => setImmediate(r));
		assert.deepEqual([timers.set, reads], [0, 0], "no Link, or unattended: no clock, and no box list read");
		enabled = true;
		host.on();
		assert.equal(timers.set, 1, "Link came up: the connected page gets its clock");
		left();
		assert.equal(timers.cleared, 1);
	} finally {
		host.stop();
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
});
