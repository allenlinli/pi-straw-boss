import { readdirSync } from "node:fs";
import { boardPath, readBoard, readYard, trainboardDir, yardPath } from "./train/board.ts";
import { isName } from "./train/spec.ts";
import { stepToken } from "./trainboard.ts";
import type { TrainId } from "./trainrole.ts";

// What the sidebar tokens need from the trainboard files (docs/specs/2026-11-07-train-workers.md §12), read with the readers' own validators and bounds, so text a board carries is a
// kind, a status and a number by the time it gets here. The integrator is the main whose session a project's `yard.json` names as its writer (the file its `train` todos make); a train's
// step is the one its own board shows. Neither is taken from a token or from anything a model wrote on a pane.

const MAX_PROJECTS = 64;

/** Whether the yard of any project names this session as its writer. */
export function isIntegrator(stateDir: string, session: string): boolean {
	let names: string[];
	try { names = readdirSync(trainboardDir(stateDir)).filter(isName).slice(0, MAX_PROJECTS); } catch { return false; }
	return names.some((project) => {
		const read = readYard(yardPath(stateDir, project));
		return read.ok && read.yard.writer.session === session;
	});
}

/** The `sb_step` token of a train from its own board, or undefined when it has none or the board cannot be read. */
export function stepOf(stateDir: string, train: TrainId): string | undefined {
	try {
		const read = readBoard(boardPath(stateDir, train.project, train.code));
		return read.ok ? stepToken(read.board.steps) : undefined;
	} catch { return undefined; }
}
