import { clean, readEntries } from "./board.ts";
import { type BoardReadInput, liveMains } from "./boardread.ts";
import { boardRows, boardText } from "./boardview.ts";

// `/boss board` (docs/specs/2026-11-09-board-view.md): the same rows as the head page's work board, as text, for this computer only. No clear and no ask from pi in this change.

export function boardCommand(o: { dir: string; now: number; net: BoardReadInput["net"] }): string {
	return boardText(boardRows(readEntries(o.dir), liveMains(o.net, o.now, (text) => clean(text, 40)), o.now), o.now);
}
