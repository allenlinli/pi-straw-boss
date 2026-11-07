import { readdirSync } from "node:fs";
import { writerAlive } from "./server/traingate.ts";
import { boardPath, readBoard, readYard, trainboardDir, type Writer, yardPath } from "./train/board.ts";
import { isName } from "./train/spec.ts";
import { stepToken } from "./trainboard.ts";
import type { TrainId } from "./trainrole.ts";

// What the sidebar tokens need from the trainboard files (docs/specs/2026-11-07-train-workers.md §12), read with the readers' own validators and bounds, so text a board carries is a
// kind, a status and a number by the time it gets here. The integrator is the main whose session a project's `yard.json` names as its writer (the file its `train` todos make) while the process
// of that writer runs; a train's step is the one its own board shows. Neither is taken from a token or from anything a model wrote on a pane. Display only: a train's bash can write a yard that
// names a live session (§23), so nothing here decides who may do what.

const MAX_PROJECTS = 64;

/** The sessions the yards of the projects name as their writers, those whose writer process still runs (its pid answers and it did not start after the yard said; a yard left by a writer that is gone names no one). */
export function integrators(stateDir: string, alive: (writer: Writer) => boolean = writerAlive): Set<string> {
	const named = new Set<string>();
	let names: string[];
	try { names = readdirSync(trainboardDir(stateDir)).filter(isName).slice(0, MAX_PROJECTS); } catch { return named; }
	for (const project of names) {
		const read = readYard(yardPath(stateDir, project));
		if (read.ok && !named.has(read.yard.writer.session) && alive(read.yard.writer)) named.add(read.yard.writer.session);
	}
	return named;
}

/** Whether a live yard of any project names this session as its writer. */
export const isIntegrator = (stateDir: string, session: string, alive?: (writer: Writer) => boolean): boolean => integrators(stateDir, alive).has(session);

/** The `sb_step` token of a train from its own board, or undefined when it has none or the board cannot be read. */
export function stepOf(stateDir: string, train: TrainId): string | undefined {
	try {
		const read = readBoard(boardPath(stateDir, train.project, train.code));
		return read.ok ? stepToken(read.board.steps) : undefined;
	} catch { return undefined; }
}
