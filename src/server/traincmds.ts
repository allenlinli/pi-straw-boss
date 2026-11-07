import { existsSync, lstatSync, readFileSync } from "node:fs";
import { availableParallelism, loadavg, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSyncExe } from "../exe.mjs";
import { checkCar, checkEvidence, parseAppAccept } from "../train/accept.ts";
import { type Board, boardPath, boardState, factsOf, MAX_CLEARS, readBoard, readTrainboards, type Writer, writeBoard } from "../train/board.ts";
import { isObject, validateStep } from "../train/spec.ts";
import { holding, loadLimit, stepWaits, type FactStep, type TrainFacts, type Wait } from "../train/waits.ts";
import { gateDeps, type GateDeps, type GateFile, readGate, runGate, writerAlive } from "./traingate.ts";
import { heldLocks, lockDirOf } from "./trainlock.ts";

// The `train` commands of cli.mjs (docs/specs/2026-11-07-train-workers.md §9.2): `gate` (traingate.ts), `check`, `status`, `clear`. Kept out of cli.ts, which carries a line budget (procscli.ts is the model). Exit codes: `gate` as the wrapper
// says (0, 1, 3, 143); `check` 0 when nothing is refused and 2 when something is (a usage error is 2 too); `status` 0; `clear` 0 done, 1 refused (the train's state does not allow it), 2 usage.

export interface TrainIo {
	out(text: string): void;
	err(text: string): void;
	env: NodeJS.ProcessEnv;
	/** The state folder (`<state>/trainboard/…`, and `<state>/locks/…`: the locks are the computer's, whichever slot asks). */
	stateDir: string;
	cwd?: string;
	now?: () => number;
	alive?: (writer: Writer) => boolean;
	user?: string;
	/** `git merge-base --is-ancestor` in `cwd`, and whether a file is there: replaced by tests. */
	isAncestor?: (older: string, newer: string) => boolean;
	exists?: (path: string) => boolean;
	load?: () => { now: number; cores: number } | undefined;
	gate?: Partial<GateDeps>;
}

const MAX_INPUT = 256 * 1024;
const usage = (io: TrainIo, text: string) => (io.err(`${text}\n`), 2);

function readInput(file: string): string {
	const stat = lstatSync(file);
	if (!stat.isFile()) throw new Error("not a regular file");
	if (stat.size > MAX_INPUT) throw new Error(`more than ${MAX_INPUT / 1024} KB`);
	return readFileSync(file, "utf8");
}

export async function runTrain(flags: Record<string, string | true>, io: TrainIo): Promise<number> {
	switch (flags.sub) {
		case "gate": return typeof flags.spec === "string" ? runGate(flags.spec, gateDeps(io.env, { out: (line) => io.out(`${line}\n`), ...io.gate })) : usage(io, "train gate needs --spec <file>");
		case "check": return check(flags, io);
		case "status": return status(flags, io);
		case "clear": return clear(flags, io);
	}
	return usage(io, "train needs gate, check, status or clear");
}

// ---- check

function check(flags: Record<string, string | true>, io: TrainIo): number {
	const cwd = io.cwd ?? process.cwd();
	if ((flags.step === undefined) === (flags.accept === undefined)) return usage(io, "train check needs --step <spec.json> or --accept <file> (with --app-accept and --slip), one of them");
	if (flags.step !== undefined && (flags["app-accept"] !== undefined || flags.slip !== undefined)) return usage(io, "--app-accept and --slip go with --accept");
	if (flags.accept === undefined && flags.slip !== undefined) return usage(io, "--slip goes with --accept");
	const read = (flag: string) => {
		try {
			return { text: readInput(resolve(cwd, String(flags[flag]))) };
		} catch (error) {
			return { refusal: `sb: cannot read --${flag} ${String(flags[flag])}: ${(error as Error).message}` };
		}
	};
	const refusals: string[] = [];
	if (flags.step !== undefined) {
		const input = read("step");
		if (input.refusal) refusals.push(input.refusal);
		else {
			let value: unknown;
			try {
				value = JSON.parse(input.text!);
			} catch (error) {
				value = undefined;
				refusals.push(`sb: the step file is not JSON (${(error as Error).message})`);
			}
			// The file may be the todo's whole metadata (`{ "sb": … }`) or `metadata.sb` itself.
			if (value !== undefined) refusals.push(...validateStep(isObject(value) && isObject(value.sb) && value.spec === undefined ? value.sb : value));
		}
	} else {
		const accept = read("accept"), slip = flags.slip !== undefined ? read("slip") : undefined;
		const list = typeof flags["app-accept"] === "string" ? String(flags["app-accept"]).split(",").map((k) => k.trim()).filter(Boolean) : [];
		const setting = parseAppAccept(list);
		if (accept.refusal) refusals.push(accept.refusal);
		if (slip?.refusal) refusals.push(slip.refusal);
		if (!setting.ok) refusals.push(setting.refusal);
		if (!accept.refusal && !slip?.refusal && setting.ok) {
			const exists = io.exists ?? ((path: string) => existsSync(resolve(cwd, path)));
			const isAncestor = io.isAncestor ?? ((older: string, newer: string) => {
				try {
					execFileSyncExe("git", ["merge-base", "--is-ancestor", older, newer], { cwd, stdio: "ignore", timeout: 15_000 });
					return true;
				} catch {
					return false;
				}
			});
			const options = { appAccept: setting.accept, exists, isAncestor };
			refusals.push(...(slip ? checkCar(slip.text!, accept.text, options) : checkEvidence(accept.text!, options)));
		}
	}
	io.out(`${JSON.stringify({ ok: refusals.length === 0, refusals })}\n`);
	return refusals.length ? 2 : 0;
}

// ---- status

export interface StepRow { id: number; kind: string; name: string; status: string; round: number; outcome?: string; waits: Wait[]; gate?: GateFile }
export interface TrainRow {
	project: string; app?: string; code: string; state: TrainFacts["state"]; reason?: string; session?: { id: string; pid: number; live: boolean }; round?: number; steps: StepRow[];
	cars: { tickets: string[]; branch: string; head: string; coordinator: string }[]; holds?: { lanes: string[]; targets: string[] };
}
export interface Status { load?: { now: number; cores: number }; locks: { name: string; train: string; step: number; pid: number; since: string }[]; trains: TrainRow[]; truncated: boolean; unlisted: string[] }

/** Every train on this computer from the trainboards: its state, its steps with the wait each is in and the wrapper's last word, the load now, and the locks held. */
export function trainStatus(io: Pick<TrainIo, "stateDir" | "now" | "alive" | "load">, project?: string): Status {
	const now = (io.now ?? Date.now)(), alive = io.alive ?? ((w: Writer) => writerAlive(w));
	const { trains: reads, truncated, unlisted } = readTrainboards(io.stateDir, project !== undefined ? { project } : {});
	const facts = reads.map((r) => factsOf(r, { now, alive }));
	const load = (io.load ?? (() => ({ now: loadavg()[0]!, cores: availableParallelism() })))();
	const locks = heldLocks(lockDirOf(io.stateDir)).map(({ name, holder }) => ({ name, train: holder.train, step: holder.step, pid: holder.pid, since: holder.since }));
	const held = Object.fromEntries(locks.map((l) => [l.name, { train: l.train, step: l.step }]));
	const trains = reads.map((read, i): TrainRow => {
		const train = facts[i]!;
		if (!read.ok) return { project: read.project, code: read.code, state: "unreadable", reason: read.reason, steps: [], cars: [] };
		const { board } = read, steps = board.steps.map((s): StepRow => {
			const fact: FactStep = { id: s.id, kind: s.kind, status: s.status, round: s.round, ...(s.holds ? { holds: s.holds } : {}), ...(s.load ? { load: s.load } : {}), ...(s.lock ? { lock: s.lock } : {}) };
			const gate = s.status === "in_progress" ? readGate(join(dirname(read.file), `gate-${s.id}.json`)) : undefined;
			return {
				id: s.id, kind: s.kind, name: s.name, status: s.status, round: s.round, ...(s.outcome ? { outcome: s.outcome } : {}),
				waits: s.status === "in_progress" ? stepWaits(train, fact, { trains: facts, ...(load ? { load } : {}), locks: held }) : [], ...(gate ? { gate } : {}),
			};
		});
		const held2 = holding(train);
		return {
			project: board.project, app: board.app, code: board.code, state: train.state, session: { id: board.writer.session, pid: board.writer.pid, live: alive(board.writer) }, round: board.round, steps,
			cars: board.cars.map((c) => ({ tickets: c.tickets, branch: c.branch, head: c.head, coordinator: c.coordinator })), holds: { lanes: held2.lanes, targets: held2.targets },
		};
	});
	return { ...(load ? { load } : {}), locks, trains, truncated, unlisted };
}

const waitText = (w: Wait) => ("load" in w ? `load <=${w.load.max} (now ${w.load.now})` : "lock" in w ? `lock ${w.lock.name}${w.lock.holder ? ` held by ${w.lock.holder.train} #${w.lock.holder.step}` : ""}`
	: "lane" in w ? `lane ${w.lane.app} held by ${w.lane.holder}${w.lane.why ? ` (${w.lane.why})` : ""}` : `target ${w.target.target} held by ${w.target.holder}${w.target.why ? ` (${w.target.why})` : ""}`);

function render(s: Status): string {
	const lines = [s.load ? `load ${Math.round(s.load.now * 10) / 10} on ${s.load.cores} cores` : "load unknown", s.locks.length ? `locks: ${s.locks.map((l) => `${l.name} (${l.train} #${l.step}, pid ${l.pid})`).join(", ")}` : "locks: none"];
	for (const t of s.trains) {
		lines.push(`${t.project} ${t.app ?? "?"} ${t.code} ${t.state}${t.session ? ` session ${t.session.id} ${t.session.live ? "live" : "gone"}` : ""}${t.round ? ` round ${t.round}` : ""}${t.reason ? ` (${t.reason})` : ""}`);
		for (const c of t.cars) lines.push(`  car ${c.tickets.join(",")} ${c.branch} (${c.coordinator})`);
		for (const st of t.steps) lines.push(`  #${st.id} ${st.kind} ${st.name}: ${st.status}${st.outcome ? ` ${st.outcome}` : ""}${st.gate ? ` [${st.gate.state}: ${st.gate.message}]` : ""}${st.waits.length ? ` waits ${st.waits.map(waitText).join("; ")}` : ""}`);
	}
	if (s.truncated) lines.push("(more trains than the 64 shown)");
	for (const u of s.unlisted) lines.push(`(${u}; the trains in it are not shown)`);
	return `${lines.join("\n")}\n`;
}

function status(flags: Record<string, string | true>, io: TrainIo): number {
	if (flags.project !== undefined && typeof flags.project !== "string") return usage(io, "--project needs a name");
	const result = trainStatus(io, flags.project as string | undefined);
	io.out(flags.json === true ? `${JSON.stringify(result)}\n` : render(result));
	return 0;
}

// ---- clear

function clear(flags: Record<string, string | true>, io: TrainIo): number {
	const { project, train, lane, target, reason } = flags;
	if (![project, train, reason].every((v) => typeof v === "string") || (lane === undefined) === (target === undefined) || (lane !== undefined && typeof lane !== "string") || (target !== undefined && typeof target !== "string"))
		return usage(io, "train clear needs --project P --train CODE --reason TEXT and one of --lane <app> or --target <name>");
	const why = String(reason).replace(/\s+/g, " ").trim();
	if (!why || why.length > 600) return usage(io, "--reason is 1 to 600 characters");
	let file: string;
	try {
		file = boardPath(io.stateDir, String(project), String(train));
	} catch (error) {
		return usage(io, (error as Error).message);
	}
	const refuse = (text: string) => (io.err(`sb: ${text}\n`), 1);
	const read = readBoard(file);
	if (!read.ok) return refuse(`the board of train ${String(train)} cannot be read (${read.reason}), so what it holds cannot be known and a clear does not release it`);
	const { board } = read, now = (io.now ?? Date.now)(), alive = (io.alive ?? ((w: Writer) => writerAlive(w)))(board.writer);
	const state = boardState(board, { now, alive });
	if (state === "ended") return refuse(`train ${board.code} has ended; it holds nothing`);
	if (state === "live") return refuse(alive ? `train ${board.code}'s session is live (pid ${board.writer.pid}); only a train whose session is gone can be cleared` : `train ${board.code}'s session is gone, but its board was updated less than 10 minutes ago; it is stale after that, and a clear is honored only for a stale train`);
	const facts = factsOf({ project: board.project, code: board.code, file, ...read }, { now, alive: () => alive }), held = holding(facts);
	const key = lane !== undefined ? "lane" : "target", name = String(lane ?? target);
	if (!(key === "lane" ? held.lanes : held.targets).includes(name)) return refuse(`train ${board.code} does not hold ${key} ${name}${board.clears?.some((c) => c[key] === name) ? " (already cleared)" : ""}`);
	if ((board.clears?.length ?? 0) >= MAX_CLEARS) return refuse(`train ${board.code} has ${MAX_CLEARS} clears already`);
	// `updated` stays as it was: the train is stale by it, and a clear is honored only while stale.
	const next: Board = { ...board, clears: [...(board.clears ?? []), { [key]: name, reason: why, by: `cli train clear (${io.user ?? userInfo().username})`, at: new Date(now).toISOString() }] };
	try {
		writeBoard(io.stateDir, next);
	} catch (error) {
		return refuse(`the clear was not written: ${(error as Error).message}`);
	}
	io.out(`${JSON.stringify({ ok: true, project: board.project, train: board.code, [key]: name, reason: why })}\n`);
	return 0;
}
