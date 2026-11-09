import { boardPath, readBoard } from "./train/board.ts";
import { stepToken } from "./trainboard.ts";
import type { TrainId } from "./trainrole.ts";

// A train's step for the sidebar token (docs/specs/2026-11-07-train-workers.md §12), read from its own board with the reader's validators and bounds. Display only. Whether a main is the integrator is its duty (mainduty.ts), not a yard.

/** The `sb_step` token of a train from its own board, or undefined when it has none or the board cannot be read. */
export function stepOf(stateDir: string, train: TrainId): string | undefined {
	try {
		const read = readBoard(boardPath(stateDir, train.project, train.code));
		return read.ok ? stepToken(read.board.steps) : undefined;
	} catch { return undefined; }
}
