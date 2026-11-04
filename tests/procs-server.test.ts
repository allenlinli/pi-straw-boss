import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseArgs, UsageError } from "../src/server/cli.ts";
import { callControl } from "../src/server/socket.ts";
import type { Proc } from "../src/procs/table.ts";
import { ServerWorld, until } from "./server-world.ts";

// The registry behind the control socket: procs-hello / bye / list / reap on a server of the world, and the registry file kept across a restart.

const P = (pid: number, ppid: number): Proc => ({ pid, ppid, pgid: pid, uid: 501, started: `t${pid}`, cpu: 0, comm: "/usr/bin/node", zombie: false });
let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());
const ask = (cmd: Record<string, unknown>) => callControl(world.record()!.socket, world.record()!.secret, cmd as { cmd: string }).then((r) => r.reply!);

test("a worker's hello, bye, and the list go through the socket; the owner is kept across a server restart", async () => {
	const table = [P(100, 1), P(101, 100)];
	const reaped: number[][] = [];
	const procs = { read: async () => table, startOf: (pid: number) => table.find((p) => p.pid === pid)?.started, cwds: async () => new Map(), markers: async () => new Map(), reap: async (refs: readonly { pid: number }[]) => (reaped.push(refs.map((r) => r.pid)), { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] }) };
	const first = await world.start({ procs });
	await first.handle.ready;
	assert.deepEqual(await ask({ cmd: "procs-hello", pid: 100, id: "w1", started: "t100" }), { ok: true, id: "w1" });
	assert.equal((await ask({ cmd: "procs-hello", pid: 4242 })).ok, false, "a pid the table does not list is refused");
	assert.equal((await ask({ cmd: "procs-beat", id: "w1" })).known, true);
	assert.equal((await ask({ cmd: "procs-list" })).owners instanceof Array, true);
	assert.ok(existsSync(join(world.slot.dir, "procs", "owners.json")));
	await first.handle.shutdown(0);
	await first.handle.done;
	// restart: the second server loads the owner back
	const second = await world.start({ procs });
	await second.handle.ready;
	const listed = (await ask({ cmd: "procs-list" })).owners as { id: string; live: boolean }[];
	assert.deepEqual(listed.map((o) => [o.id, o.live]), [["w1", true]]);
	assert.equal((await ask({ cmd: "procs-reap", owner: "w1" })).ok, false, "reap of a live owner is refused");
	assert.equal((await ask({ cmd: "procs-reap", owner: "w1", checkout: "/x" })).ok, false);
	assert.deepEqual(await ask({ cmd: "procs-bye", id: "w1" }), { ok: true, known: true });
	await until(() => reaped.length > 0, "the reap of the ended owner");
	assert.deepEqual(reaped, [[101]]);
});

test("cli: procs takes list (default) or reap with exactly one of --owner and --checkout", () => {
	assert.equal(parseArgs(["procs"]).flags.sub, "list");
	assert.deepEqual(parseArgs(["procs", "reap", "--owner", "w1"]).flags, { sub: "reap", owner: "w1" });
	for (const bad of [["procs", "reap"], ["procs", "reap", "--owner", "a", "--checkout", "/b"], ["procs", "list", "--owner", "a"], ["procs", "kill"]]) assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
});
