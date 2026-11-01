import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASK_MS, parseArgs, run, type SpawnSpec, UsageError } from "../src/agent/cli.ts";
import { agentFiles, alive, ask, type Held, NoSidecar, readHeld } from "../src/agent/paths.ts";
import { listenControl, PROTOCOL, proofOf } from "../src/server/socket.ts";

const dirs: string[] = [], servers: Server[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()));
	servers.splice(0).forEach((server) => server.close());
	dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const PANE = "wA:p3", SESSION = "085ff3b1-aaaa", cliPath = fileURLToPath(new URL("../src/agent/cli.ts", import.meta.url));
const scratch = () => {
	const stateDir = mkdtempSync(join(tmpdir(), "psb-cli-"));
	dirs.push(stateDir);
	const files = agentFiles(stateDir, PANE);
	mkdirSync(files.dir, { recursive: true });
	return { stateDir, files };
};
const SECRET = "ab".repeat(32);
const held = (over: Partial<Held> = {}): Held => ({ secret: SECRET, proto: PROTOCOL, pid: process.pid, session: SESSION, kind: "claude", pane: PANE, id: `claude-${SESSION}`, name: "claude-085ff3b1", startedAt: 1, ...over });
const output = () => {
	const out: string[] = [], err: string[] = [];
	return { out, err, deps: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) } };
};
/** A sidecar's control socket (the real handshake: hello secret in, proof out) that answers each request with `answer` and records what it was asked. */
async function sidecarAt(files: ReturnType<typeof agentFiles>, answer: (request: Record<string, unknown>) => Record<string, unknown>, hello: (held: Held) => Record<string, unknown> = () => ({})) {
	mkdirSync(files.dir, { recursive: true });
	const asked: Record<string, unknown>[] = [];
	const control = await listenControl({
		endpoint: files.socket,
		secret: SECRET,
		// Who it is: what a sidecar answers before anything else, from the state file it would have written.
		hello: () => {
			const held = readHeld(files);
			return held && alive(held.pid) ? { pid: held.pid, session: held.session, ...hello(held) } : { pid: -1 };
		},
		handle: (request) => (asked.push(request), answer(request) as { ok: boolean }),
	});
	closers.push(() => control.close());
	return asked;
}
/** A squatter at a dead sidecar's name: it accepts, answers hello with a wrong or absent proof, and records every byte it is sent. */
async function squatterAt(files: ReturnType<typeof agentFiles>, proof: "none" | "wrong") {
	mkdirSync(files.dir, { recursive: true });
	const received: string[] = [];
	const server = createServer((conn) => {
		let first = true;
		conn.setEncoding("utf8").on("data", (chunk: string) => {
			received.push(chunk);
			if (first) conn.write(`${JSON.stringify({ ok: true, v: PROTOCOL, nonce: "s", pid: process.pid, session: SESSION, ...(proof === "wrong" ? { proof: "00".repeat(32) } : {}) })}\n`);
			first = false;
		});
		conn.on("error", () => {});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(files.socket, resolve));
	return received;
}

test("arguments: each command takes its own flags, the pane defaults to the one the process runs in, and anything else is a usage error", () => {
	assert.deepEqual(parseArgs(["join", "--pane", PANE, "--kind", "codex", "--session", "s1", "--record", "/r.json", "--cli", "/x/straw-net.py"], {}), { command: "join", pane: PANE, kind: "codex", session: "s1", record: "/r.json", cli: "/x/straw-net.py" });
	assert.deepEqual(parseArgs(["status"], { HERDR_PANE_ID: "wB:p1" }), { command: "status", pane: "wB:p1" });
	assert.deepEqual(parseArgs(["call-tower", "--message", "help", "--workspace", "Beta"], { HERDR_PANE_ID: PANE }), { command: "call-tower", pane: PANE, message: "help", workspace: "Beta" });
	assert.deepEqual(parseArgs(["broadcast", "--message", "hi"], { HERDR_PANE_ID: PANE }), { command: "broadcast", pane: PANE, message: "hi" });
	assert.deepEqual(parseArgs(["broadcast", "--message", "hi", "--scope", "all"], { HERDR_PANE_ID: PANE }), { command: "broadcast", pane: PANE, message: "hi", scope: "all" });
	assert.deepEqual(parseArgs(["send", "--to", "tower", "--message", "ok", "--pane", "wZ:p9"], {}), { command: "send", pane: "wZ:p9", to: "tower", message: "ok" });
	assert.deepEqual(parseArgs(["rename", "--name", "MP-1"], { HERDR_PANE_ID: PANE }), { command: "rename", pane: PANE, name: "MP-1" });
	assert.deepEqual(parseArgs(["board", "--now", "MP-1 export", "--item", "[x] schema", "--item", "[ ] writer"], { HERDR_PANE_ID: PANE }), { command: "board", pane: PANE, now: "MP-1 export", item: ["[x] schema", "[ ] writer"] });
	assert.deepEqual(parseArgs(["board", "--now", "no items"], { HERDR_PANE_ID: PANE }), { command: "board", pane: PANE, now: "no items" });
	assert.throws(() => parseArgs(["board"], { HERDR_PANE_ID: PANE }), /--now is required/);
	assert.deepEqual(parseArgs(["board", "--clear"], { HERDR_PANE_ID: PANE }), { command: "board", pane: PANE, clear: "true" });
	assert.deepEqual(parseArgs(["board", "--clear", "--pane", "wA:p9"], { HERDR_PANE_ID: PANE }), { command: "board", pane: "wA:p9", clear: "true" });
	assert.throws(() => parseArgs(["board", "--clear", "--now", "x"], { HERDR_PANE_ID: PANE }), /--clear takes no/);
	assert.throws(() => parseArgs(["rename", "--name", "n", "--item", "[x] a"], { HERDR_PANE_ID: PANE }), /--item belongs to the board command/);
	assert.throws(() => parseArgs(["rename", "--name", "n", "--clear"], { HERDR_PANE_ID: PANE }), /unknown option --clear|--clear belongs to the board command/);
	assert.deepEqual(parseArgs(["promote"], { HERDR_PANE_ID: PANE }), { command: "promote", pane: PANE });
	assert.deepEqual(parseArgs(["stop"], { HERDR_PANE_ID: PANE }), { command: "stop", pane: PANE });
	const env = { HERDR_PANE_ID: PANE };
	for (const [argv, own, message] of [
		[[], env, /usage:/],
		[["frobnicate"], env, /unknown command frobnicate/],
		[["toString"], env, /unknown command toString/],
		[["status"], {}, /--pane or HERDR_PANE_ID/],
		[["join", "--pane", PANE, "--kind", "gemini", "--session", "s"], {}, /--kind must be claude or codex/],
		[["join", "--pane", PANE, "--kind", "claude"], {}, /--session is required/],
		[["broadcast", "--message", "x", "--scope", "galaxy"], env, /--scope must be tab, workspace, towers, or all/],
		[["broadcast"], env, /--message is required/],
		[["send", "--message", "x"], env, /--to is required/],
		[["status", "--bogus", "1"], env, /unknown option --bogus/],
		[["status", "--pane"], env, /--pane needs a value/],
	] as [string[], NodeJS.ProcessEnv, RegExp][]) assert.throws(() => parseArgs(argv, own), (error: Error) => error instanceof UsageError && message.test(error.message), `${argv.join(" ")} → ${message}`);
});

test("a pane with no sidecar is exit 2 for every command that talks to one, with the reason on stderr", async () => {
	const { stateDir } = scratch();
	for (const argv of [["status"], ["promote"], ["call-tower", "--message", "m"], ["broadcast", "--message", "m"], ["send", "--to", "t", "--message", "m"], ["rename", "--name", "n"], ["stop"]]) {
		const o = output();
		assert.equal(await run([...argv, "--pane", PANE], { stateDir, ...o.deps }), 2, argv[0]);
		assert.match(o.err.join(""), /no net sidecar for pane wA:p3/);
		assert.deepEqual(o.out, []);
	}
});

test("a state file of a process that has ended, or a socket nobody listens on, is no sidecar either", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held({ pid: 2 ** 22 + 1 })));
	const gone = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...gone.deps }), 2);
	writeFileSync(files.state, JSON.stringify(held()));
	const silent = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...silent.deps }), 2);
	assert.match(silent.err.join(""), /no net sidecar for pane wA:p3/);
});

test("R-F005: a sidecar that is connected to and does not answer in time is exit 1 (it may still act), not 2 (no sidecar); call-tower is given longer than the rest", { timeout: 4000 }, async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	// It proves itself, takes the request, and does not answer (a peer that never answers the hello is another case: R13-F004 below).
	mkdirSync(files.dir, { recursive: true });
	closers.push((await listenControl({ endpoint: files.socket, secret: SECRET, hello: () => ({ pid: process.pid, session: SESSION }), handle: () => new Promise(() => {}) })).close);
	const o = output();
	assert.equal(await run(["call-tower", "--message", "m", "--pane", PANE], { stateDir, askMs: 150, ...o.deps }), 1);
	assert.match(o.err.join(""), /did not answer within 0\.15 s/);
	assert.ok(ASK_MS["call-tower"]! >= 120_000 && ASK_MS["call-tower"]! > ASK_MS.default!, JSON.stringify(ASK_MS));
});

test("a command sends one request and prints the reply: the text, or the status as JSON; a refusal is exit 1 with its reason", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	const asked = await sidecarAt(files, (request) => {
		if (request.cmd === "status") return { ok: true, me: { id: "claude-x", role: "member" }, tabs: [] };
		if (request.cmd === "promote") return { ok: false, error: "Tab work already has a main agent, Pi One." };
		return { ok: true, text: `done ${String(request.cmd)}` };
	});
	const status = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...status.deps }), 0);
	assert.deepEqual(JSON.parse(status.out.join("")), { me: { id: "claude-x", role: "member" }, tabs: [] });
	const refused = output();
	assert.equal(await run(["promote", "--pane", PANE], { stateDir, ...refused.deps }), 1);
	assert.equal(refused.err.join("").trim(), "Tab work already has a main agent, Pi One.");
	const call = output();
	assert.equal(await run(["call-tower", "--message", "help", "--workspace", "Beta", "--pane", PANE], { stateDir, ...call.deps }), 0);
	assert.equal(call.out.join("").trim(), "done call-tower");
	await run(["broadcast", "--message", "b", "--pane", PANE], { stateDir, ...output().deps });
	await run(["send", "--to", "t", "--message", "s", "--pane", PANE], { stateDir, ...output().deps });
	await run(["rename", "--name", "n", "--pane", PANE], { stateDir, ...output().deps });
	assert.deepEqual(asked, [{ cmd: "status" }, { cmd: "promote" }, { cmd: "call-tower", message: "help", workspace: "Beta" }, { cmd: "broadcast", message: "b" }, { cmd: "send", to: "t", message: "s" }, { cmd: "rename", name: "n" }]);
});

test("a usage error is exit 2 with the usage on stderr", async () => {
	const o = output();
	assert.equal(await run(["send", "--message", "x"], { stateDir: scratch().stateDir, env: { HERDR_PANE_ID: PANE }, ...o.deps }), 2);
	assert.match(o.err.join(""), /--to is required/);
});

const spawner = (files: ReturnType<typeof agentFiles>, write: boolean) => {
	const spawned: SpawnSpec[] = [];
	return { spawned, spawn: (spec: SpawnSpec) => {
		spawned.push(spec);
		if (write) writeFileSync(files.state, JSON.stringify(held({ session: spec.args[spec.args.indexOf("--session") + 1]!, startedAt: Date.now() })));
		return { exited: new Promise<number | null>(() => {}) };
	} };
};
const joinArgs = ["join", "--pane", PANE, "--kind", "claude", "--session", SESSION, "--record", "/home/r/claude-x.json", "--cli", "/x/straw-net.py"];

test("join starts one detached sidecar with the tsx loader, the pane in its environment, and every flag, and returns once its state file exists", async () => {
	const { stateDir, files } = scratch();
	mkdirSync(files.dir, { recursive: true });
	const { spawned, spawn } = spawner(files, true);
	const o = output();
	assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/n/tsx/dist/loader.mjs", env: { HERDR_PANE_ID: "wX:p0", PI_INTERCOM_SESSION_ID: "pi-session" }, ...o.deps }), 0);
	assert.equal(spawned.length, 1);
	assert.deepEqual(spawned[0]!.args, ["--import", pathToFileURL("/n/tsx/dist/loader.mjs").href, cliPath, "serve", "--pane", PANE, "--kind", "claude", "--session", SESSION, "--record", "/home/r/claude-x.json", "--cli", "/x/straw-net.py"]);
	assert.equal(spawned[0]!.command, process.execPath);
	assert.equal(spawned[0]!.env.HERDR_PANE_ID, PANE);
	assert.equal(spawned[0]!.log, files.log);
	assert.match(o.out.join(""), /^joining as claude-085ff3b1/);
});

test("join is idempotent: a live sidecar of the same session is left alone, a dead one's leftover is replaced", async () => {
	const { stateDir, files } = scratch();
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(held()));
	await sidecarAt(files, () => ({ ok: true }));
	const same = spawner(files, true);
	assert.equal(await run(joinArgs, { stateDir, spawn: same.spawn, loader: "/l.mjs", ...output().deps }), 0);
	assert.deepEqual(same.spawned, []);
	writeFileSync(files.state, JSON.stringify(held({ pid: 2 ** 22 + 1 })));
	const dead = spawner(files, true);
	assert.equal(await run(joinArgs, { stateDir, spawn: dead.spawn, loader: "/l.mjs", ...output().deps }), 0);
	assert.equal(dead.spawned.length, 1);
});

test("join for another session in a pane that has a sidecar (a /clear) stops the old one, waits for it to leave, then starts the new one", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held({ session: "old-session" })));
	const order: string[] = [];
	await sidecarAt(files, (request) => {
		order.push(String(request.cmd));
		setTimeout(() => rmSync(files.state, { force: true }), 30); // it leaves a moment after it answers
		return { ok: true, text: "Left the net." };
	});
	const spawned: SpawnSpec[] = [];
	const spawnNew = (spec: SpawnSpec) => (order.push("spawn"), writeFileSync(files.state, JSON.stringify(held({ startedAt: Date.now() }))), spawned.push(spec), { exited: new Promise<number | null>(() => {}) });
	assert.equal(await run(joinArgs, { stateDir, spawn: spawnNew, loader: "/l.mjs", ...output().deps }), 0);
	assert.deepEqual(order, ["stop", "spawn"]);
	assert.equal(spawned.length, 1);
});

test("join says so, with exit 1, when the sidecar's state file does not appear in time or the process ends first", async () => {
	const { stateDir, files } = scratch();
	const slow = output();
	assert.equal(await run(joinArgs, { stateDir, spawn: () => ({ exited: new Promise<number | null>(() => {}) }), loader: "/l.mjs", joinMs: 100, ...slow.deps }), 1);
	assert.match(slow.err.join(""), /did not start within 0\.1 s; see .*\.log/);
	const dies = output();
	assert.equal(await run(joinArgs, { stateDir, spawn: () => ({ exited: Promise.resolve(1) }), loader: "/l.mjs", joinMs: 2000, ...dies.deps }), 1);
	assert.match(dies.err.join(""), /exited with code 1; see .*\.log/);
	const noLoader = output();
	// Nowhere to find pi-intercom: not in the agent directory, and not beside the package (a checkout may sit next to a pi-intercom checkout).
	assert.equal(await run(joinArgs, { stateDir, env: { PI_CODING_AGENT_DIR: stateDir }, here: join(stateDir, "a", "b", "c"), spawn: () => ({ exited: new Promise<number | null>(() => {}) }), ...noLoader.deps }), 1);
	assert.match(noLoader.err.join(""), /pi-intercom/);
});

test("R-F002: join never signals a process the sidecar's socket has not confirmed: a state file naming an unrelated live pid is a leftover", async () => {
	const { stateDir, files } = scratch();
	const victim = spawnChild("sleep", ["60"], { stdio: "ignore" });
	try {
		writeFileSync(files.state, JSON.stringify(held({ pid: victim.pid!, session: "old-session", startedAt: Date.now() - 3_600_000 })));
		const { spawned, spawn } = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 100, ...output().deps }), 0);
		assert.equal(spawned.length, 1);
		assert.equal(alive(victim.pid!), true);
		assert.equal(victim.exitCode, null, "it was not sent SIGTERM");
	} finally {
		victim.kill("SIGKILL");
	}
});

test("R-F002: a sidecar that answers on its socket and does not leave when asked is stopped by SIGTERM", async () => {
	const { stateDir, files } = scratch();
	const stubborn = spawnChild("sleep", ["60"], { stdio: "ignore" });
	stubborn.once("exit", () => rmSync(files.state, { force: true }));
	try {
		writeFileSync(files.state, JSON.stringify(held({ pid: stubborn.pid!, session: "old-session" })));
		await sidecarAt(files, () => ({ ok: true, text: "Left the net." }));
		const { spawned, spawn } = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 150, ...output().deps }), 0);
		assert.equal(spawned.length, 1);
		assert.notEqual(stubborn.exitCode ?? stubborn.signalCode, null, "it was sent SIGTERM");
	} finally {
		stubborn.kill("SIGKILL");
	}
});

test("R-F007: a join for the session whose sidecar is leaving waits for it to be gone, then starts a new one, and does not say it is already joined", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	await sidecarAt(files, () => ({ ok: true, text: "Left the net." }), (held) => ({ leaving: held.startedAt === 1 })); // the one that is leaving is the file as it was written; the new sidecar's is not
	setTimeout(() => rmSync(files.state, { force: true }), 120);
	const { spawned, spawn } = spawner(files, true);
	const o = output();
	assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", ...o.deps }), 0);
	assert.equal(spawned.length, 1);
	assert.doesNotMatch(o.out.join(""), /already joined/);
});

test("D19: call-tower takes --why (milestone, shared, blocked) and --reply (true, false); other words are usage errors", () => {
	assert.deepEqual(parseArgs(["call-tower", "--message", "landed", "--why", "milestone", "--reply", "false"], { HERDR_PANE_ID: PANE }), { command: "call-tower", pane: PANE, message: "landed", why: "milestone", reply: "false" });
	for (const why of ["milestone", "shared", "blocked"]) assert.equal(parseArgs(["call-tower", "--message", "m", "--why", why], { HERDR_PANE_ID: PANE }).why, why);
	assert.throws(() => parseArgs(["call-tower", "--message", "m", "--why", "progress"], { HERDR_PANE_ID: PANE }), /--why must be milestone, shared, or blocked/);
	assert.throws(() => parseArgs(["call-tower", "--message", "m", "--reply", "maybe"], { HERDR_PANE_ID: PANE }), /--reply must be true or false/);
	assert.throws(() => parseArgs(["broadcast", "--message", "m", "--why", "blocked"], { HERDR_PANE_ID: PANE }), /unknown option|--why belongs/);
});

for (const proof of ["none", "wrong"] as const) {
	test(`T13a: a squatter at a dead sidecar's name that answers hello with ${proof === "none" ? "no proof" : "a wrong proof"} gets no request, and the command reports no sidecar`, async () => {
		const { stateDir, files } = scratch();
		writeFileSync(files.state, JSON.stringify(held()));
		const received = await squatterAt(files, proof);
		const o = output();
		assert.equal(await run(["send", "--to", "t", "--message", "top secret", "--pane", PANE], { stateDir, ...o.deps }), 2);
		assert.match(o.err.join(""), /no net sidecar for pane wA:p3/);
		assert.deepEqual(o.out, []);
		assert.equal(received.length, 1, "only the hello arrived");
		assert.doesNotMatch(received.join(""), /top secret|"send"/);
		await assert.rejects(ask(files.socket, SECRET, { cmd: "status" }, 1000), NoSidecar);
		assert.equal(received.join("").includes("status"), false);
	});
}

test("T13a: a state file with no secret is no sidecar, and nothing is sent to its socket", async () => {
	const { stateDir, files } = scratch();
	const { secret: _s, ...bare } = held();
	writeFileSync(files.state, JSON.stringify(bare));
	const received = await squatterAt(files, "none");
	const o = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...o.deps }), 2);
	assert.deepEqual(received, []);
});

test("the normal path: a sidecar that proves itself gets the request and answers it", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	const asked = await sidecarAt(files, (r) => ({ ok: true, text: `did ${String(r.cmd)}` }));
	const o = output();
	assert.equal(await run(["rename", "--name", "n", "--pane", PANE], { stateDir, ...o.deps }), 0);
	assert.equal(o.out.join(""), "did rename\n");
	assert.deepEqual(asked.map((r) => r.cmd), ["rename"]);
	await assert.rejects(ask(files.socket, "cd".repeat(32), { cmd: "status" }, 1000), NoSidecar, "a wrong secret is refused with no answer");
});

// --- R13-F001: an active squatter, one that reads the hello and answers as the server ---

test("R13-F003: a sidecar that proves itself, receives the request, and drops the connection is exit 1 \"may still be carried out\", never \"no sidecar\"", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	mkdirSync(files.dir, { recursive: true });
	const asked: string[] = [];
	const control = await listenControl({ endpoint: files.socket, secret: SECRET, hello: () => ({ pid: process.pid, session: SESSION }), handle: (request) => (asked.push(String(request.cmd)), new Promise(() => {})) });
	closers.push(() => control.close());
	// The sidecar's end of the connection is destroyed after the request has reached it.
	const o = output(), pending = run(["send", "--to", "t", "--message", "m", "--pane", PANE], { stateDir, askMs: 5000, ...o.deps });
	await new Promise((resolve) => setTimeout(resolve, 100));
	await control.close(); // the sidecar dies with the request in hand
	assert.equal(await pending, 1);
	assert.deepEqual(asked, ["send"], "the request reached it");
	assert.match(o.err.join(""), /may still be carried out, so check before sending it again/);
	assert.doesNotMatch(o.err.join(""), /no net sidecar/);
});

test("R13-F004: a silent squatter is no sidecar and nothing but the hello was sent; the wait is the hello's, and the words say so", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	mkdirSync(files.dir, { recursive: true });
	const received: string[] = [];
	const server = createServer((conn) => conn.setEncoding("utf8").on("data", (chunk: string) => received.push(chunk)).on("error", () => {}));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(files.socket, resolve));
	const o = output();
	assert.equal(await run(["send", "--to", "t", "--message", "top secret", "--pane", PANE], { stateDir, askMs: 300, ...o.deps }), 2);
	assert.match(o.err.join(""), /no net sidecar/);
	assert.doesNotMatch(o.err.join(""), /may still be carried out/);
	assert.doesNotMatch(received.join(""), /top secret/);
	await assert.rejects(ask(files.socket, SECRET, { cmd: "send", message: "m" }, 300), (error) => error instanceof NoSidecar && /nothing was sent but the hello/.test(error.message));
});

test("mixed versions: a sidecar of another protocol is exit 2 with words that name the mismatch and nothing sent; the secret never goes in clear", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	mkdirSync(files.dir, { recursive: true });
	const received: string[] = [];
	// An older sidecar (the previous handshake): hello held the secret; anything else is closed with no answer.
	const older = createServer((conn) => conn.setEncoding("utf8").on("data", (chunk: string) => (received.push(chunk), conn.destroy())).on("error", () => {}));
	servers.push(older);
	await new Promise<void>((resolve) => older.listen(files.socket, resolve));
	const o = output();
	assert.equal(await run(["send", "--to", "t", "--message", "top secret", "--pane", PANE], { stateDir, askMs: 2000, ...o.deps }), 2);
	assert.match(o.err.join(""), /no net sidecar/);
	assert.ok(!received.join("").includes(SECRET) && !received.join("").includes("top secret"));
	// This package against a sidecar of a newer protocol, which says so.
	older.close();
	rmSync(files.socket, { force: true });
	const newer = createServer((conn) => conn.on("data", () => conn.end(`${JSON.stringify({ ok: false, protocol: PROTOCOL + 1, error: "control protocol mismatch: this side speaks protocol 3, the other speaks 2" })}\n`)).on("error", () => {}));
	servers.push(newer);
	await new Promise<void>((resolve) => newer.listen(files.socket, resolve));
	const n = output();
	assert.equal(await run(["send", "--to", "t", "--message", "top secret", "--pane", PANE], { stateDir, askMs: 2000, ...n.deps }), 2);
	assert.match(n.err.join(""), /control protocol mismatch.*nothing was sent/);
});

// --- R13-F002: join retires a sidecar of an older control protocol ---

test("R13-F002: join ends a sidecar of an older protocol (no secret, or a secret and no proto) once its start time is the state file's, then starts the new one", async () => {
	for (const legacy of [{ secret: undefined, proto: undefined }, { proto: undefined }]) {
		const { stateDir, files } = scratch();
		const old = spawnChild("sleep", ["60"], { stdio: "ignore" });
		try {
			await new Promise((resolve) => setTimeout(resolve, 150)); // the process exists before the file says it started
			writeFileSync(files.state, JSON.stringify(held({ pid: old.pid!, session: "old-session", startedAt: Date.now(), ...legacy })));
			old.once("exit", () => rmSync(files.state, { force: true }));
			const { spawned, spawn } = spawner(files, true);
			const o = output();
			assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 3000, ...o.deps }), 0, o.err.join(""));
			assert.equal(old.signalCode, "SIGTERM", "it was sent SIGTERM");
			assert.equal(spawned.length, 1);
		} finally {
			old.kill("SIGKILL");
		}
	}
});

test("R13-F002: a pid that started after the state file's startedAt is not the sidecar and is not signalled; a sidecar of this protocol is not retired; a stuck one is reported", async () => {
	const { stateDir, files } = scratch();
	const other = spawnChild("sleep", ["60"], { stdio: "ignore" });
	try {
		await new Promise((resolve) => setTimeout(resolve, 150));
		writeFileSync(files.state, JSON.stringify(held({ pid: other.pid!, session: "old-session", proto: undefined, secret: undefined, startedAt: Date.now() - 3_600_000 })));
		const { spawn } = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 100, ...output().deps }), 0);
		assert.equal(other.exitCode, null);
		assert.equal(other.signalCode, null, "not signalled");
		// The process is the file's, but ignores the signal: join says so with exit 1 and starts nothing.
		writeFileSync(files.state, JSON.stringify(held({ pid: other.pid!, session: "old-session", proto: undefined, secret: undefined, startedAt: Date.now() })));
		const stuck = output(), again = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn: again.spawn, loader: "/l.mjs", stopMs: 200, kill: () => {}, ...stuck.deps }), 1);
		assert.match(stuck.err.join(""), /older pi-straw-boss \(pid \d+\) did not leave/);
		assert.deepEqual(again.spawned, []);
		assert.equal(other.signalCode, null);
	} finally {
		other.kill("SIGKILL");
	}
});
