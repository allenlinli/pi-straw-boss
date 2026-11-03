import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Level, LEVELS, type LinkConfig, parseTeams, readLinkConfig, type TeamPolicy } from "./config.ts";

// An unattended device reads its policy from a fixed file that its own user cannot write (docs/specs/2026-10-25-straw-link.md, Storage and policy):
// no message or roster entry can change it. The file carries the device's trust levels and its teams, and `readEffectiveConfig` hands them to every reader
// of `link.teams` in place of config.json's. A file that is there but fails the check, or whose `teams` is malformed, refuses unattended mode: no link holder
// runs on that device (service.ts `look`), every sender is at `reply`, and the reason is said once.
// Opening a tower for a controller and the rest of unattended mode is later steps (docs/specs/2026-10-26-sb-backend.md, rebased step 6).

export const POLICY_PATH = "/etc/straw-link/policy.json";

export type Policy =
	| { mode: "attended" }
	| { mode: "unattended"; trust: Map<string, Level>; teams: Map<string, TeamPolicy> }
	| { mode: "refused"; reason: string };

/** Seams for tests: the file system's answers about owners and write access. */
export interface PolicyDeps {
	path?: string;
	uid?: number;
	stat?: (path: string) => { uid: number; symlink: boolean };
	writable?: (path: string) => boolean;
	read?: (path: string) => string;
	/** For the projects of the policy's teams (`projectProblem` refuses the home folder and the pi folders); default the real ones. */
	home?: string;
	agentDir?: string;
}

const realStat = (path: string) => {
	const st = lstatSync(path);
	return { uid: st.uid, symlink: st.isSymbolicLink() };
};
const realWritable = (path: string) => {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/** The owner and write check for the policy file and its directory: both owned by another user, neither a symlink, neither writable by this user. */
export function policyProblem(path: string, d: PolicyDeps = {}): string | undefined {
	const uid = d.uid ?? process.getuid?.(), stat = d.stat ?? realStat, writable = d.writable ?? realWritable;
	if (uid === undefined) return "this platform has no user ids, so the policy file's owner cannot be checked";
	for (const p of [path, dirname(path)]) {
		let st: { uid: number; symlink: boolean };
		try {
			st = stat(p);
		} catch (error) {
			return `${p} cannot be read: ${(error as Error).message}`;
		}
		if (st.symlink) return `${p} is a symlink`;
		if (st.uid === uid) return `${p} is owned by this device's own user`;
		if (writable(p)) return `${p} is writable by this device's own user`;
	}
	return undefined;
}

/** `true` stands for the level `dispatch`; anything else that is not a level is left out. */
function levels(raw: unknown): Map<string, Level> {
	const out = new Map<string, Level>();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [device, level] of Object.entries(raw)) {
		if (!/^[a-z2-7]{26}$/.test(device)) continue;
		if (level === true) out.set(device, "dispatch");
		else if (LEVELS.includes(level as Level)) out.set(device, level as Level);
	}
	return out;
}

/** The device's policy: attended when there is no policy file (or it does not say `unattended`), the file's trust and teams when it passes the check, else refused. */
export function readPolicy(d: PolicyDeps = {}): Policy {
	const path = d.path ?? POLICY_PATH, read = d.read ?? ((p: string) => readFileSync(p, "utf8"));
	let text: string;
	try {
		text = read(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { mode: "attended" } : { mode: "refused", reason: `${path} cannot be read: ${(error as Error).message}` };
	}
	let json: { unattended?: unknown; trust?: unknown; teams?: unknown };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		return { mode: "refused", reason: `${path} is not valid JSON` };
	}
	if (json?.unattended !== true) return { mode: "attended" };
	const problem = policyProblem(path, d);
	if (problem) return { mode: "refused", reason: problem };
	if (json.teams === undefined) return { mode: "unattended", trust: levels(json.trust), teams: new Map() };
	if (typeof json.teams !== "object" || json.teams === null || Array.isArray(json.teams)) return { mode: "refused", reason: `${path}: teams has to be an object of team ids` };
	const home = d.home ?? homedir(), bad: string[] = [];
	const teams = parseTeams(json.teams as Record<string, unknown>, { home, agentDir: d.agentDir ?? join(home, ".pi", "agent") }, (reason) => bad.push(reason), false);
	return bad.length ? { mode: "refused", reason: `${path}: ${bad.join("; ")}` } : { mode: "unattended", trust: levels(json.trust), teams };
}

/**
 * The teams and trust every reader of `link.teams` sees under `policy`: config.json's `link` section on an attended device; the policy file's trust and teams on an
 * unattended one, which ignores config.json's `link` section entirely (a file its own user can write cannot grant a team); nothing on a refused one, whose holder does not run.
 */
export function readEffectiveConfig(policy: Policy, stateDir: string, dirs: { home: string; agentDir: string }): LinkConfig {
	if (policy.mode === "unattended") return { teams: new Map(policy.teams), trust: new Map(policy.trust), problems: [] };
	if (policy.mode === "refused") return { teams: new Map(), trust: new Map(), problems: [] };
	return readLinkConfig(stateDir, dirs);
}
