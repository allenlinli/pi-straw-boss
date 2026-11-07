import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type Json, parse, toItem } from "../items.ts";
import type { HeadAskRow, HeadSeam } from "../nethead.ts";
import { groupsOf, openAsks, readAsks } from "./headasks.ts";
import { readChapters } from "./headchapters.ts";
import { headId, type Slot } from "./record.ts";

// What the net needs of the server to show the head tower (docs/specs/2026-11-04-head-tower.md, The GUI channel, Snapshot): its key, its asks, its chapters, and when it last said something.

/** The most asks the snapshot carries: the newest whole broadcasts (the page folds a group into one row, so a group is never cut). */
const ASKS = 60;
/** How far from the end of a conversation file the newest assistant text is looked for. */
const TAIL = 65_536;

/** The time of the newest assistant message with text in the last bytes of a session file; undefined when it has none or cannot be read. */
function lastSaid(file: string): number | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const { size } = statSync(file), start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const rows = buf.toString("utf8").split("\n");
		if (start) rows.shift();
		for (const raw of rows.reverse()) {
			if (!raw.includes('"assistant"')) continue;
			const entry: Json | undefined = parse(raw), item = entry && toItem(entry, raw.length), at = item?.kind === "assistant" && item.text ? Date.parse(item.at ?? "") : NaN;
			if (Number.isFinite(at)) return at;
		}
	} catch {
		// a file that is not there yet, or that cannot be read, has said nothing
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return undefined;
}

export function headSeam(slot: Slot, now: () => number): HeadSeam {
	// The conversation file is read again only when it changed: the net is read every two seconds.
	const seen = new Map<string, { sig: string; at: number | undefined }>();
	return {
		key: headId(slot),
		asks: (): HeadAskRow[] => {
			const open = new Set(openAsks(slot, now()).map((a) => a.id)), all = readAsks(slot, now()), groups = groupsOf(all), kept = new Set<string>();
			// The newest groups, whole, while they fit (the newest one always does).
			let used = 0;
			const sizes = new Map<string, number>();
			for (const a of all) sizes.set(groups.get(a.id)!, (sizes.get(groups.get(a.id)!) ?? 0) + 1);
			for (const g of [...new Set(all.map((a) => groups.get(a.id)!))].reverse()) {
				if (used && used + sizes.get(g)! > ASKS) break;
				used += sizes.get(g)!;
				kept.add(g);
			}
			return all.filter((a) => kept.has(groups.get(a.id)!)).map((a) => {
				const replaced = a.supersedes ? groups.get(a.supersedes) ?? a.supersedes : undefined, state: HeadAskRow["state"] = a.answers.length ? "answered" : a.acted !== undefined ? "handled" : a.read !== undefined ? "received" : open.has(a.id) ? "waiting" : "silent";
				return { id: a.id, group: groups.get(a.id)!, workspace: a.workspace, label: a.label, since: a.at, at: a.last, first: a.first, state, answers: a.answers.length, ...(a.answers.at(-1) ? { last: a.answers.at(-1)!.first } : {}), ...(a.sent ? { sent: a.sent } : {}), ...(a.boss ? { boss: a.boss } : {}), ...(replaced && replaced !== groups.get(a.id) ? { supersedes: replaced } : {}) };
			});
		},
		chapters: () => readChapters(slot),
		said: (file) => {
			if (!file) return undefined;
			try {
				const s = statSync(file), sig = `${s.size}:${s.mtimeMs}`, kept = seen.get(file);
				if (kept?.sig === sig) return kept.at;
				const at = lastSaid(file);
				seen.set(file, { sig, at });
				return at;
			} catch {
				return undefined;
			}
		},
	};
}
