import { startedLater } from "../startof.ts";
import { PROTOCOL } from "../server/socket.ts";
import { alive, type Held } from "./paths.ts";

// A sidecar that a package before this one started keeps the control protocol it was started with (an upgrade replaces files, not running processes): no secret, or a secret it sends in clear.
// This package cannot talk to it (it never falls back to the older handshake), and on macOS and Linux the new sidecar could not listen at its path. `join` therefore retires it by signal.

/** The slack allowed between the start time `ps` tells (whole seconds) and the `startedAt` a sidecar wrote after it booted. */
const SLACK_MS = 2000;
/** Whether the state file is from a sidecar of an older control protocol whose process still runs. */
export const isLegacy = (held: Held | undefined): held is Held => held !== undefined && (held.proto ?? 0) < PROTOCOL && alive(held.pid);
/** A start time as `startOf` tells it: ISO on Windows, `ps -o lstart=` in UTC elsewhere. */
const startMs = (text: string | undefined) => (text === undefined ? NaN : Date.parse(/[zZ]$/.test(text) ? text : `${text} UTC`));

/**
 * Whether the process under the state file's pid is the sidecar that wrote it. A pid alone proves nothing (pids are reused), but a process that started after the file's `startedAt` cannot be
 * the one that wrote it, and one that started before it, under the same pid, can only be the same process. The start time is waited for (a PowerShell read on Windows).
 */
async function isSidecarProcess(held: Held, startOf: (pid: number) => Promise<string | undefined> = (pid) => startedLater(pid)): Promise<boolean> {
	const began = startMs(await startOf(held.pid));
	return Number.isFinite(began) && began <= held.startedAt + SLACK_MS;
}

/**
 * Ends a sidecar of an older control protocol: SIGTERM (its own handler makes it leave the net; Windows ends it outright) only once its start time says it is the process that wrote the state file,
 * then waits up to `ms` for it to be gone. Returns whether it is gone; a pid that is not that process is left alone, and counts as gone for this pane (the file is a leftover).
 */
export async function retireLegacy(held: Held, ms: number, deps: { kill?: (pid: number, signal: NodeJS.Signals) => void; startOf?: (pid: number) => Promise<string | undefined>; pause: (ms: number) => Promise<void> }): Promise<boolean> {
	if (!(await isSidecarProcess(held, deps.startOf))) return true;
	try { (deps.kill ?? process.kill)(held.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
	for (const end = Date.now() + ms; alive(held.pid); await deps.pause(50)) if (Date.now() >= end) return false;
	return true;
}
