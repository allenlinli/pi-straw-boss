import { execFileExe } from "../exe.mjs";
import { existsSync } from "node:fs";
import type { IntercomLike } from "../agent/kit.ts";
import type { HerdrRun } from "../herdr.ts";
import { panes } from "../herdr.ts";
import { trainFromToken } from "../trainrole.ts";
import { CarBook, type Look } from "./carbook.ts";
import { CarNotices } from "./carnotices.ts";
import { type Slot, towerId } from "./record.ts";
import type { Reply, Request } from "./socket.ts";

// The server's side of the car book (carbook.ts) and the notice sender (carnotices.ts): the control-socket commands `cars-register`, `cars-check`, `cars-set`, `cars-read`, and the wiring of both to the broker, Herdr and a timer.
// Kept out of main.ts, which carries a line budget.

export interface Cars { book: CarBook; notices: CarNotices }

const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_NO_REPLACE_OBJECTS"];
/**
 * git in a folder, for the checks the server makes on a train's word (CR-F002): the repository-selecting variables of this process are taken out, the system and global configuration are not read, no prompt is made, and no hook, fsmonitor, `ext::` transport,
 * replace ref or submodule recursion can run something the folder chose. The folder's own `.git/config` is still read (the server reads the project's remote from the tower's checkout with it, at the open); the fetches run in a repository of the server's own. 60 s at most.
 */
export function runGit(cwd: string, args: string[]): Promise<string> {
	const env = { ...process.env };
	for (const key of GIT_ENV) delete env[key];
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
	const isolation = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "submodule.recurse=false", "--no-replace-objects"];
	return new Promise((resolve, reject) => execFileExe("git", [...isolation, "-C", cwd, ...args], { encoding: "utf8", timeout: 60_000, env, windowsHide: true }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(String(stdout).trim()))));
}

const reply = (error: unknown): Reply => ({ ok: false, error: (error as Error).message });

/** The cars' commands; undefined for a command that is not theirs. */
export function carsReply(cars: Cars | undefined, request: Request): Promise<Reply> | undefined {
	if (typeof request.cmd !== "string" || !request.cmd.startsWith("cars-")) return undefined;
	if (!cars) return Promise.resolve({ ok: false, error: "the server is still starting" });
	switch (request.cmd) {
		case "cars-register":
			return cars.book.register({ session: request.session, pid: request.pid, started: request.started, pane: request.pane }).then((r) => ({ ok: true, ...r }), reply);
		case "cars-check":
			return Promise.resolve(cars.book.check(request.secret) ? { ok: true } : { ok: false, error: "sb: this request is not from a registered session" });
		case "cars-set":
			return cars.book.set({ secret: request.secret, state: request.state as never, car: request.car as never, fields: request.fields as never }).then((r) => ({ ok: true, ...r }), reply);
		case "cars-read":
			return cars.book.readFor({ secret: request.secret, project: request.project }).then((list) => ({ ok: true, cars: list }), reply);
		default:
			return Promise.resolve({ ok: false, error: `unknown command ${request.cmd}` });
	}
}

export interface StartCars {
	slot: Slot;
	run: HerdrRun;
	now(): number;
	/** The server's own intercom connection, when it is connected. */
	client(): IntercomLike | undefined;
	startOf(pid: number): string | undefined;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	stops: (() => void)[];
	/** Replaces the book's seams (tests). */
	over?: Partial<ConstructorParameters<typeof CarBook>[0]>;
}

/** What Herdr and the broker say about a session: its pane, the pane's tokens and folder, and the pids of the pane's foreground processes. */
async function look(o: StartCars, session: string): Promise<Look | undefined> {
	const client = o.client();
	if (!client) return undefined;
	const sessions = await client.listSessions();
	const found = sessions.find((s) => s.id === session), paneId = found?.herdrLocation?.paneId;
	if (!found || !paneId) return undefined;
	const pane = (await panes(o.run)).find((p) => p.pane_id === paneId);
	if (!pane) return undefined;
	let foreground: number[] = [];
	try {
		const info = JSON.parse(await o.run(["pane", "process-info", "--pane", paneId])).result?.process_info as { foreground_processes?: { pid?: number }[] } | undefined;
		foreground = (info?.foreground_processes ?? []).flatMap((p) => (Number.isSafeInteger(p.pid) ? [p.pid!] : []));
	} catch { foreground = []; }
	const token = pane.tokens?.sb_role;
	const train = trainFromToken(pane.tokens?.sb_train);
	return { id: session, name: (found.name ?? session), ...(token ? { role: token } : {}), ...(train ? { train } : {}), pane: paneId, ...(pane.workspace_id ? { workspace: pane.workspace_id } : {}), ...(pane.cwd ? { cwd: pane.cwd } : {}), foreground };
}

/** The book and the sender of this server; the sender runs on a 5 s timer until the server leaves. */
export function startCars(o: StartCars): Cars {
	let notices: CarNotices | undefined;
	const book = new CarBook({
		stateDir: o.slot.stateDir, dir: o.slot.dir, now: o.now, look: (session) => look(o, session), git: runGit, exists: existsSync, log: o.log,
		startOf: o.startOf, onChange: () => notices?.kick(), ...o.over,
	});
	notices = new CarNotices({ book, now: o.now, intercom: () => o.client(), tower: (workspace) => towerId(o.slot, workspace), log: o.log });
	notices.start();
	o.stops.push(() => notices?.stop());
	return { book, notices };
}
