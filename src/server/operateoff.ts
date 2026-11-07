import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { writeDurableText } from "./towerstore.ts";

// The boss's switch for operate on this computer (docs/specs/2026-11-07-link-operate.md §8, decision 14): `/boss link operate off` ends every session and keeps operate off until `/boss link operate on`, across a GUI that starts again and a
// server that starts again. It is this device's own state, `link/operate-off.json` in the server's state folder, mode 600: `{"since": <ms>}`. A file that is there but cannot be read as that (a half write, a hand edit) still means off: the switch
// fails closed, and `on` is what removes it.

export interface OperateOff {
	/** When it was turned off, or nothing while operate is on. */
	since(): number | undefined;
	/** Turns it off at `at`; the answer says whether the file was written (otherwise it is off until this server stops). */
	off(at: number): { saved: boolean };
	/** Turns it on and removes the file; the answer says whether the file is gone (otherwise it stays off). */
	on(): { saved: boolean };
}

/** Whether anything is at `path`, a dangling symlink included (`readFileSync` follows the link and says ENOENT for it). */
const present = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
	}
};

export function operateOff(file: string, now: () => number): OperateOff {
	let since: number | undefined;
	try {
		const text = readFileSync(file, "utf8"), found = (JSON.parse(text) as { since?: unknown } | null)?.since;
		since = typeof found === "number" && Number.isSafeInteger(found) && found >= 0 ? found : now();
	} catch (error) {
		since = (error as NodeJS.ErrnoException)?.code === "ENOENT" && !present(file) ? undefined : now(); // a link whose target is gone is still something at the path
	}
	return {
		since: () => since,
		off(at) {
			since = at;
			try {
				mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
				writeDurableText(file, `${JSON.stringify({ since: at })}\n`);
				chmodSync(file, 0o600);
				return { saved: true };
			} catch {
				return { saved: false };
			}
		},
		on() {
			try {
				rmSync(file, { force: true });
			} catch {
				return { saved: false };
			}
			since = undefined;
			return { saved: true };
		},
	};
}
