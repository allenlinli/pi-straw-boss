import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { describe, ensure, heldText, probe, restart, ServerError, stop } from "../src/server/client.ts";
import { readRecord, secretDir, type ServerRecord, writeRecord } from "../src/server/record.ts";
import { ServerWorld } from "./server-world.ts";

// R13b-F001, F003, F004: the legacy sb server (protocol 1) is ended by signal only on positive evidence; an unknown start time pins it and starts nothing beside it.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());
const record = (over: Partial<ServerRecord> = {}): ServerRecord => ({
	pid: 7, started: "T-7", version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket: "/nowhere.sock", secret: "s".repeat(64), intercomId: "sb-server-00000000", ...over,
});
const plant = (over: Partial<ServerRecord> = {}) => (mkdirSync(world.slot.dir, { recursive: true }), writeRecord(world.slot, record(over)));

/** An older server whose socket does `behave` with each connection. */
async function older(behave: (conn: import("node:net").Socket, chunk: string) => void, over: Partial<ServerRecord> = {}) {
	secretDir(world.slot.dir);
	const socket = join(world.slot.dir, "older.sock");
	const srv = createServer((conn) => conn.setEncoding("utf8").on("data", (chunk: string) => behave(conn, chunk)).on("error", () => {}));
	await new Promise<void>((resolve) => srv.listen(socket, resolve));
	world.live.add(7);
	plant({ pid: 7, version: "0.43.0", started: "T-7", socket, ...over });
	const killed: [number, string][] = [];
	return { killed, srv, kill: (pid: number, signal: string) => { killed.push([pid, signal]); world.live.delete(pid); srv.close(); } };
}
const closing = (conn: import("node:net").Socket) => void conn.destroy();

test("R13b-F001: a start time not read yet is waited for; once it is the record's, the legacy server is ended and the new one started", async () => {
	const o = await older(closing);
	try {
		const ctx = world.ctx({ startOf: () => undefined, startedLater: async () => "T-7", kill: o.kill as never });
		assert.equal((await probe(ctx)).legacy, true);
		const got = await ensure(ctx);
		assert.ok("server" in got && got.server === "started", JSON.stringify(got));
		assert.deepEqual(o.killed, [[7, "SIGTERM"]]);
		assert.notEqual(readRecord(world.slot)?.pid, 7);
		assert.equal(readRecord(world.slot)?.proto, 2, "the new server writes the protocol it speaks");
	} finally {
		o.srv.close();
	}
});

test("R13b-F001: a start time that never arrives pins the legacy server and starts nothing beside it", async () => {
	const o = await older(closing);
	try {
		// The bounded wait runs out at once (the world's clock is not the wall clock).
		const ctx = world.ctx({ startOf: () => undefined, startedLater: () => new Promise<string | undefined>(() => {}), sleep: async () => {}, kill: o.kill as never });
		const seen = await probe(ctx);
		assert.deepEqual([seen.runs, seen.legacy, seen.live], [true, undefined, false]);
		const got = await ensure(ctx);
		assert.ok(!("server" in got && got.server === "started"), JSON.stringify(got));
		assert.deepEqual(o.killed, []);
		assert.equal(readRecord(world.slot)?.pid, 7, "no second server");
		assert.equal(world.live.has(7), true);
	} finally {
		o.srv.close();
	}
});

test("R13b-F003: a start time read late that is not the record's is neither legacy nor running (a reused pid)", async () => {
	const o = await older(closing);
	try {
		const ctx = world.ctx({ startOf: () => undefined, startedLater: async () => "T-reused", kill: o.kill as never });
		const seen = await probe(ctx);
		assert.deepEqual([seen.runs, seen.legacy, seen.unread], [false, undefined, undefined]);
		assert.deepEqual(o.killed, []);
	} finally {
		o.srv.close();
	}
});

test("R13b-F003: an older server that speaks protocol 2 and closes after its challenge is not signalled; one of protocol 1 is", async () => {
	const challenge = (conn: import("node:net").Socket, chunk: string) => { if (chunk.includes('"hello"')) conn.write(`${JSON.stringify({ ok: true, v: 2, nonce: "ab", proof: "0".repeat(64) })}\n`); conn.destroy(); };
	const o = await older(challenge, { version: "0.50.0", proto: 2 });
	try {
		const ctx = world.ctx({ version: "0.51.0", startOf: (pid: number) => (pid === 7 ? "T-7" : undefined), kill: o.kill as never } as never);
		const seen = await probe(ctx);
		assert.deepEqual([seen.runs, seen.legacy], [true, undefined], "protocol 2: a graceful upgrade, never a signal");
		plant({ pid: 7, version: "0.50.0", started: "T-7", socket: join(world.slot.dir, "older.sock") });
		assert.equal((await probe(ctx)).legacy, true, "a record with no proto is protocol 1");
		plant({ pid: 7, version: "0.50.0", started: "T-7", proto: 1, socket: join(world.slot.dir, "older.sock") });
		assert.equal((await probe(ctx)).legacy, true);
		assert.deepEqual(o.killed, []);
	} finally {
		o.srv.close();
	}
});

test("R13b-F004: on Windows the cached start time is forgotten and read again before the signal; a different time signals nothing", async () => {
	const o = await older(closing);
	try {
		let reads = 0;
		const fresh = (then: string) => world.ctx({ platform: "win32", startOf: (pid: number) => (pid === 7 ? "T-7" : undefined), startedLater: async () => (reads++, then), kill: o.kill as never } as never);
		const reused = fresh("T-other");
		await ensure(reused).catch(() => undefined);
		assert.ok(reads >= 1);
		assert.deepEqual(o.killed, [], "a pid with another start time is left alone");
	} finally {
		o.srv.close();
	}
});

test("R13c-F003: a server left alone is told with what the boss does next: it is read again by itself, and if that stays, end the process and start the server", async () => {
	const o = await older(closing);
	try {
		for (const [platform, end] of [["win32", "taskkill /F /PID 7"], ["linux", "kill 7, and kill -9 7 if it is still there after a few seconds"]] as const) {
			const ctx = world.ctx({ platform, startOf: () => undefined, startedLater: () => new Promise<string | undefined>(() => {}), sleep: async () => {}, kill: o.kill as never });
			const said = await describe(ctx);
			assert.equal(said.reachable, false);
			assert.equal(said.state, "live", "a process that may be the server is not 'gone'");
			assert.match(String(said.warning), /could not be read/);
			assert.match(String(said.warning), /reads it again by itself/);
			assert.ok(String(said.warning).includes(`(${end})`), String(said.warning));
			assert.match(String(said.warning), /\/boss server or `cli\.mjs up`/);
			await assert.rejects(restart(ctx, { reason: "x", boss: true }), (e: unknown) => String((e as Error).message).includes(`(${end})`));
		}
		assert.deepEqual(o.killed, []);
		assert.match(heldText({ platform: "win32" }, { record: record({ pid: 9 }), unread: false }), /runs but did not answer hello.*\(taskkill \/F \/PID 9\)/, "a server that runs and answers nothing is told as that");
	} finally {
		o.srv.close();
	}
});

test("R13c-F001: the start time the probe read in this call is trusted for the signal; one cached from before is read again, for as long as a read takes (not 3 s)", async () => {
	const o = await older(closing);
	try {
		// Cached from before: forgotten, read again; the read lands after the old 3 s wait would have ended and before the deadline.
		let forgot = 0, reads = 0, forgotAtKill = -1;
		const slow = world.ctx({
			// What is forgotten after the signal (a pid seen dead, R13e-F005) is not counted: the one forget that matters comes before it.
			platform: "win32", startOf: (pid: number) => (pid === 7 ? "T-7" : undefined), kill: ((pid: number, signal: string) => ((forgotAtKill = forgot), o.kill(pid, signal))) as never,
			forgetStart: () => void forgot++, startedLater: () => (reads++, new Promise<string>((resolve) => setTimeout(() => resolve("T-7"), 30))),
			sleep: (ms: number, signal?: AbortSignal) => (ms === 3000 ? Promise.resolve() : new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true }); })),
		});
		const got = await ensure(slow);
		assert.ok("server" in got && got.server === "started", JSON.stringify(got));
		assert.deepEqual([forgotAtKill, reads, o.killed], [1, 1, [[7, "SIGTERM"]]]);
	} finally {
		o.srv.close();
	}
});

const silent = () => {};
const same = { version: "0.44.0", proto: 2 } as const;

test("R13e-F005: on Windows a held verdict on a start time cached from long ago reads it again: a pid reused since is not held", async () => {
	const o = await older(silent, same);
	try {
		let cache: string | undefined = "T-7", forgets = 0;
		const ctx = world.ctx({ platform: "win32", startOf: (pid: number) => (pid === 7 ? cache : undefined), forgetStart: () => void (forgets++, (cache = undefined)), startedLater: async () => ((cache = "T-9"), "T-9"), kill: o.kill as never });
		const seen = await probe(ctx);
		assert.deepEqual([seen.runs, forgets], [false, 1], "the cached time was forgotten and read again; the process is not the server of the record");
		// The same read that gives the record's time holds it, and says it was read now.
		cache = "T-7";
		const again = await probe(world.ctx({ platform: "win32", startOf: () => cache, forgetStart: () => void (cache = undefined), startedLater: async () => ((cache = "T-7"), "T-7"), kill: o.kill as never }));
		assert.deepEqual([again.runs, again.startRead], [true, true]);
	} finally {
		o.srv.close();
	}
});

test("R13e-F005: a pid seen dead has its start time forgotten", async () => {
	plant({ pid: 7, socket: join(world.slot.dir, "gone.sock") });
	const forgot: number[] = [];
	const seen = await probe(world.ctx({ alive: () => false, forgetStart: (pid: number) => void forgot.push(pid) }));
	assert.deepEqual([seen.runs, forgot], [false, [7]]);
});

// R13e-F006a: `markStopped` keeps its own guard: the record changed to a server that runs and answers nothing between stop's look and the mark (mutation: drop the guard, this fails).
test("R13e-F006a: the mark of a stop looks again: a server that runs by then is not marked stopped", async () => {
	const o = await older(silent, same);
	try {
		let calls = 0;
		const ctx = world.ctx({ platform: "win32", startOf: (pid: number) => (pid === 7 ? "T-7" : undefined), startedLater: async () => "T-7", sleep: async () => {}, alive: (pid: number) => (pid === 7 ? ++calls > 2 : world.live.has(pid)), kill: o.kill as never });
		await assert.rejects(stop(ctx), (e: unknown) => e instanceof ServerError && e.code === "unreachable");
		assert.equal(readRecord(world.slot)?.stopped, undefined, "not marked stopped");
		assert.ok(calls >= 3, `the pid was asked about ${calls} times`);
	} finally {
		o.srv.close();
	}
});
