import { BRIEF_MAX, type MainRow } from "./towerbrief.ts";

// The brief of a head run (docs/specs/2026-11-04-head-tower.md, Runs): who it is, the workspaces now, the open asks, its memory, and the last handoff note, 8,000 characters at most, built by the server and never by a model.
// When the brief has to give up characters, the memory goes first (down to its floor), then the workspaces, then the asks. The tools, the tower_done line, and the limits are never cut.

const CAPS = { workspaces: 2400, asks: 1200, row: 200, note: 1200, recap: 2000 } as const;
export const MEMORY_FLOOR = 1200;

export interface HeadWorkspace {
	label: string;
	id: string;
	folder?: string;
	/** `standing by`, `running`, `closing`, `held`, `an older tower`, or `none`. */
	tower: string;
	rows: MainRow[];
}
export interface HeadAskLine { id: string; label: string; age: string; first: string; answer?: string }
export interface HeadBriefInput {
	identity: string;
	/** `HH:MM` the run was woken, and whether the boss's word woke it (he is at the pane now). */
	woken: string;
	boss: boolean;
	chapter: { n: number; since: string; turns: number; resumed: boolean; why?: string; recap?: string[] };
	workspaces: HeadWorkspace[];
	asks: HeadAskLine[];
	memory?: string;
	/** The ids of the open waits that are lapsed (towermemory.ts `lapsed`): the page no longer shows them to the boss, so the run closes or renews them. */
	lapsed?: string[];
	note?: { text: string; age: string };
	/** The tools the run has, one line each. */
	tools: string[];
	flags: string[];
}

const cut = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join("").trimEnd()}…` : text);
const one = (text: string) => text.replace(/\s+/g, " ").trim();
const day = (iso: string) => (Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleDateString("sv") : "an unknown day");
/** Rows within a character budget, the rest counted. */
function rowsWithin(lines: string[], budget: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget - 24) break;
		out.push(line);
		used += line.length + 1;
	}
	return out.length < lines.length ? [...out, `(+${lines.length - out.length} more)`] : out;
}
/** A section cut to `limit` characters at a line, with `marker(n)` for the lines left out; when not even its first line fits, `none` stands for all of it. */
function shrink(text: string, limit: number, marker: (n: number) => string, none: string): string {
	if (text.length <= limit) return text;
	const lines = text.split("\n");
	let kept = 0, used = 0;
	while (kept < lines.length - 1 && used + lines[kept]!.length + 1 + marker(lines.length - kept).length <= limit) used += lines[kept++]!.length + 1;
	return kept > 1 ? [...lines.slice(0, kept), marker(lines.length - kept)].join("\n") : none;
}

export function buildHeadBrief(i: HeadBriefInput): string {
	const { chapter } = i;
	const who = [
		`You are the head tower: the boss's own tower, in no workspace. This session is your one conversation with the boss (chapter ${chapter.n}, since ${day(chapter.since)}, ${chapter.turns} boss turn${chapter.turns === 1 ? "" : "s"}). ${i.boss ? "The boss is at this pane now." : "The boss is away: a tower's answer woke you."} Woken ${i.woken}. Your identity is ${i.identity}; everything you send leaves under it.`,
		...(!chapter.resumed && chapter.n > 1 ? [`New chapter ${chapter.n}: ${chapter.why ?? "the last conversation could not be resumed"}.`] : []),
	].join("\n");
	const recap = !chapter.resumed && chapter.recap?.length ? ["The last lines between you and the boss, oldest first:", ...chapter.recap.map((l) => `- ${cut(one(l), 400)}`)].join("\n") : "";
	const mains = (rows: MainRow[]) => rows.map((m) => (m.main ? `  ${m.tab}: main ${m.main.name} ${m.main.state}${m.main.stale ? " [stale: idle, not updated for over 2 hours]" : ""}${m.main.now ? `; now: ${m.main.now}` : ""}${m.main.open ? ` (${m.main.open} open)` : ""}` : `  ${m.tab}: no main`));
	const wsLines = i.workspaces.flatMap((w) => [`- ${w.label} (${w.id})${w.folder ? `, ${w.folder}` : ""}: ${w.tower === "none" ? "no tower" : `tower ${w.tower}`}`, ...mains(w.rows).slice(0, 6).map((l) => cut(l, CAPS.row))]);
	const workspaces = ["Workspaces now:", ...(wsLines.length ? rowsWithin(wsLines, CAPS.workspaces) : ["- none open: ask the boss to open the project's workspace"])].join("\n");
	const askLines = i.asks.map((a) => `- ${a.id} ${a.label}, ${a.age}: ${cut(one(a.first), 120)}${a.answer ? ` → ${cut(one(a.answer), 100)}` : ""}`);
	const asks = askLines.length ? ["Open asks:", ...rowsWithin(askLines, CAPS.asks)].join("\n") : "";
	const lapsed = i.lapsed?.length ? `Lapsed waits (the boss no longer sees them on the page): ${i.lapsed.join(", ")}. Resolve each with tower_memory resolve, or ask the boss again with a new due.` : "";
	const note = i.note ? [`Handoff note from the last run (${i.note.age} ago):`, cut(i.note.text, CAPS.note)].join("\n") : "";
	const tools = cut(["Tools:", ...i.tools, "Call tower_done with a handoff note when nothing is left for you."].join("\n"), 3600);
	const limits = [...i.flags, i.boss ? "The boss is in this run: stay and answer them; it ends when they leave or are silent for 10 minutes." : "A run woken by a tower's answer ends after 20 minutes; with the boss away, tell him in one line and call tower_done."].join("\n");
	const parts: Record<string, string> = { recap, workspaces, asks, memory: i.memory ?? "", lapsed, note };
	const size = () => [who, ...Object.values(parts), tools, limits].filter(Boolean).join("\n\n").length;
	const MORE = (n: number) => `(+${n} more)`;
	const pass = (name: string, floor: number, marker: (n: number) => string, none: string) => {
		const over = size() - BRIEF_MAX;
		if (over > 0 && parts[name]) parts[name] = shrink(parts[name]!, Math.max(floor, parts[name]!.length - over), marker, none);
	};
	const memoryMarker = (n: number) => `(+${n} more lines in memory: tower_memory read)`, memoryNone = "Memory: left out to fit the brief; call tower_memory read.";
	pass("memory", MEMORY_FLOOR, memoryMarker, memoryNone);
	pass("workspaces", 0, MORE, "Workspaces now: left out to fit the brief; call tower_list.");
	pass("asks", 0, MORE, "Open asks: left out to fit the brief.");
	pass("memory", 0, memoryMarker, memoryNone);
	return cut([who, parts.recap, parts.workspaces, parts.asks, parts.memory, parts.lapsed, parts.note, tools, limits].filter(Boolean).join("\n\n"), BRIEF_MAX);
}

/** The tools of a head run, one line each (the fixed text of the brief). */
export const HEAD_TOOLS = [
	"- tower_send {workspace, message}: forward to the tower of one workspace (id or exact label); a workspace with no tower is given one. It opens an ask (H<n>); the tower's answer comes back as a new event. You have no broadcast, no device, and no way to open a main or a tab.",
	"- tower_list: every workspace's tower and its checkout folder; board_read: what each main works on now; read, grep, find, ls: project files by absolute path.",
	"- tower_memory keeps what outlives runs: the boss's standing instructions and decisions are proposals the boss confirms; your waits are yours (add, resolve, drop). boss_server: the sb server's status, log, and restart.",
];
