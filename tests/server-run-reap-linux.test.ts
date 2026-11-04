import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// reap on Linux (pi listed by name, no run id in its command line). No real signals: world.kills records them.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.piShape = "linux";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "docs-main" };
const live = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming(from, { id: "m1", content: { text: "one" } });
	await until(() => world.pis.size >= 1, "the run to start");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "pid recorded");
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { s, id, pi };
};
const STRANGER = 9100;
const stop = async (s: Running) => {
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
};

test("reap on Linux: recorded pi alive but no longer in the pane's foreground; a stranger pi is the pane's sole pi; table unreadable", async () => {
	const { s, pi } = await live();
	world.herdr.pane(pi.pane).processes = [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }];
	await stop(s);
	assert.deepEqual(world.kills, [], "a pi that is not the run's is not signalled");
});

test("reap on Linux: same, table readable and lists the stranger (carries false, another start time)", async () => {
	const { s, pi } = await live();
	world.procTable = [
		{ pid: pi.pid, ppid: 1, name: "pi", carries: false, started: `T-${pi.pid}` },
		{ pid: STRANGER, ppid: 1, name: "pi", carries: false, started: "T-other" },
	] as never;
	world.herdr.pane(pi.pane).processes = [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }];
	await stop(s);
	assert.deepEqual(world.kills, [], "a pi that is not the run's is not signalled");
});

test("reap on Linux: the recorded pid was reused (table start differs), the pane's sole pi is a stranger", async () => {
	const { s, pi } = await live();
	world.procTable = [
		{ pid: pi.pid, ppid: 1, name: "bash", carries: false, started: "T-reused" },
		{ pid: STRANGER, ppid: 1, name: "pi", carries: false, started: "T-other" },
	] as never;
	world.herdr.pane(pi.pane).processes = [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }];
	await stop(s);
	assert.deepEqual(world.kills, [], "a pi that is not the run's is not signalled");
});

test("reap on Linux: the pane's pi is listed by Herdr but absent from the table read (gone, pid may be reused)", async () => {
	const { s, pi } = await live();
	world.procTable = [{ pid: 1, ppid: 0, name: "init", carries: false, started: "T-1" }] as never;
	world.herdr.pane(pi.pane).processes = [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }];
	await stop(s);
	assert.deepEqual(world.kills, [], "a pid the table does not show is not signalled");
});

test("reap on Linux, control: the run's own pi is listed and verified: it alone is signalled", async () => {
	const { s, pi } = await live();
	world.herdr.pane(pi.pane).processes = [{ pid: pi.pid, name: "pi", argv: ["pi"], cmdline: "pi" }, { pid: STRANGER, name: "node", cmdline: "node x" }];
	await stop(s);
	assert.deepEqual(world.kills, [[pi.pid, "SIGTERM"]]);
});

test("reap on Linux: two pi by name, the stranger leads the group (recorded pi not leader, unlisted): leader signalled?", async () => {
	world.herdr.shellPids = true;
	const { s, pi } = await live();
	world.herdr.pane(pi.pane).processes = [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }, { pid: STRANGER + 1, name: "pi", argv: ["pi"], cmdline: "pi" }];
	await stop(s);
	assert.deepEqual(world.kills, [], "a pi that is not the run's is not signalled");
});

const failStart = () => {
	// The start finds no pi at first (procOf fails, no pid recorded); the pi then shows in the pane as the only one.
	const seen = { reads: 0 };
	world.piShape = (_pid, args) => {
		const pane = world.herdr.pane(world.pis.get(args[args.indexOf("--sb-run") + 1]!)!.pane);
		Object.defineProperty(pane, "processes", { configurable: true, get: () => (++seen.reads > 1 ? [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }] : []), set: () => {} });
		return [];
	};
	return seen;
};

test("reap on Linux: no recorded pid, the pane's sole pi listed by name, the table unreadable: nothing is signalled", async () => {
	const seen = failStart();
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming(from, { id: "m1", content: { text: "one" } });
	await until(() => seen.reads > 1, "the pane to list the pi");
	await stop(s);
	assert.deepEqual(world.kills, [], "a pi found by name alone needs a row in a table that was read");
});

test("reap on Linux: no recorded pid and the pane's sole pi listed by name: that pi is signalled", async () => {
	// The start finds no pi at first (procOf fails, no pid recorded); the pi then shows in the pane as the only one, and the reap of the failed start ends it.
	world.procTable = [{ pid: STRANGER, ppid: 1, name: "pi", carries: false, started: `T-${STRANGER}` }] as never;
	let reads = 0;
	world.piShape = (_pid, args) => {
		const pane = world.herdr.pane(world.pis.get(args[args.indexOf("--sb-run") + 1]!)!.pane);
		Object.defineProperty(pane, "processes", { configurable: true, get: () => (++reads > 1 ? [{ pid: STRANGER, name: "pi", argv: ["pi"], cmdline: "pi" }] : []), set: () => {} });
		return [];
	};
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming(from, { id: "m1", content: { text: "one" } });
	await until(() => world.kills.length > 0, "the sole pi to be signalled");
	assert.deepEqual(world.kills, [[STRANGER, "SIGTERM"]]);
});
