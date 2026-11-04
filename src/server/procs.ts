import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCwd, inodeOnDisk, readCwds, type Cwd } from "../procs/cwd.ts";
import { reap as realReap, type KillReport } from "../procs/kill.ts";
import { killSet, type Owned, type Place, type Protect } from "../procs/killset.ts";
import { readOwners } from "../procs/marker.ts";
import { baseName, descendants, isOrphan, readTable, refOf, sameProc, type Proc, type Ref } from "../procs/table.ts";
import { type Checkout, checkoutOf, under } from "../procs/worktree.ts";
import { startOf } from "../startof.ts";
import { writeJson } from "./record.ts";

// The owner registry and the reaper of the server (docs/specs/2026-11-04-procs.md B, C; plan sb-procs-plan.md): a worker's pi says hello with its pid and start time, the worktree it works in, and its pane; every
// tick the server writes down the descendants of each live owner by (pid, start time); when an owner ends (bye, its pid gone or reused, or Herdr says its pane and terminal closed) what it left is killed by
// the kill sequence of src/procs/kill.ts: the snapshot, the processes that carry its marker, and the orphans that work in its worktree, minus the protected set. Records survive a server restart in
// `<slot dir>/procs/owners.json` (mode 600), so a worker that ended while the server was down is still reaped.
// Nothing here logs or returns a command line or an environment. Every signal goes through the kill sequence, and so through the test kill guard.

export const OWNERS_FILE = "owners.json";
export const TICK_MS = 10_000, SLOW_TICK_MS = 30_000, SLOW_AFTER_MS = 1000;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
/** The most descendants one owner's snapshot keeps. */
const SNAPSHOT_MAX = 2000;

/** What a worker's pi says about itself. */
export interface Hello { pid: number; started?: string; id?: string; subagentId?: string; sessionFile?: string; pane?: string; terminal?: string; cwd?: string }
export interface OwnerRecord {
	id: string; pid: number; started: string; roots: string[]; snapshot: Ref[]; subagentId?: string; pane?: string; terminal?: string; cwd?: string; helloAt: number; seenAt: number;
	/** Set once the owner has ended and something of it was left alive: the record stays so `reap` can try again. */
	ended?: { at: number; reason: string };
}
export interface PaneEvent { event: string; data: Record<string, unknown> }
export interface ProcsDeps {
	/** The folder of the slot (`slot.dir`); the registry keeps its files in `procs/` below it. */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	/** The process table now (the account's own processes); undefined where there is none. A failed read throws. */
	read?: () => Promise<Proc[] | undefined>;
	cwds?: (pids: readonly number[]) => Promise<Map<number, Cwd>>;
	markers?: (pids: readonly number[]) => Promise<Map<number, string>>;
	inode?: (path: string) => string | null;
	checkout?: (cwd: string) => Checkout;
	/** The start time of a pid now (the identity of an owner). */
	startOf?: (pid: number) => string | undefined;
	/** What is never signalled besides the other live owners: the Herdr server, live panes' shells and foregrounds, sb servers, the intercom broker. Read at each reap. */
	protect?: (table: readonly Proc[]) => Promise<Protect[]>;
	/** The pane ids Herdr lists now with their terminal; how a pane event without a terminal is told from a reused id. Throwing means unknown. */
	panes?: () => Promise<{ pane_id: string; terminal_id?: string }[]>;
	/** The kill sequence. */
	reap?: (refs: readonly Ref[]) => Promise<KillReport>;
	/** Pids that must outlive any reap: this server. */
	self?: number[];
	ownUid?: number;
	platform?: NodeJS.Platform;
}
export interface ReapResult { owner: string; reason: string; targets: number; termed: number; killed: number; skipped: number; left: { pid: number; comm: string }[]; spared: number }
export interface OwnerRow { id: string; pid: number; started: string; live: boolean; roots: string[]; snapshot: number; pane?: string; subagentId?: string; endedReason?: string }
export interface Procs {
	/** Loads the records, reaps the owners that ended while the server was down, and takes the first tick (its cost is logged once). */
	start(): Promise<void>;
	hello(hello: Hello): Promise<{ id: string }>;
	beat(id: string): boolean;
	/** The owner says it is leaving: it ends now and its reap runs behind this call (`settled()` waits for it). */
	bye(id: string): boolean;
	tick(): Promise<void>;
	/** A Herdr pane event (`pane.exited`, `pane.closed`); anything else is ignored. */
	paneEvent(event: PaneEvent): Promise<void>;
	list(): OwnerRow[];
	reapOwner(id: string): Promise<ReapResult>;
	/** Reaps what is left in a checkout; refuses while a live owner works there. */
	reapCheckout(path: string): Promise<ReapResult>;
	/** How long the next tick should wait: 10 s, or 30 s after a first tick that cost more than a second. */
	tickMs(): number;
	/** Resolves once every reap started so far has finished. */
	settled(): Promise<void>;
}

export class ProcsRefusal extends Error {}

export function createProcs(d: ProcsDeps): Procs {
	const folder = join(d.dir, "procs"), file = join(folder, OWNERS_FILE);
	const read = d.read ?? (() => readTable()), cwdsOf = d.cwds ?? ((pids) => readCwds(pids)), markersOf = d.markers ?? ((pids) => readOwners(pids));
	const inode = d.inode ?? inodeOnDisk, checkout = d.checkout ?? checkoutOf, probe = d.startOf ?? startOf, reap = d.reap ?? ((refs) => realReap(refs));
	const platform = d.platform ?? process.platform, self = d.self ?? [process.pid];
	const owners = new Map<string, OwnerRecord>();
	const pending = new Set<Promise<unknown>>();
	let tickEvery = TICK_MS, ticking: Promise<void> | undefined;

	const save = () => {
		mkdirSync(folder, { recursive: true, mode: 0o700 });
		writeJson(file, { v: 1, owners: [...owners.values()] });
	};
	const load = () => {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { owners?: unknown };
			for (const r of Array.isArray(parsed.owners) ? parsed.owners : []) {
				const o = r as Partial<OwnerRecord>;
				if (typeof o?.id === "string" && ID.test(o.id) && Number.isSafeInteger(o.pid) && typeof o.started === "string" && Array.isArray(o.roots) && Array.isArray(o.snapshot)) {
					owners.set(o.id, { ...(o as OwnerRecord), snapshot: o.snapshot.filter((s: Ref) => Number.isSafeInteger(s?.pid) && typeof s?.started === "string") });
				}
			}
		} catch { /* none yet, or unreadable: the registry starts empty and the next hello makes the file */ }
	};
	const owned = (r: OwnerRecord): Owned => ({ id: r.id, pid: r.pid, started: r.started, roots: r.roots, snapshot: r.snapshot });
	const alive = (table: readonly Proc[], r: Pick<OwnerRecord, "pid" | "started">) => table.some((p) => !p.zombie && sameProc(refOf(p), r));
	const rootsOf = (cwd: string | undefined): string[] => {
		// Only a linked worktree has roots: a worker in the parent checkout gets no cwd rule (a main's long-lived processes live there).
		const c = cwd ? checkout(cwd) : undefined;
		return c?.kind === "linked" ? [c.root] : [];
	};

	/** The kill set of one owner on a fresh table, and the kill sequence over it. */
	async function reapSet(subject: OwnerRecord, reason: string): Promise<ReapResult> {
		const table = await read();
		if (!table) throw new Error("the process table could not be read; nothing was signalled");
		const live = [...owners.values()].filter((o) => !o.ended && o.id !== subject.id && alive(table, o)).map(owned);
		const orphans = subject.roots.length ? table.filter((p) => !p.zombie && isOrphan(p, reapersOf(table))) : [];
		const found = await cwdsOf(orphans.map((p) => p.pid));
		const places = new Map<number, Place>();
		for (const [pid, cwd] of found) places.set(pid, { path: cwd.path, removed: classifyCwd(cwd, inode(cwd.path)) === "removed" });
		const markers = await markersOf(table.filter((p) => !p.zombie).map((p) => p.pid));
		const protect = (await d.protect?.(table)) ?? [];
		const { targets, spared } = killSet({ owner: owned(subject), live, table, places, markers, protect, reapers: reapersOf(table), self, ...(d.ownUid !== undefined ? { ownUid: d.ownUid } : {}) });
		const report: KillReport = targets.length ? await reap(targets.map((t) => refOf(t.proc))) : { termed: 0, killed: 0, skipped: 0, groups: 0, left: [] };
		const result: ReapResult = { owner: subject.id, reason, targets: targets.length, termed: report.termed, killed: report.killed, skipped: report.skipped, left: report.left, spared: spared.length };
		d.log("procs-reaped", { owner: subject.id, reason, targets: targets.length, termed: report.termed, killed: report.killed, left: report.left.length, protected: spared.length });
		return result;
	}
	/** The user's `systemd --user` adopts orphans on Linux (a subreaper): a process named systemd whose parent is init. */
	const reapersOf = (table: readonly Proc[]) => (platform === "linux" ? table.filter((p) => p.ppid === 1 && baseName(p.comm) === "systemd").map((p) => p.pid) : []);

	/** The owner ends: its record is closed, its reap runs; a record with something left alive stays marked `ended` for a later `reap`. */
	function end(record: OwnerRecord, reason: string): Promise<void> {
		if (record.ended) return Promise.resolve();
		record.ended = { at: d.now(), reason };
		save();
		d.log("procs-owner-ended", { owner: record.id, reason, pid: record.pid });
		const work = reapSet(record, reason).then(
			(result) => {
				if (result.left.length) {
					d.log("procs-left", { owner: record.id, count: result.left.length, programs: result.left.map((l) => l.comm).slice(0, 5).join(",") });
					record.snapshot = [];
				} else owners.delete(record.id);
				save();
			},
			(error: Error) => {
				// The reap could not run (no table): the record stays, `ended`, and the next tick or a `reap` tries again.
				d.log("procs-error", { owner: record.id, text: error.message.slice(0, 200) });
				record.ended = { at: d.now(), reason: `${reason}; reap failed` };
				save();
			},
		);
		pending.add(work);
		void work.finally(() => pending.delete(work));
		return work;
	}

	async function takeTick(): Promise<void> {
		const table = await read();
		if (!table) return;
		let changed = false;
		for (const r of [...owners.values()]) {
			if (r.ended) continue;
			if (!alive(table, r)) {
				void end(r, "pid gone");
				continue;
			}
			// What the owner has started: everything below it now, plus what an earlier tick saw that is still alive with the same identity (it may have been adopted by init since).
			const below = descendants(table, [r.pid]).filter((p) => !p.zombie).map(refOf);
			const kept = r.snapshot.filter((s) => table.some((p) => !p.zombie && sameProc(refOf(p), s)) && !below.some((b) => sameProc(b, s)));
			const next = [...below, ...kept].slice(0, SNAPSHOT_MAX);
			if (next.length !== r.snapshot.length || next.some((s, i) => !sameProc(s, r.snapshot[i] ?? { pid: -1, started: "" }))) (r.snapshot = next, changed = true);
			r.seenAt = d.now();
		}
		// An owner whose reap could not run (no table) is tried again.
		for (const r of owners.values()) {
			if (r.ended?.reason.endsWith("; reap failed")) {
				const reason = r.ended.reason.slice(0, -"; reap failed".length);
				r.ended = undefined;
				void end(r, reason);
			}
		}
		if (changed) save();
	}

	return {
		async start() {
			load();
			const table = await read();
			for (const r of [...owners.values()]) {
				if (r.ended) continue;
				if (table && !alive(table, r)) void end(r, "gone while the server was down");
			}
			d.log("procs-start", { owners: owners.size });
			const began = d.now();
			await takeTick();
			const cost = d.now() - began;
			if (cost > SLOW_AFTER_MS) tickEvery = SLOW_TICK_MS;
			d.log("procs-tick-cost", { ms: cost, owners: owners.size, procs: table?.length ?? 0, everyMs: tickEvery });
		},
		async hello(h) {
			if (!Number.isSafeInteger(h.pid) || h.pid <= 1) throw new ProcsRefusal("procs-hello needs the pid of the pi");
			const id = h.id ?? `p${h.pid}`;
			if (!ID.test(id)) throw new ProcsRefusal("procs-hello: the owner id is 1 to 64 letters, digits, and . _ -");
			// The pid must be a process of this account that has the start time the pi gave (or, without one, the one it has now).
			const table = await read();
			const proc = table?.find((p) => p.pid === h.pid && !p.zombie);
			const started = proc?.started ?? probe(h.pid);
			if (!started || (h.started !== undefined && h.started !== started)) throw new ProcsRefusal("procs-hello: that pid is not a process of this account with that start time");
			const known = owners.get(id);
			if (known && !known.ended && (known.pid !== h.pid || known.started !== started)) await end(known, "replaced by a new hello");
			const cwd = typeof h.cwd === "string" && h.cwd.length <= 4096 ? h.cwd : undefined;
			const text = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
			const keep = known && !known.ended && known.pid === h.pid && known.started === started ? known : undefined;
			const record: OwnerRecord = {
				id, pid: h.pid, started, roots: rootsOf(cwd), snapshot: keep?.snapshot ?? [], helloAt: keep?.helloAt ?? d.now(), seenAt: d.now(),
				...(text(h.subagentId) ? { subagentId: text(h.subagentId)! } : {}), ...(text(h.pane) ? { pane: text(h.pane)! } : {}), ...(text(h.terminal) ? { terminal: text(h.terminal)! } : {}), ...(cwd ? { cwd } : {}),
			};
			owners.set(id, record);
			save();
			d.log("procs-hello", { owner: id, pid: h.pid, worktree: record.roots.length > 0 });
			return { id };
		},
		beat(id) {
			const r = owners.get(id);
			if (!r || r.ended) return false;
			r.seenAt = d.now();
			return true;
		},
		bye(id) {
			const r = owners.get(id);
			if (!r || r.ended) return false;
			void end(r, "bye");
			return true;
		},
		async tick() {
			// One tick at a time: a slow table read never stacks a second one behind it.
			if (ticking) return ticking;
			ticking = takeTick().finally(() => void (ticking = undefined));
			return ticking;
		},
		async paneEvent(event) {
			if (event.event !== "pane.exited" && event.event !== "pane.closed") return;
			const pane = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined, terminal = typeof event.data.terminal_id === "string" ? event.data.terminal_id : undefined;
			if (!pane) return;
			for (const r of [...owners.values()]) {
				if (r.ended || r.pane !== pane) continue;
				// A pane id is reused by Herdr: the event is the owner's only when it names the owner's terminal, or (without one) when the owner's terminal is no longer the one in that pane.
				if (terminal !== undefined && r.terminal !== undefined && terminal !== r.terminal) continue;
				if (terminal === undefined && r.terminal !== undefined) {
					const now = await d.panes?.().catch(() => undefined);
					const same = now?.find((p) => p.pane_id === pane);
					if (!now || (same && (same.terminal_id === undefined || same.terminal_id === r.terminal))) continue;
				}
				void end(r, event.event);
			}
		},
		list() {
			return [...owners.values()].map((r) => ({ id: r.id, pid: r.pid, started: r.started, live: !r.ended, roots: r.roots, snapshot: r.snapshot.length, ...(r.pane ? { pane: r.pane } : {}), ...(r.subagentId ? { subagentId: r.subagentId } : {}), ...(r.ended ? { endedReason: r.ended.reason } : {}) }));
		},
		async reapOwner(id) {
			const r = owners.get(id);
			if (!r) throw new ProcsRefusal(`no owner ${id}`);
			if (!r.ended) {
				const table = await read();
				if (table && alive(table, r)) throw new ProcsRefusal(`owner ${id} (pid ${r.pid}) is alive; reap works on an owner that has ended`);
			}
			const result = await reapSet(r, "reap");
			if (!result.left.length) (owners.delete(id), save());
			return result;
		},
		async reapCheckout(path) {
			const table = await read();
			const holders = [...owners.values()].filter((r) => !r.ended && table && alive(table, r) && r.roots.some((root) => under(path, root) || under(root, path)));
			if (holders.length) throw new ProcsRefusal(`a live owner works in ${path}: ${holders.map((h) => `${h.id} (pid ${h.pid})`).join(", ")}`);
			const known = [...owners.values()].find((r) => r.roots.some((root) => under(path, root) || under(root, path)));
			const subject: OwnerRecord = known ?? { id: "checkout", pid: -1, started: "", roots: [path], snapshot: [], helloAt: d.now(), seenAt: d.now() };
			const result = await reapSet(subject, "reap");
			if (known && !result.left.length) (owners.delete(known.id), save());
			return result;
		},
		tickMs: () => tickEvery,
		settled: async () => void (await Promise.allSettled([...pending])),
	};
}

/** The pids of the sb servers that `server.json` files under a state folder name (this slot's and the secondary slots'). */
export function serverPids(stateDir: string): number[] {
	const files = [join(stateDir, "server.json")];
	try {
		for (const hash of readdirSync(join(stateDir, "servers"))) files.push(join(stateDir, "servers", hash, "server.json"));
	} catch { /* no secondary slots */ }
	const pids: number[] = [];
	for (const f of files) {
		try {
			const pid = (JSON.parse(readFileSync(f, "utf8")) as { pid?: unknown }).pid;
			if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) pids.push(pid);
		} catch { /* none, or not a record */ }
	}
	return pids;
}

export interface ProtectSources {
	/** `herdr` CLI/API runner (a pane list and each pane's process-info). */
	run?: (args: string[]) => Promise<string>;
	stateDir: string;
	/** The folder of pi's agent state: the intercom broker's pid file is `<agentDir>/intercom/broker.pid`. */
	agentDir: string;
	self: number;
}
/**
 * The protected set (plan C): the Herdr server, every live pane's shell and foreground, the sb servers named in a `server.json` (with what they started), the intercom broker, and this server.
 * Read at each reap, not each tick. A source that cannot be read protects nothing it would have named: the reap then rests on the kill set's own rules (a pane's pi is a live owner, spared as one).
 */
export async function protectedSet(table: readonly Proc[], { run, stateDir, agentDir, self }: ProtectSources): Promise<Protect[]> {
	const out: Protect[] = [{ pid: self, why: "sb-server", tree: true }];
	for (const p of table) if (baseName(p.comm) === "herdr") out.push({ pid: p.pid, started: p.started, why: "herdr" });
	for (const pid of serverPids(stateDir)) out.push({ pid, why: "sb-server", tree: true });
	try {
		const pid = Number(readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8").trim());
		if (Number.isSafeInteger(pid) && pid > 1) out.push({ pid, why: "intercom-broker", tree: true });
	} catch { /* no broker */ }
	if (run) {
		try {
			const listed = (JSON.parse(await run(["pane", "list"])) as { result?: { panes?: { pane_id: string }[] } }).result?.panes ?? [];
			for (const pane of listed) {
				try {
					const info = (JSON.parse(await run(["pane", "process-info", "--pane", pane.pane_id])) as { result?: { process_info?: { shell_pid?: number; foreground_processes?: { pid?: number }[] } } }).result?.process_info;
					for (const pid of [info?.shell_pid, ...(info?.foreground_processes ?? []).map((f) => f.pid)]) if (typeof pid === "number" && pid > 1) out.push({ pid, why: "pane" });
				} catch { /* the pane closed meanwhile */ }
			}
		} catch { /* Herdr does not answer */ }
	}
	return out;
}
