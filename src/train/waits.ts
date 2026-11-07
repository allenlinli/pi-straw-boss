import { compareCodes, type Holds, type LoadSpec } from "./spec.ts";

// What a train holds and what a step waits for (docs/specs/2026-11-07-train-workers.md §3.4, §7.3). Straw Boss derives every wait from the specs and the trainboards; the model writes none, and every wait is on a machine or an
// earlier train, never on a person (D11). "Earlier" is the departure order of the code, so two trains never wait on each other. Pure: the load, the locks and the boards come in as arguments.

export type StepStatus = "pending" | "in_progress" | "completed";
export type TrainState = "live" | "stale" | "ended" | "unreadable";
export interface FactStep { id: number; kind: string; status: StepStatus; round: number; holds?: Holds; load?: LoadSpec; lock?: string }
/** A release written by `train clear`: a train whose session is gone no longer holds this lane or target. */
export interface Clear { lane?: string; target?: string; reason: string; by: string; at: string }
export interface TrainFacts { project: string; code: string; state: TrainState; steps: FactStep[]; clears?: Clear[] }
export interface Holding { lanes: string[]; targets: string[]; all: boolean }
export interface Holder { code: string; why?: "stale" | "unreadable" }

/**
 * What a train holds: a lane or target from the start of the first step that declares it until every step that declares it has completed, in any round, so a re-assembly's new steps keep the hold across the gap.
 * An ended train holds nothing; a stale one holds what it held until `train clear`; a board that cannot be read holds everything of its project, since what it held cannot be known. A clear is honored only while the
 * train is stale: one that resumed (live) holds again, so a step it runs later never shares the lane with another train.
 */
export function holding(train: TrainFacts): Holding {
	if (train.state === "unreadable") return { lanes: [], targets: [], all: true };
	if (train.state === "ended") return { lanes: [], targets: [], all: false };
	const clears = train.state === "stale" ? train.clears ?? [] : [];
	const held = (key: "lane" | "target") => {
		const names = new Set<string>();
		for (const step of train.steps) if (step.holds?.[key] !== undefined) names.add(step.holds[key]!);
		return [...names].filter((name) => {
			const declaring = train.steps.filter((s) => s.holds?.[key] === name);
			return declaring.some((s) => s.status !== "pending") && declaring.some((s) => s.status !== "completed") && !clears.some((c) => c[key] === name);
		}).sort();
	};
	return { lanes: held("lane"), targets: held("target"), all: false };
}

export interface HoldQuery { project: string; lane?: string; target?: string; before?: string }

/** The trains of a project that hold a lane or a target, earliest first; with `before`, only those that departed earlier than that code. */
export function holders(trains: readonly TrainFacts[], query: HoldQuery): Holder[] {
	const out: Holder[] = [];
	for (const train of [...trains].sort((a, b) => compareCodes(a.code, b.code))) {
		if (train.project !== query.project || (query.before !== undefined && compareCodes(train.code, query.before) >= 0)) continue;
		const held = holding(train);
		if (held.all) out.push({ code: train.code, why: "unreadable" });
		else if ((query.lane !== undefined && held.lanes.includes(query.lane)) || (query.target !== undefined && held.targets.includes(query.target)))
			out.push(train.state === "stale" ? { code: train.code, why: "stale" } : { code: train.code });
	}
	return out;
}

export type Wait =
	| { load: { max: number; now: number } }
	| { lock: { name: string; holder?: { train: string; step: number } } }
	| { lane: { app: string; holder: string; why?: "stale" | "unreadable" } }
	| { target: { target: string; holder: string; why?: "stale" | "unreadable" } };

export interface WaitContext {
	trains: readonly TrainFacts[];
	/** The 1-minute load average and the core count where the step runs; without a reading no load wait is invented. */
	load?: { now: number; cores: number };
	/** The holder of each named lock now. */
	locks?: Record<string, { train: string; step: number }>;
}

/** The load a step may start under: its `max`, or its `perCore` factor times the cores. */
export const loadLimit = (load: LoadSpec, cores: number) => load.max ?? (load.perCore ?? 0) * cores;

/** The waits of one step, in the order the wrapper checks them: load, lock, lane, target. */
export function stepWaits(train: TrainFacts, step: FactStep, ctx: WaitContext): Wait[] {
	const out: Wait[] = [];
	if (step.load && ctx.load) {
		const max = loadLimit(step.load, ctx.load.cores);
		if (ctx.load.now > max) out.push({ load: { max, now: ctx.load.now } });
	}
	const lock = step.lock !== undefined ? ctx.locks?.[step.lock] : undefined;
	if (step.lock !== undefined && lock && !(lock.train === train.code && lock.step === step.id)) out.push({ lock: { name: step.lock, holder: { ...lock } } });
	const first = (query: Omit<HoldQuery, "project" | "before">) => holders(ctx.trains, { ...query, project: train.project, before: train.code })[0];
	const lane = step.holds?.lane !== undefined ? first({ lane: step.holds.lane }) : undefined;
	if (lane) out.push({ lane: { app: step.holds!.lane!, holder: lane.code, ...(lane.why ? { why: lane.why } : {}) } });
	const target = step.holds?.target !== undefined ? first({ target: step.holds.target }) : undefined;
	if (target) out.push({ target: { target: step.holds!.target!, holder: target.code, ...(target.why ? { why: target.why } : {}) } });
	return out;
}

/** The codes of the trains with a step in progress that waits on a lane or target an earlier train holds: the page's 「互相等待」 count. Called without a load or locks, so those waits are not in it. */
export function waitingTrains(trains: readonly TrainFacts[]): string[] {
	return [...trains].sort((a, b) => compareCodes(a.code, b.code)).filter((train) => train.state !== "ended"
		&& train.steps.some((step) => step.status === "in_progress" && stepWaits(train, step, { trains }).length > 0)).map((t) => t.code);
}

const held = (holder: string, extra: string | undefined) => `held by ${holder}${extra ? `, ${extra}` : ""}`;

/** The English line of a step's waits, the `progress.message` of a waiting monitor line (§8.2); the page words the same fields itself. */
export function waitMessage(waits: readonly Wait[]): string {
	if (waits.length === 0) return "";
	const parts = waits.map((w) => {
		if ("load" in w) return `load <=${w.load.max} (now ${w.load.now})`;
		if ("lock" in w) return `lock ${w.lock.name}${w.lock.holder ? ` (held by ${w.lock.holder.train} #${w.lock.holder.step})` : ""}`;
		if ("lane" in w) return `lane ${w.lane.app} (${held(w.lane.holder, w.lane.why)})`;
		return `target ${w.target.target} (${held(w.target.holder, w.target.why)})`;
	});
	return `waiting: ${parts.join("; ")}`;
}
