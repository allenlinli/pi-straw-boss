import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { listRuns, readRun } from "../src/server/towerrunstore.ts";

// Finding pi's process in the pane on Linux. Herdr's /proc reader (platform/linux.rs, foreground_job_from_members) lists a process with `name` = the kernel's comm, no `argv0`, and `argv`/`cmdline` from /proc/<pid>/cmdline;
// pi sets its process title to "pi", which on Linux rewrites argv in place, so pi is listed as { name: "pi", cmdline: "pi" } with the run id nowhere in it (the box's log: `foreground="pi 33463"`, then "pi's process was not found in the pane").
// macOS lists { argv0: "pi", name: "node" } with the arguments in `cmdline` (the other tests of the runs).

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "docs-main" };
const wake = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming(from, { id: "m1", content: { text: "one" } });
	await until(() => world.pis.size >= 1, "the run to start");
	return { s, id: [...world.pis.keys()][0]! };
};
const claim = (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	return ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
};
const pidRecorded = async (id: string) => {
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return readRun(world.slot, "wA", id)!.pid;
};

test("Linux: a pi that Herdr lists by name alone (no argv0, a command line of just `pi`) is the run's process: its pid is recorded and its claim is accepted", async () => {
	world.piShape = "linux";
	const { s, id } = await wake();
	assert.equal(await pidRecorded(id), world.pis.get(id)!.pid);
	const got = await claim(s, id);
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined, "the run did not crash at its start");
});

test("Linux: a pi by name wins over a node process in the same foreground", async () => {
	world.piShape = (pid) => [{ pid: 4001, name: "node", cmdline: "node helper.js" }, { pid, name: "pi", cmdline: "pi" }];
	const { s, id } = await wake();
	assert.equal(await pidRecorded(id), world.pis.get(id)!.pid);
	assert.equal((await claim(s, id)).ok, true);
});

test("Linux: two pi by name, no leader, and a node child: the node is not guessed", async () => {
	world.herdr.shellPids = false;
	world.piShape = (pid) => [{ pid: 4002, name: "pi", cmdline: "pi" }, { pid, name: "pi", cmdline: "pi" }, { pid: 4005, name: "node", cmdline: "node x.js" }];
	await wake();
	await until(() => listRuns(world.slot, "wA").some((r) => r.outcome === "crashed"), "the run to end as crashed");
	assert.equal(listRuns(world.slot, "wA")[0]!.pid, undefined);
});

test("Linux: two pi processes by name in the foreground are told apart by the foreground process group's leader", async () => {
	world.herdr.shellPids = true; // the fake names the first listed process the group's leader
	world.piShape = (pid) => [{ pid, name: "pi", cmdline: "pi" }, { pid: 4002, name: "pi", cmdline: "pi" }];
	const { id } = await wake();
	assert.equal(await pidRecorded(id), world.pis.get(id)!.pid);
});

test("Linux: two pi processes by name and no leader among them: nothing is guessed, the start fails and the run ends as crashed without a pid", async () => {
	world.herdr.shellPids = false; // no process group in the answer: no leader to name
	world.piShape = (pid) => [{ pid: 4002, name: "pi", cmdline: "pi" }, { pid, name: "pi", cmdline: "pi" }];
	await wake();
	await until(() => listRuns(world.slot, "wA").some((r) => r.outcome === "crashed"), "the run to end as crashed");
	assert.equal(listRuns(world.slot, "wA")[0]!.pid, undefined);
});

test("macOS: the run id in the command line still wins over a pi by name", async () => {
	world.piShape = (pid, args) => [{ pid: 4003, name: "pi", cmdline: "pi" }, { pid, argv0: "pi", name: "node", cmdline: `node pi ${args.slice(args.indexOf("--") + 1).join(" ")}` }];
	const { id } = await wake();
	assert.equal(await pidRecorded(id), world.pis.get(id)!.pid);
});
