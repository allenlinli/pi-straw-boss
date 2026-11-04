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
	const dir = join(root, name), gitdir = join(root, "repo", ".git", "worktrees", name);
	mkdirSync(dir, { recursive: true });
	mkdirSync(gitdir, { recursive: true });
	writeFileSync(join(dir, ".git"), `gitdir: ${gitdir}\n`);
	writeFileSync(join(gitdir, "gitdir"), `${join(dir, ".git")}\n`);
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
function rig(o: { env?: Record<string, string>; platform?: string; argv?: string[]; table?: object[]; cwds?: Record<number, string>; markers?: Record<number, string>; server?: (request: object) => object | undefined; git?: string | Error; workspaces?: object[] | Error; idle?: Record<string, number[] | Error>; pid?: number; terminal?: () => Promise<string | undefined> } = {}): Rig {
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
		workspaces: async () => {
			if (o.workspaces instanceof Error) throw o.workspaces;
			return o.workspaces ?? [];
		},
		idleShells: async (workspace) => {
			asked.push(`idle ${workspace}`);
			const idle = o.idle?.[workspace];
			if (idle instanceof Error) throw idle;
			return idle ?? [];
		},
		terminalOf: async (pane) => (asked.push("terminal"), o.terminal ? o.terminal() : `term-of-${pane}`),
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
	// A node child of this test, in the checkout; it ends by itself (its own exit timer) if the test does not reach its kill.
	const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(3), 120000)"], { cwd: wt, stdio: "ignore" });
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

const callRemove = async (r, target, cwd = root) => r.pi.fire("tool_call", { toolName: "worktree_remove", input: { target } }, r.ctx(cwd));
const WS = (id: string, path: string, linked = true) => ({ workspace_id: id, worktree: { is_linked_worktree: linked, checkout_path: path } });

test("T3R-F001: a retained idle pane shell of the target workspace is not a holder; a busy foreground, a shell Herdr cannot vouch for, and a shell of another workspace are", async () => {
	const wt = worktree("feat-x");
	const base = { table: [proc(700, { comm: "zsh" }), proc(701, { ppid: 700 }), proc(702, { comm: "zsh" })], workspaces: [WS("w7", wt), WS("w8", join(root, "other"))] };
	// 700 is the idle shell of w7; 701 runs in its foreground (its pane is not idle); 702 is a shell of workspace w8 working in the same folder.
	const cwds = { 700: wt, 701: wt, 702: wt };
	const idle = rig({ ...base, cwds, idle: { w7: [700], w8: [702] } });
	idle.load();
	const out = await callRemove(idle, "w7");
	assert.equal(out.block, true);
	assert.match(out.reason, /refused: 2 processes work in /);
	assert.ok(!out.reason.includes("pid 700 "), "the idle shell of the target workspace is exempt");
	assert.ok(out.reason.includes("pid 701 ") && out.reason.includes("pid 702 "), "a child of the shell and the shell of another workspace still hold");
	assert.deepEqual(idle.asked.filter((a) => a.startsWith("idle")), ["idle w7"], "only workspaces of the checkout are asked");

	const only = rig({ ...base, table: [proc(700, { comm: "zsh" })], cwds: { 700: wt }, idle: { w7: [700] } });
	only.load();
	assert.equal(await callRemove(only, "w7"), undefined, "worker done, only its idle shell left: the removal passes");
	assert.equal(await callRemove(only, wt), undefined, "by path too");

	const cannot = rig({ ...base, table: [proc(700, { comm: "zsh" })], cwds: { 700: wt }, idle: { w7: new Error("pane closed") } });
	cannot.load();
	assert.equal((await callRemove(cannot, "w7")).block, true, "Herdr cannot say: the shell stays a holder");

	const listFails = rig({ ...base, table: [proc(700, { comm: "zsh" })], cwds: { 700: wt }, workspaces: new Error("herdr down") });
	listFails.load();
	assert.equal((await callRemove(listFails, wt)).block, true, "no workspace list: nothing is exempt");

	const bash = rig({ ...base, table: [proc(700, { comm: "zsh" })], cwds: { 700: wt }, idle: { w7: [700] } });
	bash.load();
	const attempt = async (command) => (await bash.pi.fire("tool_call", { toolName: "bash", input: { command } }, bash.ctx()))?.block === true;
	assert.equal(await attempt("herdr worktree remove --workspace w7"), false);
	assert.equal(await attempt(`git worktree remove ${wt}`), true, "bare git does not close the workspace, so the idle shell holds");
});

test("T3R-F002: git's unique trailing path components name a worktree too", async () => {
	const feat = worktree("feat-x"), other = join(root, "wts", "feat-y");
	mkdirSync(other, { recursive: true });
	const list = (...paths) => paths.map((p, i) => `worktree ${p}\nHEAD abc\nbranch refs/heads/b${i}\n`).join("\n");
	const holder = { table: [proc(501)], cwds: { 501: feat } };
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const r = rig({ ...holder, git: list(repo, feat) });
	r.load();
	assert.equal((await callRemove(r, "feat-x", repo))?.block, true, "the last component, from the main checkout where no such folder exists");
	assert.equal((await callRemove(r, "feat-x/", repo))?.block, true, "with a trailing slash");
	assert.equal(await callRemove(r, "nothing", repo), undefined);
	const long = rig({ table: [proc(501)], cwds: { 501: other }, git: list(repo, other, feat) });
	long.load();
	assert.equal((await callRemove(long, "wts/feat-y", repo))?.block, true, "several trailing components");
	assert.equal(await callRemove(long, "ts/feat-y", repo), undefined, "a part of a component is no component");
	const twice = rig({ ...holder, git: list(repo, feat, join(root, "elsewhere", "feat-x")) });
	twice.load();
	assert.equal(await callRemove(twice, "feat-x", repo), undefined, "two worktrees ending alike: git refuses it itself");
	const main = rig({ table: [proc(501)], cwds: { 501: repo }, git: list(repo, feat) });
	main.load();
	assert.equal(await callRemove(main, "repo", root), undefined, "the main checkout is never a target, even as the unique suffix");
});

test("T3R-F003: a look at git or Herdr that cannot run blocks the removal and says so", async () => {
	const wt = worktree("feat-x");
	const holder = { table: [proc(501)], cwds: { 501: wt } };
	const gitDown = rig({ ...holder, git: new Error("git timed out") });
	gitDown.load();
	const byBranch = await callRemove(gitDown, "feat/y");
	assert.equal(byBranch.block, true);
	assert.match(byBranch.reason, /check for running processes in the checkout failed \(git timed out\)/);
	const viaBash = await gitDown.pi.fire("tool_call", { toolName: "bash", input: { command: "git worktree remove feat/y" } }, gitDown.ctx());
	assert.equal(viaBash.block, true);
	const herdrDown = rig({ ...holder, git: "", workspaces: new Error("herdr down") });
	herdrDown.load();
	const byId = await callRemove(herdrDown, "w7");
	assert.equal(byId.block, true, "a workspace id with no workspace list");
	assert.match(byId.reason, /herdr down/);
	const herdrBash = await herdrDown.pi.fire("tool_call", { toolName: "bash", input: { command: "herdr worktree remove --workspace w7" } }, herdrDown.ctx());
	assert.equal(herdrBash.block, true);
	// A plain git command never asks Herdr, so a Herdr that is not there costs a git user nothing.
	const gitOnly = rig({ table: [], git: "", workspaces: new Error("herdr down") });
	gitOnly.load();
	assert.equal(await gitOnly.pi.fire("tool_call", { toolName: "bash", input: { command: "git worktree remove feat/y" } }, gitOnly.ctx()), undefined);
});

test("T3R-F008: herdr worktree remove without --workspace takes the caller's workspace, or is blocked when this pi does not know it", async () => {
	const wt = worktree("feat-x");
	const holder = { table: [proc(501)], cwds: { 501: wt }, workspaces: [WS("w7", wt)] };
	const known = rig({ ...holder, env: { HERDR_WORKSPACE_ID: "w7" } });
	known.load();
	const attempt = async (r, command) => r.pi.fire("tool_call", { toolName: "bash", input: { command } }, r.ctx());
	assert.equal((await attempt(known, "herdr worktree remove --force"))?.block, true, "the workspace of the caller is the target");
	const unknown = rig({ ...holder });
	unknown.load();
	const out = await attempt(unknown, "herdr worktree remove");
	assert.equal(out.block, true);
	assert.match(out.reason, /name it with --workspace/);
	assert.equal(await attempt(unknown, "git worktree remove"), undefined, "git without a target fails by itself");
});

test("T3R-F004: a hello that outlives its session reads nothing from the stale ctx and rejects nowhere", async () => {
	let stale = false;
	const gate = Promise.withResolvers();
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1", HERDR_PANE_ID: "p_9" }, terminal: () => gate.promise, server: () => ({ ok: false, error: "the owner id is in use", refused: true }) });
	const ctx = {
		get cwd() { if (stale) throw new Error("This extension ctx is stale"); return "/work/tree"; },
		get sessionManager() { if (stale) throw new Error("This extension ctx is stale"); return { getSessionFile: () => "/sessions/w.jsonl" }; },
		get ui() { if (stale) throw new Error("This extension ctx is stale"); return { notify: (text: string) => void r.notes.push(text) }; },
	};
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, ctx);
	stale = true; // /reload: the session is replaced while the hello waits for Herdr
	gate.resolve("term-1");
	const results = await Promise.allSettled(r.tracked.splice(0));
	assert.deepEqual(results.map((x) => x.status), ["fulfilled"], "the hello does not reject");
	assert.equal(r.calls[0].cwd, "/work/tree", "the folder and the session file were read while the ctx was live");
	assert.equal(r.calls[0].sessionFile, "/sessions/w.jsonl");
	assert.equal(r.notes.length, 1, "the refusal is still told, through the ui read at the start");
});

test("T3R-F004: a failing background step is swallowed where it is spawned", async () => {
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1" }, server: () => { throw new Error("socket exploded"); } });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	r.ticks[0]();
	const results = await Promise.allSettled(r.tracked.splice(0));
	assert.ok(results.every((x) => x.status === "fulfilled"));
});

test("T3R-F009: the terminal of the pane is asked of Herdr once per session start, however often hello is repeated", async () => {
	const r = rig({ pid: 4200, env: { PI_SUBAGENT_ID: "w1", HERDR_PANE_ID: "p_9" } }); // no server
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.settle();
	for (let i = 0; i < 3; i++) {
		r.ticks[0]();
		await r.settle();
	}
	assert.equal(r.calls.length, 4, "a hello at every beat while no server runs");
	assert.equal(r.asked.filter((a) => a === "terminal").length, 1);
	await r.pi.fire("session_start", { reason: "reload" }, r.ctx());
	await r.settle();
	assert.equal(r.asked.filter((a) => a === "terminal").length, 2, "a new session start asks again");
});

test("T3R-F007: the main checkout is never a target, even with a process in it", async () => {
	const wt = worktree("feat-x"), repo = join(root, "repo");
	const porcelain = `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD def\nbranch refs/heads/feat/x\n`;
	const r = rig({ table: [proc(501)], cwds: { 501: repo }, git: porcelain });
	r.load();
	assert.equal(await callRemove(r, "main"), undefined, "a process in the main checkout does not block a removal of the branch it is on");
	assert.equal(await callRemove(r, repo), undefined, "nor by its path");
});

test("T3R-F005: commands are split on operators outside quotes only, and the words decide", () => {
	assert.deepEqual(removeTargets("bash -c 'cd /x; git worktree remove wt'", "/w"), [{ target: "wt", cwd: "/x", via: "git" }], "a cd inside the quotes of bash -c moves that command's folder");
	assert.deepEqual(removeTargets(`git worktree remove "/tmp/a;b"`, "/w"), [{ target: "/tmp/a;b", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets("(cd /other) ; git worktree remove wt", "/w"), [{ target: "wt", cwd: "/w", via: "git" }], "a subshell's cd ends with it");
	assert.deepEqual(removeTargets("(cd /other && git worktree remove wt)", "/w"), [{ target: "wt", cwd: "/other", via: "git" }]);
	assert.deepEqual(removeTargets(`git worktree "remove" wt`, "/w"), [{ target: "wt", cwd: "/w", via: "git" }], "quotes inside the subcommand");
	assert.deepEqual(removeTargets(`git "worktree" 're'move wt`, "/w"), [{ target: "wt", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets(`git commit -m 'x; git worktree remove wt'`, "/w"), []);
	assert.deepEqual(removeTargets(`git commit -m "x && git worktree remove wt" && echo`, "/w"), []);
	assert.deepEqual(removeTargets("git worktree remove wt > /dev/null 2>&1", "/w"), [{ target: "wt", cwd: "/w", via: "git" }], "redirections are not targets");
	assert.deepEqual(removeTargets("git worktree remove wt 2>/dev/null &", "/w"), [{ target: "wt", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets("echo a & git worktree remove wt", "/w"), [{ target: "wt", cwd: "/w", via: "git" }], "a lone & ends a command");
	assert.deepEqual(removeTargets("cd /x\ngit worktree remove wt", "/w"), [{ target: "wt", cwd: "/x", via: "git" }], "a newline ends a command");
	assert.deepEqual(removeTargets("echo $(cd /y; pwd); git worktree remove wt", "/w"), [{ target: "wt", cwd: "/w", via: "git" }], "a command substitution's cd ends with it");
	assert.deepEqual(removeTargets("herdr worktree remove", "/w"), [{ target: "", cwd: "/w", via: "herdr" }], "no workspace named: the caller's");
	assert.deepEqual(removeTargets("herdr worktree remove --force", "/w"), [{ target: "", cwd: "/w", via: "herdr" }]);
});

test("a bash command that spells the subcommand with quotes is guarded, and tokenizing costs no I/O for one that removes nothing", async () => {
	const wt = worktree("feat-x");
	const r = rig({ table: [proc(501)], cwds: { 501: wt } });
	r.load();
	const attempt = async (command) => (await r.pi.fire("tool_call", { toolName: "bash", input: { command } }, r.ctx()))?.block === true;
	assert.equal(await attempt(`git worktree "remove" ${wt}`), true);
	assert.equal(await attempt(`git commit -m 'git worktree remove ${wt}'`), false);
	assert.equal(await attempt(`bash -c 'cd ${root}; git worktree remove feat-x'`), true);
});

test("FR-F004: only a refused reply is permanent; restarting and other ok:false replies are asked again at the next beat", async () => {
	let answer: object = { ok: false, error: "restarting" };
	const r = rig({ pid: 4300, env: { PI_SUBAGENT_ID: "w3" }, server: () => answer });
	r.load();
	await r.pi.fire("session_start", { reason: "startup" }, r.ctx());
	await r.settle();
	answer = { ok: true, id: "w3-4300" };
	r.ticks[0]();
	await r.settle();
	r.ticks[0]();
	await r.settle();
	assert.deepEqual(r.calls.map((c) => c.cmd), ["procs-hello", "procs-hello", "procs-beat"]);
	assert.equal(r.notes.length, 0, "a restart is not told as a refusal");
});

test("FR-F002/F007: the idle-shell exemption needs a shell program, and only for the tool and herdr, not bare git", async () => {
	const wt = worktree("feat-idle");
	const base = { workspaces: [WS("w7", wt)], idle: { w7: [700] } };
	const exec = rig({ ...base, table: [proc(700, { comm: "node", cpu: 99999 })], cwds: { 700: wt } });
	exec.load();
	assert.equal((await callRemove(exec, "w7")).block, true, "a pid Herdr calls idle that runs node is a holder");
	const login = rig({ ...base, table: [proc(700, { comm: "-zsh" })], cwds: { 700: wt } });
	login.load();
	assert.equal(await callRemove(login, "w7"), undefined, "a login shell is a shell");
	const bare = async (command: string) => (await login.pi.fire("tool_call", { toolName: "bash", input: { command } }, login.ctx()))?.block === true;
	assert.equal(await bare(`git worktree remove ${wt}`), true, "bare git does not close the workspace");
	assert.equal(await bare("herdr worktree remove --workspace w7"), false);
});

test("FR-F005: a target that is not a literal word blocks", async () => {
	const wt = worktree("feat-var");
	const r = rig({ table: [], cwds: {}, workspaces: [WS("w1", wt)] });
	r.load();
	for (const command of ['git worktree remove "$WT"', "for w in a b; do git worktree remove $w; done", "git worktree remove $(echo wt)", "git worktree remove `echo wt`", "git worktree remove ../wts/feat-*"]) {
		assert.equal((await r.pi.fire("tool_call", { toolName: "bash", input: { command } }, r.ctx()))?.block, true, command);
	}
	assert.equal(await r.pi.fire("tool_call", { toolName: "bash", input: { command: "echo $(date) && git status" } }, r.ctx()), undefined);
});

test("FR-F008: via the tool, a workspace id resolves even when the caller's cwd is no git repository", async () => {
	const wt = worktree("feat-nogit");
	const r = rig({ table: [proc(900)], cwds: { 900: wt }, git: new Error("not a git repository"), workspaces: [WS("w5", wt)] });
	r.load();
	const out = await callRemove(r, "w5");
	assert.match(out.reason, /refused: 1 process works in /, "resolved by Herdr and holders found");
	const none = rig({ table: [], git: new Error("not a git repository"), workspaces: [WS("w5", wt)] });
	none.load();
	assert.equal(await callRemove(none, "w5"), undefined);
});

test("FR-F009: lexer edges: a redirect glued to a target, a heredoc body, pushd", () => {
	assert.deepEqual(removeTargets("git worktree remove wt>/dev/null", "/w"), [{ target: "wt", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets("cat <<EOF\ngit worktree remove wt\nEOF\necho done", "/w"), []);
	assert.deepEqual(removeTargets("cat <<'EOF' > f\ngit worktree remove wt\nEOF\ngit worktree remove b", "/w"), [{ target: "b", cwd: "/w", via: "git" }]);
	assert.deepEqual(removeTargets("pushd /x; git worktree remove wt", "/w"), [{ target: "wt", cwd: "/x", via: "git" }]);
});

test("GR-F001: a here-string, arithmetic shift or unterminated heredoc hides no later line from the guard", () => {
	const rm = [{ target: "wt", cwd: "/w", via: "git" }];
	assert.deepEqual(removeTargets('cat <<< "hi"\ngit worktree remove wt', "/w"), rm);
	assert.deepEqual(removeTargets("cat <<<hi\ngit worktree remove wt", "/w"), rm);
	assert.deepEqual(removeTargets("cat <<< x; git worktree remove wt", "/w"), rm);
	assert.deepEqual(removeTargets("echo $((1<<2))\ngit worktree remove wt", "/w"), rm);
	assert.deepEqual(removeTargets("echo $((1<<2)); git worktree remove wt", "/w"), rm);
	assert.deepEqual(removeTargets("cat <<EOF\ngit worktree remove wt", "/w"), rm, "no closing line: fail closed");
});
