import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callControl, ControlError } from "../server/socket.ts";

// Where a net sidecar keeps what it leaves for the commands (one pane's state file, control socket, and log), and where pi-intercom and its tsx loader are.

/** The `straw-boss` directory of pi's agent directory, where the GUI's record and the sidecars' files live. */
export const stateDirOf = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss");

/** The files of the sidecar of one pane, named by a hash of the pane id (a pane id is not a safe file name). */
export function agentFiles(stateDir: string, pane: string) {
	const base = join(stateDir, "agents", createHash("sha256").update(pane).digest("hex").slice(0, 16));
	return { dir: dirname(base), state: `${base}.json`, socket: `${base}.sock`, log: `${base}.log` };
}
/**
 * Whether the control socket is the file `files.socket` (removed and made mode 600). On Windows it is a named pipe instead, in a namespace every account shares:
 * each sidecar names its own at random and records it in its state file (`Held.pipe`), which other accounts cannot read, so none can take the name first.
 */
export const socketIsFile = (platform: NodeJS.Platform = process.platform) => platform !== "win32";
export const newPipe = () => `\\\\.\\pipe\\straw-boss-${randomBytes(16).toString("hex")}`;
/** Where the sidecar that wrote `held` answers. */
export const socketOf = (files: AgentFiles, held: Held | undefined) => (typeof held?.pipe === "string" ? held.pipe : files.socket);
export type AgentFiles = ReturnType<typeof agentFiles>;

/** What a running sidecar writes first: who holds the pane. */
export interface Held { pid: number; session: string; kind: string; pane: string; id: string; name: string; startedAt: number; pipe?: string;
	/** The sidecar's hello secret (new at each start; the file is mode 600): a connection without it gets no answer, and an answer without the proof made from it gets no request. */
	secret?: string }

/** Whether `pid` is a live process of this user: a sidecar is, so EPERM (another user's process) is not one of ours. */
export const alive = (pid: unknown) => {
	try {
		return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && process.kill(pid, 0);
	} catch {
		return false;
	}
};
export function readHeld(files: AgentFiles): Held | undefined {
	return parseHeld(readRaw(files));
}
export function readRaw(files: AgentFiles): string | undefined {
	try {
		return readFileSync(files.state, "utf8");
	} catch {
		return undefined;
	}
}
export function parseHeld(raw: string | undefined): Held | undefined {
	try {
		const held = JSON.parse(raw ?? "") as Held;
		return typeof held.pid === "number" && typeof held.session === "string" ? held : undefined;
	} catch {
		return undefined;
	}
}

/** How long a state file whose owner has not opened its socket yet still counts: a sidecar listens within a moment of claiming the pane. */
export const STARTING_MS = 15_000;
/** `up` and `leaving` are confirmed by the sidecar itself, over its socket (same pid and session); `starting` is a young file whose process is alive and does not answer yet. */
export interface Holder { held: Held; state: "up" | "starting" | "leaving" }
/**
 * Who holds the pane for a state file. A pid alone proves nothing (pids are reused, and a crash leaves the file behind), so the holder is the process that
 * answers `hello` on the pane's socket with the file's own pid and session. Only a young file whose process is alive is given the benefit of the doubt.
 */
export async function judge(files: AgentFiles, held: Held | undefined, now: () => number = Date.now): Promise<Holder | undefined> {
	if (!held) return undefined;
	const reply = await ask(socketOf(files, held), held.secret, { cmd: "hello" }, 3000).catch(() => undefined);
	if (reply?.ok && reply.pid === held.pid && reply.session === held.session) return { held, state: reply.leaving ? "leaving" : "up" };
	return alive(held.pid) && now() - held.startedAt < STARTING_MS ? { held, state: "starting" } : undefined;
}
export const holder = (files: AgentFiles, now?: () => number) => judge(files, readHeld(files), now);
/** The sidecar that holds the pane and is not on its way out. */
export const liveHeld = async (files: AgentFiles) => ((h) => (h && h.state !== "leaving" ? h.held : undefined))(await holder(files));

/** One request to a sidecar's control socket: one JSON line out, one JSON line back. */
export interface Reply { ok: boolean; error?: string; text?: string; [key: string]: unknown }
/** Nothing listens on the socket (it was never made, or the sidecar behind it has ended); any other failure means a sidecar was reached. */
export class NoSidecar extends Error {}
/**
 * `secret` is the one in the pane's state file. The request is written only after the sidecar has answered the hello with a proof made from it, so whatever sits on the name of a dead
 * sidecar (a pipe on Windows is free once the last instance closes) gets no request and counts as no sidecar.
 */
export async function ask(socket: string, secret: string | undefined, request: Record<string, unknown>, timeoutMs = 60_000): Promise<Reply> {
	if (!secret) throw new NoSidecar("the pane's state file holds no secret for its sidecar");
	try {
		// The hello of the handshake already says who answers (pid, session, leaving): asking it again as a request would be a second round trip.
		if (request.cmd === "hello") return (await callControl(socket, secret, undefined, timeoutMs)).hello;
		return (await callControl(socket, secret, { ...request, cmd: String(request.cmd) }, timeoutMs)).reply!;
	} catch (error) {
		if (!(error instanceof ControlError)) throw error;
		if (error.failure === "no-server") throw new NoSidecar(error.message);
		if (error.failure === "refused") throw new NoSidecar(`whatever answers there did not prove itself the pane's sidecar (${error.message}); run join again`);
		if (error.failure === "timeout") throw new Error(`the sidecar did not answer within ${timeoutMs / 1000} s`);
		throw new Error(error.message);
	}
}

/** pi-intercom's directory: named by STRAW_BOSS_INTERCOM, else beside this package (both live in pi's npm node_modules), else in the agent directory's npm node_modules. */
export function findIntercom(env: NodeJS.ProcessEnv = process.env, here = dirname(fileURLToPath(import.meta.url))): string {
	const agent = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const found = [env.STRAW_BOSS_INTERCOM, join(here, "..", "..", "..", "pi-intercom"), join(agent, "npm", "node_modules", "pi-intercom")].find((dir) => dir && existsSync(join(dir, "broker", "client.ts")));
	if (!found) throw new Error("pi-intercom (>= 0.17.1) was not found: install it with pi, or name its directory in STRAW_BOSS_INTERCOM");
	return found;
}
/** The tsx loader that pi-intercom starts its own broker with: the sidecar is a TypeScript file under node_modules, which Node alone refuses to run. */
export function tsxLoader(intercom: string): string {
	try {
		return createRequire(join(intercom, "package.json")).resolve("tsx");
	} catch {
		const sibling = join(intercom, "..", "tsx", "dist", "loader.mjs");
		if (existsSync(sibling)) return sibling;
		throw new Error(`the tsx loader was not found beside ${intercom}`);
	}
}
