import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { integrationOff } from "../trainswitch.ts";
import { type BoardRead, type BoardStep, type CarRow, carsDir, factsOf, readTrainboards, readYard, trainboardDir, type Writer, yardPath } from "../train/board.ts";
import { type CarFile, type CarState, type NoticeRecord, noticeStatus } from "../train/cars.ts";
import { isName, isObject, isoTime, SHA_RE } from "../train/spec.ts";
import { type FactStep, holding, stepWaits, type TrainFacts, type Wait, waitingTrains } from "../train/waits.ts";
import type { NetLoad, ProjectYard, YardAccepted, YardCar, YardFormingRow, YardJoin, YardNotice, Yards, YardStep, YardTrainRow } from "../train/yardview.ts";
import { readCars } from "../trainboard.ts";
import { plain } from "./operatesanitize.ts";
import { readGate, writerAlive } from "./traingate.ts";

// The yards of the net snapshot (docs/specs/2026-11-07-train-workers.md §11.1): what the page draws of the trains, read from `<state>/trainboard/*/` on every reading of the net. The files are written by train sessions and the
// integrator, which are models, so nothing in them is trusted: a board is read with the writer's own validator and bounds (at most 64 trains, 64 KB a file, regular files only, no link followed), a file that fails shows as
// unreadable with its reason and nothing else of it is guessed, and every string that reaches the page is plain text cut to its length. Which unit of the net is a train is told by the net's own pane tokens, never by a file.
// `yards` stay on this computer: nothing here is reachable from the board message, a remote turn or the operate slice (tests/train-yard-net.test.ts).

export const MAX_PROJECTS = 64, MAX_VIEW_STEPS = 64, MAX_VIEW_CARS = 16, MAX_PROBLEMS = 8;
const MAX_EVIDENCE_COPIES = 32, MAX_EVIDENCE_BYTES = 32 * 1024;

export interface YardDeps {
	stateDir: string;
	now?: () => number;
	/** Whether a board's writer is still running (see `writerAlive`). */
	alive?: (writer: Writer) => boolean;
	/** The load now: waits on the load of a step are made only with a reading. */
	load?: NetLoad;
}

/** Plain text for the page: controls, escapes and bidi marks become spaces, cut to `max`; the state folder's path never leaves (a reason may name it). */
const text = (stateDir: string) => (value: string, max: number) => plain(value.split(stateDir).join("<state>"), max);

const listDirs = (path: string): { names: string[]; failed?: string } => {
	try {
		return { names: readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && isName(e.name)).map((e) => e.name).sort() };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { names: [] } : { names: [], failed: `cannot list ${path}: ${code ?? (error as Error).message}` };
	}
};

/** The boss's words in the train's own copies of the evidence (`car-<n>.json`, §5.3), by car head and kind: regular files under 32 KB, at most 32 of them, shaped as an evidence file. Anything else adds nothing. */
function nodsOf(folder: string, clean: (value: string, max: number) => string): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	let names: string[] = [];
	try { names = readdirSync(folder).filter((n) => /^car-\d{1,3}\.json$/.test(n)).sort().slice(0, MAX_EVIDENCE_COPIES); } catch { return out; }
	for (const name of names) {
		let fd: number | undefined;
		try {
			const file = join(folder, name), stat = lstatSync(file);
			if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) continue;
			fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			if (fstatSync(fd).size > MAX_EVIDENCE_BYTES) continue;
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (!isObject(value) || !isObject(value.car) || !SHA_RE.test(String(value.car.head)) || !Array.isArray(value.accepted)) continue;
			const kinds = out.get(value.car.head as string) ?? new Map<string, string>();
			for (const entry of value.accepted.slice(0, 8)) if (isObject(entry) && typeof entry.kind === "string" && typeof entry.nod === "string" && entry.nod.trim() && !kinds.has(entry.kind)) kinds.set(entry.kind, clean(entry.nod, 300));
			out.set(value.car.head as string, kinds);
		} catch { /* not an evidence copy */ } finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
	return out;
}

type CarIndex = Map<string, { file: CarFile; notice?: NoticeRecord }>;

/** The newest state of every car file of a project and its notice: from `<state>/trainboard/<project>/cars/`, a real folder only (a link is not followed). */
function carIndex(stateDir: string, project: string): CarIndex {
	const index: CarIndex = new Map();
	try {
		if (!lstatSync(carsDir(stateDir, project)).isDirectory()) return index;
	} catch { return index; }
	for (const found of readCars(stateDir, project)) index.set(`${found.file.app}\n${found.file.car.head}`, found);
	return index;
}

const noticeOf = (found: { file: CarFile; notice?: NoticeRecord } | undefined, clean: (value: string, max: number) => string): YardNotice | undefined => {
	const latest = found?.file.states.at(-1);
	if (!found || !latest) return undefined;
	const state: CarState = latest.state, status = noticeStatus(found.notice, state);
	return status.kind === "pending" ? { state, status: "pending", attempts: status.attempts, ...(status.last ? { last: clean(status.last, 120) } : {}) } : { state, status: status.kind, attempts: status.attempts, at: status.at };
};

function cleanWait(wait: Wait, clean: (value: string, max: number) => string): Wait {
	if ("load" in wait) return { load: { max: wait.load.max, now: wait.load.now } };
	if ("lock" in wait) return { lock: { name: clean(wait.lock.name, 32), ...(wait.lock.holder ? { holder: { train: clean(wait.lock.holder.train, 32), step: wait.lock.holder.step } } : {}) } };
	if ("lane" in wait) return { lane: { app: clean(wait.lane.app, 64), holder: clean(wait.lane.holder, 32), ...(wait.lane.why ? { why: wait.lane.why } : {}) } };
	return { target: { target: clean(wait.target.target, 128), holder: clean(wait.target.holder, 32), ...(wait.target.why ? { why: wait.target.why } : {}) } };
}

/** Which unit of the net is a train: the one whose pane's token names it. With two claims the one that is the board's own writer wins; with no way to tell, none. */
function unitOf(join: YardJoin, project: string, code: string, writer?: string): string | undefined {
	const claims = join.trains.filter((u) => u.project === project && u.code === code);
	return claims.length === 1 ? claims[0]!.key : claims.find((u) => u.key === writer)?.key;
}

/**
 * The yards of the snapshot: per project the forming trains of its `yard.json` and every train of its trainboards, with the unit of the net that runs each. `undefined` when there is nothing to show (no trainboard folder, or no project in
 * it has a train or a yard). Never throws on what a file holds; a folder that cannot be listed is told in `problems`.
 */
export function readYards(deps: YardDeps, join_: YardJoin): Yards | undefined {
	const { stateDir } = deps, now = (deps.now ?? Date.now)(), isAlive = deps.alive ?? ((w: Writer) => writerAlive(w)), clean = text(stateDir);
	const root = trainboardDir(stateDir), listed = listDirs(root), problems = listed.failed ? [listed.failed] : [];
	const names = listed.names.slice(0, MAX_PROJECTS), { trains: reads, truncated, unlisted } = readTrainboards(stateDir);
	problems.push(...unlisted);
	// A board's writer is asked once, however many ways its liveness is used.
	const lives = new Map<BoardRead, boolean>();
	const live = (read: BoardRead & { ok: true }) => (lives.has(read) ? lives.get(read)! : (lives.set(read, isAlive(read.board.writer)), lives.get(read)!));
	const facts: TrainFacts[] = reads.map((read) => factsOf(read, { now, alive: () => (read.ok ? live(read) : false) }));
	const load = deps.load ? { now: deps.load.now, cores: deps.load.cores } : undefined;
	const projects: ProjectYard[] = [];
	for (const project of names) {
		const mine = reads.flatMap((read, i) => (read.project === project ? [{ read, fact: facts[i]! }] : []));
		const yard = readYard(yardPath(stateDir, project)), missing = !yard.ok && yard.reason === "cannot read: ENOENT";
		if (!mine.length && missing) continue;
		const index = carIndex(stateDir, project);
		const carView = (row: CarRow, app: string, nods?: Map<string, Map<string, string>>): YardCar => {
			const accepted = (row.accepted ?? []).slice(0, 8).map((kind): YardAccepted => ((nod) => (nod ? { kind: clean(kind, 32), nod } : { kind: clean(kind, 32) }))(nods?.get(row.head)?.get(kind)));
			const notice = noticeOf(index.get(`${app}\n${row.head}`), clean);
			return { tickets: row.tickets.slice(0, 16).map((t) => clean(t, 64)), branch: clean(row.branch, 255), head: row.head, departs: clean(row.departs, 300), ...(row.arrived ? { arrived: row.arrived } : {}), accepted, ...(notice ? { notice } : {}) };
		};
		const trains = mine.map(({ read, fact }): YardTrainRow => {
			if (!read.ok) {
				const key = unitOf(join_, project, read.code);
				return { code: read.code, state: "unreadable", reason: clean(read.reason, 200), ...(key ? { key } : {}), cars: [], steps: [] };
			}
			const { board } = read, key = unitOf(join_, project, board.code, board.writer.session), nods = nodsOf(dirname(read.file), clean);
			const factSteps = new Map<number, FactStep>(fact.steps.map((s) => [s.id, s]));
			const view = (s: BoardStep): YardStep => {
				const recorded = s.status === "in_progress" ? (s.waits ?? []).filter((w) => "lock" in w) : [];
				const waits = s.status === "in_progress" ? [...stepWaits(fact, factSteps.get(s.id)!, { trains: facts, ...(load ? { load } : {}) }), ...recorded].slice(0, 8).map((w) => cleanWait(w, clean)) : [];
				const gate = s.status === "in_progress" ? readGate(join(dirname(read.file), `gate-${s.id}.json`)) : undefined;
				const gateOk = gate && gate.train === board.code && gate.step === s.id && isoTime(gate.since) && isoTime(gate.updated);
				return {
					id: s.id, kind: s.kind, name: clean(s.name, 64), status: s.status, round: s.round, ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.why ? { why: s.why } : {}),
					...(s.load ? { load: { ...s.load } } : {}), ...(s.holds ? { holds: { ...s.holds } } : {}), waits, ...(gateOk ? { gate: { state: gate.state, since: gate.since, updated: gate.updated } } : {}),
				};
			};
			const steps = board.steps.toSorted((a, b) => a.id - b.id), shown = steps.slice(-MAX_VIEW_STEPS), held = holding(fact);
			return {
				code: board.code, app: board.app, state: fact.state === "unreadable" ? "unreadable" : fact.state, ...(key ? { key } : {}), writerLive: live(read), round: board.round, updated: board.updated,
				cars: board.cars.slice(0, MAX_VIEW_CARS).map((c) => carView(c, board.app, nods)), steps: shown.map(view), ...(steps.length > shown.length ? { stepsCut: steps.length - shown.length } : {}),
				...(held.lanes.length || held.targets.length ? { holds: { lanes: held.lanes, targets: held.targets } } : {}),
			};
		});
		const forming = yard.ok ? yard.yard.trains.filter((t) => t.status !== "opened").map((t): YardFormingRow => ({
			code: t.code, app: t.app, status: t.status as YardFormingRow["status"], cars: t.cars.slice(0, MAX_VIEW_CARS).map((c) => carView(c, t.app)), ...(t.departs ? { departs: { maxCars: t.departs.maxCars, maxWaitMin: t.departs.maxWaitMin, oldest: t.departs.oldest } } : {}),
		})) : [];
		projects.push({
			project, ...(yard.ok ? { integrator: { ...(join_.mains.has(yard.yard.writer.session) ? { key: yard.yard.writer.session } : {}), live: isAlive(yard.yard.writer) } } : {}),
			...(!yard.ok && !missing ? { problem: clean(`yard.json: ${yard.reason}`, 200) } : {}), forming, trains, waiting: waitingTrains(mine.map((m) => m.fact)),
		});
	}
	const cut = truncated || listed.names.length > MAX_PROJECTS;
	if (!projects.length && !problems.length && !cut) return undefined;
	return { projects, ...(cut ? { truncated: true as const } : {}), ...(problems.length ? { problems: problems.slice(0, MAX_PROBLEMS).map((p) => clean(p, 200)) } : {}) };
}

export interface TrainyardOptions {
	env: NodeJS.ProcessEnv;
	stateDir: string;
	platform?: NodeJS.Platform;
	/** The 1-minute load average and the core count (tests give their own). */
	load?: () => { now: number; cores: number };
	now?: () => number;
	alive?: (writer: Writer) => boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What the net reads the trains through. With the merge train off (`trainswitch.ts`, checked at every reading, so a switch turned on or off shows at once) nothing is read at all. A reader that fails is told in `problems`, not thrown:
 * the net stays up. The load is one decimal; there is none on Windows, where the system gives no load average (§16).
 */
export function trainyardSeam(o: TrainyardOptions) {
	const reading = (): NetLoad | undefined => {
		if ((o.platform ?? process.platform) === "win32") return undefined;
		const now = o.load?.() ?? { now: loadavg()[0]!, cores: availableParallelism() };
		return Number.isFinite(now.now) && now.cores > 0 ? { now: r1(now.now), cores: now.cores } : undefined;
	};
	const off = () => integrationOff(o.env, o.stateDir);
	return {
		yards(join_: YardJoin): Yards | undefined {
			if (off()) return undefined;
			try {
				const load = reading();
				return readYards({ stateDir: o.stateDir, ...(o.now ? { now: o.now } : {}), ...(o.alive ? { alive: o.alive } : {}), ...(load ? { load } : {}) }, join_);
			} catch (error) {
				return { projects: [], problems: [plain(`the trains could not be read: ${(error as Error).message}`.split(o.stateDir).join("<state>"), 200)] };
			}
		},
		load(): NetLoad | undefined {
			try {
				return off() ? undefined : reading();
			} catch {
				return undefined; // told once, in `yards`' problems, by the reading that failed
			}
		},
	};
}
export type Trainyard = ReturnType<typeof trainyardSeam>;
