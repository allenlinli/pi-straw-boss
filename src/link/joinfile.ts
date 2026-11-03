import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// An unattended device has no screen to paste an invite into: its infra drops the invite text in `link/join.txt` (docs/specs/2026-10-25-straw-link.md, Storage and
// policy). The holder reads it at start and on each tick while no join is in flight (admin.ts `joinFileTick`). The file carries a secret, so it is read only when it is
// a regular file, not a symlink, owned by this device's own user, and readable by that user alone (mode 600); anything else is refused and removed, never read.

export const JOIN_FILE = "join.txt";
export const joinFilePath = (linkDir: string) => join(linkDir, JOIN_FILE);

export type JoinFileRead = { state: "absent" } | { state: "refused"; reason: string } | { state: "text"; text: string };

/** The file system's answers, for tests: the own user's id (default `process.getuid()`). */
export interface JoinFileDeps { uid?: number }

/** Names the file now at `path` (device, inode, mtime) without reading it, or `undefined` when there is none; a file that could not be removed is told once by this name. */
export function fileMark(path: string): string | undefined {
	try {
		const st = lstatSync(path);
		return `${st.dev}:${st.ino}:${st.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** Reads `path` if it passes the check. The text is opened without following a symlink and checked on the descriptor it was read from, so a swap between check and read gains nothing. */
export function readJoinFile(path: string, d: JoinFileDeps = {}): JoinFileRead {
	const uid = d.uid ?? process.getuid?.();
	if (uid === undefined) return { state: "refused", reason: "this platform has no user ids, so the owner of join.txt cannot be checked" };
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) return { state: "refused", reason: "join.txt is a symlink" };
		// Before the open: opening a FIFO for reading would block until a writer comes, and the tick would hang on it.
		if (!st.isFile()) return { state: "refused", reason: "join.txt is not a regular file" };
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "refused", reason: `join.txt cannot be read: ${(error as NodeJS.ErrnoException).code ?? "error"}` };
	}
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fstatSync(fd);
		if (!st.isFile()) return { state: "refused", reason: "join.txt is not a regular file" };
		if (st.uid !== uid) return { state: "refused", reason: "join.txt is not owned by this device's own user" };
		if ((st.mode & 0o777) !== 0o600) return { state: "refused", reason: `join.txt has mode ${(st.mode & 0o777).toString(8)}; it has to be 600` };
		return { state: "text", text: readFileSync(fd, "utf8") };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? { state: "absent" } : { state: "refused", reason: `join.txt cannot be read: ${code ?? "error"}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Removes the file itself (a symlink's link, never its target); one that is gone already is fine. */
export function removeJoinFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
