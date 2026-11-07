import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { allyLabel } from "../boardauto.ts";
import { canonical } from "../history.ts";
import type { Found, Ref } from "../net.ts";
import type { Transcripts } from "../watch.ts";
import type { Owner, Scope } from "./operatescope.ts";
import { isHeadKey, UNIT_ROLES } from "./operateroles.ts";
import { writeDurableText } from "./towerstore.ts";

// The transcripts of finished runs (docs/specs/2026-11-07-link-operate.md §9). The net shows a session for 10 minutes after it ends, so no list reaches back further; the box's server therefore keeps `link/operate-ledger.jsonl`, mode 600
// and append-only: one line the first time a unit with a session file is seen (with its owner, §4), one when a live run's owner reads differently (the owner is read from records that are written one after the other, so the first reading may be early), one when it ends, and one when a resumed unit is seen live again. A line holds no content: the owner, who dispatched it, its role, a scrubbed
// name and workspace label, the path of its session file (the box keeps it; it never leaves), and when it was first and last seen. Compacted at start: lines folded into one row per session file, 30 days, at most 2,000 rows.
//
// What a request names is a key `t<id>`, `id` being 16 hex of a hash of the file's path. The box looks the id up in the ledger and never takes a path from the request; the row's scope is checked again on every read, and the file must
// still be a regular `.jsonl` inside pi's session folder (a row of a tampered ledger that points elsewhere is not read). Reading is `history.ts`, as for a live unit: the same paging and 2 KB previews, through `watch.ts`'s `api`.

/** How long a row is kept, and how many: both applied when the ledger is opened. */
export const KEEP_MS = 30 * 24 * 3_600_000, MAX_ROWS = 2000, MAX_LIST = 50;
const ID = /^[0-9a-f]{16}$/, KEY = /^t([0-9a-f]{16})$/, CURSOR = /^(\d{1,16}):([0-9a-f]{16})$/, DEVICE = /^[a-z2-7]{26}$/, TEAM = /^[A-Za-z0-9_-]{1,64}$/;
/** What a ledger row says of an owner, in place of `{ box: true }`: no team id is the word `box`. */
const BOX = "box";
/** The role of the head tower's units, which no scope reaches (operateroles.ts `isHeadKey`). */
const HEAD = "head";

/** One session file as the ledger knows it. `team` is the owning team's id, or `box`; `ended` is set while the latest line says the unit is over. */
export interface Row { id: string; team: string; device?: string; role: string; name: string; workspace: string; file: string; first: number; last: number; ended?: true }
/**
 * A unit of a net reading, as `observe` takes it: only one with a session file is kept. `live: false` is a unit the net still shows but whose run is over (a finished subagent). `owner` is none while the reading cannot say whose it is yet
 * (operatescope.ts `ownerOf` with `settled`): such a unit is present, so its row does not end, but no row is made for it and none changes owner.
 */
export interface Seen { role: string; name: string; workspace: string; file: string; owner?: Owner; device?: string; live?: boolean }
export const transcriptKey = (id: string) => `t${id}`;
/** The id a session file is known by: the first 8 bytes of a hash of its path, as hex. */
export const idOf = (file: string) => createHash("sha256").update("straw-link/operate-ledger/1\0").update(file).digest("hex").slice(0, 16);

export interface LedgerDeps {
	/** `link/operate-ledger.jsonl`. */
	file: string;
	/** pi's session folder: a transcript is read only from inside it. */
	root: string;
	now(): number;
	/** The label of a device on the roster, for the list's `dispatcher`; none for a device it does not know. */
	label?(device: string): string | undefined;
	/** A write that failed: the ledger keeps what it knows in memory and goes on (a ledger must not stop the net's reading). */
	failed?(error: unknown): void;
}

const isRow = (v: unknown): v is Row => {
	const r = v as Partial<Row> | null;
	return typeof r === "object" && r !== null && typeof r.id === "string" && ID.test(r.id) && typeof r.team === "string" && (r.team === BOX || TEAM.test(r.team)) && (r.device === undefined || (typeof r.device === "string" && DEVICE.test(r.device)))
		&& typeof r.role === "string" && (UNIT_ROLES as readonly string[]).includes(r.role) && typeof r.name === "string" && r.name.length <= 200 && typeof r.workspace === "string" && r.workspace.length <= 200 && typeof r.file === "string" && r.file.length > 0 && r.file.length <= 4096
		&& Number.isSafeInteger(r.first) && Number.isSafeInteger(r.last) && (r.ended === undefined || r.ended === true) && idOf(r.file) === r.id;
};
const text = (row: Row) => `${JSON.stringify(row)}\n`;

/** The ledger's lines folded into one row per id: the first line's role, names and file stand; the latest line's owner, device, `last` and `ended` do (a line is written whenever the owner of a live run changes, and never after its end line). A line that is not a row is dropped. */
function fold(source: string): { rows: Map<string, Row>; lines: number } {
	const rows = new Map<string, Row>();
	let lines = 0;
	for (const line of source.split("\n")) {
		if (!line) continue;
		lines++;
		let found: unknown;
		try { found = JSON.parse(line); } catch { continue; }
		if (!isRow(found)) continue;
		const old = rows.get(found.id), { ended: _ended, ...rest } = found;
		rows.set(found.id, old ? { ...(({ ended: _o, device: _d, ...base }) => base)(old), ...(old.ended ? { team: old.team, ...(old.device ? { device: old.device } : {}) } : { team: found.team, ...(found.device ? { device: found.device } : {}) }), first: Math.min(old.first, found.first), last: Math.max(old.last, found.last), ...(found.ended ? { ended: true as const } : {}) } : { ...rest, ...(found.ended ? { ended: true as const } : {}) });
	}
	return { rows, lines };
}
const order = (a: Row, b: Row) => b.last - a.last || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** A `file` inside `root`, by its real path a regular `.jsonl` with no other hard link, checked on an open handle (no symlink at the last step, and no wait on a pipe) whose device and inode are those of the real path; none for anything else. A reader opens the path again, without following a link at its last step (history.ts). */
function readable(file: string, root: string): { real: string; size: number } | undefined {
	const real = canonical(file), top = canonical(root);
	if (!real || !top || !real.endsWith(".jsonl") || !real.startsWith(top + sep)) return undefined;
	let fd: number | undefined;
	try {
		fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const s = fstatSync(fd), at = statSync(real);
		return s.isFile() && s.nlink === 1 && s.dev === at.dev && s.ino === at.ino ? { real, size: s.size } : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export interface Ledger {
	/** A net reading: every unit with a session file is written when first seen; a unit missing from the reading, or marked not live, ends. Pass the box's whole reading, not a scope's slice. */
	observe(units: Iterable<Seen>): void;
	/** The transcripts a scope reaches, for the hub of an operate session. `scope` is read at every call, so a roster or policy change takes effect at the next one. */
	within(scope: () => Scope): Transcripts;
	/** The rows now, newest first (a copy). */
	rows(): Row[];
}

/** Opens the ledger: reads and compacts the file (30 days, 2,000 rows, one line per row, rewritten whole only when something changed), and appends from here on. */
export function openLedger(d: LedgerDeps): Ledger {
	const failed = d.failed ?? (() => {});
	let source = "";
	try { source = readFileSync(d.file, "utf8"); } catch { /* none yet */ }
	const { rows, lines } = fold(source), at = d.now();
	// The head tower is nobody's (RR-F001): a 0.62.x or 0.63.x box filed its chapters as the box's own. Such rows are not loaded, so no list, lookup or owner memory holds one, and the next compaction leaves them out of the file.
	for (const [id, r] of rows) if (r.role === HEAD) rows.delete(id);
	// Who owned every session the ledger has ever held, kept after its row left the book (30 days, the 2,000 cap): a session seen again keeps that owner, never the one of the moment (review OL-F004).
	const owners = new Map([...rows.values()].map((r) => [r.id, { team: r.team, device: r.device }] as const));
	try { chmodSync(d.file, 0o600); } catch { /* none yet */ } // an append sets a mode only on create
	const kept = [...rows.values()].filter((r) => at - r.last <= KEEP_MS).sort(order).slice(0, MAX_ROWS);
	if (kept.length !== rows.size || lines !== rows.size || (source && !source.endsWith("\n"))) {
		try {
			mkdirSync(dirname(d.file), { recursive: true, mode: 0o700 });
			writeDurableText(d.file, kept.slice().reverse().map(text).join(""));
		} catch (error) { failed(error); }
	}
	const book = new Map(kept.map((r) => [r.id, r] as const));
	const write = (row: Row) => {
		try {
			mkdirSync(dirname(d.file), { recursive: true, mode: 0o700 });
			appendFileSync(d.file, text(row), { mode: 0o600 });
		} catch (error) { failed(error); }
	};
	const put = (row: Row) => { book.set(row.id, row); owners.set(row.id, { team: row.team, device: row.device }); write(row); };
	const clean = (v: string) => allyLabel(v, 60, d.root);

	function observe(units: Iterable<Seen>): void {
		const at = d.now(), live = new Set<string>();
		for (const u of units) {
			if (!u.file || u.role === HEAD) continue;
			const file = canonical(u.file) ?? u.file, id = idOf(file), old = book.get(id), over = u.live === false;
			if (!old) {
				const prior = owners.get(id), mine = u.owner && ("team" in u.owner ? u.owner.team : BOX);
				if (!prior && !mine) continue; // whose it is cannot be said yet: it is not the box's, nor a team's, so it has no row until a reading can say (its run is then seen from there on)
				const team = prior?.team ?? mine!, device = prior ? prior.device : u.device;
				if (team !== BOX && !TEAM.test(team)) continue;
				const row: Row = { id, team, ...(device && DEVICE.test(device) ? { device } : {}), role: (UNIT_ROLES as readonly string[]).includes(u.role) ? u.role : "main", name: clean(u.name), workspace: clean(u.workspace), file, first: at, last: at };
				put(row);
				if (over) put({ ...row, ended: true });
				else live.add(id);
			} else if (over) {
				if (!old.ended) put({ ...old, last: at, ended: true });
			} else {
				live.add(id);
				const { ended: _ended, ...base } = old;
				if (old.ended) put({ ...base, last: at }); // seen live again: a resumed session keeps the owner it ended with
				else {
					// A live run's owner is read again at each reading until it ends: the first one may have come before the records that say whose it is (review OW-F004). A reading that cannot say changes nothing, and a team's run is never
					// moved to the box's by a reading (the box part of a session reaches a wider book than a team's admin does).
					const team = u.owner && ("team" in u.owner ? u.owner.team : BOX), device = u.device && DEVICE.test(u.device) ? u.device : undefined;
					if (team !== undefined && (team === BOX ? old.team === BOX : TEAM.test(team)) && (team !== old.team || (device !== undefined && device !== old.device))) {
						const { device: _device, ...rest } = base;
						put({ ...rest, team, ...(device ? { device } : {}), last: at });
					} else book.set(id, { ...old, last: at }); // `last` moves in memory; the end line carries it
				}
			}
		}
		for (const old of [...book.values()]) if (!old.ended && !live.has(old.id)) put({ ...old, ended: true });
		// Bounded in memory as in the file: the oldest finished rows go (the file is compacted at the next start).
		if (book.size > MAX_ROWS) for (const old of [...book.values()].filter((r) => r.ended).sort(order).reverse().slice(0, book.size - MAX_ROWS)) book.delete(old.id);
	}

	const sorted = (scope: Scope) => [...book.values()].filter((r) => (r.team === BOX ? scope.box : scope.teams.includes(r.team))).sort(order);
	const row = (key: string, scope: Scope): Row | undefined => {
		const id = KEY.exec(key)?.[1], found = id ? book.get(id) : undefined;
		return found && (found.team === BOX ? scope.box : scope.teams.includes(found.team)) ? found : undefined;
	};
	return {
		observe,
		rows: () => [...book.values()].sort(order),
		within(at) {
			return {
				has: (key) => Boolean(row(key, at())),
				lookup(key): Found | undefined {
					const found = row(key, at()), file = found && readable(found.file, d.root);
					return found && file ? { key, base: found.workspace, name: found.name, role: found.role, file: file.real, live: false } satisfies Found : undefined;
				},
				list: async (query) => {
					const scope = at(), raw = query.get("before"), cut = raw === null ? undefined : CURSOR.exec(raw);
					if (raw !== null && !cut) return { status: 400, body: { error: "bad_request", reason: "`before` is the cursor a page gave." } };
					const want = Math.min(MAX_LIST, Math.max(1, Math.floor(Number(query.get("limit"))) || MAX_LIST)), out: unknown[] = [];
					let more = false, last: Row | undefined;
					for (const r of sorted(scope)) {
						if (cut && !(r.last < Number(cut[1]) || (r.last === Number(cut[1]) && r.id < cut[2]!))) continue;
						const file = readable(r.file, d.root);
						if (!file) continue; // a file that is gone, or no longer where pi keeps sessions, is no row
						if (out.length === want) { more = true; break; }
						const dispatcher = r.device ? d.label?.(r.device) : undefined;
						out.push({ id: r.id, name: r.name, role: r.role, workspace: r.workspace, ...(dispatcher ? { dispatcher: clean(dispatcher) } : {}), first: r.first, last: r.last, size: file.size });
						last = r;
					}
					return { status: 200, body: { rows: out, ...(more && last ? { before: `${last.last}:${last.id}` } : {}) } };
				},
			};
		},
	};
}

/** The units of a net reading that have a session file, for `observe`: `refs` are the registry's entries (every unit the net holds), `owner` is operatescope.ts's reading of whose a unit is (settled: none while it cannot be said), and `device` the dispatcher of a unit (dispatcher.ts). A unit whose owner cannot be said is still in the reading, so its row does not end. */
export function seenFrom(d: { refs: Iterable<Ref>; workspace(base: string): string; owner(key: string): Owner | undefined; device(key: string): string | undefined; live?(key: string): boolean }): Seen[] {
	const out: Seen[] = [];
	for (const r of d.refs) {
		if (isHeadKey(r.key)) continue; // the head tower leaves no ledger row (RR-F001)
		const owner = r.file ? d.owner(r.key) : undefined;
		if (r.file) out.push({ role: r.role, name: r.name, workspace: d.workspace(r.base), file: r.file, ...(owner ? { owner } : {}), ...(d.device(r.key) ? { device: d.device(r.key)! } : {}), ...(d.live && !d.live(r.key) ? { live: false } : {}) });
	}
	return out;
}
