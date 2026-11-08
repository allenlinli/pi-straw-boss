import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The version gate of the merge train (docs/specs/2026-11-07-train-workers.md §14.1, TB-F008). The train's and the integrator's prompts follow pi-anchorloop's `integrating` and `deploying` skills as of 2.11.0 (the Step runner seam, the
// `## Acceptance` row), and a model cannot tell 2.10.1 from 2.11.0 by reading the skill. The guard asks this module instead: it reads the `version` of the installed `pi-anchorloop` package.json, and a version it cannot find, read or
// parse, or one older than 2.11.0, refuses the train's and the integrator's `todo` and `MonitorCreate` calls with the reason. Where it looks: the agent folder's npm packages (`<agent>/npm/node_modules`), its git packages
// (`<agent>/git/<host>/<owner>/pi-anchorloop`), and the project's own (`<cwd>/.pi/npm/node_modules`); the newest it finds counts.

export const MIN_ANCHORLOOP = "2.11.0";
export type Anchorloop = { ok: true; version: string } | { ok: false; refusal: string };

/** `x.y.z` of a version, or undefined. A pre-release of a version ranks below it (`2.11.0-rc.1` is older than `2.11.0`). */
function parse(version: unknown): { nums: [number, number, number]; pre: boolean } | undefined {
	const found = typeof version === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim()) : null;
	return found ? { nums: [Number(found[1]), Number(found[2]), Number(found[3])], pre: found[4] !== undefined } : undefined;
}
/** Negative when `a` is older than `b`; undefined when either is no version. */
export function compareVersions(a: string, b: string): number | undefined {
	const [x, y] = [parse(a), parse(b)];
	if (!x || !y) return undefined;
	for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
	return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

const dirs = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };

/** Every `package.json` of `pi-anchorloop` the agent folder and the project hold. */
function candidates(agentDir: string, cwd?: string): string[] {
	const out = [join(agentDir, "npm", "node_modules", "pi-anchorloop", "package.json")];
	if (cwd) out.push(join(cwd, ".pi", "npm", "node_modules", "pi-anchorloop", "package.json"));
	for (const host of dirs(join(agentDir, "git"))) for (const owner of dirs(join(agentDir, "git", host))) out.push(join(agentDir, "git", host, owner, "pi-anchorloop", "package.json"));
	return out;
}

export function checkAnchorloop(o: { agentDir: string; cwd?: string; min?: string }): Anchorloop {
	const min = o.min ?? MIN_ANCHORLOOP, found: { file: string; version: string }[] = [], problems: string[] = [];
	for (const file of candidates(o.agentDir, o.cwd)) {
		let text: string;
		try { text = readFileSync(file, "utf8"); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file} cannot be read (${(error as Error).message})`);
			continue;
		}
		try {
			const version = (JSON.parse(text) as { version?: unknown }).version;
			if (parse(version)) found.push({ file, version: String(version) });
			else problems.push(`${file} has no version`);
		} catch { problems.push(`${file} cannot be parsed`); }
	}
	if (!found.length) return { ok: false, refusal: `sb: the merge train needs pi-anchorloop ${min} or newer, and its version cannot be read (${problems.length ? problems.join("; ") : `no pi-anchorloop package under ${join(o.agentDir, "npm", "node_modules")} or the project's .pi/npm`}); install it, then try again` };
	const newest = found.reduce((top, f) => (compareVersions(f.version, top.version)! > 0 ? f : top));
	return compareVersions(newest.version, min)! < 0
		? { ok: false, refusal: `sb: the merge train needs pi-anchorloop ${min} or newer, and ${newest.file} is ${newest.version}; update it and /reload, then try again` }
		: { ok: true, version: newest.version };
}
