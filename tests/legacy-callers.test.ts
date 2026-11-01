import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type CliDeps, run } from "../src/server/cli.ts";
import { type Ctx, ensure, launch, restart, ServerError, stop } from "../src/server/client.ts";
import { readRecord, secretDir, type ServerRecord, updateRecord, writeRecord } from "../src/server/record.ts";
import { ensureTowerVia } from "../src/server/towerclient.ts";
import { createStartOf } from "../src/startof.ts";
import { World } from "./fakes.ts";
import { ServerWorld, until } from "./server-world.ts";

// R13d: while server.json names a pid that runs, no caller (ensure, a boss's ensure, restart, stop, a session's look, `cli.mjs up`, a tower's ask) starts a server and none marks the record
// stopped, unless that pid was signalled by us and has been seen to exit. A skipped signal, a start time not read, or a read too slow is a server that is left alone, said as such with
// what the boss does next (R13c-F001, F003). One table: every caller against every state of the old server.

const ISO = "2026-11-01T00:00:07.000Z";
const never = () => new Promise<string | undefined>(() => {});
const after = (ms: number, value: string) => () => new Promise<string | undefined>((resolve) => setTimeout(() => resolve(value), ms));
const abortable = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true }); });

interface Scenario {
	name: string;
	/** Whether the old server is signalled and seen to leave; if not, nothing is started and nothing is marked. */
	ends: boolean;
	record?: Partial<ServerRecord>;
	/** The old server's socket accepts and never answers (a stuck loop) instead of closing the hello. */
	silent?: boolean;
	ctx: Partial<Ctx>;
}
const scenarios: Scenario[] = [
	{ name: "legacy, the start time is read again and is the record's: signalled, seen to exit", ends: true, ctx: { startOf: (pid: number) => (pid === 7 ? ISO : undefined), startedLater: async () => ISO } },
	// The re-read after the cache is forgotten takes longer than the old 3 s wait and ends well before the deadline: the signal still goes (R13c-F001).
	{ name: "legacy, the re-read is slower than 3 s but under the deadline: signalled", ends: true, ctx: { startOf: (pid: number) => (pid === 7 ? ISO : undefined), startedLater: after(20, ISO), sleep: (ms: number, signal?: AbortSignal) => (ms === 3000 ? Promise.resolve() : abortable(ms, signal)) } },
	{ name: "legacy skip: the re-read never lands within its limit", ends: false, ctx: { startOf: (pid: number) => (pid === 7 ? ISO : undefined), startedLater: never, sleep: async () => {} } },
	{ name: "unread: the start time is not told at all", ends: false, ctx: { startOf: () => undefined, startedLater: never, sleep: async () => {} } },
	// Not legacy at all: the same package's server whose pid runs with the record's start time, and whose socket is gone. A server in doubt is not raced either.
	{ name: "a server of this package that runs and answers nothing", ends: false, record: { version: "0.44.0", socket: "/nowhere.sock" }, ctx: { startOf: (pid: number) => (pid === 7 ? ISO : undefined), startedLater: async () => ISO, sleep: async () => {} } },
	// R13e-F001: a stuck or slow server of this package, whose start time is not cached and is not read in time: the hello times out, and it is held, never joined by a second server.
	{ name: "a server of this package that answers nothing, start time not read", ends: false, silent: true, record: { version: "0.44.0" }, ctx: { startOf: () => undefined, startedLater: never, sleep: async () => {} } },
];

interface Caller { name: string; run(w: ServerWorld, ctx: Ctx): Promise<{ said: string; threw?: Error }> }
const attempt = async (work: () => Promise<unknown>) => {
	try {
		return { said: JSON.stringify(await work()) };
	} catch (error) {
		return { said: (error as Error).message, threw: error as Error };
	}
};

async function cliUp(w: ServerWorld, ctx: Ctx) {
	const { by: _by, ...requester } = ctx;
	let out = "", err = "";
	const deps: CliDeps = { env: w.env, stateDir: w.stateDir, version: ctx.version, cli: "/fake/cli.mjs", ctx: { ...requester, env: w.env }, herdrListens: async () => true, out: (t) => void (out += t), err: (t) => void (err += t) };
	const code = await run(["up"], deps);
	return { said: `${out}${err}`, ...(code === 0 ? {} : { threw: new Error(`${err}${out}`) }) };
}
async function lookOf(w: ServerWorld, over: Partial<Ctx>, until_: () => unknown, ms?: number) {
	const world = new World();
	const { slot: _slot, version: _version, by: _by, env: _env, cli: _cli, now: _now, log: _log, ...rest } = w.ctx({ version: "0.44.0" });
	const agent = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: w.env.HOME! }, deps: { stateDir: w.stateDir, version: "0.44.0", adoptMs: 30, server: w.server({ ...rest, ...over }) } });
	try {
		await agent.start();
		await until(until_, "the look to have decided", ms);
	} finally {
		await world.stopAll();
	}
	return { said: "", notices: agent.notices.map((n) => n.text) };
}
const callers: Caller[] = [
	{ name: "ensure", run: (_w, ctx) => attempt(() => ensure(ctx)) },
	{ name: "ensure (the boss's start)", run: (_w, ctx) => attempt(() => ensure(ctx, { boss: true })) },
	{ name: "restart", run: (_w, ctx) => attempt(() => restart(ctx, { reason: "r", boss: true })) },
	{ name: "stop", run: (_w, ctx) => attempt(() => stop(ctx)) },
	{ name: "cli up", run: (w, ctx) => cliUp(w, ctx) },
	{ name: "a tower's ask", run: (_w, ctx) => attempt(() => ensureTowerVia(ctx, { workspace: "w1" })) },
];

let open: Server[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))));
});

/** An older server (pid 7) whose socket closes any hello; `kill` ends it. */
async function older(w: ServerWorld, record: Partial<ServerRecord>, silent = false) {
	secretDir(w.slot.dir);
	const socket = join(w.slot.dir, "older.sock"), killed: [number, string][] = [];
	const srv = createServer((conn) => (silent ? conn.on("data", () => {}) : conn.on("data", () => conn.destroy())).on("error", () => {}));
	open.push(srv);
	await new Promise<void>((resolve) => srv.listen(socket, resolve));
	w.live.add(7);
	mkdirSync(w.slot.dir, { recursive: true });
	writeRecord(w.slot, { pid: 7, started: ISO, version: "0.43.0", herdr: w.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket, secret: "s".repeat(64), intercomId: "sb-server-00000000", ...record });
	return { killed, kill: (pid: number, signal: string) => { killed.push([pid, signal]); w.live.delete(pid); srv.close(); } };
}

for (const scenario of scenarios) {
	for (const caller of callers) {
		test(`R13d invariant: ${caller.name} against ${scenario.name}`, async () => {
			const w = new ServerWorld();
			try {
				const o = await older(w, scenario.record ?? {}, scenario.silent);
				const ctx = w.ctx({ platform: "win32", kill: o.kill as never, ...scenario.ctx });
				const out = await caller.run(w, ctx);
				const record = readRecord(w.slot);
				if (scenario.ends) {
					assert.deepEqual(o.killed, [[7, "SIGTERM"]], `${caller.name}: the old server is signalled once`);
					assert.equal(w.live.has(7), false);
					if (caller.name === "stop") {
						assert.equal(w.spawned.length, 0, "a stop starts nothing");
						assert.equal(record?.stopped, true, "the old server was seen to exit: the stop is marked");
					} else {
						assert.equal(w.spawned.length, 1, `${caller.name}: one new server`);
						assert.notEqual(record?.pid, 7);
						assert.equal(record?.stopped, undefined);
					}
					return;
				}
				assert.equal(w.spawned.length, 0, `${caller.name}: nothing is started beside a server that may run (${out.said})`);
				assert.deepEqual(o.killed, [], "nothing is signalled");
				assert.equal(record?.pid, 7, "the record is the old server's");
				assert.equal(record?.stopped, undefined, `${caller.name}: a server that may run is not marked stopped`);
				assert.equal(w.live.has(7), true);
				if (caller.name === "ensure" || caller.name === "ensure (the boss's start)") assert.match(out.said, /"server":"found"/);
				else {
					assert.ok(out.threw, `${caller.name} says it did not do it (${out.said})`);
					assert.match(out.said, /taskkill \/F \/PID 7\b/, `${caller.name}: the words name what to do`);
					if (out.threw instanceof ServerError) assert.equal(out.threw.code, "unreachable");
				}
			} finally {
				await w.close();
			}
		});
	}
	test(`R13d invariant: a session's look against ${scenario.name}`, async () => {
		const w = new ServerWorld();
		try {
			const o = await older(w, scenario.record ?? {}, scenario.silent);
			let probes = 0;
			const alive = (pid: number) => (pid === 7 && probes++, w.live.has(pid));
			const { notices } = await lookOf(w, { platform: "win32", kill: o.kill as never, alive, ...scenario.ctx }, () => (scenario.ends ? w.spawned.length >= 1 && readRecord(w.slot)?.pid !== 7 : probes >= 12), scenario.silent ? 60_000 : undefined);
			const record = readRecord(w.slot);
			if (!scenario.ends) {
				// R13e-F002: the boss is told once, with the remedy, that the server is held.
				const held = notices.filter((text) => /left alone and nothing is started beside it/.test(text));
				assert.equal(held.length, 1, `told once (${notices.join(" | ")})`);
				assert.match(held[0]!, /taskkill \/F \/PID 7\b/);
			}
			if (scenario.ends) {
				assert.deepEqual(o.killed, [[7, "SIGTERM"]]);
				assert.equal(w.spawned.length, 1);
				return;
			}
			assert.equal(w.spawned.length, 0, "a look starts nothing beside a server that may run");
			assert.deepEqual(o.killed, []);
			assert.deepEqual([record?.pid, record?.stopped], [7, undefined]);
		} finally {
			await w.close();
		}
	});
}

// R13e-F002: the notice is forgotten when the hold clears: the same server held again is told again.
test("R13e-F002: a held server is told once, again after the hold cleared", async () => {
	const w = new ServerWorld();
	try {
		const o = await older(w, { version: "0.44.0" }, true);
		let up = true, down = 0;
		const told = (notices: string[]) => notices.filter((text) => /left alone and nothing is started beside it/.test(text)).length;
		const base = { platform: "win32" as const, kill: o.kill as never, startOf: (pid: number) => (pid === 7 ? ISO : undefined), startedLater: async () => ISO, sleep: async () => {}, alive: (pid: number) => (pid === 7 ? (up || down++, up) : w.live.has(pid)) };
		const world = new World();
		const { slot: _slot, version: _version, by: _by, env: _env, cli: _cli, now: _now, log: _log, ...rest } = w.ctx({ version: "0.44.0" });
		const agent = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: w.env.HOME! }, deps: { stateDir: w.stateDir, version: "0.44.0", adoptMs: 30, server: w.server({ ...rest, ...base }) } });
		try {
			await agent.start();
			await until(() => told(agent.notices.map((n) => n.text)) === 1, "the first notice", 30_000);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(told(agent.notices.map((n) => n.text)), 1, "told once while the hold lasts");
			// While the server is not running, the record says a restart is under way, so the look neither starts nor tells anything.
			const at = new Date(w.ctx().now()).toISOString();
			updateRecord(w.slot, (r) => ({ ...r, restarting: { began: at, since: at, reason: "t", by: "t" } }));
			up = false;
			await until(() => down > 0, "a look that finds the server not running", 30_000);
			up = true;
			updateRecord(w.slot, ({ restarting: _r, ...r }) => r);
			await until(() => told(agent.notices.map((n) => n.text)) === 2, "the notice again after the hold cleared", 30_000);
		} finally {
			await world.stopAll();
		}
	} finally {
		await w.close();
	}
});

// The rule is kept where every start passes, not only where a caller looks first: `launch` itself refuses, whatever picture its caller had.
for (const scenario of scenarios.filter((x) => !x.ends)) {
	test(`R13d invariant: launch itself starts nothing beside ${scenario.name}`, async () => {
		const w = new ServerWorld();
		try {
			const o = await older(w, scenario.record ?? {}, scenario.silent);
			const ctx = w.ctx({ platform: "win32", kill: o.kill as never, ...scenario.ctx });
			await assert.rejects(launch(ctx), (e: unknown) => e instanceof ServerError && e.code === "unreachable" && /taskkill \/F \/PID 7\b/.test(e.message));
			assert.deepEqual([w.spawned.length, o.killed, readRecord(w.slot)?.pid, readRecord(w.slot)?.stopped], [0, [], 7, undefined]);
		} finally {
			await w.close();
		}
	});
}

// `cli.mjs serve` runs the server in its own process: it is a caller too (a supervisor's), and it starts nothing beside a server that may run.
for (const scenario of scenarios) {
	test(`R13d invariant: serve against ${scenario.name}`, async () => {
		const w = new ServerWorld();
		try {
			const o = await older(w, scenario.record ?? {}, scenario.silent);
			const ctx = w.ctx({ platform: "win32", kill: o.kill as never, ...scenario.ctx });
			const { by: _by, ...requester } = ctx;
			let err = "", started = 0;
			const code = await run(["serve"], {
				env: w.env, stateDir: w.stateDir, version: ctx.version, cli: "/fake/cli.mjs", ctx: { ...requester, env: w.env }, herdrListens: async () => true, out: () => {}, err: (t) => void (err += t),
				server: async () => { started++; throw new Error("the foreground server would start here"); },
			}).catch((error: Error) => (error.message.includes("would start here") ? -1 : Promise.reject(error)));
			if (scenario.ends) {
				assert.deepEqual([code, started, o.killed], [-1, 1, [[7, "SIGTERM"]]], "the old server is signalled once, then the foreground server starts");
				return;
			}
			assert.deepEqual([code, started, o.killed], [1, 0, []], err);
			assert.match(err, /taskkill \/F \/PID 7\b/);
			assert.deepEqual([readRecord(w.slot)?.pid, readRecord(w.slot)?.stopped], [7, undefined]);
		} finally {
			await w.close();
		}
	});
}

// --- R13c-F001: what a look costs while the old server is pending ---

test("R13d: a look does not start a read of the start time at every turn while the old server is pending: one read in flight serves them all", async () => {
	const w = new ServerWorld();
	try {
		// The first read (the cache is warmed) answers; every later one hangs, as a PowerShell does on a machine too busy to answer.
		const reads: number[] = [];
		const launch = (_file: string, args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
			reads.push(Number(/ProcessId=(\d+)/.exec(args.at(-1)!)?.[1]));
			if (reads.length === 1) queueMicrotask(() => done(null, ISO));
		};
		const starts = createStartOf({ platform: "win32", launch });
		assert.equal(await starts.startedLater(7, { hold: false }), ISO);
		const o = await older(w, {});
		let probes = 0;
		const alive = (pid: number) => (pid === 7 && probes++, w.live.has(pid));
		await lookOf(w, { platform: "win32", kill: o.kill as never, alive, startOf: starts.startOf, startedLater: (pid: number) => starts.startedLater(pid, { hold: false }), forgetStart: starts.forget, sleep: async () => {} }, () => probes >= 12);
		assert.deepEqual(reads, [7, 7], "the warm-up and one read for the signal; a dozen looks add none");
		assert.equal(w.spawned.length, 0);
		assert.deepEqual(o.killed, []);
		assert.deepEqual([readRecord(w.slot)?.pid, readRecord(w.slot)?.stopped], [7, undefined]);
	} finally {
		await w.close();
	}
});

test("R13d: a start time the probe itself read in this call is not forgotten and read again before the signal", async () => {
	const w = new ServerWorld();
	try {
		const o = await older(w, {});
		let cache: string | undefined, reads = 0, forgets = 0, forgetsAtKill = -1;
		const ctx = w.ctx({
			platform: "win32", kill: ((pid: number, signal: string) => ((forgetsAtKill = forgets), o.kill(pid, signal))) as never,
			startOf: (pid: number) => (pid === 7 ? cache : undefined),
			startedLater: async (pid: number) => { if (pid !== 7) return undefined; reads++; cache = ISO; return ISO; },
			forgetStart: () => void (forgets++, (cache = undefined)),
		});
		const got = await ensure(ctx);
		assert.ok("server" in got && got.server === "started", JSON.stringify(got));
		assert.deepEqual(o.killed, [[7, "SIGTERM"]]);
		// A pid seen dead after the signal is forgotten (R13e-F005); nothing is forgotten before it.
		assert.deepEqual([reads, forgetsAtKill], [1, 0], "the read that told the time is the one the signal rests on");
	} finally {
		await w.close();
	}
});
