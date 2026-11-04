import { readFileSync } from "node:fs";
import { run, type Run } from "./table.ts";

// The owner marker: a pi that is a registered owner sets STRAW_BOSS_OWNER=<id> in its own environment, and everything its bash starts inherits it. Readers look for that one key and keep the id only.
// No command line or environment leaves this file: a row of `ps -E` or a `/proc/<pid>/environ` is matched in memory and dropped. (macOS shows no environment for Apple's own programs, /bin/sh and sleep among them,
// and none for a pi's late `process.env` change in the pi itself, only in what it starts: the T0 spike. The snapshot and cwd rules cover those.)

export const OWNER_KEY = "STRAW_BOSS_OWNER";
const ID = /^[A-Za-z0-9._-]{1,64}$/;
const WORD = new RegExp(`(?:^|\\s)${OWNER_KEY}=([^\\s]*)(?=\\s|$)`, "g");

/**
 * The owner id among the words of one row of environment text, undefined when there is none or it is not an id. The last match wins: `ps -E` prints the argument words first and the environment after them,
 * so a word of the command line that looks like the marker never beats the real entry.
 */
export function ownerOf(text: string): string | undefined {
	const id = [...text.matchAll(WORD)].at(-1)?.[1];
	return id && ID.test(id) ? id : undefined;
}

/** Puts the marker into `env` (this process's, by default): a child started afterwards carries it. */
export function setOwner(id: string, env: NodeJS.ProcessEnv = process.env): void {
	if (!ID.test(id)) throw new Error(`not an owner id: ${JSON.stringify(id)}`);
	env[OWNER_KEY] = id;
}

/** pid → owner id from the rows of `ps -E -ww -o pid=,command=`; only the pids asked for, and only the id of each is kept. */
export function parseOwnerRows(text: string, wanted: ReadonlySet<number>): Map<number, string> {
	const out = new Map<number, string>();
	for (const line of text.split("\n")) {
		const m = /^\s*(\d+)\s(.*)$/.exec(line);
		const pid = m ? Number(m[1]) : NaN;
		const id = m && wanted.has(pid) ? ownerOf(m[2]!) : undefined;
		if (id) out.set(pid, id);
	}
	return out;
}

const CHUNK = 100;
export interface OwnerDeps { run?: Run; platform?: NodeJS.Platform; environ?: (pid: number) => Buffer }
/** The owner id each readable pid carries. A pid that is gone, not readable, or without the marker is missing from the answer. */
export async function readOwners(pids: readonly number[], { run: ask = run, platform = process.platform, environ = (pid: number) => readFileSync(`/proc/${pid}/environ`) }: OwnerDeps = {}): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	if (platform === "win32") return out;
	if (platform === "linux") {
		for (const pid of pids) {
			try {
				const id = environ(pid).toString("utf8").split("\0").map((word) => word.startsWith(`${OWNER_KEY}=`) ? ownerOf(` ${word}`) : undefined).find(Boolean);
				if (id) out.set(pid, id);
			} catch { /* gone, or not readable */ }
		}
		return out;
	}
	for (let i = 0; i < pids.length; i += CHUNK) {
		const chunk = pids.slice(i, i + CHUNK);
		for (const [pid, id] of parseOwnerRows(await ask("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", chunk.join(",")]), new Set(chunk))) out.set(pid, id);
	}
	return out;
}
