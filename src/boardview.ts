import { type BoardItem, clean, type Count, type Entry, joinLocal, type LiveMain, readEntries, type Src } from "./board.ts";
import type { Net } from "./net.ts";

// The work board on the boss's own page and in `/boss board` (docs/specs/2026-11-09-board-view.md): the rows of THIS computer's board, built with the code a tower's `board_read` uses (`readEntries` and `joinLocal`), unscrubbed (the boss's own
// view keeps raw text, as `board_read` does outside a remote turn) and cut to the board's caps by the reader. An ended entry stays while its file exists. Allies' boards are never an input here: the rows come from the files of this computer and its live mains.

/**
 * One row. `updated` (epoch ms) is when the line was written, not how long ago: the snapshot carries it so a page is sent only when the board moved, and the page counts the age itself. `stale`: a live main that is idle, whose line is over 2 hours old
 * (as `board_read`); `clearable`: the row is `ended` or `stale`, which is all the Clear button needs (and the server decides again at the click, from its own reading). A live main with no line is a row with its name and tab only.
 */
export interface BoardViewRow {
	session: string;
	workspace: string;
	tab: string;
	/** The main's name; an ended row has the name an auto line kept (`who`), else none. */
	main: string;
	role?: "train";
	/** The net mark of a live main (`working`, `waiting`, `idle`, `commanding`, `done`, `error`, `unknown`), or `ended`. */
	state: string;
	now?: string;
	items: BoardItem[];
	src?: Src;
	count?: Count;
	updated?: number;
	stale?: true;
	clearable?: true;
}

/** The ended rows shown are the newest this many (a folder that kept a hundred dead lines shows the latest); live mains are all shown. */
export const MAX_ENDED = 100;

/** The live mains of the net snapshot the server already built (units of this computer's own bases; a box this computer operates is another computer's board). */
export function mainsOfNet(net: Pick<Net, "bases">): LiveMain[] {
	return net.bases.filter((b) => !b.box).flatMap((b) => b.tabs.flatMap((t) => t.units.filter((u) => u.role === "main" || u.role === "train").map((u): LiveMain => ({
		session: u.key, ...(u.role === "train" ? { role: "train" as const } : {}), name: clean(u.name, 40), workspaceId: b.id, workspace: clean(b.label, 40), tab: clean(t.label, 40), state: u.mark, commanding: u.mark === "commanding",
	}))));
}

/** The rows: every live main in net order (the entry it wrote, if any), then the ended entries, newest first. */
export function boardRows(entries: Entry[], mains: LiveMain[], now: number): BoardViewRow[] {
	const written = new Map(entries.map((e) => [e.session, e.updated])), all = joinLocal(entries, mains, now, { keepEnded: true });
	const live = all.filter((r) => r.state !== "ended"), ended = all.filter((r) => r.state === "ended").sort((a, b) => (written.get(b.session) ?? 0) - (written.get(a.session) ?? 0)).slice(0, MAX_ENDED);
	return [...live, ...ended].map((r): BoardViewRow => {
		const updated = r.now === undefined ? undefined : written.get(r.session);
		return {
			session: r.session, workspace: r.workspace, tab: r.tab, main: r.main || r.who || "", ...(r.role ? { role: r.role } : {}), state: r.state, ...(r.now !== undefined ? { now: r.now } : {}), items: r.items,
			...(r.src ? { src: r.src } : {}), ...(r.count ? { count: r.count } : {}), ...(updated !== undefined ? { updated } : {}), ...(r.stale ? { stale: true as const } : {}), ...(r.state === "ended" || r.stale ? { clearable: true as const } : {}),
		};
	});
}

/** What the net reads the board through (`netSource`'s `board`): nothing when there is no row, so an empty computer's snapshot has no `board`. A failed read leaves the board out and the net up. */
export function boardSeam(o: { dir: string; now(): number }) {
	return {
		rows(net: Pick<Net, "bases">): BoardViewRow[] | undefined {
			try {
				const rows = boardRows(readEntries(o.dir), mainsOfNet(net), o.now());
				return rows.length ? rows : undefined;
			} catch {
				return undefined;
			}
		},
	};
}
export type BoardSeam = ReturnType<typeof boardSeam>;

const MIN = 60_000;
/** `12 min ago`, `3 h ago`, `2 d ago`. */
export function agoText(ms: number): string {
	const n = Math.max(0, ms);
	return n < MIN ? "under 1 min ago" : n < 60 * MIN ? `${Math.floor(n / MIN)} min ago` : n < 24 * 60 * MIN ? `${Math.floor(n / (60 * MIN))} h ago` : `${Math.floor(n / (24 * 60 * MIN))} d ago`;
}
/** The done count of a row: an auto line's own count, else its items. None when there is nothing to count. */
export function doneCount(r: Pick<BoardViewRow, "items" | "count">): { done: number; total: number } | undefined {
	if (r.count) return r.count;
	return r.items.length ? { done: r.items.filter((i) => i.done).length, total: r.items.length } : undefined;
}

/** `/boss board`: the rows as text, one line each: `workspace › tab · main · state · now · n/m · age`, with `stale` marked (an ended row says so as its state). */
export function boardText(rows: BoardViewRow[], now: number): string {
	if (!rows.length) return "The work board is empty: no main has joined and no line is left.";
	const stale = rows.filter((r) => r.stale).length, ended = rows.filter((r) => r.state === "ended").length, bare = rows.filter((r) => r.now === undefined && r.state !== "ended").length;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`, notes = [stale && `${stale} idle over 2 h`, ended && `${ended} ended`, bare && `${plural(bare, "main")} wrote none`].filter(Boolean);
	const head = `Work board: ${plural(rows.length - bare, "line")}${notes.length ? ` (${notes.join(", ")})` : ""}`;
	const lines = rows.map((r) => {
		const count = doneCount(r);
		return [[r.workspace, r.tab].filter(Boolean).join(" › "), r.main || r.session.slice(0, 8), ...(r.role ? ["train"] : []), r.state, r.now ?? "no line", ...(count ? [`${count.done}/${count.total}`] : []), ...(r.updated !== undefined ? [agoText(now - r.updated)] : []), ...(r.stale ? ["stale"] : [])].filter(Boolean).join(" · ");
	});
	return [head, ...lines].join("\n");
}
