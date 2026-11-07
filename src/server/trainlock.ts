import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOf as realStartOf } from "../startof.ts";

// The named machine-wide lock of the train gate wrapper (docs/specs/2026-11-07-train-workers.md §9.1): `<slot dir>/locks/<name>.lock`, held by the wrapper process for the child's life. Node has no flock, so the lock is a file that only
// one process can make (a hard link of a finished temp file: never seen half written) and whose body is its holder (train, step, pid, start time). A holder whose pid is gone, or answers to another start time (the pid was reused), loses the
// lock at the next look: the looker takes it over under a marker (one looker at a time; the marker's body is its looker, linked into place finished, and goes only when that looker is dead, never by age, so a looker that stalls is not robbed),
// re-checks the body it judged dead, replaces it by an atomic rename of a new body, and reads it back to be sure the body is its own.
// Nothing here is held by a descriptor, so nothing is lost across an exec; the holder is the wrapper itself, which spawns the command and never execs it. Everything is synchronous: the marker is held for a few file calls.

export const LOCK_NAME = /^[a-z0-9-]{1,32}$/;
/** A lock body or marker that does not read as one and is older than this is a crashed writer's: a live writer makes it whole at once. A marker that reads is judged by its looker's liveness, never by age. */
export const MARKER_MAX_MS = 5000;

export interface LockHolder { train: string; step: number; pid: number; started?: string; since: string }
export interface LockDeps {
	now?: () => number;
	/** The start time of a pid now, undefined when it is gone or cannot be told. */
	startOf?: (pid: number) => string | undefined;
	/** Whether a process with the pid exists. */
	alive?: (pid: number) => boolean;
	/** Runs between a takeover's replace and its read-back: where a test puts the other process that must not be able to win. */
	afterReplace?: () => void;
	/** Runs while the looker holds the marker, after it re-read the lock and before it replaces it: where a test stalls the looker. */
	beforeReplace?: () => void;
	/** Runs when a marker was judged a dead looker's, before it is moved aside: where a test puts a live looker's marker in its place. */
	beforeMoveAside?: () => void;
}
export type Taken =
	| { ok: true; holder: LockHolder; release(): void }
	| { ok: false; holder?: LockHolder; why: "held" | "unreadable" | "looking" };

export const lockDirOf = (slotDir: string) => join(slotDir, "locks");
const fileOf = (dir: string, name: string) => join(dir, `${name}.lock`);
const check = (name: string) => {
	if (!LOCK_NAME.test(name)) throw new Error(`sb: lock name "${name}" must be 1 to 32 of a-z, 0-9, -`);
};

const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Whether the holder still runs: its pid answers and, when its start time was recorded and can be read now, that is the time it answers to. A start time that cannot be read for a live pid is not a reason to take its lock. */
export function holderAlive(holder: Pick<LockHolder, "pid" | "started">, deps: LockDeps = {}): boolean {
	if (!(deps.alive ?? pidAlive)(holder.pid)) return false;
	if (holder.started === undefined) return true;
	const now = (deps.startOf ?? realStartOf)(holder.pid);
	return now === undefined || now === holder.started;
}

const isHolder = (value: unknown): value is LockHolder => {
	const h = value as LockHolder;
	return typeof h === "object" && h !== null && typeof h.train === "string" && Number.isInteger(h.step) && Number.isSafeInteger(h.pid) && h.pid > 0 && typeof h.since === "string" && (h.started === undefined || typeof h.started === "string");
};
const readRaw = (file: string) => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};
const parse = (raw: string | undefined): LockHolder | undefined => {
	try {
		const value = JSON.parse(raw ?? "");
		return isHolder(value) ? value : undefined;
	} catch {
		return undefined;
	}
};
const ageOf = (file: string, now: number) => {
	try {
		return now - statSync(file).mtimeMs;
	} catch {
		return 0;
	}
};

/** The live holder of a lock now; nothing when it is free, its holder is dead, or its file does not read. */
export function holderOf(dir: string, name: string, deps: LockDeps = {}): LockHolder | undefined {
	check(name);
	const holder = parse(readRaw(fileOf(dir, name)));
	return holder && holderAlive(holder, deps) ? holder : undefined;
}

/** Every lock whose holder is alive, by name. */
export function heldLocks(dir: string, deps: LockDeps = {}): { name: string; holder: LockHolder }[] {
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch { /* no locks yet */ }
	return names.filter((n) => n.endsWith(".lock") && LOCK_NAME.test(n.slice(0, -5))).sort().flatMap((n) => {
		const holder = holderOf(dir, n.slice(0, -5), deps);
		return holder ? [{ name: n.slice(0, -5), holder }] : [];
	});
}

/**
 * Takes the lock `name` for `who` (a train's step; this process, unless `pid` says otherwise), or says who has it. Free: the body is linked into place. Held by a live process: `held`. Held by a dead one (pid gone, or another start
 * time): taken over under `<name>.lock.looking`, which one looker at a time makes; the looker reads the lock again under it, and only a body that is still the dead one it judged is replaced, by renaming the new body over it, after which the
 * lock is read back and is this looker's only if the body is its own. A marker whose looker is dead, or an unreadable marker or body older than 5 s, goes. Another looker at the marker is `looking`: the caller looks again at its next poll.
 */
export function takeLock(dir: string, name: string, who: { train: string; step: number; pid?: number; started?: string }, deps: LockDeps = {}): Taken {
	check(name);
	const now = deps.now ?? Date.now, pid = who.pid ?? process.pid, started = who.started ?? (deps.startOf ?? realStartOf)(pid);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const holder: LockHolder = { train: who.train, step: who.step, pid, ...(started ? { started } : {}), since: new Date(now()).toISOString() };
	const body = JSON.stringify(holder), file = fileOf(dir, name), marker = `${file}.looking`;
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
	const release = () => {
		if (readRaw(file) === body) {
			try { unlinkSync(file); } catch { /* released already */ }
		}
	};
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				linkSync(temp, file);
				return { ok: true, holder, release };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const raw = readRaw(file), seen = parse(raw);
			if (raw === undefined) continue; // released between the link and the read
			if (seen && holderAlive(seen, deps)) return { ok: false, holder: seen, why: "held" };
			if (!seen && ageOf(file, now()) <= MARKER_MAX_MS) return { ok: false, why: "unreadable" };
			// A dead holder, or a body nobody finished writing for 5 s.
			const mine = enterMarker(marker, now, deps);
			if (mine === undefined) return { ok: false, ...(seen ? { holder: seen } : {}), why: "looking" };
			try {
				if (readRaw(file) !== raw) continue; // changed while we waited for the marker: look again
				deps.beforeReplace?.();
				renameSync(temp, file);
				deps.afterReplace?.();
				if (readRaw(file) === body) return { ok: true, holder, release };
				return { ok: false, holder: parse(readRaw(file)), why: "held" };
			} finally {
				if (readRaw(marker) === mine) try { unlinkSync(marker); } catch { /* gone */ }
			}
		}
		return { ok: false, why: "looking" };
	} finally {
		try { unlinkSync(temp); } catch { /* it was renamed into place, or never made */ }
	}
}

const isLooker = (value: unknown): value is { pid: number; started?: string } => {
	const l = value as { pid: number; started?: string };
	return typeof l === "object" && l !== null && Number.isSafeInteger(l.pid) && l.pid > 0 && (l.started === undefined || typeof l.started === "string");
};
const parseLooker = (raw: string) => {
	try {
		const value = JSON.parse(raw);
		return isLooker(value) ? value : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Makes the marker, which only one looker can: its body is this process (pid and start time), written whole under another name and linked into place. A marker whose looker is dead goes at once; one that does not read goes when it is older than 5 s;
 * one whose looker is alive stays however old it is. What is moved aside is put back when it is not the marker that was judged (a live looker made a new one in between). Returns the body of the marker that is ours, or nothing.
 */
function enterMarker(marker: string, now: () => number, deps: LockDeps): string | undefined {
	const started = (deps.startOf ?? realStartOf)(process.pid), body = JSON.stringify({ pid: process.pid, ...(started ? { started } : {}) });
	const temp = `${marker}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
	try {
		for (let tries = 0; tries < 2; tries++) {
			try {
				linkSync(temp, marker);
				return body;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const raw = readRaw(marker);
			if (raw === undefined) continue; // gone between the link and the read
			const looker = parseLooker(raw);
			if (looker ? holderAlive(looker, deps) : ageOf(marker, now()) <= MARKER_MAX_MS) return undefined;
			deps.beforeMoveAside?.();
			const aside = `${marker}.${process.pid}.${randomUUID()}.old`;
			try {
				renameSync(marker, aside);
			} catch {
				continue; // another looker moved it first
			}
			if (readRaw(aside) !== raw) {
				// What we moved is not the marker we judged: a live looker's new one. Put it back.
				try { linkSync(aside, marker); } catch { /* a third looker made one: it is theirs */ }
				try { unlinkSync(aside); } catch { /* gone */ }
				return undefined;
			}
			try { unlinkSync(aside); } catch { /* gone */ }
		}
		return undefined;
	} finally {
		try { unlinkSync(temp); } catch { /* never made */ }
	}
}
