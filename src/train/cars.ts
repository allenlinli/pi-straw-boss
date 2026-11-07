import { isCode, isObject, isName, isoTime, SHA_RE, shortCode } from "./spec.ts";

// A car's states and notices (docs/specs/2026-11-07-train-workers.md §5.5, D14), as data: which states a car has, the fields each carries, the car file they are appended to, the text of each notice, and when a notice counts as told.
// The train and the integrator only set a state; the sb server sends the intercom, records the broker's answer, and holds the step that depends on it (task 5a builds the tool and the sender). Pure: nothing here sends or writes.

export const CAR_STATES = ["received", "returned", "dropped", "landed"] as const;
export type CarState = (typeof CAR_STATES)[number];
export const TERMINAL_STATES = ["returned", "dropped", "landed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
/** Delays before the retries of a notice the broker did not deliver: 30 s, 2 min, 5 min (§5.5). */
export const RETRY_MS = [30_000, 120_000, 300_000] as const;
const MAX_REASON = 600;

const present = (value: unknown) => value !== undefined;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim() !== "" && value.length <= max;
const isTerminal = (state: string): state is TerminalState => (TERMINAL_STATES as readonly string[]).includes(state);

/** What each state carries, and how each field is read. */
const FIELDS: Record<CarState, { name: string; ok: (v: unknown) => boolean; help: string }[]> = {
	received: [
		{ name: "train", ok: isCode, help: "must be YYYY-MM-DD-<letters>" },
		{ name: "departs", ok: (v) => text(v, 300), help: "must be the departure conditions in words, at most 300 characters" },
	],
	returned: [{ name: "reason", ok: (v) => text(v, MAX_REASON), help: `must be 1 to ${MAX_REASON} characters` }],
	dropped: [
		{ name: "round", ok: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1, help: "must be a whole number from 1" },
		{ name: "reason", ok: (v) => text(v, MAX_REASON), help: `must be 1 to ${MAX_REASON} characters` },
		{ name: "evidence", ok: (v) => text(v, 1024), help: "must be a path of 1 to 1024 characters" },
	],
	landed: [
		{ name: "version", ok: (v) => text(v, 128), help: "must be a non-empty string" },
		{ name: "commit", ok: (v) => SHA_RE.test(String(v)), help: "must be 40 hex" },
	],
};

/** What a state is refused for, from the fields given with it. Whether the commit is on the base's remote branch, or the evidence path exists, is the tool's to check (it reads git and the disk). */
export function validateStateFields(state: CarState, fields: Record<string, unknown>): string[] {
	if (!(CAR_STATES as readonly string[]).includes(state)) return [`sb: state "${String(state)}" is not one of ${CAR_STATES.join(", ")}`];
	const spec = FIELDS[state], out: string[] = [];
	for (const { name, ok, help } of spec) {
		if (!present(fields[name]) || fields[name] === "") out.push(`sb: ${state} needs ${name}`);
		else if (!ok(fields[name])) out.push(`sb: ${state}.${name} ${help}`);
	}
	for (const key of Object.keys(fields)) if (present(fields[key]) && !spec.some((f) => f.name === key)) out.push(`sb: ${state}.${key} is not a field`);
	return out;
}

export interface Setter { role: "train" | "main"; name: string; session: string }
export type StateEntry = { state: CarState; at: string; by: Setter } & Record<string, unknown>;
export interface CarFile {
	v: 1; project: string; app: string;
	car: { tickets: string[]; branch: string; head: string };
	/** The session id the slip named and the tower's forward confirmed: the one every notice goes to. */
	coordinator: string;
	states: StateEntry[];
}

export function emptyCar(car: { project: string; app: string; tickets: string[]; branch: string; head: string; coordinator: string }): CarFile {
	return { v: 1, project: car.project, app: car.app, car: { tickets: [...car.tickets], branch: car.branch, head: car.head }, coordinator: car.coordinator, states: [] };
}

/** `<app>-<first 12 hex of the head>.json`: a car that comes back reworked has a new head and so a new file. */
export function carFileName(app: string, head: string): string {
	if (!isName(app)) throw new Error(`sb: app "${app}" is not a path-safe name`);
	if (!SHA_RE.test(head)) throw new Error(`sb: head "${head}" is not 40 hex`);
	return `${app}-${head.slice(0, 12)}.json`;
}

const label = (file: { car: { tickets: string[] } }) => file.car.tickets[0] ?? "?";

/** A second terminal state is refused, and `received` only comes first: the word of the refusal, or nothing. */
function sequence(states: readonly { state: string }[], next: string, car: string): string | undefined {
	if (next === "received" && states.some((s) => s.state === "received")) return `sb: car ${car} is already received`;
	const terminal = states.find((s) => isTerminal(s.state));
	return terminal && (isTerminal(next) || next === "received") ? `sb: car ${car} is already ${terminal.state}` : undefined;
}

/** The car file with one more state, or an error in the guard's words; the file given is not changed. */
export function addState(file: CarFile, set: { state: CarState; fields: Record<string, unknown>; by: Setter; at: string }): CarFile {
	const refusals = validateStateFields(set.state, set.fields);
	if (refusals.length) throw new Error(refusals.join("; "));
	if (!isoTime(set.at)) throw new Error("sb: at must be an ISO time with its zone");
	const refusal = sequence(file.states, set.state, label(file));
	if (refusal) throw new Error(refusal);
	return { ...file, states: [...file.states, { state: set.state, at: set.at, by: { ...set.by }, ...set.fields }] };
}

/** What a car file is refused for: its shape, each state's fields, and the order of the states. */
export function validateCarFile(value: unknown): string[] {
	if (!isObject(value)) return ["sb: car file must be an object"];
	const out = Object.keys(value).filter((k) => present(value[k]) && !["v", "project", "app", "car", "coordinator", "states"].includes(k)).map((k) => `sb: car.${k} is not a field`);
	if (value.v !== 1) out.push("sb: car.v must be 1");
	for (const key of ["project", "app"]) if (!(typeof value[key] === "string" && isName(value[key]))) out.push(`sb: car.${key} must be a path-safe name`);
	const car = isObject(value.car) ? value.car : undefined;
	if (!car) out.push("sb: car.car must be an object");
	else {
		if (!(Array.isArray(car.tickets) && car.tickets.length > 0 && car.tickets.every((t) => text(t, 64)))) out.push("sb: car.car.tickets must be a non-empty list of tickets");
		if (!text(car.branch, 255)) out.push("sb: car.car.branch must be a non-empty string");
		if (!SHA_RE.test(String(car.head))) out.push("sb: car.car.head must be 40 hex");
	}
	if (!text(value.coordinator, 128)) out.push("sb: car.coordinator must be a non-empty string");
	if (!Array.isArray(value.states)) return [...out, "sb: car.states must be an array"];
	const name = car && Array.isArray(car.tickets) ? String(car.tickets[0]) : "?", seen: { state: string }[] = [];
	value.states.forEach((entry, i) => {
		const at = `states[${i}]`;
		if (!isObject(entry)) return void out.push(`sb: ${at} must be an object`);
		const { state, at: when, by, ...fields } = entry;
		if (!isoTime(when)) out.push(`sb: ${at}.at must be an ISO time with its zone`);
		if (!isObject(by) || !text(by.name, 128) || !text(by.session, 128)) out.push(`sb: ${at}.by must name the session that set it`);
		else if (by.role !== "train" && by.role !== "main") out.push(`sb: ${at}.by.role must be train or main`);
		const refusals = validateStateFields(state as CarState, fields);
		out.push(...refusals.map((r) => r.replace(/^sb: /, `sb: ${at}: `)));
		if (!refusals.length || (CAR_STATES as readonly string[]).includes(state as string)) {
			const order = sequence(seen, String(state), name);
			if (order) out.push(order.replace(/^sb: /, `sb: ${at}: `));
		}
		seen.push({ state: String(state) });
	});
	return out;
}

export interface NoticeContext { ticket: string; head: string; train: string; departs?: string; reason?: string; round?: number; evidence?: string; version?: string; commit?: string }

/** The line the coordinator is sent for a state (the table of §5.5). */
export function noticeText(state: CarState, c: NoticeContext): string {
	const need = (field: keyof NoticeContext) => {
		const v = c[field];
		if (v === undefined || v === "") throw new Error(`sb: ${state} needs ${field}`);
		return String(v);
	};
	const head = c.head.slice(0, 12), train = shortCode(c.train);
	switch (state) {
		case "received": return `received: your car ${c.ticket} (${head}) rides train ${train}; it departs ${need("departs")}`;
		case "returned": return `returned: your car ${c.ticket} (${head}): ${need("reason")}`;
		case "dropped": return `dropped from train ${train} round ${need("round")}: ${need("reason")}; evidence ${need("evidence")}`;
		case "landed": return `landed in ${need("version")}, your commit is ${need("commit")}`;
	}
}

export type Outcome = "delivered" | "queued" | "failed" | "not-live" | "unknown";
export interface Attempt { at: string; outcome: Outcome; answer?: string }
export interface StateNotice { id?: string; attempts: Attempt[]; deliveredAt?: string; escalatedAt?: string }
/** `<car file>.notice.json`: per state, what the server sent and what the broker answered (the server is its one writer). */
export interface NoticeRecord { v: 1; states: Partial<Record<CarState, StateNotice>> }
export type NoticeStatus = { kind: "pending"; attempts: number; last?: string } | { kind: "delivered" | "escalated"; attempts: number; at: string };

/** A notice is told when the broker said `socket_delivered` (`deliveredAt`) or the tower was told the coordinator is gone (`escalatedAt`); queued, failed and unknown attempts are not. */
export function noticeStatus(record: NoticeRecord | undefined, state: CarState): NoticeStatus {
	const entry = record?.states[state], attempts = entry?.attempts ?? [];
	if (entry && isoTime(entry.deliveredAt)) return { kind: "delivered", attempts: attempts.length, at: entry.deliveredAt };
	if (entry && isoTime(entry.escalatedAt)) return { kind: "escalated", attempts: attempts.length, at: entry.escalatedAt };
	const last = attempts.at(-1);
	return last ? { kind: "pending", attempts: attempts.length, last: last.answer ?? last.outcome } : { kind: "pending", attempts: 0 };
}

/** The latest time a car file was changed; a file with no state yet is the oldest. */
const latest = (file: CarFile) => file.states.reduce((at, s) => (s.at > at ? s.at : at), "");

/**
 * The `notice` check (§6.3): every named car's terminal state is `state` and its notice is told. Returns what is still missing, in words; an empty list passes.
 * A ticket whose car came back is in several car files (§5.5: a new head, a new file); the one changed last is its current life, and two changed at the same time are refused, not guessed. `app` leaves out another app's car of the same ticket.
 */
export function noticeSatisfied(cars: readonly { file: CarFile; notice?: NoticeRecord }[], tickets: readonly string[], state: TerminalState, opts: { app?: string } = {}): string[] {
	return tickets.flatMap((ticket) => {
		const files = cars.filter((c) => c.file.car.tickets.includes(ticket) && (opts.app === undefined || c.file.app === opts.app));
		if (files.length === 0) return [`sb: car ${ticket} has no car file`];
		const newest = files.reduce((top, c) => (latest(c.file) > latest(top.file) ? c : top));
		const tied = files.filter((c) => latest(c.file) === latest(newest.file));
		if (tied.length > 1) return [`sb: car ${ticket} has ${tied.length} car files with the same latest state (heads ${tied.map((c) => c.file.car.head.slice(0, 12)).join(", ")}); one of them must change first`];
		const found = newest;
		const terminal = found.file.states.find((s) => isTerminal(s.state));
		if (!terminal) return [`sb: car ${ticket} has no terminal state yet`];
		if (terminal.state !== state) return [`sb: car ${ticket} is ${terminal.state}, not ${state}`];
		const status = noticeStatus(found.notice, state);
		if (status.kind !== "pending") return [];
		const tried = `${status.attempts} attempt${status.attempts === 1 ? "" : "s"}${status.last ? `, last: ${status.last}` : ""}`;
		return [`sb: waits for sb to tell ${found.file.coordinator} that car ${ticket} is ${state} (${tried})`];
	});
}
