import type { CarState } from "./cars.ts";
import type { Kind } from "./spec.ts";
import type { StepStatus, Wait } from "./waits.ts";

// The yards as the net snapshot carries them (docs/specs/2026-11-07-train-workers.md §11.1): types only, so the page can import them without the server's modules. Every string in a view has passed the server's reader as plain text
// (controls, escapes and bidi marks gone, a length cap), every number is a whole number or a plain finite one, and a unit `key` is the one the net itself holds, never a value a file chose.

/** The server's 1-minute load average and the core count (`Net.load`); absent where the platform has no load average (Windows). */
export interface NetLoad { now: number; cores: number }

/** One acceptance the car's evidence shows (`kind`: `e2e`, `uat`, or the evidence's own label) and, when the train kept a copy of the evidence file, the words the approver gave. */
export interface YardAccepted { kind: string; nod?: string }
/** Whether sb has told the car's coordinator of the car's newest `state` (§5.5): `delivered` or `escalated` at `at`, or still `pending` after `attempts`, the last answer in `last`. */
export interface YardNotice { state: CarState; status: "delivered" | "pending" | "escalated"; attempts: number; at?: string; last?: string }
export interface YardCar { tickets: string[]; branch: string; head: string; departs: string; arrived?: string; accepted: YardAccepted[]; notice?: YardNotice }

export interface YardStep {
	id: number; kind: Kind; name: string; status: StepStatus; round: number; outcome?: "passed" | "failed" | "void"; why?: "superseded" | "skipped";
	/** The CPU the step needs: its load limit (`max`, or `perCore` of the cores) and the cores it expects to use. */
	load?: { max?: number; perCore?: number; weight?: number };
	holds?: { lane?: string; target?: string };
	/** What an in-progress step waits for now (§7.3): load and lanes and targets from the server's own reading of the boards, locks as the train recorded them. */
	waits: Wait[];
	/** The gate wrapper's last word for an in-progress step, from its gate file. */
	gate?: { state: string; since: string; updated: string };
}

export interface YardTrainRow {
	code: string;
	app?: string;
	/** `unreadable`: the board failed to read; `reason` says why and nothing else of the train is shown. */
	state: "live" | "stale" | "ended" | "unreadable";
	reason?: string;
	/** The unit of the net whose pane's token names this train: the page opens its comms with it. */
	key?: string;
	/** Whether the process that wrote the board still runs. */
	writerLive?: boolean;
	round?: number;
	updated?: string;
	cars: YardCar[];
	steps: YardStep[];
	/** How many older steps were left out (a train shows its newest 64). */
	stepsCut?: number;
	holds?: { lanes: string[]; targets: string[] };
}

export interface YardFormingRow { code: string; app: string; status: "forming" | "departing" | "refused"; cars: YardCar[]; departs?: { maxCars: number; maxWaitMin: number; oldest: string } }

export interface ProjectYard {
	project: string;
	/** The writer of the project's `yard.json`: `key` is its unit when the net has that session as a main; `live` whether its process runs. */
	integrator?: { key?: string; live: boolean };
	/** Why `yard.json` could not be read (a file that is not there is no problem). */
	problem?: string;
	forming: YardFormingRow[];
	trains: YardTrainRow[];
	/** The codes of the trains with a step that waits for a lane or target another train holds (「互相等待」). */
	waiting: string[];
}

/** `yards` of the snapshot: this computer's only (the `board` message, a remote turn and the operate slice never carry it). `truncated`: more trains or projects than the 64 read. `problems`: folders that could not be listed. */
export interface Yards { projects: ProjectYard[]; truncated?: true; problems?: string[] }

/** What the reader needs of the net to name units: the live unit of each train (its pane's `sb_train` token) and the keys of the mains. */
export interface YardJoin { trains: { key: string; project: string; code: string }[]; mains: ReadonlySet<string> }
