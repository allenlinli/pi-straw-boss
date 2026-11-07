import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { forgetOwned, noteOwned } from "../procs/killguard.ts";
import { sendSignal } from "../procs/kill.ts";
import { startOf as realStartOf } from "../startof.ts";
import { factsOf, readTrainboards, type Writer } from "../train/board.ts";
import { type Json, isObject, validateStep } from "../train/spec.ts";
import { loadLimit, stepWaits, type FactStep, type TrainFacts, type Wait, waitMessage } from "../train/waits.ts";
import { holderAlive, holderOf, lockDirOf, takeLock, type Taken } from "./trainlock.ts";

// The train gate wrapper (docs/specs/2026-11-07-train-workers.md §8): `cli.mjs train gate --spec <file>` is the process a train's `MonitorCreate` runs for a `run` step. It reads the step's frozen spec, waits while a load, lock, lane or target
// wait is unresolved, runs the command in a process group of its own with the lock held in this process, verifies it, and ends with one outcome line and an exit code (0 passed, 1 failed, 3 refused, 143 stopped). Every line is one JSON object of at
// most 1000 characters with `progress.message`, so the monitor counts it as progress, and at least one comes every 30 s; the same state is written to `gate-<id>.json` beside the step file, which the server reads (§11.1).
// Every line also carries `sb.spec` (the SHA-256 of the step file it read) and `sb.run` (a nonce of this process): the guard of the train's session takes a run's pass from the monitor's own record and those two fields (trainguard.ts, §21).
// Time, load, process liveness, signals and output come in as arguments, so a test runs it on a clock it moves.

export const BEAT_MS = 30_000, GRACE_MS = 4000, KILL_WAIT_MS = 500, TRY_GRACE_MS = 10_000, GATE_MAX_BOARDS = 4096, MAX_LINE = 1000, MAX_TAIL = 200, MAX_SPEC_BYTES = 16 * 1024;
export type GateState = "waiting" | "running" | "verifying" | "passed" | "failed" | "refused" | "stopped";
export const EXIT: Record<"passed" | "failed" | "refused" | "stopped", number> = { passed: 0, failed: 1, refused: 3, stopped: 143 };
/** A pipeline's last line that ends a poll: the conclusion is in and it is not the expected one. The whole line is the status; a longer line is never read for these words. */
export const CONCLUDED_BAD = /^(?:failed|failure|startup_failure|error|errored|cancell?ed|aborted|timed[_-]?out|timeout|skipped)$/i;

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export interface GateDeps {
	/** The environment the command runs in. */
	env: NodeJS.ProcessEnv;
	out(line: string): void;
	clock: Clock;
	/** The 1-minute load average and the core count; undefined where there is none. */
	load(): { now: number; cores: number } | undefined;
	startOf(pid: number): string | undefined;
	/** Whether a board's writer is still running (see `writerAlive`). */
	alive(writer: Writer): boolean;
	/** Where the wrapper hears that it is asked to end (SIGTERM, SIGINT, SIGHUP). */
	signals(leave: (signal: string) => void): void;
	platform: NodeJS.Platform;
	home: string;
	pid: number;
	/** The folder of the named locks for a state folder. */
	lockDir(stateDir: string): string;
	beatMs?: number;
	graceMs?: number;
	/** How many trainboards of the project a wait round reads before it holds everything (`GATE_MAX_BOARDS`). */
	maxBoards?: number;
	/** How a signal (or, with 0, a probe) reaches a process group; a negative pid is a group. The default is the guarded `process.kill`. */
	kill?: (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;
}

/** A start time as an instant: the text `ps` prints is read in UTC and carries no zone (Date.parse would take it as local time), and the ISO text Windows gives carries its own. */
export const startMs = (text: string) => (/Z$/.test(text) ? Date.parse(text) : Date.parse(`${text} GMT`));

/**
 * Whether a board's writer still runs: its pid answers and the process is not one that started after the writer did (a reused pid). The writer's `started` is an ISO time and `startOf` answers in the platform's text, so both go through
 * `startMs` and `Date.parse`, with 2 s for the seconds that `ps` rounds off and for the time the session took to say it started.
 */
export function writerAlive(writer: Writer, startOf: (pid: number) => string | undefined = realStartOf): boolean {
	if (!holderAlive({ pid: writer.pid })) return false;
	const process = startMs(startOf(writer.pid) ?? ""), said = Date.parse(writer.started);
	return Number.isNaN(process) || Number.isNaN(said) || process <= said + 2000;
}

export const gateDeps = (env: NodeJS.ProcessEnv = process.env, over: Partial<GateDeps> = {}): GateDeps => ({
	env,
	out: (line) => void process.stdout.write(`${line}\n`),
	clock: { now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
	load: () => ({ now: loadavg()[0]!, cores: availableParallelism() }),
	startOf: realStartOf,
	alive: (writer) => writerAlive(writer),
	signals: (leave) => (["SIGTERM", "SIGINT", "SIGHUP"] as const).forEach((signal) => process.on(signal, () => leave(signal))),
	platform: process.platform,
	home: env.HOME || homedir(),
	pid: process.pid,
	lockDir: (stateDir) => lockDirOf(stateDir),
	...over,
});

// ---- the frozen spec

export interface Frozen { file: string; stateDir: string; project: string; code: string; id: number; sb: Json; hash: string }
type Read = { ok: true; frozen: Frozen } | { ok: false; refusals: string[]; sb?: Json; id?: number };

/**
 * The step's frozen spec: `metadata.sb` as the guard froze it, at `<state>/trainboard/<project>/<code>/step-<id>.json`. The state folder, the project and the code come from the path and must be the spec's own, so a spec cannot be run from
 * anywhere else; the step id is the file name's. A spec that does not validate, or whose check is not `run`, is refused.
 */
export function readSpec(specFile: string): Read {
	const file = resolve(specFile), id = /^step-([1-9]\d*)\.json$/.exec(basename(file));
	if (!id) return { ok: false, refusals: [`sb: ${basename(file)} is not a step file (step-<id>.json)`] };
	const codeDir = dirname(file), projectDir = dirname(codeDir), board = dirname(projectDir);
	if (basename(board) !== "trainboard") return { ok: false, refusals: [`sb: ${file} is not in a trainboard folder (<state>/trainboard/<project>/<code>/)`] };
	let sb: unknown, raw = "", fd: number | undefined;
	try {
		const stat = lstatSync(file);
		if (!stat.isFile()) return { ok: false, refusals: [`sb: ${file} is not a regular file`] };
		if (stat.size > MAX_SPEC_BYTES) return { ok: false, refusals: [`sb: ${file} is more than ${MAX_SPEC_BYTES / 1024} KB`] };
		fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		if (fstatSync(fd).size > MAX_SPEC_BYTES) return { ok: false, refusals: [`sb: ${file} is more than ${MAX_SPEC_BYTES / 1024} KB`] };
		raw = readFileSync(fd, "utf8");
		sb = JSON.parse(raw);
	} catch (error) {
		return { ok: false, refusals: [`sb: cannot read the step file ${file}: ${(error as Error).message}`] };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const refusals = validateStep(sb);
	if (!isObject(sb)) return { ok: false, refusals };
	const spec = isObject(sb.spec) ? sb.spec : {}, check = isObject(spec.check) ? spec.check : {};
	if (refusals.length === 0 && check.type !== "run") refusals.push(`sb: train gate runs a run check, not "${String(check.type)}"`);
	if (sb.project !== basename(projectDir)) refusals.push(`sb: the spec's project ${String(sb.project)} is not the folder's ${basename(projectDir)}`);
	if (sb.train !== basename(codeDir)) refusals.push(`sb: the spec's train ${String(sb.train)} is not the folder's ${basename(codeDir)}`);
	if (refusals.length) return { ok: false, refusals, sb, id: Number(id[1]) };
	return { ok: true, frozen: { file, stateDir: dirname(board), project: String(sb.project), code: String(sb.train), id: Number(id[1]), sb, hash: createHash("sha256").update(raw).digest("hex") } };
}

// ---- lines and the gate file

const cut = (text: string, max: number) => (text.length > max ? Array.from(text).slice(0, max).join("") : text);
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** The last line of text as a person sees it: escape sequences gone, a carriage return's last rewrite, control characters and runs of blanks as one space, cut to 200 characters. */
export function cleanTail(text: string): string {
	const segments = text.replace(ANSI, "").split(/[\r\n]+/).map((s) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
	return cut(segments.at(-1) ?? "", MAX_TAIL);
}

/** The last `max` bytes of a file as text: a verify that prints hundreds of MB is not read whole. */
export function lastBytes(file: string, max: number): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size, length = Math.min(size, max), buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** The last line of a log file, read from its last 8 KB. */
export function tailOf(file: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size, length = Math.min(size, 8192), buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return cleanTail(buffer.toString("utf8"));
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** A line of at most 1000 characters: the tail gives way first, then the waits, then the message. */
export function fit(line: Json): string {
	let text = JSON.stringify(line);
	if (text.length <= MAX_LINE) return text;
	const copy = structuredClone(line) as { progress: { message: string }; sb?: { tail?: string; waits?: unknown } };
	const sb = copy.sb;
	while (sb?.tail && text.length > MAX_LINE) {
		// By code points, at least one a round: a tail of characters outside the BMP (two UTF-16 units each) shrinks too.
		const points = Array.from(sb.tail), drop = Math.max(1, Math.floor((text.length - MAX_LINE) / 2));
		sb.tail = points.slice(0, Math.max(0, points.length - drop)).join("");
		if (!sb.tail) delete sb.tail;
		text = JSON.stringify(copy);
	}
	if (text.length > MAX_LINE && sb) {
		delete sb.waits;
		text = JSON.stringify(copy);
	}
	for (const max of [300, 150, 60]) {
		if (text.length <= MAX_LINE) break;
		copy.progress.message = cut(copy.progress.message, max);
		const outcome = (copy as { monitorOutcome?: { message: string } }).monitorOutcome;
		if (outcome) outcome.message = cut(outcome.message, max);
		text = JSON.stringify(copy);
	}
	return text;
}

export interface GateFile {
	v: 1; project: string; app: string; train: string; step: number; kind: string; name: string; state: GateState; since: string; updated: string; message: string;
	load?: { max: number; now: number; cores: number }; waits: Wait[]; holder?: string; pid: number; started?: string; spec: string; exit?: number;
}
const STATES: readonly string[] = ["waiting", "running", "verifying", "passed", "failed", "refused", "stopped"];

/** The gate file as the server reads it: bounded, parsed, and checked for the fields it uses; undefined when it is not one. */
export function readGate(file: string): GateFile | undefined {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) return undefined;
		const value = JSON.parse(readFileSync(file, "utf8")) as GateFile;
		const ok = isObject(value) && value.v === 1 && typeof value.train === "string" && Number.isInteger(value.step) && STATES.includes(value.state) && typeof value.since === "string" && typeof value.updated === "string"
			&& Array.isArray(value.waits) && Number.isInteger(value.pid) && typeof value.spec === "string";
		return ok ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeGate(file: string, gate: GateFile) {
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(gate)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
		chmodSync(file, 0o600);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* nothing written */ }
		throw error;
	}
}

const short = (ms: number) => (ms < 60_000 ? `${Math.floor(ms / 1000)}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}m`);
/** The elapsed time of an outcome line: 18m3s. */
export const long = (ms: number) => {
	const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
	return `${h ? `${h}h` : ""}${h || m ? `${m}m` : ""}${s % 60}s`.replace(/^(\d+m)0s$/, "$1");
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const expand = (path: string, home: string) => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

/** What a signal to a group answers when nothing in it can take it any more: the group is gone (ESRCH), or macOS holds only a dead leader that has not been waited for (EPERM). */
const GONE = new Set(["ESRCH", "EPERM"]);
const killGroup = (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => (signal === 0 ? process.kill(pid, 0) : sendSignal(pid, signal));
const realSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The last line of the output, trimmed: the pipeline's conclusion or the version a target runs. */
export const lastLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

interface Ended { code: number | null; signal: string | null; error?: Error; stopped?: boolean; timedOut?: boolean }

export async function runGate(specFile: string, deps: GateDeps): Promise<number> {
	const d = { ...deps, beatMs: deps.beatMs ?? BEAT_MS, graceMs: deps.graceMs ?? GRACE_MS, kill: deps.kill ?? killGroup };
	const groupAlive = (pid: number) => {
		try {
			d.kill(-pid, 0);
			return true;
		} catch {
			return false; // see GONE
		}
	};
	const clock = d.clock;
	const read = readSpec(specFile);
	const refuse = (reason: string, sb?: Json, id?: number) => {
		const message = cut(`refused: ${reason}`, 400);
		d.out(fit({ monitorOutcome: { status: "refused", message }, progress: { message }, sb: { v: 1, ...(typeof sb?.train === "string" ? { train: sb.train } : {}), ...(id !== undefined ? { step: id } : {}), ...(typeof sb?.kind === "string" ? { kind: sb.kind } : {}), state: "refused" } }));
		return EXIT.refused;
	};
	if (!read.ok) return refuse(read.refusals.map((r) => r.replace(/^sb: /, "")).join("; "), read.sb, read.id);
	const { frozen } = read, { sb, id, project, code, stateDir } = frozen;
	const spec = sb.spec as Json, check = spec.check as Json, load = spec.load as { max?: number; perCore?: number; weight?: number } | undefined, lockName = spec.lock as string | undefined;
	const holds = spec.holds as { lane?: string; target?: string } | undefined;
	if (d.platform === "win32") return refuse("train gate needs process groups (macOS or Linux); this computer is Windows", sb, id);
	const home = d.home, cwd = resolve(expand(String(check.cwd), home)), logFile = resolve(cwd, expand(String(check.log), home));
	const gateFile = join(dirname(frozen.file), `gate-${id}.json`);
	let started = d.startOf(d.pid);
	const began = clock.now();
	// What the guard binds a run to (trainguard.ts): the hash of the step file this process read and a nonce only this process knows. Every line carries both, the first before the command exists, so nothing the command prints or runs can
	// put a line into the monitor's stream that the guard takes for this wrapper's (the command's output goes to the log, not to this stdout).
	const nonce = randomBytes(16).toString("hex");

	let state: GateState = "waiting", since = new Date(began).toISOString(), waits: Wait[] = [], loadNow: GateFile["load"];
	let signalled: string | undefined, wake = () => {};
	const stopped = new Promise<"stop">((done) => (wake = () => done("stop")));
	d.signals((signal) => {
		signalled ??= signal;
		wake();
	});
	const readLoad = () => {
		const l = d.load();
		loadNow = l && load ? { max: loadLimit(load, l.cores), now: r1(l.now), cores: l.cores } : undefined;
		return l;
	};

	function line(next: GateState, message: string, extra: { tail?: string; exit?: number } = {}) {
		if (next !== state) (state = next, since = new Date(clock.now()).toISOString());
		const final = next === "passed" || next === "failed" || next === "stopped";
		const holder = waits.map((w) => ("lock" in w ? w.lock.holder?.train : "lane" in w ? w.lane.holder : "target" in w ? w.target.holder : undefined)).find(Boolean);
		// A gate file that cannot be written does not keep the line from the monitor; a line that is not the last then ends the gate (the caller ends what it started).
		let failure: Error | undefined;
		try {
			writeGate(gateFile, {
				v: 1, project, app: String(sb.app), train: code, step: id, kind: String(sb.kind), name: String(sb.name), state, since, updated: new Date(clock.now()).toISOString(), message: cut(message, 400),
				...(loadNow ? { load: loadNow } : {}), waits, ...(holder ? { holder } : {}), pid: d.pid, ...(started ? { started } : {}), spec: frozen.hash, ...(extra.exit !== undefined ? { exit: extra.exit } : {}),
			});
		} catch (error) {
			failure = error as Error;
		}
		const ident = { v: 1, train: code, step: id, kind: sb.kind, state, spec: frozen.hash, run: nonce };
		const progress = { message, ...(loadNow ? { load: { max: loadNow.max, now: loadNow.now } } : {}) };
		d.out(final ? fit({ monitorOutcome: { status: state, message }, progress: { message }, sb: { ...ident, ...(extra.exit !== undefined ? { exit: extra.exit } : {}) } })
			: fit({ progress, sb: { ...ident, since, ...(waits.length ? { waits } : {}), ...(extra.tail ? { tail: extra.tail } : {}) } }));
		if (failure && !final) throw failure;
	}

	/** Sleeps `ms` in beats; false when a signal came first. `beat` prints the line between beats. */
	async function pause(ms: number, beat: () => void): Promise<boolean> {
		for (let left = ms; left > 0 && !signalled;) {
			const chunk = Math.min(d.beatMs, left);
			await Promise.race([clock.sleep(chunk), stopped]);
			if (signalled) return false;
			left -= chunk;
			if (left > 0) beat();
		}
		return !signalled;
	}

	let ended = false, lock: Extract<Taken, { ok: true }> | undefined, current: { pid: number; exited: Promise<Ended> } | undefined;
	/** The lock goes before the outcome line, so whoever reads the line finds it free. */
	const finish = (status: "passed" | "failed" | "stopped", message: string, exit?: number) => {
		ended = true;
		lock?.release();
		lock = undefined;
		line(status, message, { exit });
		return EXIT[status];
	};

	/** SIGTERM to the child's group; SIGKILL to what is left of it after the grace (4 s, and at most 0.5 s more: MonitorStop's own SIGKILL comes 5 s after its SIGTERM). */
	async function terminate(child: { pid: number; exited: Promise<Ended> }) {
		const signal = (name: "SIGTERM" | "SIGKILL") => {
			try { d.kill(-child.pid, name); } catch (error) { if (!GONE.has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
		};
		if (!groupAlive(child.pid)) return; // it ended while the signal was on its way
		signal("SIGTERM");
		let over = false;
		const gone = (async () => {
			while (!over && groupAlive(child.pid)) await realSleep(20);
			return !over;
		})();
		const quick = await Promise.race([gone, clock.sleep(d.graceMs).then(() => false)]);
		over = true;
		if (!quick && groupAlive(child.pid)) {
			signal("SIGKILL");
			// One budget for what follows the kill, so the whole stop (grace and this) ends inside MonitorStop's 5 s between SIGTERM and SIGKILL.
			const end = Date.now() + KILL_WAIT_MS;
			while (groupAlive(child.pid) && Date.now() < end) await realSleep(20);
			await Promise.race([child.exited, realSleep(Math.max(0, end - Date.now()))]);
			return;
		}
		await Promise.race([child.exited, realSleep(KILL_WAIT_MS)]);
	}

	/** Runs a command through the shell in a group of its own; ends when it exits, when a signal came, when `deadline` (a time of the clock) passed, or when a beat could not be written (the group is then killed first). */
	async function runChild(command: string, stdout: number, stderr: number, beat: () => void, deadline?: number): Promise<Ended> {
		const file = "/bin/sh"; // a literal absolute path: the gate runs where there are process groups, which is where this is
		const child = spawn(file, ["-c", command], { cwd, detached: true, stdio: ["ignore", stdout, stderr], env: d.env });
		const exited = new Promise<Ended>((done) => {
			child.once("exit", (code, signal) => done({ code, signal }));
			child.once("error", (error) => done({ code: null, signal: null, error }));
		});
		const pid = child.pid;
		if (pid === undefined) return exited;
		noteOwned(pid);
		current = { pid, exited };
		try {
			for (;;) {
				const first = await Promise.race([exited, clock.sleep(Math.max(1, Math.min(d.beatMs, deadline === undefined ? d.beatMs : deadline - clock.now()))).then(() => "beat" as const), stopped]);
				if (first === "stop") {
					await terminate({ pid, exited });
					return { code: null, signal: null, stopped: true };
				}
				if (first === "beat") {
					if (deadline !== undefined && clock.now() >= deadline) {
						await terminate({ pid, exited });
						return { code: null, signal: null, timedOut: true };
					}
					try {
						beat();
					} catch (error) {
						await terminate({ pid, exited }); // never leave the command running unwatched
						throw error;
					}
					continue;
				}
				return first;
			}
		} finally {
			current = undefined;
			forgetOwned(pid);
		}
	}

	try {
		if (load && !d.load()) return refuse("this computer has no load average to wait on (a load spec needs macOS or Linux)", sb, id);
		const dir = d.lockDir(stateDir);
		// ---- waits
		for (;;) {
			const l = readLoad();
			const boards = readTrainboards(stateDir, { project, max: d.maxBoards ?? GATE_MAX_BOARDS });
			// A read that was cut cannot say who holds what: everything is held, which for a gate is a refusal (it would otherwise run beside a train it did not see).
			if (boards.truncated) return refuse(`more than ${d.maxBoards ?? GATE_MAX_BOARDS} trainboards of project ${project}, so what is held cannot be known; remove the folders of ended trains under ${join(stateDir, "trainboard", project)}`, sb, id);
			// The same for a folder that could not be listed: what is in it is unknown.
			if (boards.unlisted.length) return refuse(`what trains of project ${project} hold cannot be known: ${boards.unlisted.join("; ")}`, sb, id);
			const trains = boards.trains.map((b) => factsOf(b, { now: clock.now(), alive: d.alive }));
			const step: FactStep = { id, kind: String(sb.kind), status: "in_progress", round: Number(sb.round), ...(holds ? { holds } : {}), ...(load ? { load } : {}), ...(lockName ? { lock: lockName } : {}) };
			const own: TrainFacts = trains.find((t) => t.code === code) ?? { project, code, state: "live", steps: [step] };
			const locks = lockName ? (() => { const h = holderOf(dir, lockName, { startOf: d.startOf }); return h ? { [lockName]: { train: h.train, step: h.step } } : {}; })() : {};
			waits = stepWaits(own, step, { trains: [own, ...trains.filter((t) => t.code !== code)], ...(l ? { load: { now: r1(l.now), cores: l.cores } } : {}), locks });
			if (waits.length === 0 && lockName && !(started ??= d.startOf(d.pid))) {
				// A lock without the holder's start time cannot tell a reused pid from its holder: wait a beat for it.
				line("waiting", "waiting: this process's start time cannot be read yet (the lock records it)");
				if (!(await pause(d.beatMs, () => {}))) return finish("stopped", `stopped by ${signalled} while waiting`);
				continue;
			}
			if (waits.length === 0 && lockName) {
				const taken = takeLock(dir, lockName, { train: code, step: id, pid: d.pid, ...(started ? { started } : {}) }, { startOf: d.startOf });
				if (taken.ok) lock = taken;
				else waits = [{ lock: { name: lockName, ...(taken.holder ? { holder: { train: taken.holder.train, step: taken.holder.step } } : {}) } }];
			}
			if (waits.length === 0) break;
			line("waiting", waitMessage(waits));
			if (!(await pause(d.beatMs, () => {}))) return finish("stopped", `stopped by ${signalled} while waiting`);
		}
		waits = [];

		// ---- run
		mkdirSync(dirname(logFile), { recursive: true });
		const log = openSync(logFile, "a", 0o600), ranFrom = clock.now();
		const tail = () => tailOf(logFile);
		const running = () => {
			const l = readLoad();
			line("running", `running ${short(clock.now() - ranFrom)}: ${String(sb.name)}${l ? ` (load ${r1(l.now)})` : ""}`, { tail: tail() });
		};
		let result: Ended;
		try {
			running();
			result = await runChild(String(check.run), log, log, running);
		} finally {
			closeSync(log);
		}
		const took = long(clock.now() - ranFrom);
		if (result.stopped) return finish("stopped", `stopped by ${signalled}; the command's process group was ended`);
		if (result.error) return finish("failed", `could not start the command: ${result.error.message}`);
		if (result.code !== 0) return finish("failed", result.signal ? `killed by ${result.signal} after ${took}` : `exit ${result.code} in ${took}`, result.code ?? undefined);

		// ---- verify
		const verify = check.verify as string | undefined, expect = check.expect as string | undefined, poll = check.poll as { everySec: number; forMin: number } | undefined;
		if (!verify) return finish("passed", `exit 0 in ${took}`, 0);
		const outFile = join(dirname(frozen.file), `verify-${id}.out`), until = clock.now() + (poll ? poll.forMin * 60_000 : 0), verifyFrom = clock.now();
		// A try inside a poll ends with the poll (and a short grace for a try that started at its end): a verify that hangs does not hold the gate and its lock for ever.
		const deadline = poll ? until + TRY_GRACE_MS : undefined;
		for (let attempt = 1; ; attempt++) {
			const beat = () => line("verifying", `verifying ${short(clock.now() - verifyFrom)}: ${String(sb.name)} (try ${attempt})`, { tail: tail() });
			beat();
			const outFd = openSync(outFile, "w", 0o600), errFd = openSync(logFile, "a", 0o600);
			let checked: Ended;
			try {
				checked = await runChild(verify, outFd, errFd, beat, deadline);
			} finally {
				closeSync(outFd);
				closeSync(errFd);
			}
			const printed = lastLine(lastBytes(outFile, 16384));
			try { unlinkSync(outFile); } catch { /* gone */ }
			if (checked.stopped) return finish("stopped", `stopped by ${signalled}; the command's process group was ended`);
			if (checked.timedOut) return finish("failed", `verify was still running after ${long(clock.now() - verifyFrom)} of polling; its group was ended`, 0);
			if (checked.error) return finish("failed", `could not start verify: ${checked.error.message}`);
			const exitedOk = checked.code === 0;
			if (exitedOk && (expect === undefined || printed === expect.trim())) return finish("passed", `exit 0 in ${took}; verified${expect !== undefined ? ` "${cut(printed, 80)}"` : ""} in ${long(clock.now() - verifyFrom)}`, 0);
			const why = !exitedOk ? `verify ${checked.signal ? `was killed by ${checked.signal}` : `exited ${checked.code}`}` : `verify printed "${cut(printed, 80)}", expected "${cut(String(expect), 80)}"`;
			if (!poll) return finish("failed", why, 0);
			if (exitedOk && CONCLUDED_BAD.test(printed)) return finish("failed", `${why}: the pipeline concluded "${cut(printed, 40)}"`, 0);
			if (clock.now() + poll.everySec * 1000 > until) return finish("failed", `${why}; still not after ${long(clock.now() - verifyFrom)} of polling`, 0);
			if (!(await pause(poll.everySec * 1000, beat))) return finish("stopped", `stopped by ${signalled} while polling`);
		}
	} catch (error) {
		if (current) await terminate(current).catch(() => {});
		if (ended) throw error;
		return finish("failed", `the wrapper failed: ${cut((error as Error).message, 300)}`);
	} finally {
		lock?.release();
	}
}
