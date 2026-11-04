import { readlinkSync, statSync } from "node:fs";
import { run, type Run } from "./table.ts";

// Where a process works. Linux: the link `/proc/<pid>/cwd` (a removed folder reads ` (deleted)`). macOS: `lsof -a -d cwd`, asked for the candidates only. lsof prints no marker for a removed folder and keeps
// the old path and inode, so a removed folder is told by the path being gone or by its inode no longer being the one lsof reports (T0 spike).

export interface Cwd { path: string; inode?: string; deleted?: boolean }
export type CwdState = "present" | "removed";

/** The `-Fpfni` records of lsof: `p<pid>`, then for the cwd descriptor `fcwd`, `i<inode>`, `n<name>`. */
export function parseLsofCwd(text: string): Map<number, Cwd> {
	const out = new Map<number, Cwd>();
	let pid: number | undefined, inode: string | undefined, cwd = false;
	for (const line of text.split("\n")) {
		const field = line[0], value = line.slice(1);
		if (field === "p") (pid = Number(value), inode = undefined, cwd = false);
		else if (field === "f") (cwd = value === "cwd", inode = undefined);
		else if (field === "i" && cwd) inode = value;
		else if (field === "n" && cwd && pid !== undefined && value) out.set(pid, { path: value, ...(inode ? { inode } : {}) });
	}
	return out;
}

const CHUNK = 200;
export interface CwdDeps { run?: Run; platform?: NodeJS.Platform; readlink?: (pid: number) => string }
/** The cwd of each pid that can be read; a pid that is gone, or another account's, is missing from the answer. */
export async function readCwds(pids: readonly number[], { run: ask = run, platform = process.platform, readlink = (pid: number) => readlinkSync(`/proc/${pid}/cwd`) }: CwdDeps = {}): Promise<Map<number, Cwd>> {
	const out = new Map<number, Cwd>();
	if (platform === "win32") return out;
	if (platform === "linux") {
		for (const pid of pids) {
			try {
				const link = readlink(pid), gone = link.endsWith(" (deleted)");
				out.set(pid, { path: gone ? link.slice(0, -" (deleted)".length) : link, ...(gone ? { deleted: true } : {}) });
			} catch { /* gone, or not readable */ }
		}
		return out;
	}
	for (let i = 0; i < pids.length; i += CHUNK) {
		for (const [pid, cwd] of parseLsofCwd(await ask("lsof", ["-a", "-d", "cwd", "-Fpfni", "-p", pids.slice(i, i + CHUNK).join(",")]))) out.set(pid, cwd);
	}
	return out;
}

/** `onDisk`: the inode of the path now, null when the path is not there. */
export function classifyCwd(cwd: Cwd, onDisk: string | null): CwdState {
	if (cwd.deleted || onDisk === null) return "removed";
	return cwd.inode !== undefined && cwd.inode !== onDisk ? "removed" : "present";
}

/** The inode of a path now (as text: it can exceed what a number holds), null when it is not there. */
export function inodeOnDisk(path: string): string | null {
	try {
		return String(statSync(path, { bigint: true }).ino);
	} catch {
		return null;
	}
}
