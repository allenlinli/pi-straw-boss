import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { carsDir, trainboardDir } from "../train/board.ts";
import { addState, type CarFile, carFileName, type CarState, type CarView, coordinatorWord, emptyCar, headsIn, type NoticeRecord, type Setter, type StateEntry, type StateNotice, validateStateFields } from "../train/cars.ts";
import { isCode, isName, isObject, SHA_RE } from "../train/spec.ts";
import { readCars, writePrivate } from "../trainboard.ts";

// The server's book of cars (docs/specs/2026-11-07-train-workers.md §5.5, §23; todo #125 task 5a). Every car state is set here, and every check that rests on a state or a notice asks here. The train's shell runs as the same user and can open the
// control socket and write any file under the state folder, so nothing is taken on a caller's word:
//   - A request carries a per-session secret that `register` handed to the pi process once. The secret lives only in that process's memory (never env, argv, a file or tool output), and `register` answers it only once per process: a shell that asks later is
//     refused. Who sets a state is read from the registration and from Herdr's own record of the session's pane, never from the payload.
//   - The facts of each state are read by the server: a car belongs to a train when the integrator's `received` named that train; `received` and the receipt `returned` need a tower's forward of that very slip to the setter (the server stamped it); `landed`
//     is a commit that git, run here, finds on the remote branch of the base the server read from the manifest it was handed at the open.
//   - The car files and notice records on disk are this server's journal. It reads them at its start and never again while it runs; the guard asks the server (`read`), never the files.

const KEEP_MS = 24 * 3600_000, MAX_FORWARDS = 512, MAX_FILES = 256, MAX_TRAIN_RECORDS = 256;
const BASE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export const refusal = (text: string) => new Error(text);

/** What the server knows of a session from the broker and Herdr: the pane token role, the train token, the pane and its folder, and the pids of the pane's foreground processes (pi is one). */
export interface Look { id: string; name: string; role?: string; train?: { project: string; code: string }; pane: string; workspace?: string; cwd?: string; foreground: number[] }

export interface BookDeps {
	/** The state folder: the trainboard (the journal) lives under it. */
	stateDir: string;
	/** The server's own folder: where the book keeps what a restart must not lose (forwards, trains). */
	dir: string;
	now(): number;
	look(session: string): Promise<Look | undefined>;
	/** The start time of a process, in the form `register` was given; undefined when it cannot be told. */
	startOf?(pid: number): string | undefined;
	/** git in a folder; rejects when git exits non-zero. */
	git(cwd: string, args: string[]): Promise<string>;
	exists(path: string): boolean;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
	/** 32 random bytes in hex (tests give a fixed one). */
	secret?(): string;
	/** Called when a state was added: the sender looks at once. */
	onChange?(): void;
}

/** A train the tower opened: what the server read from the manifest the integrator sent (§5.3) and the open's own result. */
export interface TrainRecord { project: string; code: string; session: string; pane: string; integrator: string; base?: string; at: string }
/** A forward the tower's code stamped (runtools.ts): the event it came in, the session that sent it there, the sessions it went to, and the slip heads it carries. */
export interface ForwardRecord { fwd: string; from: string; to: string[]; heads: string[]; at: number }
interface Registration { session: string; pid: number; started?: string; pane: string; cwd?: string; at: number }

export interface CarRef { project?: string; app: string; head: string; tickets?: string[]; branch?: string; coordinator?: string }
export interface SetRequest { secret: unknown; state: CarState; car: CarRef; fields?: Record<string, unknown> }
export interface SetResult { state: CarState; at: string; file: string; coordinator: string }
interface Held { file: CarFile; notice?: NoticeRecord }

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const iso = (ms: number) => new Date(ms).toISOString();
const noticeName = (name: string) => name.replace(/\.json$/, ".notice.json");
const firstLine = (error: unknown) => String((error as { stderr?: unknown }).stderr || (error as Error).message).trim().split("\n")[0]!.slice(0, 200);

export class CarBook {
	private readonly cars = new Map<string, Map<string, Held>>();
	private readonly regs = new Map<string, Registration>();
	private readonly bySession = new Map<string, string>();
	private forwards: ForwardRecord[] = [];
	private readonly trains = new Map<string, TrainRecord>();
	private chain: Promise<unknown> = Promise.resolve();
	private readonly d: BookDeps;

	constructor(deps: BookDeps) {
		this.d = deps;
		this.loadState();
		this.loadCars();
	}

	// ---- what a restart keeps

	private get stateFile() { return join(this.d.dir, "cars-book.json"); }
	private loadState() {
		try {
			const value = JSON.parse(readFileSync(this.stateFile, "utf8")) as unknown;
			if (!isObject(value) || value.v !== 1) return;
			if (Array.isArray(value.forwards)) this.forwards = value.forwards.filter((f): f is ForwardRecord => isObject(f) && text(f.fwd, 32) && text(f.from, 128) && Array.isArray(f.to) && Array.isArray(f.heads) && typeof f.at === "number").slice(-MAX_FORWARDS);
			if (Array.isArray(value.trains)) for (const t of value.trains) if (isObject(t) && isName(t.project) && isCode(t.code) && text(t.session, 128) && text(t.pane, 64) && text(t.integrator, 128)) this.trains.set(`${t.project}/${t.code}`, t as unknown as TrainRecord);
		} catch { /* a book that was never written */ }
	}
	private saveState() {
		const trains = [...this.trains.values()].slice(-MAX_TRAIN_RECORDS);
		try { writePrivate(this.stateFile, `${JSON.stringify({ v: 1, forwards: this.forwards, trains })}\n`, this.d.dir); } catch (error) { this.d.log?.("cars-state", { error: (error as Error).message.slice(0, 200) }); }
	}
	private loadCars() {
		let projects: string[] = [];
		try { projects = readdirSync(trainboardDir(this.d.stateDir)).filter((n) => isName(n)); } catch { return; }
		for (const project of projects) {
			const held = new Map<string, Held>();
			for (const view of readCars(this.d.stateDir, project)) held.set(carFileName(view.file.app, view.file.car.head), { file: view.file, ...(view.notice ? { notice: view.notice } : {}) });
			if (held.size) this.cars.set(project, held);
		}
	}
	private writeCar(project: string, name: string, held: Held) {
		const dir = carsDir(this.d.stateDir, project), root = trainboardDir(this.d.stateDir);
		writePrivate(join(dir, name), `${JSON.stringify(held.file)}\n`, root);
		if (held.notice) writePrivate(join(dir, noticeName(name)), `${JSON.stringify(held.notice)}\n`, root);
	}

	// ---- facts the server itself records

	/** A forward the tower's code stamped. Called by the tower tools of the server, never by a session. */
	noteForward(f: { fwd: string; from: string; to: string[]; text: string }): void {
		const heads = headsIn(f.text);
		if (!heads.length) return;
		this.forwards = [...this.forwards.filter((x) => this.d.now() - x.at < KEEP_MS), { fwd: f.fwd, from: f.from, to: f.to.slice(0, 20), heads, at: this.d.now() }].slice(-MAX_FORWARDS);
		this.saveState();
	}
	/** The newest forward of this head to this session. */
	forwardOf(head: string, to: string): ForwardRecord | undefined {
		return [...this.forwards].reverse().find((f) => this.d.now() - f.at < KEEP_MS && f.heads.includes(head) && f.to.includes(to));
	}
	/** A train the tower opened (the open's result and the manifest's `base:`). */
	noteTrain(t: Omit<TrainRecord, "at">): void {
		this.trains.set(`${t.project}/${t.code}`, { ...t, at: iso(this.d.now()) });
		this.saveState();
	}
	trainOf(project: string, code: string): TrainRecord | undefined { return this.trains.get(`${project}/${code}`); }

	// ---- the proof

	/**
	 * Hands the pi process its secret, once. The session must be live, in a pane Herdr knows, and `pid` one of that pane's foreground processes (pi is; a shell the model started is not) with the start time given; and nothing may be registered for that same
	 * process already. A pi that started again (a new pid) replaces the old registration.
	 */
	async register(req: { session: unknown; pid: unknown; started?: unknown; pane: unknown }): Promise<{ secret: string }> {
		const session = req.session, pid = req.pid, pane = req.pane;
		if (!text(session, 128) || !Number.isSafeInteger(pid) || (pid as number) <= 1 || !text(pane, 64)) throw refusal("sb: cars-register needs the session id, the pid of the pi and its pane");
		const started = typeof req.started === "string" && req.started ? req.started : undefined;
		const look = await this.d.look(session);
		if (!look) throw refusal(`sb: session ${session} is not live on the net, so it cannot register`);
		if (look.pane !== pane) throw refusal(`sb: session ${session} does not run in pane ${pane}`);
		if (!look.foreground.includes(pid as number)) throw refusal(`sb: pid ${pid} is not a foreground process of pane ${pane}; only the pi of the pane registers`);
		const real = this.d.startOf?.(pid as number);
		if (real !== undefined && started !== undefined && real !== started) throw refusal(`sb: pid ${pid} started at ${real}, not ${started}`);
		const known = this.bySession.get(session), old = known ? this.regs.get(known) : undefined;
		if (old && old.pid === pid && old.started === started) throw refusal(`sb: session ${session} is already registered to this process; its secret is held in that process's memory and is not given twice`);
		if (known) this.regs.delete(known);
		const secret = this.d.secret?.() ?? randomBytes(32).toString("hex");
		this.regs.set(secret, { session, pid: pid as number, ...(started ? { started } : {}), pane, ...(look.cwd ? { cwd: look.cwd } : {}), at: this.d.now() });
		this.bySession.set(session, secret);
		this.d.log?.("cars-register", { session: session.slice(0, 40), pid: pid as number });
		return { secret };
	}

	/** Who a secret is: the registration, checked against what Herdr and the broker say now. */
	private async who(secret: unknown): Promise<{ reg: Registration; setter: Setter; train?: { project: string; code: string } }> {
		const reg = typeof secret === "string" ? this.regs.get(secret) : undefined;
		if (!reg) throw refusal("sb: this request is not from a registered session: a car state is set from the pi session itself with the train_car tool");
		const look = await this.d.look(reg.session);
		if (!look || look.pane !== reg.pane || !look.foreground.includes(reg.pid)) throw refusal(`sb: session ${reg.session} is not the process that registered (it ended or moved)`);
		const role = look.role === "train" ? "train" : look.role === "main" ? "main" : undefined;
		if (!role) throw refusal(`sb: session ${look.name} is neither a train nor a main (its role is ${look.role ?? "none"})`);
		if (role === "train" && !look.train) throw refusal(`sb: session ${look.name} is a train with no train token`);
		// A pane token is Herdr state any process of the user can write: the train is the session this server opened for that code, not the one whose pane says so.
		if (role === "train" && this.trainOf(look.train!.project, look.train!.code)?.session !== reg.session) throw refusal(`sb: this server did not open train ${look.train!.code} of project ${look.train!.project} for session ${reg.session}`);
		return { reg, setter: { role, name: look.name, session: reg.session, ...(look.workspace ? { workspace: look.workspace } : {}) }, ...(look.train ? { train: look.train } : {}) };
	}

	// ---- reading

	/** Every car file of a project with its notice record, as the guard reads them (`cars-read`). */
	read(project: string): CarView[] {
		return [...(this.cars.get(project)?.values() ?? [])].slice(0, MAX_FILES).map((h) => ({ file: structuredClone(h.file), ...(h.notice ? { notice: structuredClone(h.notice) } : {}) }));
	}
	/** Every state whose notice is not yet told, oldest first, for the sender. */
	pending(): { project: string; name: string; file: CarFile; entry: StateEntry; notice?: StateNotice }[] {
		const out: { project: string; name: string; file: CarFile; entry: StateEntry; notice?: StateNotice }[] = [];
		for (const [project, held] of this.cars) {
			for (const [name, h] of held) {
				for (const entry of h.file.states) {
					const notice = h.notice?.states[entry.state];
					if (notice?.deliveredAt) continue;
					out.push({ project, name, file: h.file, entry, ...(notice ? { notice } : {}) });
				}
			}
		}
		return out.sort((a, b) => a.entry.at.localeCompare(b.entry.at));
	}
	/** The notice record of one state of one car file, as it is now. */
	noticeOf(project: string, name: string, state: CarState): StateNotice | undefined { return this.cars.get(project)?.get(name)?.notice?.states[state]; }
	/** Changes one notice record (the sender is the only caller) and writes it. */
	updateNotice(project: string, name: string, state: CarState, change: (record: StateNotice) => void): void {
		const held = this.cars.get(project)?.get(name);
		if (!held) return;
		const notice: NoticeRecord = held.notice ?? { v: 1, states: {} };
		const record: StateNotice = notice.states[state] ?? { attempts: [] };
		change(record);
		notice.states[state] = record;
		held.notice = notice;
		this.writeCar(project, name, held);
	}

	// ---- setting a state

	set(req: SetRequest): Promise<SetResult> {
		const run = this.chain.then(() => this.setNow(req));
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async setNow(req: SetRequest): Promise<SetResult> {
		const { setter, train, reg } = await this.who(req.secret);
		const state = req.state, fields = isObject(req.fields) ? { ...req.fields } : {};
		const bad = validateStateFields(state, fields);
		if (bad.length) throw refusal(bad.join("; "));
		const car = req.car;
		if (!isObject(car) || !isName(car.app) || !SHA_RE.test(String(car.head))) throw refusal("sb: car needs an app and a 40-hex head");
		const project = setter.role === "train" ? train!.project : car.project;
		if (!isName(project)) throw refusal("sb: car needs a project (a path-safe name)");
		if (setter.role === "train" && car.project !== undefined && car.project !== project) throw refusal(`sb: this train works for project ${project}, not ${String(car.project)}`);
		if (setter.role === "main" && (state === "dropped" || state === "landed")) throw refusal(`sb: only a train sets ${state}; the integrator sets received and returned`);
		if (setter.role === "train" && state === "received") throw refusal("sb: only the integrator sets received");
		const name = carFileName(car.app, car.head), held = this.cars.get(project)?.get(name);
		let file = held?.file;
		const label = file?.car.tickets[0] ?? (Array.isArray(car.tickets) && car.tickets.length ? String(car.tickets[0]) : name);

		if (setter.role === "main") {
			// The integrator's: the slip arrived as a tower's forward to this session, and the session that sent it there is the coordinator.
			if (file?.states.some((s) => s.state === "received")) throw refusal(`sb: car ${label} is already received${state === "returned" ? "; the integrator returns a car at receipt only" : ""}`);
			const sent = this.forwardOf(car.head, setter.session);
			if (!sent) throw refusal(`sb: no forward by a tower carries head ${car.head.slice(0, 12)} to this session: a car slip reaches the integrator only as the tower's tower_send or tower_reply with forward: (the code stamps fwd-from)`);
			const claimed = car.coordinator ?? file?.coordinator;
			if (!text(claimed, 128)) throw refusal("sb: car needs the slip's coordinator");
			const tickets = Array.isArray(car.tickets) && car.tickets.length && car.tickets.every((t) => text(t, 64)) ? (car.tickets as string[]) : file?.car.tickets;
			const branch = car.branch ?? file?.car.branch;
			if (!tickets || !text(branch, 255)) throw refusal("sb: car needs its tickets and branch");
			if (claimed !== sent.from) {
				const word = coordinatorWord(tickets[0]!, claimed, sent.from);
				if (state === "received") throw refusal(word);
				// A returned car goes to the session that really sent it, with the word.
				fields.reason = word;
			}
			file ??= emptyCar({ project, app: car.app, tickets, branch, head: car.head, coordinator: sent.from });
		} else {
			// A train's: the car is one the integrator received for this train.
			if (!file) throw refusal(`sb: car with head ${car.head.slice(0, 12)} is not in the book of project ${project}: only a car the integrator received can be set`);
			const received = file.states.find((s) => s.state === "received");
			if (!received) throw refusal(`sb: car ${label} was never received, so it is on no train`);
			if (received.train !== train!.code) throw refusal(`sb: car ${label} rides train ${String(received.train)}, not ${train!.code}`);
			if (state === "dropped" && (!isAbsolute(String(fields.evidence)) || !this.d.exists(String(fields.evidence)))) throw refusal(`sb: dropped.evidence ${String(fields.evidence).slice(0, 200)} is not a file that exists (give its absolute path)`);
			if (state === "landed") await this.landed(project, train!.code, reg, String(fields.commit), label);
		}
		let next: CarFile;
		try { next = addState(file, { state, fields, by: setter, at: iso(this.d.now()) }); } catch (error) { throw refusal((error as Error).message); }
		const entry = next.states.at(-1)!, stored: Held = { file: next, ...(held?.notice ? { notice: held.notice } : {}) };
		const forProject = this.cars.get(project) ?? new Map<string, Held>();
		forProject.set(name, stored);
		this.cars.set(project, forProject);
		this.writeCar(project, name, stored);
		this.d.log?.("cars-set", { project, state, car: label.slice(0, 40) });
		queueMicrotask(() => this.d.onChange?.());
		return { state, at: entry.at, file: name, coordinator: next.coordinator };
	}

	/** A commit is landed when git, run here, finds it on the remote branch of the base named in the manifest this server was handed at the open. */
	private async landed(project: string, code: string, reg: Registration, commit: string, label: string): Promise<void> {
		const record = this.trainOf(project, code);
		if (!record) throw refusal(`sb: this server did not open train ${code} of project ${project}, so it has no manifest to read the base from`);
		if (!record.base || !BASE_RE.test(record.base) || record.base.includes("..")) throw refusal(`sb: the manifest of train ${code} names no usable base (base: <branch>)`);
		if (!reg.cwd) throw refusal(`sb: the folder of the train's pane is not known, so ${label}'s commit cannot be checked`);
		const ref = `refs/remotes/origin/${record.base}`;
		try { await this.d.git(reg.cwd, ["fetch", "--no-tags", "origin", `+refs/heads/${record.base}:${ref}`]); } catch (error) { throw refusal(`sb: git fetch of ${record.base} failed in ${reg.cwd}: ${firstLine(error)}`); }
		try { await this.d.git(reg.cwd, ["merge-base", "--is-ancestor", commit, ref]); } catch { throw refusal(`sb: landed.commit ${commit.slice(0, 12)} is not on origin/${record.base}: a car has landed only when its commit is on the base's remote branch`); }
	}
}
