// @ts-nocheck: the fake pi, the fake server and the process tables are loose test data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import hygieneDefault, { BEAT_MS, createHygiene, ownerId } from "../src/hygiene.ts";
import { ageText, cpuText, parseWorktreeList, removeTargets, words } from "../src/procs/guard.ts";
import { OWNER_KEY } from "../src/procs/marker.ts";

let root = "";
const MARK = Symbol.for("pi-straw-boss.run.mark"), NOTE = Symbol.for("pi-straw-boss.hygiene.told");
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "sb-hyg-")));
	delete globalThis[MARK];
	delete globalThis[NOTE];
});
afterEach(() => {
	delete globalThis[MARK];
	delete globalThis[NOTE];
	rmSync(root, { recursive: true, force: true });
});

/** A linked worktree on disk: a folder whose `.git` is a file into `<repo>/.git/worktrees/<name>`. */
function worktree(name: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".git"), `gitdir: ${join(root, "repo", ".git", "worktrees", name)}\n`);
	return dir;
}

const STARTED = "Tue Nov  3 22:00:00 2026";
const NOW = Date.parse(`${STARTED} UTC`) + (6 * 60 + 20) * 60_000;
const proc = (pid: number, over = {}) => ({ pid, ppid: 1, pgid: pid, uid: 501, started: STARTED, cpu: 192, comm: "/usr/local/bin/node", zombie: false, ...over });

/** The fake pi: handlers by event; `fire` runs them in turn and gives the first answer. */
function fakePi() {
	const handlers = new Map<string, Function[]>();
	return {
		on: (name: string, fn: Function) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		async fire(name: string, event: object, ctx: object) {
			let answer;
			for (const fn of handlers.get(name) ?? []) answer ??= await fn(event, ctx);
			return answer;
		},
		count: (name: string) => handlers.get(name)?.length ?? 0,
	};
}

interface Rig { calls: Record<string, unknown>[]; asked: string[]; ticks: (() => void)[]; notes: string[]; pi: ReturnType<typeof fakePi>; env: Record<string, string>; load(): void; ctx(cwd?: string): object; tracked: Promise<unknown>[]; settle(): Promise<void> }
/** One pi with the extension loaded; `server` answers the control socket (undefined: no server). */
function rig(o: { env?: Record<string, string>; platform?: string; argv?: string[]; table?: object[]; cwds?: Record<number, string>; markers?: Record<number, string>; server?: (request: object) => object | undefined; git?: string | Error; workspaces?: object[]; pid?: number } = {}): Rig {
	const calls: Record<string, unknown>[] = [], asked: string[] = [], ticks: (() => void)[] = [], notes: string[] = [], tracked: Promise<unknown>[] = [];
	const env = { ...(o.env ?? {}) };
	const pi = fakePi();
	const make = createHygiene({
		env, platform: o.platform ?? "darwin", argv: o.argv ?? ["node", "pi"], pid: o.pid ?? 4100, now: () => NOW, startOf: () => "Tue Nov  3 21:00:00 2026",
		call: async (request) => (calls.push(request), o.server?.(request)),
		table: async () => (asked.push("table"), o.table ?? []),
		cwds: async (pids) => new Map(pids.flatMap((pid) => (o.cwds?.[pid] ? [[pid, { path: o.cwds[pid] }]] : []))),
		markers: async (pids) => new Map(pids.flatMap((pid) => (o.markers?.[pid] ? [[pid, o.markers[pid]]] : []))),
		git: async (cwd, args) => {
			asked.push(`git ${args.join(" ")} @${cwd}`);
			if (o.git instanceof Error) throw o.git;
			return o.git ?? "";
		},
		workspaces: async () => o.workspaces ?? [],
		terminalOf: async (pane) => `term-of-${pane}`,
		every: (fn) => (ticks.push(fn), () => void ticks.splice(ticks.indexOf(fn), 1)),
		cli: () => "node '/pkg/dist/server/cli.mjs'",
		track: (done) => void tracked.push(done),
	});
	return {
		calls, asked, ticks, notes, pi, env, tracked,
		load: () => make(pi),
		ctx: (cwd = join(root, "main")) => ({ cwd, sessionManager: { getSessionFile: () => "/sessions/w.jsonl" }, ui: { notify: (text: string) => void notes.push(text) } }),
		settle: async () => void (await Promise.allSettled(tracked.splice(0))),
	};
}

test("the marker is set at load in every pi: the pid, with the subagent id in front for a worker", () => {
	const main = rig({ pid: 4100 });
	main.load();
	assert.equal(main.env[OWNER_KEY], "pi-4100");
	const worker = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "agent 7/α" } });
	worker.load();
	assert.equal(worker.env[OWNER_KEY], "agent-7-4200", "an id of the owner registry is letters, digits and . _ - only");
	assert.match(ownerId(7, "x".repeat(100)), /^x+-7$/);
	assert.equal(ownerId(7, "x".repeat(100)).length, 64);
	assert.equal(ownerId(7, "///"), "pi-7");
});

test("the extension is registered in package.json and has a default export that loads", async () => {
	const { default: pkg } = await import("../package.json", { with: { type: "json" } });
	assert.ok(pkg.pi.extensions.includes("./src/hygiene.ts"));
	assert.equal(typeof hygieneDefault, "function");
});

test("hello carries the pid, the start time, the owner id, the subagent id, the session file, the pane, its terminal and the working folder", async () => {
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1", HERDR_PANE_ID: "p_9" }, server: () => ({ ok: true, id: "w1-4200" }) });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx("/work/tree"));
	await r.settle();
	assert.deepEqual(r.calls, [{ cmd: "procs-hello", pid: 4200, id: "w1-4200", started: "Tue Nov  3 21:00:00 2026", subagentId: "w1", sessionFile: "/sessions/w.jsonl", pane: "p_9", terminal: "term-of-p_9", cwd: "/work/tree" }]);
	assert.equal(r.ticks.length, 1, "a beat timer runs");
});

test("a pi that is not a worker says nothing to the server", async () => {
	const r = rig({ env: { HERDR_PANE_ID: "p_1" }, server: () => ({ ok: true }) });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.settle();
	await r.pi.fire("session_shutdown", { reason: "quit" }, r.ctx());
	assert.deepEqual(r.calls, []);
	assert.equal(r.ticks.length, 0);
});

test("beats go every 30 s; a server that forgot the owner or was away gets a new hello; a refusal is told once and not repeated", async () => {
	assert.equal(BEAT_MS, 30_000);
	let known = true, up = true;
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1" }, server: (request) => (!up ? undefined : request.cmd === "procs-beat" ? { ok: true, known } : { ok: true, id: "w1-4200" }) });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.settle();
	r.ticks[0]();
	await r.settle();
	assert.deepEqual(r.calls.map((c) => c.cmd), ["procs-hello", "procs-beat"]);
	assert.equal(r.calls[1].id, "w1-4200");
	known = false;
	r.ticks[0]();
	await r.settle();
	r.ticks[0]();
	await r.settle();
	assert.deepEqual(r.calls.map((c) => c.cmd), ["procs-hello", "procs-beat", "procs-beat", "procs-hello"], "the beat that is not known is followed by a hello");
	known = true;
	up = false;
	r.ticks[0]();
	await r.settle();
	up = true;
	r.ticks[0]();
	await r.settle();
	assert.deepEqual(r.calls.slice(-2).map((c) => c.cmd), ["procs-beat", "procs-hello"], "a server that was away gets a hello when it answers again");

	const refused = rig({ pid: 4300, env: { PI_SUBAGENT_ID: "w2" }, server: () => ({ ok: false, error: "the owner id is in use", refused: true }) });
	refused.load();
	await refused.pi.fire("session_start", { reason: "startup" }, refused.ctx());
	await refused.settle();
	refused.ticks[0]();
	await refused.settle();
	assert.equal(refused.calls.length, 1, "a refusal is not asked again");
	assert.equal(refused.notes.length, 1);
	assert.match(refused.notes[0], /did not register this worker.*in use/);
});

test("bye goes on quit and not on a reload or a new session; the timer stops either way", async () => {
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1" }, server: () => ({ ok: true }) });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.settle();
	await r.pi.fire("session_shutdown", { reason: "reload" }, r.ctx());
	assert.deepEqual(r.calls.map((c) => c.cmd), ["procs-hello"]);
	assert.equal(r.ticks.length, 0);
	await r.pi.fire("session_start", { reason: "reload" }, r.ctx());
	await r.settle();
	await r.pi.fire("session_shutdown", { reason: "quit" }, r.ctx());
	assert.deepEqual(r.calls.map((c) => c.cmd), ["procs-hello", "procs-hello", "procs-bye"]);
	assert.equal(r.calls[2].id, "w1-4200");
	assert.equal(r.ticks.length, 0);
});

test("the guard blocks worktree_remove while a process works in the checkout, and lists pid, program, cpu, age and owner state, never a command line", async () => {
	const wt = worktree("feat-x");
	const server = (request) => (request.cmd === "procs-list" ? { ok: true, owners: [{ id: "w1-4200", live: false, endedReason: "bye" }, { id: "w2-7", live: true }] } : undefined);
	const r = rig({
		server, table: [proc(501), proc(502, { ppid: 77, comm: "zsh", cpu: 3 }), proc(503), proc(504, { zombie: true }), proc(505)],
		cwds: { 501: wt, 502: join(wt, "src"), 503: join(root, "feat-xy"), 504: wt, 505: join(root, "other") },
		markers: { 501: "w1-4200", 502: "w2-7" },
	});
	r.load();
	const out = await r.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, r.ctx());
	assert.equal(out.block, true);
	const reason = out.reason;
	assert.match(reason, /^worktree_remove refused: 2 processes work in /);
	assert.match(reason, new RegExp(`in ${wt}\\n`));
	assert.match(reason, /- pid 501 node, cpu 3m12s, age 6h20m, owner w1-4200 \(ended: bye\), orphan\n/);
	assert.match(reason, /- pid 502 zsh, cpu 3s, age 6h20m, owner w2-7 \(live\)\n/);
	assert.ok(!reason.includes("pid 503") && !reason.includes("pid 504") && !reason.includes("pid 505"), "a sibling that shares a prefix, a zombie and a stranger are not holders");
	assert.ok(reason.includes(`node '/pkg/dist/server/cli.mjs' procs reap --checkout '${wt}'`), "the reap command is given");
	assert.ok(!reason.includes("/usr/local/bin"), "the program is its name, not its path or command line");
});

test("the guard passes when no process works in the checkout", async () => {
	const wt = worktree("feat-x");
	const r = rig({ table: [proc(1, { ppid: 0 }), proc(600)], cwds: { 600: join(root, "elsewhere") } });
	r.load();
	assert.equal(await r.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, r.ctx()), undefined);
	assert.ok(r.asked.includes("table"), "the table was read");
});

test("an unknown owner marker and a server that is down are told as such", async () => {
	const wt = worktree("feat-x");
	const known = rig({ server: () => ({ ok: true, owners: [] }), table: [proc(501)], cwds: { 501: wt }, markers: { 501: "gone-1" } });
	known.load();
	assert.match((await known.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, known.ctx())).reason, /owner gone-1 \(not known to the server\)/);
	const none = rig({ table: [proc(501)], cwds: { 501: wt } });
	none.load();
	assert.match((await none.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, none.ctx())).reason, /no owner marker/);
});

test("target resolution: a path (absolute or relative to the working folder), a branch, and a Herdr workspace id", async () => {
	const wt = worktree("feat-x");
	const holder = { table: [proc(501)], cwds: { 501: wt } };
	const porcelain = `worktree ${join(root, "repo")}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD def\nbranch refs/heads/feat/x\n`;
	const block = async (r, target) => (await r.pi.fire("tool_call", { toolName: "worktree_remove", input: { target } }, r.ctx(root)))?.block === true;

	const byPath = rig(holder);
	byPath.load();
	assert.equal(await block(byPath, wt), true, "absolute path");
	assert.equal(await block(byPath, "feat-x"), true, "path relative to the working folder");
	assert.equal(await block(byPath, "./feat-x/"), true, "relative with a dot and a slash");

	const byBranch = rig({ ...holder, git: porcelain });
	byBranch.load();
	assert.equal(await block(byBranch, "feat/x"), true, "branch");
	assert.ok(byBranch.asked.some((a) => a.startsWith("git worktree list --porcelain @")), "git was asked from the working folder");
	assert.equal(await block(byBranch, "main"), false, "the main checkout is never a target");
	assert.equal(await block(byBranch, "no-such-branch"), false, "a target that names no worktree is the tool's own to refuse");

	const byWorkspace = rig({ ...holder, workspaces: [{ workspace_id: "w7", worktree: { is_linked_worktree: true, checkout_path: wt } }, { workspace_id: "w1", worktree: { is_linked_worktree: false, checkout_path: join(root, "repo") } }] });
	byWorkspace.load();
	assert.equal(await block(byWorkspace, "w7"), true, "workspace id");
	assert.equal(await block(byWorkspace, "w1"), false, "a workspace of the main checkout is not a worktree to remove");

	const broken = rig({ ...holder, git: new Error("not a repository") });
	broken.load();
	assert.equal(await block(broken, "feat-x"), true, "a git that fails does not lose the path");
});

test("a check that cannot run blocks the removal and says why", async () => {
	const wt = worktree("feat-x");
	const r = rig({ table: [] });
	const failing = createHygiene({ platform: "darwin", argv: ["node"], env: {}, pid: 9, table: async () => { throw new Error("ps failed"); }, call: async () => undefined, git: async () => "", workspaces: async () => [] });
	const pi = fakePi();
	failing(pi);
	const out = await pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, r.ctx());
	assert.equal(out.block, true);
	assert.match(out.reason, /check for running processes in the checkout failed \(ps failed\)/);
});

test("bash: git worktree remove and herdr worktree remove are guarded wherever they sit in the command; other commands cost nothing", async () => {
	const wt = worktree("feat-x");
	const holder = { table: [proc(501)], cwds: { 501: wt }, workspaces: [{ workspace_id: "w7", worktree: { is_linked_worktree: true, checkout_path: wt } }] };
	const r = rig(holder);
	r.load();
	const attempt = async (command, cwd = root) => (await r.pi.fire("tool_call", { toolName: "bash", input: { command } }, r.ctx(cwd)))?.block === true;
	assert.equal(await attempt(`git worktree remove ${wt}`), true);
	assert.equal(await attempt(`git worktree remove --force '${wt}'`), true);
	assert.equal(await attempt("git worktree remove feat-x"), true, "relative to the working folder");
	assert.equal(await attempt(`cd ${root} && git worktree remove feat-x`, "/"), true, "a cd before it moves the folder");
	assert.equal(await attempt(`git -C ${root} worktree remove feat-x`, "/"), true, "git -C moves the folder");
	assert.equal(await attempt(`echo done; git worktree remove -f ${wt} && echo ok`), true);
	assert.equal(await attempt(`bash -c "git worktree remove ${wt}"`), true, "inside the quotes of bash -c");
	assert.equal(await attempt("herdr worktree remove --workspace w7"), true, "herdr, by workspace id");
	assert.equal(await attempt("herdr worktree remove --workspace=w7 --force"), true);
	r.asked.length = 0;
	assert.equal(await attempt("git worktree list"), false);
	assert.equal(await attempt("git worktree remove"), false, "no target");
	assert.equal(await attempt("echo worktree remove"), false);
	assert.deepEqual(r.asked, [], "a command that removes nothing reads nothing");

	const free = rig({ table: [proc(501)], cwds: { 501: join(root, "elsewhere") } });
	free.load();
	assert.equal((await free.pi.fire("tool_call", { toolName: "bash", input: { command: `git worktree remove ${wt}` } }, free.ctx()))?.block, undefined, "no holder: it passes");
	assert.equal(await free.pi.fire("tool_call", { toolName: "read", input: { path: wt } }, free.ctx()), undefined);
});

test("inert in a standing tower run: no marker, no guard, no hello", async () => {
	const wt = worktree("feat-x");
	const flagged = rig({ argv: ["node", "pi", "--sb-run"], table: [proc(501)], cwds: { 501: wt }, env: { PI_SUBAGENT_ID: "w1" }, server: () => ({ ok: true }) });
	flagged.load();
	assert.equal(flagged.env[OWNER_KEY], undefined);
	assert.equal(await flagged.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, flagged.ctx()), undefined);
	assert.deepEqual(flagged.asked, []);

	// A pi that the run mode took after load (a standing pane handed over): the guard goes quiet and the marker goes.
	const late = rig({ table: [proc(501)], cwds: { 501: wt } });
	late.load();
	assert.equal(late.env[OWNER_KEY], "pi-4100");
	assert.equal((await late.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, late.ctx())).block, true);
	globalThis[MARK] = "local";
	await late.pi.fire("session_start", { reason: "startup" }, late.ctx());
	assert.equal(late.env[OWNER_KEY], undefined);
	late.asked.length = 0;
	assert.equal(await late.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, late.ctx()), undefined);
	assert.equal(await late.pi.fire("tool_call", { toolName: "bash", input: { command: `git worktree remove ${wt}` } }, late.ctx()), undefined);
	assert.deepEqual(late.asked, []);
});

test("inert on Windows, and it says so once for the process", async () => {
	const wt = worktree("feat-x");
	const r = rig({ platform: "win32", table: [proc(501)], cwds: { 501: wt }, env: { PI_SUBAGENT_ID: "w1" }, server: () => ({ ok: true }) });
	r.load();
	assert.equal(r.env[OWNER_KEY], undefined);
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.pi.fire("session_start", { reason: "reload" }, r.ctx());
	assert.equal(r.notes.length, 1);
	assert.match(r.notes[0], /not available on Windows/);
	const other = rig({ platform: "win32" });
	other.load();
	await other.pi.fire("session_start", { reason: "reload" }, other.ctx());
	assert.equal(other.notes.length, 0, "a reload builds the extension again and does not repeat it");
	assert.equal(await r.pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, r.ctx()), undefined);
	assert.deepEqual(r.asked, []);
	assert.deepEqual(r.calls, []);
	assert.equal(r.ticks.length, 0);
});

test("words, removeTargets, parseWorktreeList and the text of age and cpu", () => {
	assert.deepEqual(words(`a 'b c' "d \\"e\\"" f\\ g 'unclosed`), ["a", "b c", 'd "e"', "f g", "unclosed"]);
	assert.deepEqual(words(`x ""`), ["x", ""]);
	assert.deepEqual(removeTargets("git worktree remove a b", "/w"), [{ target: "a", cwd: "/w", via: "git" }, { target: "b", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets("cd /x && /usr/bin/git -c core.x=1 worktree remove -f -- -odd", "/w"), [{ target: "-odd", cwd: "/x", via: "git" }]);
	assert.deepEqual(removeTargets("sh -c 'herdr worktree remove --workspace w3'", "/w"), [{ target: "w3", cwd: "/w", via: "herdr" }]);
	assert.deepEqual(removeTargets("git worktree add x && git worktree list && git status", "/w"), []);
	assert.deepEqual(removeTargets("git commit -m 'git worktree remove x'", "/w"), [], "a word that only says it in a message is not asked for");
	assert.deepEqual(parseWorktreeList("worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n"), [{ path: "/a", branch: "main" }, { path: "/b" }]);
	assert.equal(cpuText(5), "5s");
	assert.equal(cpuText(192), "3m12s");
	assert.equal(cpuText(7500), "2h05m");
	assert.equal(ageText(STARTED, NOW), "6h20m");
	assert.equal(ageText(STARTED, Date.parse(`${STARTED} UTC`) + 30 * 60_000), "30m");
	assert.equal(ageText(STARTED, Date.parse(`${STARTED} UTC`) + 50 * 3600_000), "2d2h");
	assert.equal(ageText("not a date", NOW), "?");
});

test("with the real process table: a child that works in the checkout holds the removal until it is gone", async () => {
	const wt = worktree("feat-real");
	// A node child of this test, in the checkout; it ends by itself (the unref'd exit timer) if the test does not reach its kill.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1 << 30)"], { cwd: wt, stdio: "ignore" });
	const gone = new Promise((resolve) => child.once("exit", resolve));
	const exit = setTimeout(() => process.exit(3), 120_000);
	exit.unref();
	try {
		const make = createHygiene({ env: {}, platform: process.platform, argv: ["node"], pid: 9, call: async () => undefined, git: async () => "", workspaces: async () => [], cli: () => "cli" });
		const pi = fakePi();
		make(pi);
		const ctx = { cwd: root };
		const first = await pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, ctx);
		assert.equal(first?.block, true);
		assert.match(first.reason, new RegExp(`- pid ${child.pid} node, cpu .*, age .*, no owner marker\\n`));
		child.kill("SIGKILL");
		await gone;
		assert.equal(await pi.fire("tool_call", { toolName: "worktree_remove", input: { target: wt } }, ctx), undefined, "the same call passes once nothing works there");
	} finally {
		child.kill("SIGKILL");
	}
});
