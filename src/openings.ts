import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJson } from "./server/record.ts";

// The bases the page opened by an opening id (spawn.ts `open/base` with a `deploy`), kept in openings.json (mode 600) so the id outlives a server restart: a client that retries an
// open the old server was still serving finds the workspace that open made, instead of making a second one for the same folder. The last few are kept; a record whose workspace
// is gone is the caller's to drop (it is only a lead, Herdr says what exists, and it reuses ids).

/** Where the first message stands: `none` (the open had none), `pending` (never attempted), `sending` (being typed: it may have arrived), `sent`. */
export type Delivery = "none" | "pending" | "sending" | "sent";
export interface Opening { workspace: string; tab: string; pane: string; dir: string; label: string; delivery: Delivery }
const KEPT = 64, str = (v: unknown): v is string => typeof v === "string" && v.length > 0, DELIVERY = ["none", "pending", "sending", "sent"];

export function createOpenings(file?: string) {
	const kept = new Map<string, Opening>();
	try {
		const saved = file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		if (saved && typeof saved === "object") {
			for (const [id, o] of Object.entries(saved as Record<string, Partial<Opening>>)) {
				if (str(o?.workspace) && str(o.tab) && str(o.pane) && str(o.dir) && str(o.label) && DELIVERY.includes(o.delivery as string)) kept.set(id, { workspace: o.workspace, tab: o.tab, pane: o.pane, dir: o.dir, label: o.label, delivery: o.delivery as Delivery });
			}
		}
	} catch {} // no file or one that does not read: nothing is known, as for a first start
	const save = () => {
		if (!file) return;
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeJson(file, Object.fromEntries(kept)); // an open whose id cannot be kept would be made twice by a retry: the failure reaches the open
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
		/** Forgets the records whose workspace is not in `open`: Herdr reuses the ids of closed workspaces, so a record left behind could name an unrelated one later. */
		prune(open: ReadonlySet<string>) {
			let changed = false;
			for (const [id, o] of kept) if (!open.has(o.workspace)) (kept.delete(id), (changed = true));
			if (changed) save();
		},
	};
}
export type Openings = ReturnType<typeof createOpenings>;
