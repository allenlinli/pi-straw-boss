import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The bases the page opened by an opening id (spawn.ts `open/base` with a `deploy`), kept in openings.json (mode 600) so the id outlives a server restart: a client that retries an
// open the old server was still serving finds the workspace that open made, instead of making a second one for the same folder. The last few are kept; a record whose workspace
// is gone is the caller's to drop (it is only a lead, Herdr says what exists).

export interface Opening { workspace: string; tab: string; pane: string }
const KEPT = 64, str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function createOpenings(file?: string) {
	const kept = new Map<string, Opening>();
	try {
		const saved = file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		if (saved && typeof saved === "object") for (const [id, o] of Object.entries(saved as Record<string, Partial<Opening>>)) if (str(o?.workspace) && str(o.tab) && str(o.pane)) kept.set(id, { workspace: o.workspace, tab: o.tab, pane: o.pane });
	} catch {} // no file or one that does not read: nothing is known, as for a first start
	const save = () => {
		if (!file) return;
		const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(temp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600, flag: "wx" });
			renameSync(temp, file);
		} catch (failure) {
			rmSync(temp, { force: true });
			throw failure; // an open whose id cannot be kept would be made twice by a retry: the open fails instead
		}
	};
	return {
		get: (id: string) => kept.get(id),
		set(id: string, opening: Opening) {
			kept.delete(id);
			kept.set(id, opening);
			for (const old of kept.keys()) if (kept.size > KEPT) kept.delete(old);
			save();
		},
		drop(id: string) {
			if (kept.delete(id)) save();
		},
	};
}
export type Openings = ReturnType<typeof createOpenings>;
