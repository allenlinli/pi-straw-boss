// What the remote (operate) base's lazy part (gui/box.ts) reads from a box: the sentence an ended base gets, the one form of key a route is built from, and the rows of Earlier runs. Everything a box says is untrusted: the controller's bridge has already held it to a schema, and this module still reads defensively.

export type EndedKind = "revoked" | "refused" | "other";
const REVOKED = new Set(["policy", "roster"]), REFUSED = new Set(["not-granted", "not-admin", "out-of-scope", "local-only"]);
/** Which of the three sentences an ended base gets (the word is the bridge's, from a fixed set; any other reads as a plain end). */
export const endedKind = (why: string | undefined): EndedKind => (why !== undefined && REVOKED.has(why) ? "revoked" : why !== undefined && REFUSED.has(why) ? "refused" : "other");

/** A page key the controller made for a box's unit or finished run: `x` and 16 hex. It is the only thing a route is built from. */
export const safeKey = (key: unknown): key is string => typeof key === "string" && /^x[0-9a-f]{16}$/.test(key);

export interface RunRow { key: string; name: string; role: string; workspace: string; first: number; last: number; size: number; dispatcher?: string }
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** The rows of `GET api/transcripts` (a page of at most 50, newest first) and the cursor for the next page. A row that is not the controller's own form is dropped. */
export function runRows(reply: unknown): { rows: RunRow[]; before?: string } {
	const r = typeof reply === "object" && reply !== null ? (reply as { rows?: unknown; before?: unknown }) : {}, rows: RunRow[] = [];
	for (const v of Array.isArray(r.rows) ? r.rows.slice(0, 50) : []) {
		const x = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
		if (!safeKey(x.key) || !text(x.name, 200) || !text(x.role, 40) || typeof x.workspace !== "string" || x.workspace.length > 200 || !num(x.first) || !num(x.last) || !num(x.size)) continue;
		rows.push({ key: x.key, name: x.name, role: x.role, workspace: x.workspace, first: x.first, last: x.last, size: x.size, ...(text(x.dispatcher, 100) ? { dispatcher: x.dispatcher } : {}) });
	}
	return { rows, ...(text(r.before, 200) ? { before: r.before } : {}) };
}
