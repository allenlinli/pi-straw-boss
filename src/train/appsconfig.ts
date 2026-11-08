import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkStages, parseAppAccept } from "./accept.ts";
import { isObject } from "./spec.ts";

// What the code reads of an app in `.straw-boss/apps.json` before it lets a car depart (docs/specs/2026-11-07-train-workers.md §14, TB-F001, TB-F002): the kinds of acceptance the app requires (`integration.accept`) and its `stages`, which may no longer list
// `uat`. The integrator's guard, the train's manifest check, the train open and `train check` all read it here, so the requirement is the file's and not a flag a model passes. A file or an app that cannot be read is a refusal naming the file, never an empty list.

const MIGRATION = "see docs/how-it-works.md, Moving a project to 0.65.0";

export type Apps = { ok: true; file: string; apps: Record<string, unknown>[]; missing?: undefined } | { ok: false; file: string; refusal: string; missing?: true };

/** The `apps` list of `<dir>/.straw-boss/apps.json` (empty when the file names none). A file that is not there is `missing`; one that cannot be read or parsed, or whose `apps` is no list, is a refusal. */
export function readApps(dir: string): Apps {
	const file = join(dir, ".straw-boss", "apps.json");
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return { ok: false, file, refusal: `${file} ${missing ? "is not there" : `cannot be read (${(error as Error).message})`}, so integration.accept of the app is unknown`, ...(missing ? { missing: true as const } : {}) };
	}
	let config: unknown;
	try { config = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (error) { return { ok: false, file, refusal: `${file} cannot be parsed (${(error as Error).message}), so integration.accept of the app is unknown` }; }
	const apps = isObject(config) ? config.apps : undefined;
	if (apps !== undefined && !Array.isArray(apps)) return { ok: false, file, refusal: `${file}: apps must be a list, so integration.accept of the app is unknown` };
	return { ok: true, file, apps: (apps ?? []).filter(isObject) };
}

/** The refusals of one app's `integration`: `stages` that list `uat` (or are otherwise wrong) and an `accept` that is not a list of kind names. */
function integrationRefusals(file: string, name: string, integration: Record<string, unknown>): string[] {
	const out = checkStages(integration.stages).map((r) => `${file}: app ${name}: ${r.replace(/^sb: /, "")} (${MIGRATION}, step 2)`);
	const accept = parseAppAccept(integration.accept);
	if (!accept.ok) out.push(`${file}: app ${name}: ${accept.refusal.replace(/^sb: /, "")}`);
	return out;
}

export type AppIntegration = { ok: true; accept: string[] } | { ok: false; refusal: string };

/** `integration.accept` of the app `app` in `<dir>/.straw-boss/apps.json`, after its `stages` and `accept` passed. Fails closed: a file, an app, or an `integration` that is not there is a refusal. */
export function readAppIntegration(dir: string, app: string): AppIntegration {
	const read = readApps(dir);
	if (!read.ok) return { ok: false, refusal: `sb: ${read.refusal}` };
	const entry = read.apps.find((a) => a.name === app);
	if (!entry) return { ok: false, refusal: `sb: ${read.file} has no app named ${app}, so integration.accept of the app is unknown` };
	if (!isObject(entry.integration)) return { ok: false, refusal: `sb: ${read.file}: app ${app} has no integration, so it takes no train` };
	const refusals = integrationRefusals(read.file, app, entry.integration), accept = parseAppAccept(entry.integration.accept);
	return refusals.length || !accept.ok ? { ok: false, refusal: `sb: ${refusals.join("; ")}` } : { ok: true, accept: accept.accept };
}

/**
 * The refusal of a train open (§14.2): the `stages` or `accept` of the manifest's app, or of every app with an `integration` when the manifest names none. A file that is not there refuses nothing here (the open reads `maxTrains` the same way, and
 * the guard of the integrator refuses a car whose app it cannot read); one that exists and cannot be read or parsed refuses.
 */
export function openRefusal(dir: string, app: string | undefined): string | undefined {
	const read = readApps(dir);
	if (!read.ok) return read.missing ? undefined : `sb: ${read.refusal}`;
	const named = app === undefined ? read.apps : read.apps.filter((a) => a.name === app);
	const out = named.flatMap((a) => (isObject(a.integration) ? integrationRefusals(read.file, String(a.name), a.integration) : []));
	return out.length ? `sb: ${out.join("; ")}` : undefined;
}
