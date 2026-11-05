import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The merge-train switch (boss, 2026-11-05: "往上游修：sb 在 desk 裡不套整合員規則"). `STRAW_BOSS_INTEGRATION=off` in the environment, or `"integration": "off"` in config.json of the
// state folder, takes the integrator rules out of what a session is told: the role prompts lose their integration text, and `{{dir}}` (the files an agent reads: apps-config.md, planning.md)
// points to a copy without it and without integrator.md. The environment wins; the default is on, off under the desk (`STRAW_BOSS_DESK=1`), and an unreadable setting is off. Nothing else reads apps.json's `integration`, so the copy is the whole of "ignored".
// Prompt files mark the text: `<!-- integration -->…<!-- /integration -->` is dropped when off, `<!-- no-integration -->…<!-- /no-integration -->` is kept only when off (role prompts only: a file an agent reads raw would show it when on).

export const SWITCH = "STRAW_BOSS_INTEGRATION";
const ON = new Set(["on", "true", "1", "yes"]);
const OFF = new Set(["off", "false", "0", "no"]);
/** `true`/`false` for a known value, undefined for anything else. */
function parseOn(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	const word = typeof value === "string" ? value.trim().toLowerCase() : undefined;
	return word === undefined ? undefined : ON.has(word) ? true : OFF.has(word) ? false : undefined;
}

export interface SwitchState { off: boolean; /** Set when the user clearly tried to set the switch and the value could not be read: the switch is off, and this says why. */ problem?: string }

/**
 * Whether the merge train is off on this computer, and a problem to tell when the setting was unreadable. A non-empty `STRAW_BOSS_INTEGRATION` wins, else `integration` in `<stateDir>/config.json`
 * (a BOM is ignored), else off under the desk (`STRAW_BOSS_DESK=1`) and on elsewhere. The switch fails closed: a value that is present and not on/true/1/yes or off/false/0/no, and a config.json that
 * exists but cannot be read or parsed, turn the train off.
 */
export function switchState(env: NodeJS.ProcessEnv, stateDir: string): SwitchState {
	const set = env[SWITCH]?.trim();
	if (set) {
		const on = parseOn(set);
		return on === undefined ? { off: true, problem: `${SWITCH}=${JSON.stringify(set)} is not on or off; integration is off` } : { off: !on };
	}
	const file = join(stateDir, "config.json");
	let text: string | undefined;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { off: true, problem: `${file} cannot be read (${(error as Error).message}); integration is off` };
	}
	if (text !== undefined) {
		let value: unknown;
		try {
			const config = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
			if (typeof config !== "object" || config === null || Array.isArray(config)) throw new Error("not a JSON object");
			value = (config as Record<string, unknown>).integration;
		} catch (error) { return { off: true, problem: `${file} cannot be parsed (${(error as Error).message}); integration is off` }; }
		if (value !== undefined) {
			const on = parseOn(value);
			return on === undefined ? { off: true, problem: `${file}: "integration": ${JSON.stringify(value)} is not on or off; integration is off` } : { off: !on };
		}
	}
	return { off: env.STRAW_BOSS_DESK === "1" };
}
export const integrationOff = (env: NodeJS.ProcessEnv, stateDir: string) => switchState(env, stateDir).off;

/** `keep`: the blocks of that kind stay (their markers go), the others go whole. A block is whole lines, one whole line, or inline. */
function resolve(text: string, name: "integration" | "no-integration", keep: boolean): string {
	const open = `<!-- ${name} -->`, close = `<!-- /${name} -->`;
	const multi = new RegExp(`^${open}\\n([\\s\\S]*?)^${close}\\n?`, "gm"), line = new RegExp(`^${open}([^\\n]*?)${close}(\\n|$)`, "gm"), inline = new RegExp(`${open}([\\s\\S]*?)${close}`, "g");
	return text.replace(multi, keep ? "$1" : "").replace(line, keep ? "$1$2" : "").replace(inline, keep ? "$1" : "");
}

/** Every marker must be exactly `<!-- [no-]integration -->` / `<!-- /[no-]integration -->`, in blocks that neither nest nor cross; anything else is a file error, on or off. */
function checkMarkers(text: string): void {
	let open: string | undefined;
	for (const found of text.matchAll(/<!--\s*(\/?)((?:no-)?integration)\s*-->/gi)) {
		const [marker, slash, name] = found;
		if (marker !== `<!-- ${slash}${name} -->` || name !== name.toLowerCase()) throw new Error(`a malformed integration marker in a prompt file: ${marker}`);
		if (!slash && open) throw new Error(`a nested integration marker in a prompt file: ${marker} inside <!-- ${open} -->`);
		if (!slash) open = name;
		else if (open !== name) throw new Error(`an unclosed or stray integration marker in a prompt file: ${marker}`);
		else open = undefined;
	}
	if (open) throw new Error(`an unclosed or stray integration marker in a prompt file: <!-- ${open} -->`);
}

/** A prompt file as a session gets it: the integration blocks dropped when `off`, kept when on, and the off-only blocks the other way round. A marker left over, nested, crossed, or malformed is a file error. */
export function strip(text: string, off: boolean): string {
	checkMarkers(text);
	return resolve(resolve(text, "integration", !off), "no-integration", off);
}

const told = new Set<string>();
/** Tells a problem once per process, however many sessions or turns read the switch. */
const tellOnce = (warn: ((text: string) => void) | undefined, text: string) => { if (!told.has(text)) (told.add(text), warn?.(text)); };

/**
 * The prompt files of one session. `read(name)` is `<name>.md` with the switch applied (placeholders untouched); `dir` is the folder `{{dir}}` names, and when off it is the copy, made at the first use
 * (so a tower run, which reads one role prompt, writes nothing); when the copy cannot be made, `warn` says so and `dir` is undefined. When on, a copy left by an earlier off is removed.
 */
export function promptSet({ promptDir, stateDir, env, warn }: { promptDir: string; stateDir: string; env: NodeJS.ProcessEnv; warn?: (text: string) => void }) {
	const { off, problem } = switchState(env, stateDir), copyDir = join(stateDir, "prompts-off");
	if (problem) tellOnce(warn, problem);
	if (!off) try { rmSync(copyDir, { recursive: true, force: true }); } catch { /* a stale copy is harmless: nothing points to it */ }
	const read = (name: string) => strip(readFileSync(join(promptDir, `${name}.md`), "utf8").trim(), off);
	let copy: { dir?: string } | undefined;
	return {
		off, read,
		get dir(): string | undefined {
			if (!off) return promptDir;
			if (!copy) {
				try { copy = { dir: copyWithout(promptDir, copyDir) }; } catch (error) {
					copy = {};
					tellOnce(warn, `Straw Boss could not write ${copyDir} (${(error as Error).message}); the prompts name no folder for apps-config.md and planning.md, and integration stays off`);
				}
			}
			return copy.dir;
		},
	};
}
export type PromptSet = ReturnType<typeof promptSet>;

/** Brings the copy in line with the sources at each load: a file is rewritten (by rename, so a session that reads it meanwhile sees the old or the new, never half) when its text differs, and a file no source has, integrator.md, or a temp file left by a crash is removed. */
function copyWithout(promptDir: string, dir: string): string {
	mkdirSync(dir, { recursive: true });
	const names = readdirSync(promptDir).filter((file) => file.endsWith(".md") && file !== "integrator.md");
	for (const file of readdirSync(dir)) if (file.endsWith(".tmp") || (file.endsWith(".md") && !names.includes(file))) rmSync(join(dir, file), { force: true });
	for (const file of names) {
		const text = strip(readFileSync(join(promptDir, file), "utf8"), true);
		let current: string | undefined;
		try { current = readFileSync(join(dir, file), "utf8"); } catch { /* not there yet */ }
		if (current === text) continue;
		const temp = join(dir, `.${file}.${process.pid}.tmp`);
		writeFileSync(temp, text);
		renameSync(temp, join(dir, file));
	}
	return dir;
}
