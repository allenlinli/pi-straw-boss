import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The merge-train switch (boss, 2026-11-05: "往上游修：sb 在 desk 裡不套整合員規則"). `STRAW_BOSS_INTEGRATION=off` in the environment, or `"integration": "off"` in config.json of the
// state folder, takes the integrator rules out of what a session is told: the role prompts lose their integration text, and `{{dir}}` (the files an agent reads: apps-config.md, planning.md)
// points to a copy without it and without integrator.md. The environment wins; the default is on. Nothing else reads apps.json's `integration`, so the copy is the whole of "ignored".
// Prompt files mark the text: `<!-- integration -->…<!-- /integration -->` is dropped when off, `<!-- no-integration -->…<!-- /no-integration -->` is kept only when off (role prompts only: a file an agent reads raw would show it when on).

export const SWITCH = "STRAW_BOSS_INTEGRATION";
const OFF = new Set(["off", "false", "0", "no"]);
const isOff = (value: unknown) => value === false || (typeof value === "string" && OFF.has(value.trim().toLowerCase()));

/** Whether the merge train is off on this computer: a non-empty `STRAW_BOSS_INTEGRATION`, else `integration` in `<stateDir>/config.json`; a config that is missing or unreadable means on. */
export function integrationOff(env: NodeJS.ProcessEnv, stateDir: string): boolean {
	const set = env[SWITCH]?.trim();
	if (set) return isOff(set);
	try { return isOff((JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as Record<string, unknown>).integration); } catch { return false; }
}

/** `keep`: the blocks of that kind stay (their markers go), the others go whole. A block is whole lines, one whole line, or inline. */
function resolve(text: string, name: "integration" | "no-integration", keep: boolean): string {
	const open = `<!-- ${name} -->`, close = `<!-- /${name} -->`;
	const multi = new RegExp(`^${open}\\n([\\s\\S]*?)^${close}\\n?`, "gm"), line = new RegExp(`^${open}([^\\n]*?)${close}(\\n|$)`, "gm"), inline = new RegExp(`${open}([\\s\\S]*?)${close}`, "g");
	return text.replace(multi, keep ? "$1" : "").replace(line, keep ? "$1$2" : "").replace(inline, keep ? "$1" : "");
}

/** A prompt file as a session gets it: the integration blocks dropped when `off`, kept when on, and the off-only blocks the other way round. A marker left over is a file error. */
export function strip(text: string, off: boolean): string {
	const out = resolve(resolve(text, "integration", !off), "no-integration", off);
	const left = /<!--\s*\/?(?:no-)?integration\s*-->/.exec(out);
	if (left) throw new Error(`an unclosed or stray integration marker in a prompt file: ${left[0]}`);
	return out;
}

/**
 * The prompt files of one session. `read(name)` is `<name>.md` with the switch applied (placeholders untouched); `dir` is the folder `{{dir}}` names, and when off it is the copy, made at the first use
 * (so a tower run, which reads one role prompt, writes nothing).
 */
export function promptSet({ promptDir, stateDir, env }: { promptDir: string; stateDir: string; env: NodeJS.ProcessEnv }) {
	const off = integrationOff(env, stateDir);
	const read = (name: string) => strip(readFileSync(join(promptDir, `${name}.md`), "utf8").trim(), off);
	let copy: string | undefined;
	return {
		off, read,
		get dir(): string {
			if (!off) return promptDir;
			return (copy ??= copyWithout(promptDir, join(stateDir, "prompts-off")));
		},
	};
}
export type PromptSet = ReturnType<typeof promptSet>;

/** Rewritten at each load, so a new release or a changed prompt reaches the copy; a file by rename, so a session that reads it meanwhile sees the old or the new, never half. integrator.md is not copied. */
function copyWithout(promptDir: string, dir: string): string {
	mkdirSync(dir, { recursive: true });
	const names = readdirSync(promptDir).filter((file) => file.endsWith(".md") && file !== "integrator.md");
	for (const file of readdirSync(dir)) if (file.endsWith(".md") && !names.includes(file)) rmSync(join(dir, file), { force: true });
	for (const file of names) {
		const temp = join(dir, `.${file}.${process.pid}.tmp`);
		writeFileSync(temp, strip(readFileSync(join(promptDir, file), "utf8"), true));
		renameSync(temp, join(dir, file));
	}
	return dir;
}
