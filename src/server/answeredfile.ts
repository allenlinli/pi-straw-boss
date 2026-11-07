import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync } from "node:fs";
import type { AnsweredDeps } from "../answered.ts";
import { writeDurableText } from "./towerstore.ts";

// The record of answered blocks on disk (answered.ts), read as the house reads its records (record.ts `readOwned`): a link is not followed (`O_NOFOLLOW`, and an lstat where the flag does not exist) and a file another account owns is not read. A file that is not there is a new
// record (undefined); anything else that stops the read throws, which the record takes for an unreadable file. Such a file is moved aside (`answered.json.unreadable-<time>`) before the first write, never replaced.

const MAX_BYTES = 32 * 1024 * 1024;

/** The file's text when this account owns a regular file there, undefined when there is none, and a throw for anything else (a link, a directory, another account's file, one too big, a read error). */
function readOwnedStrict(file: string): string | undefined {
	let fd: number;
	try {
		if (lstatSync(file).isSymbolicLink()) throw new Error("the record is a link");
		fd = openSync(file, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_BYTES) throw new Error("the record is not a regular file of a sane size");
		if (process.getuid && info.uid !== process.getuid()) throw new Error("the record belongs to another account");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/** The record's three file operations for `file`. */
export const answeredFileDeps = (file: string): Pick<AnsweredDeps, "load" | "save" | "aside"> => ({
	load: () => readOwnedStrict(file),
	save: (text) => writeDurableText(file, text),
	aside: () => renameSync(file, `${file}.unreadable-${Date.now()}`),
});
