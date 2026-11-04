import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stateDirOf } from "./agent/paths.ts";
import { herdrRun, panes as herdrPanes, workspaces as herdrWorkspaces, type HerdrRun, type Workspace } from "./herdr.ts";
import { type Cwd, readCwds } from "./procs/cwd.ts";
import { type Holder, parseWorktreeList, refusal, removeTargets } from "./procs/guard.ts";
import { OWNER_KEY, readOwners, setOwner } from "./procs/marker.ts";
import { isOrphan, type Proc, readTable } from "./procs/table.ts";
import { checkoutOf, physical, under } from "./procs/worktree.ts";
import { inRun, inStandingRun } from "./runmark.ts";
import { makeCtx, trusted } from "./server/client.ts";
import { packageRoot } from "./server/version.ts";
import { slotOf } from "./server/record.ts";
import { callControl, type Reply } from "./server/socket.ts";
import { startOf } from "./startof.ts";

// Process hygiene in every pi (docs/specs/2026-11-04-procs.md; plan sb-procs-plan.md A, B, D). Three jobs:
//  1. The owner marker: STRAW_BOSS_OWNER=<id> in this process's environment at load, so everything its bash starts carries it (src/procs/marker.ts).
//  2. A pi-herdr-agents worker (PI_SUBAGENT_ID set) tells the sb server it exists (`procs-hello`), beats every 30 s, and says `procs-bye` when it quits; the server reaps what the worker leaves (src/server/procs.ts).
//  3. The removal guard: `worktree_remove`, and a bash `git worktree remove` / `herdr worktree remove`, are refused while a process has its working folder in the target checkout. The `/worktree remove` slash command
//     does not pass `tool_call`; that is a documented limit, and the reaper plugin refuses its own removals.
// Inert in a standing tower run (src/runmark.ts) and on Windows (it says so once). No command line or environment is read, logged or shown.

export const BEAT_MS = 30_000;
const NOTE = Symbol.for("pi-straw-boss.hygiene.told");

/** What this extension reaches the machine with; replaced in tests. */
export interface HygieneDeps {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	argv?: readonly string[];
	pid?: number;
	startOf?: (pid: number) => string | undefined;
	/** One request to the live sb server; undefined when none runs or it does not answer. */
	call?: (request: Record<string, unknown>) => Promise<Reply | undefined>;
	table?: () => Promise<Proc[] | undefined>;
	cwds?: (pids: readonly number[]) => Promise<Map<number, Cwd>>;
	markers?: (pids: readonly number[]) => Promise<Map<number, string>>;
	/** Runs git in a folder and gives its output; throws when it fails. */
	git?: (cwd: string, args: string[]) => Promise<string>;
	workspaces?: () => Promise<Workspace[]>;
	/** The terminal id Herdr gives a pane (a pane id is reused). */
	terminalOf?: (pane: string) => Promise<string | undefined>;
	exists?: (path: string) => boolean;
	real?: (path: string) => string;
	now?: () => number;
	/** Calls `fn` every `ms` until the returned function is called. */
	every?: (fn: () => void, ms: number) => () => void;
	/** The command that runs the CLI of this package, as the refusal prints it. */
	cli?: () => string;
	/** Told every background step as it starts, so a test can wait for it. */
	track?: (done: Promise<unknown>) => void;
}

const run = (file: string, args: string[], cwd: string) => new Promise<string>((resolveRun, reject) => execFile(file, args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1 << 24 }, (error, stdout) => (error ? reject(error) : resolveRun(stdout))));
const sanitize = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

/** The owner id of a pi: its pid, with the pi-herdr-agents subagent id in front for a worker (`<id>-<pid>` is unique while the pid lives; a pid reused later has another start time). */
export function ownerId(pid: number, subagentId?: string): string {
	const tail = `-${pid}`, head = subagentId ? sanitize(subagentId).slice(0, 64 - tail.length) : "pi";
	return `${head || "pi"}${tail}`;
}

/** The command that runs this package's CLI: the built `cli.mjs`, or the source in a checkout. */
function cliCommand(): string {
	const root = packageRoot(), built = join(root, "dist", "server", "cli.mjs");
	return existsSync(built) ? `node '${built}'` : `npx tsx '${join(root, "src", "server", "cli.ts")}'`;
}

/** One request to the live sb server of this account over its control socket; undefined when none runs, it is not trusted, or it does not answer. */
async function callServer(env: NodeJS.ProcessEnv, request: Record<string, unknown>): Promise<Reply | undefined> {
	try {
		const ctx = makeCtx({ env, slot: slotOf(stateDirOf(env), env), version: "0.0.0", cli: "cli.mjs", by: "process hygiene" });
		const record = await trusted(ctx);
		if (!record || !ctx.alive(record.pid)) return undefined;
		return (await callControl(record.socket, record.secret, { ...request, cmd: String(request.cmd) }, 5000)).reply;
	} catch {
		return undefined;
	}
}

export function createHygiene(deps: HygieneDeps = {}) {
	const env = deps.env ?? process.env, platform = deps.platform ?? process.platform, argv = deps.argv ?? process.argv, pid = deps.pid ?? process.pid;
	const call = deps.call ?? ((request) => callServer(env, request)), now = deps.now ?? Date.now, exists = deps.exists ?? existsSync, real = deps.real ?? physical;
	const table = deps.table ?? (() => readTable()), cwdsOf = deps.cwds ?? ((pids) => readCwds(pids)), markersOf = deps.markers ?? ((pids) => readOwners(pids));
	const git = deps.git ?? ((cwd, args) => run("git", args, cwd)), cli = deps.cli ?? cliCommand;
	const herdr: HerdrRun = herdrRun;
	const workspacesOf = deps.workspaces ?? (() => herdrWorkspaces(herdr)), terminalOf = deps.terminalOf ?? (async (pane) => (await herdrPanes(herdr)).find((p) => p.pane_id === pane)?.terminal_id);
	const every = deps.every ?? ((fn, ms) => {
		const timer = setInterval(fn, ms);
		timer.unref();
		return () => clearInterval(timer);
	});
	const track = (done: Promise<unknown>) => (deps.track?.(done), done);
	const subagentId = env.PI_SUBAGENT_ID?.trim() || undefined;
	const id = ownerId(pid, subagentId);
	/** Nothing of this runs on Windows, nor in a standing tower run (a run of the sb server, which has its own pane and rules). */
	const inert = () => platform === "win32" || inStandingRun(argv);

	/** The linked worktrees a target word names: a path, a branch, or a Herdr workspace id. Physical roots, as lsof tells a working folder. */
	async function checkoutsOf(target: string, cwd: string): Promise<string[]> {
		const found = new Set<string>(), abs = resolve(cwd, target.startsWith("~/") ? join(env.HOME ?? "", target.slice(2)) : target);
		if (exists(abs)) {
			const c = checkoutOf(abs);
			if (c.kind === "linked") found.add(c.root);
		}
		const listed = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""));
		// The first entry is the main checkout, which git does not remove.
		for (const w of listed.slice(1)) if (w.branch === target || real(w.path) === real(abs)) found.add(real(w.path));
		for (const w of await workspacesOf().catch(() => [] as Workspace[])) {
			if (w.workspace_id === target && w.worktree?.is_linked_worktree && w.worktree.checkout_path) found.add(real(w.worktree.checkout_path));
		}
		return [...found];
	}

	/** The processes that work in `root`, with what the server knows of their owners. */
	async function holdersOf(root: string): Promise<Holder[]> {
		const all = await table();
		if (!all) return [];
		const live = all.filter((p) => !p.zombie), cwds = await cwdsOf(live.map((p) => p.pid));
		const here = live.filter((p) => { const c = cwds.get(p.pid); return c !== undefined && under(real(c.path), root); });
		if (!here.length) return [];
		const marks = await markersOf(here.map((p) => p.pid)).catch(() => new Map<number, string>());
		const known = marks.size ? ((await call({ cmd: "procs-list" }).catch(() => undefined))?.owners as { id: string; live: boolean; endedReason?: string }[] | undefined) : undefined;
		return here.map((proc) => {
			const mark = marks.get(proc.pid), row = mark ? known?.find((o) => o.id === mark) : undefined;
			return { proc, orphan: isOrphan(proc, []), ...(mark ? { owner: { id: mark, state: row ? (row.live ? "live" : "ended") : "unknown", ...(row?.endedReason ? { reason: row.endedReason } : {}) } as NonNullable<Holder["owner"]> } : {}) };
		});
	}

	/** The refusal of a removal of `targets`, or undefined when no process works in any checkout they name. A target that names no linked worktree is the tool's own to refuse. */
	async function guard(what: string, targets: { target: string; cwd: string }[]): Promise<string | undefined> {
		const roots = new Set<string>();
		for (const { target, cwd } of targets) for (const root of await checkoutsOf(target, cwd)) roots.add(root);
		for (const root of roots) {
			const holders = await holdersOf(root);
			if (holders.length) return refusal(what, root, holders, cli(), now());
		}
		return undefined;
	}

	return function hygiene(pi: ExtensionAPI): void {
		// A standing tower run is a pane the server owns: it gets no marker, no hello, no guard.
		if (!inRun(argv) && platform !== "win32") setOwner(id, env);
		const tell = (ctx: ExtensionContext, text: string) => {
			const host = globalThis as { [NOTE]?: Set<string> };
			const told = (host[NOTE] ??= new Set());
			if (told.has(text)) return;
			told.add(text);
			ctx.ui?.notify?.(text, "warning");
		};
		let stop: (() => void) | undefined, registered = false, refused = false;
		/** What the hello says about this pi; the server checks the pid against its own table. */
		const hello = async (ctx: ExtensionContext, pane: string | undefined) => {
			const started = deps.startOf ? deps.startOf(pid) : startOf(pid);
			const terminal = pane ? await terminalOf(pane).catch(() => undefined) : undefined;
			const file = ctx.sessionManager?.getSessionFile?.();
			const reply = await call({ cmd: "procs-hello", pid, id, ...(started ? { started } : {}), ...(subagentId ? { subagentId } : {}), ...(file ? { sessionFile: file } : {}), ...(pane ? { pane } : {}), ...(terminal ? { terminal } : {}), cwd: ctx.cwd });
			if (reply?.ok) return void (registered = true);
			registered = false;
			// The server turned this pi down (an id in use, a pid it does not know): that does not change on its own, so it is said once and not asked again. No server at all is tried again at the next beat.
			if (reply && !reply.ok) (refused = true, tell(ctx, `Straw Boss: the sb server did not register this worker for process hygiene: ${String(reply.error ?? "refused")}. What it starts is not reaped when it ends.`));
		};

		pi.on("session_start", (_event, ctx) => {
			if (platform === "win32") return void tell(ctx, "Straw Boss process hygiene is not available on Windows: workers are not tracked and worktree removal is not checked for running processes.");
			if (inStandingRun(argv)) {
				if (env[OWNER_KEY] === id) delete env[OWNER_KEY];
				return;
			}
			if (!subagentId) return;
			const pane = env.HERDR_PANE_ID;
			refused = false;
			stop?.();
			void track(hello(ctx, pane));
			stop = every(() => void track(registered ? call({ cmd: "procs-beat", id }).then((reply) => void (registered = reply?.ok === true && reply.known === true), () => void (registered = false)) : refused ? Promise.resolve() : hello(ctx, pane)), BEAT_MS);
		});
		pi.on("session_shutdown", async (event) => {
			stop?.();
			stop = undefined;
			// A reload or a switch of session keeps this process (and its children) alive: only a quit is the worker's end.
			if (event.reason === "quit" && subagentId && registered && !inert()) await track(call({ cmd: "procs-bye", id })).catch(() => undefined);
			registered = false;
		});

		pi.on("tool_call", async (event, ctx) => {
			if (inert()) return;
			let what: string, targets: { target: string; cwd: string }[];
			if (event.toolName === "worktree_remove") {
				const target = (event.input as { target?: unknown }).target;
				if (typeof target !== "string" || !target) return;
				[what, targets] = ["worktree_remove", [{ target, cwd: ctx.cwd }]];
			} else if (event.toolName === "bash") {
				const command = (event.input as { command?: unknown }).command;
				if (typeof command !== "string" || !/worktree\s+remove/.test(command)) return;
				targets = removeTargets(command, ctx.cwd);
				what = "worktree remove";
				if (!targets.length) return;
			} else return;
			try {
				const reason = await guard(what, targets);
				return reason ? { block: true, reason } : undefined;
			} catch (error) {
				// A check that could not run is not a pass: the removal waits (the `/worktree remove` command does not pass here).
				return { block: true, reason: `${what} refused: the check for running processes in the checkout failed (${(error as Error).message}). Repeat the call; if it keeps failing, use the /worktree remove command.` };
			}
		});
	};
}

export default createHygiene();
