import { acceptanceWord, isObject, isoTime, isName, kb, SHA_RE } from "./spec.ts";

// What a coordinator hands the train and what `train check --accept` proves about it (docs/specs/2026-11-07-train-workers.md §5.1 to §5.4): the slip's `departs` and `accept` lines, the acceptance evidence file, and
// `integration.accept` and `stages` of apps.json. Acceptance happens before loading (D11), so a slip or evidence that asks the train for any is refused at once with `acceptanceWord` (D13). Pure: the files and git come in as functions.
// The check proves the evidence is complete, names the car's head, and points at files that exist; it does not prove the boss said the quoted nod (§16).

export { acceptanceWord };
export const MAX_EVIDENCE_BYTES = 32 * 1024;
const KINDS = ["e2e", "uat", "other"];
const ENTRY_FIELDS = ["kind", "label", "what", "on", "result", "evidence", "at", "nod", "delta"];
/** Fields of an entry that name something still to be run: a request, not evidence. */
const TO_DO = ["check", "run", "page", "checkpoints"];
const PENDING = /^(pending|todo|tbd|waiting|open|not[ _-]?run)$/i;
const present = (value: unknown) => value !== undefined;
const text = (value: unknown, max = 1000): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;

// ---- the slip

export interface ParsedSlip { fields: Record<string, string>; tickets: string[] }

/** Splits at ` | ` outside double quotes and parentheses, so a quoted `auth` or a parenthesised `light` keeps its pipes. */
function segments(line: string): string[] {
	const out: string[] = [];
	let depth = 0, quoted = false, from = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') quoted = !quoted;
		else if (!quoted && c === "(") depth++;
		else if (!quoted && c === ")") depth = Math.max(0, depth - 1);
		else if (!quoted && depth === 0 && c === "|" && line[i - 1] === " " && line[i + 1] === " ") out.push(line.slice(from, i - 1)), (from = i + 2);
	}
	out.push(line.slice(from));
	return out;
}

/** The slip's block: lines of `key: value` segments joined by ` | `. A key seen again is ignored (the first stands); a segment with no key belongs to nothing. */
export function parseSlip(slip: string): ParsedSlip {
	const fields: Record<string, string> = {};
	for (const line of slip.split(/\r?\n/)) for (const segment of segments(line)) {
		const m = /^\s*([a-z][a-z0-9-]*):[ \t]*([^]*)$/.exec(segment);
		if (m && !(m[1]! in fields)) fields[m[1]!] = m[2]!.trim();
	}
	const tickets = (fields.tickets ?? "").replace(/\([^)]*\)/g, " ").split(/[\s,]+/).filter(Boolean);
	return { fields, tickets };
}

export interface Departs { mode: "next" | "alone" | "with"; with?: string; after?: string; by?: string }
export type DepartsResult = { ok: true; departs: Departs } | { ok: false; refusal: string };

/** The `departs:` line, comma separated: one ride (`next`, `alone`, `with <ticket or branch>`) and optionally `after` and `by` an ISO time. No line means `next`. */
export function parseDeparts(value: string | undefined): DepartsResult {
	const refuse = (what: string): DepartsResult => ({ ok: false, refusal: `sb: departs: ${what}` });
	const departs: Departs = { mode: "next" };
	let ride = false;
	for (const item of (value ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
		const word = item.toLowerCase();
		if (word === "next" || word === "alone" || /^with(\s|$)/.test(word)) {
			if (ride) return refuse("choose one of next, alone or with");
			ride = true;
			if (word === "with" || /^with\s*$/.test(word)) return refuse('"with" needs a ticket or branch');
			if (/^with\s/.test(word)) Object.assign(departs, { mode: "with", with: item.replace(/^with\s+/i, "") });
			else departs.mode = word as "next" | "alone";
			continue;
		}
		const time = /^(after|by)(?:\s+(.*))?$/i.exec(item);
		if (!time) return refuse(`"${item}" is not one of next, alone, with <ticket or branch>, after <ISO time>, by <ISO time>`);
		const key = time[1]!.toLowerCase() as "after" | "by";
		if (!isoTime(time[2])) return refuse(`${key} needs an ISO time with its zone, such as 2026-11-07T09:00:00Z`);
		if (departs[key]) return refuse(`${key} twice`);
		departs[key] = time[2]!;
	}
	if (departs.after && departs.by && Date.parse(departs.after) > Date.parse(departs.by)) return refuse("after is later than by");
	return { ok: true, departs };
}

/** `accept: none` is allowed only for an app whose `integration.accept` is empty. */
export function checkAcceptRef(value: string | undefined, appAccept: readonly string[]): string[] {
	if (value === undefined) return ["sb: the slip has no accept: line; send accept: <evidence file> | none"];
	if (value.trim() === "") return ["sb: accept: is empty; send accept: <evidence file> | none"];
	if (value.trim().toLowerCase() === "none" && appAccept.length > 0) return [`sb: accept: none is allowed only for an app whose integration.accept is empty (this app requires ${appAccept.join(", ")})`];
	return [];
}

/** Whether free text asks the train to accept a car, on the train or after deploy; returns the word it asked for. A target named `uat-env` or a light check that ran e2e asks nothing. */
function asksTrain(value: string): string | undefined {
	const what = /\b(?:uat|e2e|acceptance|accept)\b|驗收/i.exec(value)?.[0];
	const where = /\b(?:after|post)[- ]?(?:the )?(?:deploy(?:ment)?|merge|landing|release)\b|\b(?:on|by) the train\b|\btrain (?:runs?|does|to run|to do|should|must|will|handles?)\b|\bat deploy\b|部署後|上線後|合併後|火車/i;
	return what && where.test(value) ? what : undefined;
}

const NOT_SCANNED = new Set(["car", "branch", "head", "tested-on", "auth", "coordinator", "departs", "accept", "uat"]);
const base = (path: string) => path.split(/[\\/]/).pop() ?? path;
const namesCheckpoints = (path: string) => base(path).toLowerCase().split(/[^a-z0-9]+/).some((token) => /^(checkpoints?|conditions?)$/.test(token));

export interface SlipOptions { appAccept: readonly string[] }

/** The refusals of the slip itself: its head and tickets, `departs`, `accept`, an old `uat:` line, and free text that asks the train for acceptance. */
export function checkSlip(slip: string, { appAccept }: SlipOptions): string[] {
	const { fields, tickets } = parseSlip(slip), out: string[] = [], car = tickets[0] ?? fields.branch ?? "unknown";
	if (!SHA_RE.test(fields.head ?? "")) out.push("sb: slip head must be 40 hex");
	if (tickets.length === 0) out.push("sb: slip tickets is empty");
	if (present(fields.uat)) {
		if (fields.uat!.toLowerCase() === "none") out.push("sb: the slip's uat: line is gone; send accept: <evidence file> | none");
		else out.push(acceptanceWord({ car, what: `UAT (${fields.uat})`, where: "slip line uat:" }));
	}
	const accept = fields.accept;
	if (accept !== undefined && accept.toLowerCase() !== "none" && accept !== "") {
		if (namesCheckpoints(accept)) out.push(acceptanceWord({ car, what: `checkpoints or conditions (${accept})`, where: "slip line accept:" }));
		else if (!/\.json$/i.test(accept)) out.push(`sb: accept: ${accept} is not an evidence file (.json)`);
	} else out.push(...checkAcceptRef(accept, appAccept));
	if (present(fields.departs)) {
		const parsed = parseDeparts(fields.departs);
		if (!parsed.ok) out.push(parsed.refusal);
	}
	for (const [key, value] of Object.entries(fields)) {
		const what = NOT_SCANNED.has(key) ? undefined : asksTrain(value);
		if (what !== undefined) out.push(acceptanceWord({ car, what, where: `slip field ${key}` }));
	}
	return out;
}

// ---- the evidence file

export interface EvidenceOptions {
	appAccept: readonly string[];
	/** The slip's head: the car's head every entry and `car.head` must name. Left out, `car.head` is the car's. */
	head?: string;
	exists: (path: string) => boolean;
	/** Whether the first commit is an ancestor of the second, as `git merge-base --is-ancestor` says. */
	isAncestor: (older: string, newer: string) => boolean;
}

function entryRefusals(entry: unknown, n: number, car: string, ref: string | undefined, o: EvidenceOptions): string[] {
	const at = `sb: evidence entry ${n}:`;
	if (!isObject(entry)) return [`${at} must be an object`];
	const out: string[] = [], kind = typeof entry.kind === "string" ? entry.kind : "acceptance";
	for (const key of Object.keys(entry)) if (present(entry[key]) && !ENTRY_FIELDS.includes(key)) {
		if (TO_DO.includes(key)) out.push(acceptanceWord({ car, what: kind, where: `evidence entry ${n}: ${key} to be done` }));
		else out.push(`${at} ${key} is not a field`);
	}
	if (!KINDS.includes(entry.kind as string)) out.push(`${at} kind must be e2e, uat or other`);
	else if (entry.kind === "other" && !text(entry.label, 64)) out.push(`${at} kind other needs a label`);
	if (!text(entry.what, 300)) out.push(`${at} what is empty`);
	const result = entry.result;
	if (!present(result) || (typeof result === "string" && PENDING.test(result))) out.push(acceptanceWord({ car, what: kind, where: `evidence entry ${n}: result ${present(result) ? String(result) : "missing"}` }));
	else if (result !== "passed" && result !== "accepted") out.push(`${at} result must be passed or accepted (got ${JSON.stringify(result)})`);
	const on = isObject(entry.on) ? entry.on : undefined;
	if (!SHA_RE.test(String(on?.head))) out.push(`${at} on.head must be 40 hex`);
	else if (ref !== undefined) {
		const same = on!.head === ref;
		if (present(entry.delta)) {
			if (same) out.push(`${at} delta only goes with an on.head that is an ancestor of the car's head`);
			else if (!o.isAncestor(on!.head as string, ref)) out.push(`${at} on.head is not the car's head`);
			else if (!text(entry.delta) || !o.exists(entry.delta)) out.push(`${at} delta ${String(entry.delta)} does not exist`);
		} else if (!same) out.push(`${at} on.head is not the car's head`);
	}
	if (!text(entry.evidence)) out.push(`${at} evidence is empty`);
	else if (!o.exists(entry.evidence)) out.push(`${at} evidence ${entry.evidence} does not exist`);
	if (!isoTime(entry.at)) out.push(`${at} at must be an ISO time with its zone`);
	if (!text(entry.nod, 2000)) out.push(`${at} nod is empty`);
	return out;
}

/** Whether an evidence file is complete for what the app requires, names the car's head, and points at files that exist (§5.2). */
export function checkEvidence(raw: string, o: EvidenceOptions): string[] {
	const bytes = Buffer.byteLength(raw);
	if (bytes > MAX_EVIDENCE_BYTES) return [`sb: evidence file is ${kb(bytes)} KB, more than ${MAX_EVIDENCE_BYTES / 1024}`];
	let file: unknown;
	try {
		file = JSON.parse(raw);
	} catch (error) {
		return [`sb: evidence file is not JSON (${(error as Error).message})`];
	}
	if (!isObject(file)) return ["sb: evidence file must be a JSON object"];
	const out: string[] = [], car = isObject(file.car) ? file.car : undefined;
	const ticket = Array.isArray(car?.tickets) && typeof car!.tickets[0] === "string" ? (car!.tickets[0] as string) : "unknown";
	for (const old of ["conditions", "checkpoints"]) if (present(file[old])) out.push(acceptanceWord({ car: ticket, what: `UAT ${old}`, where: `evidence file: top-level ${old}, the old format` }));
	for (const key of Object.keys(file)) if (present(file[key]) && !["v", "car", "accepted", "conditions", "checkpoints"].includes(key)) out.push(`sb: evidence.${key} is not a field`);
	if (file.v !== 1) out.push("sb: evidence.v must be 1");
	if (!car) out.push("sb: evidence.car must be an object");
	else {
		for (const key of Object.keys(car)) if (present(car[key]) && !["app", "tickets", "branch", "head"].includes(key)) out.push(`sb: evidence.car.${key} is not a field`);
		if (!(isName(car.app))) out.push("sb: evidence.car.app must be a path-safe name");
		if (!(Array.isArray(car.tickets) && car.tickets.length > 0 && car.tickets.every((t) => text(t, 64)))) out.push("sb: evidence.car.tickets must be a non-empty list of tickets");
		if (!text(car.branch, 255)) out.push("sb: evidence.car.branch must be a non-empty string");
		if (!SHA_RE.test(String(car.head))) out.push("sb: evidence.car.head must be 40 hex");
		else if (o.head !== undefined && car.head !== o.head) out.push("sb: evidence.car.head is not the slip's head");
	}
	if (!Array.isArray(file.accepted)) {
		out.push("sb: evidence.accepted must be an array");
		return out;
	}
	const ref = o.head ?? (SHA_RE.test(String(car?.head)) ? (car!.head as string) : undefined);
	file.accepted.forEach((entry, i) => out.push(...entryRefusals(entry, i + 1, ticket, ref, o)));
	const entries = file.accepted.filter(isObject);
	for (const required of o.appAccept) if (!entries.some((e) => e.kind === required || (e.kind === "other" && e.label === required)))
		out.push(`sb: acceptance evidence lacks a ${required} entry (the app requires ${o.appAccept.join(", ")})`);
	return out;
}

export interface CarOptions extends EvidenceOptions {}

/** The slip and its evidence together, as the coordinator checks before it sends and the integrator at receipt. `evidence` is the text of the file the slip's `accept:` names, read by the caller. */
export function checkCar(slip: string, evidence: string | undefined, o: Omit<CarOptions, "head"> & { head?: string }): string[] {
	const out = checkSlip(slip, o), { fields } = parseSlip(slip), accept = fields.accept;
	const isFile = accept !== undefined && !namesCheckpoints(accept) && /\.json$/i.test(accept);
	if (!isFile) return out;
	if (evidence === undefined) out.push(`sb: accept: ${accept} names an evidence file, but it was not read`);
	else out.push(...checkEvidence(evidence, { ...o, head: SHA_RE.test(fields.head ?? "") ? fields.head : undefined }));
	return out;
}

// ---- apps.json

export type AcceptSetting = { ok: true; accept: string[] } | { ok: false; refusal: string };

/** `integration.accept` of an app: the kinds of acceptance a car of it must show evidence of; none by default. */
export function parseAppAccept(value: unknown): AcceptSetting {
	if (value === undefined) return { ok: true, accept: [] };
	const refusal = "sb: integration.accept must be a list of kind names (a-z, 0-9, -; 1 to 32 characters; no repeats)";
	if (!Array.isArray(value) || !value.every((k) => typeof k === "string" && /^[a-z0-9-]{1,32}$/.test(k)) || new Set(value).size !== value.length) return { ok: false, refusal };
	return { ok: true, accept: [...value] };
}

/** An app's `stages` list `merge`, then optionally `deploy`; `uat` moved to `integration.accept` and is a config error (§14.2). */
export function checkStages(stages: unknown): string[] {
	if (stages === undefined) return [];
	if (!Array.isArray(stages)) return ["sb: stages must be a list (merge, then optionally deploy)"];
	const out: string[] = [];
	if (stages.includes("uat")) out.push('sb: stages lists "uat"; move it to integration.accept (a coordinator accepts before loading) and remove it from stages');
	if (stages[0] !== "merge") out.push("sb: stages must start with merge");
	stages.forEach((stage, i) => {
		if (stage === "uat") return;
		if (stage !== "merge" && stage !== "deploy") out.push(`sb: stage "${String(stage)}" is not one of merge, deploy`);
		else if (stages.indexOf(stage) !== i) out.push(`sb: stage "${stage}" twice`);
	});
	return out;
}
