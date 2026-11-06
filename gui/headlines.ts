import { fieldsOf } from "../src/headerfields.ts";
import type { Item } from "../src/items.ts";
import { m } from "./paraglide/messages.js";
import { bossTurn, eventTurn, heard } from "./towerturns.ts";

// The lines under Zen's circle (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle). Pure: the head's history items in, its lines out; and the clock of how a line fades, from the moment it is first on screen.

/** `boss`: his words; `head`: the final words of one of its turns; `note`: a forward or a tower's answer, in one short line. `reply`: a head line whose turn answers something the boss sent. A turn that the server or a timer started is the head's own and has none, and it takes back what the boss sent that the head never answered in words; a tower's answer in between does not (it is part of the answer to him), so the head's first text after it still is the reply. */
export interface HeadLine { id: string; who: "boss" | "head" | "note"; text: string; at: number; reply?: true }

const one = (text: string) => text.replace(/\s+/g, " ").trim();
const time = (at?: string) => (at ? Date.parse(at) || 0 : 0);
/** The workspace a `tower_send` was aimed at, from its arguments; the preview may be cut, so a cut one is read by its first field. */
function targetOf(args?: string): string | undefined {
	try {
		const w = (JSON.parse(args ?? "") as { workspace?: unknown }).workspace;
		if (typeof w === "string") return one(w);
	} catch {} // cut or not JSON: read the field by its name
	return /"workspace"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args ?? "")?.[1];
}

/** All the lines of a run of history items, oldest first: the boss's turns, the final text of each of the head's turns, a note for each forward, and a note for each tower's answer to an ask. */
export function headLines(items: readonly Item[]): HeadLine[] {
	const out: HeadLine[] = [];
	let reply: HeadLine | undefined, asked = false; // the turn's last text: it is a line when the turn ends. `asked`: the boss sent something the head has not answered yet; a tower's answer in between does not take it back, a server notice or a timer does
	const end = () => (reply && (out.push(asked ? { ...reply, reply: true } : reply), (asked = false)), (reply = undefined));
	const line = (it: Item, who: HeadLine["who"], text: string, id = it.id) => text && out.push({ id, who, text, at: time(it.at) });
	for (const it of items) {
		if (it.kind === "assistant") {
			for (const t of it.tools ?? []) {
				const to = t.name === "tower_send" ? targetOf(t.args) : undefined;
				if (to) line(it, "note", m.head_forwarded({ workspace: to }), `${it.id}:${t.id}`);
			}
			const text = one(it.text ?? "");
			if (text) reply = { id: it.id, who: "head", text, at: time(it.at) };
			continue;
		}
		if (it.kind === "user") {
			end();
			const first = heard(it.text);
			if (first && first.kind !== "intercom") asked = false; // the server's or a timer's turn is the head's own: what the boss sent before it is not answered by it
			if (!first) (line(it, "boss", one(bossTurn(it.text)?.body ?? it.text ?? "")), (asked = true));
			continue;
		}
		if (it.kind !== "notice") continue;
		const turn = eventTurn(it);
		if (!turn) continue; // a notice that is no event of the server's: it ends nothing
		end();
		if (turn.kind === "boss") (line(it, "boss", one(turn.body)), (asked = true));
		else if (turn.kind === "server" || turn.kind === "timer") asked = false;
		else if (turn.kind === "intercom") {
			const fields = fieldsOf(turn.body), ask = fields?.["in-reply-to"];
			if (fields?.kind === "tower_send" && ask && fields.workspace) line(it, "note", m.head_from_tower({ workspace: fields.workspace }));
		}
	}
	end();
	return out;
}

/** Lines shown under the circle while the strip is quiet (zen.css hides the older ones), and on a phone or a window 560 px tall or less. */
export const SHOWN = 3, SHOWN_SMALL = 2;
/** Lines the strip keeps on the page: while it is awake the lines take all the height the circle leaves (zen.css `data-fill`), and the page shows as many whole ones as fit. */
export const FILL = 24;
/** A line is clear for `CLEAR_MS`, then fades over `FADE_MS` to `REST`, almost gone and still there. By rank (0 the newest) the clear level steps down a little, so the newest is the one focus; every level holds Zen's 7 : 1 (tests/zen-contrast.test.ts). */
export const CLEAR_MS = 20_000, FADE_MS = 180_000, REST = 0.16, CLEAR = [1, 0.95, 0.9] as const;
/** Opacity of a line of rank `rank` that was first on screen `age` ms ago. */
export function levelOf(rank: number, age: number): number {
	const top = CLEAR[Math.min(rank, CLEAR.length - 1)]!;
	return age <= CLEAR_MS ? top : age >= CLEAR_MS + FADE_MS ? REST : top + (REST - top) * ((age - CLEAR_MS) / FADE_MS);
}

/** The clock of the lines: when each was first on screen (this page). The page's CSS fades each line by `levelOf`'s curve from that moment (zen.css); a held line, the newest while the head waits for the boss, stays clear there. */
export function createFade(now: () => number) {
	const first = new Map<string, number>();
	const age = (id: string) => (first.has(id) ? now() - first.get(id)! : 0);
	return {
		/** The lines on screen now; one not seen before starts its clear time. */
		see: (ids: readonly string[]) => ids.forEach((id) => first.has(id) || first.set(id, now())),
		age,
		/** Whether the strip is at rest: nothing held and every one of these lines at its rest level. */
		rested: (ids: readonly string[], held: boolean) => !held && ids.every((id) => age(id) >= CLEAR_MS + FADE_MS),
		/** The moment the last of these lines gets to rest (for the one timer); none when there is nothing to wait for. */
		restAt: (ids: readonly string[], held: boolean) => (held || !ids.length ? undefined : Math.max(...ids.map((id) => (first.get(id) ?? now()) + CLEAR_MS + FADE_MS))),
	};
}
