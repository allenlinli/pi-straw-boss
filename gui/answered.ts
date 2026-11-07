import { get } from "./post.ts";
import { type Fields, lockFor } from "./blocklock.ts";

// The server's record of which chat blocks were answered, for a unit (docs/specs/2026-11-07-better-show-host.md, "Answered"): read when a log is drawn, so a reload, another device, and another address of this computer all show the same locks. One request is shared by every message
// drawn together, and a later drawing reads it again when the last read is older than a few seconds. A document's blocks come with its text instead (doc.ts). A record that cannot be read leaves the blocks open with a note that says so: the server still refuses a block it knows
// is answered.

export interface Record_ { done: [string, number, Fields][]; pending: [string, number][]; unreadable?: boolean }
/** The read, replaceable by a test or the demo. */
export const answeredHooks: { get?(key: string): Promise<Record_ | undefined> } = {};
const FRESH_MS = 3000;
const reads = new Map<string, { at: number; read: Promise<boolean> }>();
/** The entries each unit's last record named: one that a later record names no more is told so (an empty seed), so a block shown as on its way opens again. */
const named = new Map<string, Set<string>>();
export const forgetAnswered = () => (reads.clear(), named.clear());

async function load(key: string): Promise<boolean> {
	try {
		const record = answeredHooks.get ? await answeredHooks.get(key) : await get(`answered/${encodeURIComponent(key)}`).then((r) => (r.ok ? (r.body as unknown as Record_) : undefined));
		if (!record || !Array.isArray(record.done) || !Array.isArray(record.pending)) return false;
		const by = new Map<string, { done: [number, Fields][]; pending: number[] }>(), of = (entry: string) => by.get(entry) ?? (by.set(entry, { done: [], pending: [] }), by.get(entry)!);
		for (const [entry, index, fields] of record.done) of(entry).done.push([index, fields]);
		for (const [entry, index] of record.pending) of(entry).pending.push(index);
		for (const entry of named.get(key) ?? []) if (!by.has(entry)) lockFor(key, entry).seed({ done: [], pending: [] });
		for (const [entry, seed] of by) lockFor(key, entry).seed(seed);
		named.set(key, new Set(by.keys()));
		return !record.unreadable;
	} catch {
		return false;
	}
}

/** Reads the unit's record into the page's locks; false when it could not be read. */
export function readAnswered(key: string): Promise<boolean> {
	const had = reads.get(key);
	if (had && Date.now() - had.at < FRESH_MS) return had.read;
	const read = load(key);
	reads.set(key, { at: Date.now(), read });
	return read;
}
