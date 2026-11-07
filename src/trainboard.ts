import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Board, type BoardStep, type CarRow, MAX_CARS, MAX_STEPS, MAX_TRAINS, type Writer, type Yard, type YardTrain, trainboardDir, carsDir } from "./train/board.ts";
import { type CarFile, type NoticeRecord, validateCarFile } from "./train/cars.ts";
import { compareCodes, isCode, isName, isObject, type Json, KINDS, type Kind } from "./train/spec.ts";
import type { StepStatus, Wait } from "./train/waits.ts";

// The files a train's session writes (docs/specs/2026-11-07-train-workers.md §10) and the small readers around them: the frozen step the gate wrapper reads, the board derived from the todo list, the integrator's yard derived
// from its `train` todos, the sidebar's step token (§12), and the car files the `notice` check reads (§5.5). Pure but for the files: the guard (trainguard.ts) decides when to call them.

export interface Row { id: number; status: string; metadata?: Record<string, unknown> }
const STATUSES = new Set(["pending", "in_progress", "completed"]);
const sbOf = (row: Row): Json | undefined => (isObject(row.metadata?.sb) ? (row.metadata!.sb as Json) : undefined);

let counter = 0;
/** Writes `file` whole or not at all: a private temp file in its folder, renamed over it; the folders are 700 and the file 600. */
export function writePrivate(file: string, text: string, root: string): void {
	const folders: string[] = [];
	for (let dir = dirname(file); ; dir = dirname(dir)) {
		folders.unshift(dir);
		if (dir === root || dir === dirname(dir)) break;
	}
	for (const dir of folders) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	const temp = `${file}.${process.pid}.${counter++}.tmp`;
	try {
		writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		try { unlinkSync(temp); } catch { /* nothing was written */ }
		throw error;
	}
}

/** `<state>/trainboard/<project>/<code>/step-<id>.json`: the frozen step the wrapper runs (mode 600). */
export const stepFile = (stateDir: string, project: string, code: string, id: number) => {
	if (!isName(project) || !isCode(code) || !Number.isInteger(id) || id < 1) throw new Error(`sb: no step file for ${project}/${code} #${id}`);
	return join(trainboardDir(stateDir), project, code, `step-${id}.json`);
};
export function freezeStep(stateDir: string, project: string, code: string, id: number, text: string): string {
	const file = stepFile(stateDir, project, code, id);
	writePrivate(file, text, trainboardDir(stateDir));
	return file;
}

// ---- the board

export interface BoardInput { project: string; code: string; app: string; rows: readonly Row[]; cars: CarRow[]; writer: Writer; now: number; clears?: Board["clears"]; waits?: (step: BoardStep) => Wait[] }

/** The step of a row, as the board shows it; a row that is not a well-formed step is left out (the guard would have refused it, and a board must stay readable). */
function stepOf(row: Row): BoardStep | undefined {
	const sb = sbOf(row);
	if (!sb || !STATUSES.has(row.status) || !(KINDS as readonly string[]).includes(sb.kind as string) || typeof sb.name !== "string" || !Number.isInteger(sb.round) || (sb.round as number) < 1) return undefined;
	const spec = isObject(sb.spec) ? sb.spec : {}, result = isObject(sb.result) ? sb.result : undefined;
	const holds = isObject(spec.holds) ? (Object.fromEntries(Object.entries(spec.holds).filter(([k, v]) => (k === "lane" || k === "target") && isName(v))) as BoardStep["holds"]) : undefined;
	const load = isObject(spec.load) ? (Object.fromEntries(Object.entries(spec.load).filter(([k, v]) => ["max", "perCore", "weight"].includes(k) && typeof v === "number")) as BoardStep["load"]) : undefined;
	return {
		id: row.id, kind: sb.kind as Kind, name: sb.name.slice(0, 64), status: row.status as StepStatus, round: sb.round as number,
		...(holds && Object.keys(holds).length ? { holds } : {}), ...(load && Object.keys(load).length ? { load } : {}),
		...(typeof spec.lock === "string" && /^[a-z0-9-]{1,32}$/.test(spec.lock) ? { lock: spec.lock } : {}),
		...(row.status === "completed" && result && ["passed", "failed", "void"].includes(result.outcome as string) ? { outcome: result.outcome as "passed" | "failed" | "void" } : {}),
		...(row.status === "completed" && result?.outcome === "void" && ["superseded", "skipped"].includes(result.why as string) ? { why: result.why as "superseded" | "skipped" } : {}),
	};
}

/** A train's board from its todo list: steps, the current round, its cars, and the waits of the steps in progress. The writer's `clears` are kept. */
export function buildBoard(i: BoardInput): Board {
	const steps = i.rows.flatMap((row) => stepOf(row) ?? []).slice(-MAX_STEPS).map((s) => {
		const waits = s.status === "in_progress" ? i.waits?.(s) ?? [] : [];
		return waits.length ? { ...s, waits: waits.slice(0, 8) } : s;
	});
	const round = steps.reduce((top, s) => Math.max(top, s.round), 1);
	return { v: 1, project: i.project, app: i.app, code: i.code, writer: i.writer, updated: new Date(i.now).toISOString(), round, cars: i.cars.slice(0, MAX_CARS), steps, ...(i.clears?.length ? { clears: i.clears } : {}) };
}

const GLYPH = { waiting: "\uF254", running: "\uF04B", passed: "\uF00C", failed: "\uF00D", rollback: "\uF0E2" };
/** The sidebar's `sb_step` token (§12): a glyph for the current step's state and its kind, at most 24 characters. The current step is the lowest one in progress, else the newest that completed. */
export function stepToken(steps: readonly Pick<BoardStep, "id" | "kind" | "status" | "outcome" | "waits">[]): string | undefined {
	const going = steps.filter((s) => s.status === "in_progress").sort((a, b) => a.id - b.id)[0];
	const done = steps.filter((s) => s.status === "completed").sort((a, b) => b.id - a.id)[0];
	const step = going ?? done;
	if (!step) return undefined;
	const glyph = going ? (going.waits?.length ? GLYPH.waiting : going.kind === "rollback" ? GLYPH.rollback : GLYPH.running) : done!.outcome === "failed" ? GLYPH.failed : GLYPH.passed;
	return Array.from(`${glyph} ${step.kind}`).slice(0, 24).join("");
}

// ---- the integrator's yard (§7.4, §10)

export interface YardInput { project: string; rows: readonly Row[]; writer: Writer; now: number }

/** The yard of the project: one train per `train` todo, forming while it is pending, departing while its manifest is with the tower, opened (with the train's session) or refused when it completed. */
export function buildYard(i: YardInput): Yard {
	const byCode = new Map<string, YardTrain>();
	for (const row of i.rows) {
		const sb = sbOf(row);
		if (!sb || sb.kind !== "train" || !STATUSES.has(row.status) || sb.project !== i.project || !isCode(sb.train) || !isName(sb.app) || !isObject(sb.spec) || !Array.isArray(sb.spec.cars)) continue;
		const result = isObject(sb.result) ? sb.result : undefined;
		const status = row.status === "pending" ? "forming" : row.status === "in_progress" ? "departing" : result?.outcome === "passed" ? "opened" : "refused";
		const departs = isObject(sb.spec.departs) ? (sb.spec.departs as YardTrain["departs"]) : undefined;
		byCode.set(sb.train, { code: sb.train, app: sb.app, status, ...(status === "opened" && typeof result?.session === "string" ? { session: result.session } : {}), cars: (sb.spec.cars as CarRow[]).slice(0, MAX_CARS), ...(departs ? { departs } : {}) });
	}
	const trains = [...byCode.values()].sort((a, b) => compareCodes(a.code, b.code)).slice(-MAX_TRAINS);
	return { v: 1, project: i.project, writer: i.writer, updated: new Date(i.now).toISOString(), trains };
}

// ---- the car files (§5.5)

const MAX_CAR_FILES = 256, MAX_CAR_BYTES = 64 * 1024;
const readSmall = (file: string): unknown => {
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > MAX_CAR_BYTES) return undefined;
	return JSON.parse(readFileSync(file, "utf8"));
};
const noticeFile = (file: string) => file.replace(/\.json$/, ".notice.json");
const iso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
function noticeOk(value: unknown): value is NoticeRecord {
	if (!isObject(value) || value.v !== 1 || !isObject(value.states)) return false;
	return Object.values(value.states).every((s) => isObject(s) && Array.isArray(s.attempts) && s.attempts.length <= 64 && s.attempts.every((a) => isObject(a) && typeof a.outcome === "string") && (s.deliveredAt === undefined || iso(s.deliveredAt)) && (s.escalatedAt === undefined || iso(s.escalatedAt)));
}

/** Every car file of a project and its notice record, from `<state>/trainboard/<project>/cars/`. A file that is not a car, too big, or out of shape is skipped; a notice record out of shape is none. */
export function readCars(stateDir: string, project: string): { file: CarFile; notice?: NoticeRecord }[] {
	const dir = carsDir(stateDir, project), out: { file: CarFile; notice?: NoticeRecord }[] = [];
	let names: string[];
	try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".notice.json")).sort().slice(0, MAX_CAR_FILES); } catch { return out; }
	for (const name of names) {
		try {
			const value = readSmall(join(dir, name));
			if (validateCarFile(value).length) continue;
			let notice: unknown;
			try { notice = readSmall(noticeFile(join(dir, name))); } catch { notice = undefined; }
			out.push({ file: value as CarFile, ...(noticeOk(notice) ? { notice } : {}) });
		} catch { /* not a car file */ }
	}
	return out;
}
