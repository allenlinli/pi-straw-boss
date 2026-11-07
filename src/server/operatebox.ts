import { COMBOS } from "../keys.ts";
import type { OperateIn } from "../link/holder.ts";
import type { OperateMessage } from "../link/kinds.ts";
import { OperateRegistry, OperateSession, type OperateEnd, type OperateInner } from "../link/operate.ts";
import type { Policy } from "../link/policy.ts";
import type { Reply } from "../control.ts";
import type { Net } from "../net.ts";
import { type OperateScope, routeOf, type Row } from "../operateroutes.ts";
import { MAX_WATCHES, type Operate, type OperateSession as Seam } from "../operateseam.ts";
import { createOperateGuard, type GuardSession } from "./operateguard.ts";
import { type EndReason, type MemberOf, type Owner, type Refusal, type Scope } from "./operatescope.ts";

// The box's bridge for Straw Link operate (docs/specs/2026-11-07-link-operate.md §5.4, §5.5, §5.6, §6.1, §10): the holder's `operate` sink opens a session per operator, whose grant the guard (operateguard.ts) checks on every request;
// each session is one `OperateSession` (the sealed transport) over one seam session of the GUI (operateseam.ts), which does the work and reads nothing but what the session's scope holds.
//
//   open      the guard admits it (policy, roster, grant), the registry counts it, the seam opens a session, and one snapshot goes out at once.
//   req       the table's row and the unit it names, then the guard's four checks against the roster and the policy now (bound to the envelope's sender and team), then the seam; the reply goes back as `rep`.
//   watch     as req, to `watch` of the seam; its events go back as `ev` under the watch's id.
//   pacing    the mirror's frames are folded into whole screens and sent at most twice a second, and an empty "current" frame every 2 s when the screen is calm; snapshots at most one per 2 s, and only when the sliced net moved.
//   budget    one budget for the box (900 envelopes a minute across all sessions, below the relay's own limit): the mirror is stretched first (1 s, then 2 s), then the snapshots. `rep`, `accept`, `refuse` and `close` are never held.
//   teardown  the guard's `end` (a policy or roster change, a request whose grant is gone) closes the session at once and synchronously: nothing here waits for the holder's lock. The operator's `close`, 45 s of silence and the 12 h rekey
//             end it too; the policy watch (policy.ts `watchPolicy`) starts before the first open is admitted.
// link.log lines (§10) carry words, ids and counts: never typed text, a key's value, a choice, or file content.

export const BOX_BUDGET = 900;
/** The mirror's cadence while the budget is calm, and stretched; a calm screen still sends an empty "current" frame this often (the controller's 3 s freshness holds through a slow link). */
export const MIRROR_MS = 500, MIRROR_SLOW_MS = 1000, MIRROR_CALM_MS = 2000;
/** The snapshot's cadence, and what it stretches to when the budget is nearly spent. */
export const SNAP_MS = 2000, SNAP_SLOW_MS = 4000;
const WINDOW_MS = 60_000, PULSE_MS = 250, REFRESH_MS = 2000;
/** Bulk (mirror, snapshot, events) waits while this many sends are in flight; at `STALLED` nothing but a close or refuse is handed on (a relay that does not answer). Events queued over `EV_QUEUE` end the session. */
const BULK_INFLIGHT = 32, STALLED = 256, EV_QUEUE = 256, REQUESTS = 16, MAX_ROWS = 120;
const WORD = /^[a-z0-9._-]{1,32}$/;

export interface BoxDeps {
	/** The GUI's operate entry, while a GUI runs. */
	gui(): Operate | undefined;
	/** One outer message to one device of a team (`LinkHolder.sendLive`). */
	send(team: string, device: string, message: OperateMessage): Promise<unknown>;
	/** This box's own device id. */
	device(): string | undefined;
	/** The policy as the file reads now (a throw reads as refused). */
	policy(): Policy;
	member: MemberOf;
	/** The owner of a unit by its box key, from facts `refresh` read: synchronous, so a session's scope can answer `has`. */
	owner(key: string): Owner | undefined;
	/** Reads the facts `owner` reads (Herdr's listing, the live ally panes): before each check, and every 2 s while a session lives. */
	refresh(): Promise<void>;
	/** The pane a unit key is in, for the log. */
	pane(key: string): string | undefined;
	log(entry: Record<string, unknown>): void;
	now(): number;
	/** A repeating timer; returns the way to stop it. */
	every(ms: number, fn: () => void): () => void;
	/** The policy file's watch (policy.ts `watchPolicy`). */
	watch(onChange: () => void): { stop(): void };
	/** Envelopes a minute across all sessions (default `BOX_BUDGET`). */
	budget?: number;
	/**
	 * The seam for the transcript ledger (task 8, operateledger.ts): called with each session's sliced net, right after it was read for a snapshot and before it is sent, with the scope it was sliced by. The ledger's observer
	 * and a scoped hub for `api/transcripts` plug in here and in `gui.operate` when task 8 merges; nothing in this file reads them.
	 */
	observe?(net: Net, scope: Scope): void;
}

type Say = (entry: Record<string, unknown>) => void;
interface Screen { key: string; rows: string[]; cols: number; seq: number; dirty: boolean; hidden: boolean; sentAt: number }
interface Live {
	id: string; team: string; from: string; since: number;
	core: OperateSession; seam: Seam; gui: Operate;
	scope: Scope; opScope: OperateScope;
	/** The sender and team of the envelope being taken: what `guard.check` is bound to. */
	envelope: { from: string; team: string };
	screens: Map<string, Screen>; events: OperateInner[];
	snapDirty: boolean; snapAt: number; snapSent: string | undefined; snapping: boolean;
	busy: number; unlisten: (() => void) | undefined; failedAt: number; ended: boolean;
}

const TEXT: Record<Refusal, string> = {
	"not-granted": "This device is not granted operate here.",
	"not-admin": "This device is no admin of the team that owns that.",
	"out-of-scope": "That unit is not one this session reaches.",
	"local-only": "That stays on the box's own console.",
	policy: "This box's policy does not allow operate.",
};
const REASON = (word: Refusal): Reply => ({ status: 403, body: { error: "operate_refused", why: word, reason: TEXT[word] } });
const ACTIONS: [RegExp, string][] = [[/^sessions\/\*\/input$/, "input"], [/^sessions\/\*\/keys$/, "keys"], [/^sessions\/\*\/answer$/, "answer"], [/^sessions\/\*\/dequeue$/, "dequeue"], [/^sessions\/\*\/upload$/, "upload"], [/^close\/unit$/, "close-unit"], [/^close\/tab$/, "close-tab"], [/^dismiss$/, "dismiss"], [/^tower\/\*\/memory$/, "memory"], [/^tower\//, "tower"]];
const READS: Record<string, string> = { "history/*": "history", "entry/*/*": "entry", "image/*/*/*": "image", "sessions/*/commands": "commands" };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sane = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const errorName = (error: unknown): string => (error as Error)?.name ?? "Error";

/** The class of a key request for the log: what kind of input it was, never its text. */
function classOf(action: string, body: Record<string, unknown>): string | undefined {
	if (action === "input") return "text";
	if (action !== "keys") return undefined;
	if (typeof body.paste === "string") return "paste";
	if (typeof body.text === "string") return "text";
	if (Array.isArray(body.keys)) return "esc";
	const key = body.key;
	if (key === "enter") return "enter";
	if (key === "esc") return "esc";
	return typeof key === "string" && COMBOS.test(key) ? "chord" : "pad";
}

export function createOperateBox(d: BoxDeps) {
	const budget = d.budget ?? BOX_BUDGET, registry = new OperateRegistry(d.now), live = new Map<string, Live>();
	const sent: number[] = [];
	let inflight = 0, stopPulse: (() => void) | undefined, watcher: { stop(): void } | undefined, refreshedAt = -Infinity, refreshing = false;
	const say: Say = (entry) => { try { d.log(entry); } catch { /* a log that fails is not the session's problem */ } };

	// ---- The budget -----------------------------------------------------------------------------------------------------------------------------------

	const used = (): number => {
		const from = d.now() - WINDOW_MS;
		while (sent.length && sent[0]! <= from) sent.shift();
		return sent.length;
	};
	/** Bulk goes while the window has room and the relay answers; control always goes. */
	const bulkOk = (): boolean => used() < budget && inflight < BULK_INFLIGHT;
	const mirrorEvery = (): number => { const f = used() / budget; return f < 0.5 ? MIRROR_MS : f < 0.75 ? MIRROR_SLOW_MS : MIRROR_CALM_MS; };
	const snapEvery = (): number => (used() / budget < 0.9 ? SNAP_MS : SNAP_SLOW_MS);

	/** Every outer message of every session goes through here: counted against the budget, and bounded in flight. */
	const transport = (team: string, device: string, onError: (error: unknown) => void) => (message: OperateMessage): Promise<void> | undefined => {
		const control = message.type === "close" || message.type === "refuse";
		if (inflight >= STALLED && !control) return undefined;
		sent.push(d.now());
		inflight++;
		let out: Promise<unknown>;
		try {
			out = Promise.resolve(d.send(team, device, message));
		} catch (error) {
			inflight--;
			onError(error);
			return undefined;
		}
		return out.then(() => undefined).finally(() => void inflight--);
	};

	// ---- A session ------------------------------------------------------------------------------------------------------------------------------------

	const scopeOf = (scope: Scope): OperateScope => {
		const teams = new Set(scope.teams), box = scope.box;
		return { box, has: (key) => { const o = d.owner(key); return o ? ("team" in o ? teams.has(o.team) : box) : false; } };
	};
	const copy = (scope: Scope): Scope => ({ teams: [...scope.teams], box: scope.box });
	const same = (a: Scope, b: Scope): boolean => a.box === b.box && a.teams.join() === b.teams.join();

	/** Sends an inner message of the session; the core cuts it into parts when it is large. A message the core refuses (over 4 MB) is dropped here. */
	const out = (s: Live, inner: OperateInner): boolean => {
		try {
			return s.core.send(inner);
		} catch {
			return false;
		}
	};
	const reply = (s: Live, id: string, r: Reply): void => {
		if (out(s, { t: "rep", id, status: r.status, body: r.body })) return;
		if (!s.ended) out(s, { t: "rep", id, status: 502, body: { error: "too_large", reason: "The answer is larger than a session carries." } });
	};

	/** The session ends: whatever it held is dropped, and the line is written once. `by` is who ended it. */
	const teardown = (s: Live, end: OperateEnd): void => {
		if (s.ended) return;
		s.ended = true;
		live.delete(s.id);
		try { s.unlisten?.(); } catch { /* the entry is going away */ }
		try { s.seam.stop(); } catch { /* the seam ends what it held */ }
		s.screens.clear();
		s.events.length = 0;
		const operator = end.reason === "peer-closed";
		say({ event: "operate-close", team: s.team, from: s.from, session: s.id, by: operator ? "operator" : "box", reason: operator ? (end.peer && WORD.test(end.peer) ? end.peer : "unspecified") : end.reason, seconds: Math.round((d.now() - s.since) / 1000) });
		guard.release(s.id);
		if (!live.size) (stopPulse?.(), (stopPulse = undefined));
	};
	/** The box ends the session on its own: a `close` with the word goes out (the core then ends, which tears down). */
	const close = (s: Live, reason: string): void => {
		if (s.ended) return;
		s.core.close(reason);
		teardown(s, { reason });
	};

	const guard = createOperateGuard({
		policy: d.policy, member: d.member, owner: d.owner, now: d.now, log: say,
		end: (g: GuardSession, reason: EndReason) => { const s = live.get(g.id); if (s) close(s, reason); },
	});
	/** After anything that may have narrowed a session's scope: the seam is told, so a watch or a mirror of a unit that left ends, and the next snapshot is cut down. */
	const sync = (): void => {
		for (const g of guard.sessions()) {
			const s = live.get(g.id);
			if (!s || s.ended || same(s.scope, g.scope)) continue;
			s.scope = copy(g.scope);
			s.opScope = scopeOf(s.scope);
			s.snapDirty = true;
			void s.seam.rescope(s.opScope).catch(() => undefined);
		}
	};
	const refresh = async (): Promise<void> => {
		refreshedAt = d.now();
		try {
			await d.refresh();
		} catch { /* the facts stay as they were: ownership is read from them, and a unit nobody knows is out of scope */ }
	};

	// ---- What goes out ------------------------------------------------------------------------------------------------------------------------------------

	async function snapshot(s: Live): Promise<void> {
		if (s.snapping || s.ended) return;
		s.snapping = true;
		s.snapDirty = false;
		s.snapAt = d.now();
		try {
			await refresh();
			const net = await s.gui.snapshot(s.opScope);
			if (s.ended) return;
			try { d.observe?.(net, copy(s.scope)); } catch { /* an observer's failure is not the snapshot's */ }
			const text = JSON.stringify(net);
			if (text === s.snapSent) return;
			s.snapSent = text;
			out(s, { t: "snap", net });
		} catch (error) {
			say({ event: "operate-snapshot-failed", session: s.id, error: errorName(error) });
		} finally {
			s.snapping = false;
		}
	}
	const flushEvents = (s: Live): void => {
		while (s.events.length && bulkOk() && !s.ended) out(s, s.events.shift()!);
	};
	const whole = (m: Screen) => ({ key: m.key, seq: m.seq, rows: m.rows.length, cols: m.cols, whole: true as const, set: m.rows.map((row, i): [number, string] => [i, row]) });
	function mirror(s: Live, key: string, data: Record<string, unknown>): void {
		if (typeof data.ended === "string") {
			s.screens.delete(key);
			out(s, { t: "ev", id: `m:${key}`, e: "mirror", d: { key, ended: data.ended.slice(0, 200) } });
			return;
		}
		const m = s.screens.get(key) ?? { key, rows: [], cols: 0, seq: 0, dirty: false, hidden: false, sentAt: -Infinity };
		s.screens.set(key, m);
		if (data.hidden === true) return void ((m.hidden = true), (m.dirty = true));
		m.hidden = false;
		const rows = typeof data.rows === "number" && Number.isSafeInteger(data.rows) && data.rows >= 0 ? Math.min(data.rows, MAX_ROWS) : m.rows.length, cols = typeof data.cols === "number" && Number.isSafeInteger(data.cols) ? data.cols : m.cols;
		if (rows !== m.rows.length || cols !== m.cols) m.dirty = true;
		m.cols = cols;
		if (rows < m.rows.length) m.rows.length = rows;
		while (m.rows.length < rows) m.rows.push("");
		if (Array.isArray(data.set)) {
			for (const entry of data.set) {
				if (!Array.isArray(entry) || !Number.isSafeInteger(entry[0]) || entry[0] < 0 || entry[0] >= rows || typeof entry[1] !== "string") continue;
				if (m.rows[entry[0]] !== entry[1]) (m.rows[entry[0]] = entry[1], (m.dirty = true));
			}
		}
		if (typeof data.seq === "number") m.seq = data.seq;
	}
	/** The seam's sink: a mirror's frames are folded into the session's whole screen, and every other event is a watch's, queued in order. */
	const sink = (s: Live) => (id: string, event: string, data: unknown): void => {
		if (s.ended) return;
		if (id.startsWith("m:") && event === "mirror" && isObject(data)) return mirror(s, id.slice(2), data);
		if (s.events.length >= EV_QUEUE) {
			say({ event: "operate-overload", session: s.id });
			return close(s, "overload");
		}
		s.events.push({ t: "ev", id, e: String(event).slice(0, 32), d: data });
		flushEvents(s);
	};
	function pulseOne(s: Live): void {
		const now = d.now();
		try { s.core.tick(); } catch { /* a session's own failure ends nothing else */ }
		if (s.ended) return;
		if (d.gui() !== s.gui) return close(s, "unavailable");
		sync();
		flushEvents(s);
		for (const m of s.screens.values()) {
			const age = now - m.sentAt;
			if (m.dirty && age >= mirrorEvery() && bulkOk()) {
				m.dirty = false;
				m.sentAt = now;
				out(s, { t: "ev", id: `m:${m.key}`, e: "mirror", d: m.hidden ? { key: m.key, hidden: true } : whole(m) });
			} else if (!m.dirty && age >= MIRROR_CALM_MS && bulkOk()) {
				m.sentAt = now;
				out(s, { t: "ev", id: `m:${m.key}`, e: "mirror", d: m.hidden ? { key: m.key, hidden: true } : { key: m.key, seq: m.seq, rows: m.rows.length, cols: m.cols, set: [] } });
			}
		}
		if (s.snapDirty && now - s.snapAt >= snapEvery() && bulkOk()) void snapshot(s);
	}
	const pulse = (): void => {
		if (d.now() - refreshedAt >= REFRESH_MS && !refreshing) (refreshing = true, void refresh().finally(() => (refreshing = false)));
		for (const s of [...live.values()]) pulseOne(s);
	};

	// ---- Requests -----------------------------------------------------------------------------------------------------------------------------------------

	/** The box key a request names, from the row's own account of where (operateroutes.ts `names`); a squad is the seam's to check. */
	const unitOf = (row: Row | undefined, parts: string[], body: unknown): string | undefined => {
		const names = row?.names;
		if (!names) return undefined;
		if ("part" in names) return parts[names.part];
		if ("body" in names && isObject(body)) return typeof body[names.body] === "string" ? (body[names.body] as string) : undefined;
		return undefined;
	};
	const refused = (s: Live, route: string, reason: string, r: Reply, id: string): void => {
		say({ event: "operate-refused", session: s.id, from: s.from, route, reason });
		reply(s, id, r);
	};
	/** The four checks of §3.2 for one request, bound to the envelope the message came in. A grant that is gone ended the session inside the guard. */
	const checked = async (s: Live, env: Live["envelope"], q: { unit?: string; localOnly?: boolean }): Promise<{ ok: true } | { ok: false; reason: Refusal }> => {
		await refresh();
		if (s.ended) return { ok: false, reason: "not-granted" };
		const v = guard.check(s.id, { from: env.from, team: env.team, ...q });
		sync();
		return v;
	};

	async function request(s: Live, env: Live["envelope"], m: Record<string, unknown>): Promise<void> {
		const id = m.id;
		if (!sane(id, 64)) return;
		const method = m.m, parts = m.parts;
		if ((method !== "GET" && method !== "POST") || !Array.isArray(parts) || parts.length === 0 || parts.length > 8 || !parts.every((p) => sane(p, 200))) return reply(s, id, { status: 400, body: { error: "bad_request", reason: "A request names a method and its path." } });
		if (m.q !== undefined && !isObject(m.q)) return reply(s, id, { status: 400, body: { error: "bad_request", reason: "The query is an object." } });
		const row = routeOf(method, parts as string[]), route = row?.path ?? "unknown", upload = row?.path === "sessions/*/upload";
		let body: Record<string, unknown> | Buffer;
		if (upload) {
			if (typeof m.body !== "string") return reply(s, id, { status: 400, body: { error: "bad_request", reason: "An upload is the file's bytes." } });
			body = Buffer.from(m.body, "base64");
		} else if (m.body === undefined || m.body === null) body = {};
		else if (isObject(m.body)) body = m.body;
		else return reply(s, id, { status: 400, body: { error: "bad_request", reason: "The body is a JSON object." } });
		const query = new URLSearchParams(Object.entries((m.q ?? {}) as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
		const unit = unitOf(row, parts as string[], upload ? {} : body), stays = !row || row.cross === "refused" || row.cross === "local";
		const v = await checked(s, env, { ...(unit !== undefined ? { unit } : {}), ...(stays ? { localOnly: true } : {}) });
		if (!v.ok) return refused(s, route, v.reason, REASON(v.reason), id);
		if (s.ended) return;
		if (row?.cross === "mirror") return void (await mirrorRequest(s, id, unit, body as Record<string, unknown>));
		const done = await s.seam.request(method, parts as string[], query, body, s.opScope);
		const denied = done.status === 403 && isObject(done.body) && done.body.error === "operate_refused";
		if (denied) say({ event: "operate-refused", session: s.id, from: s.from, route, reason: String((done.body as { why?: unknown }).why ?? "refused").slice(0, 32) });
		else if (method === "GET" || row?.path === "sessions/*/commands") say({ event: "operate-read", session: s.id, from: s.from, ...(unit !== undefined ? { unit } : {}), what: READS[route] ?? "read" });
		else {
			const action = ACTIONS.find(([re]) => re.test(route))?.[1] ?? "request", pane = unit !== undefined ? d.pane(unit) : undefined;
			const cls = classOf(action, body as Record<string, unknown>);
			say({ event: "operate-input", session: s.id, from: s.from, team: s.team, ...(unit !== undefined ? { unit } : {}), ...(pane ? { pane } : {}), action, ...(cls ? { class: cls } : {}), status: done.status });
		}
		reply(s, id, done);
	}
	async function mirrorRequest(s: Live, id: string, unit: string | undefined, body: Record<string, unknown>): Promise<void> {
		if (unit === undefined || typeof body.on !== "boolean") return reply(s, id, { status: 400, body: { error: "bad_request", reason: "Name the unit and whether to show it." } });
		const done = await s.seam.mirror(unit, body.on, s.opScope);
		if (done.status === 200) say({ event: "operate-mirror", session: s.id, from: s.from, unit, ...(d.pane(unit) ? { pane: d.pane(unit) } : {}), on: body.on });
		if (done.status === 200 && !body.on) s.screens.delete(unit);
		reply(s, id, done);
	}
	async function watch(s: Live, env: Live["envelope"], m: Record<string, unknown>): Promise<void> {
		const id = m.id, target = m.target;
		if (!sane(id, 64) || !sane(target, 200) || typeof m.on !== "boolean") return void (sane(id, 64) && reply(s, id, { status: 400, body: { error: "bad_request", reason: "A watch names an id, a target and on or off." } }));
		const unit = target.startsWith("w:") ? undefined : target;
		const v = await checked(s, env, unit !== undefined ? { unit } : {});
		if (!v.ok) return refused(s, "watch", v.reason, REASON(v.reason), id);
		if (s.ended) return;
		const done = await s.seam.watch(id, target, m.on, s.opScope);
		if (done.status === 200) say({ event: "operate-watch", session: s.id, from: s.from, unit: target, on: m.on });
		else if (done.status === 403) say({ event: "operate-refused", session: s.id, from: s.from, route: "watch", reason: String((done.body as { why?: unknown })?.why ?? "refused").slice(0, 32) });
		reply(s, id, done);
	}
	/** One inner message of an opened session. A handler that fails answers 500 and logs the error's name only. */
	function inner(s: Live, m: OperateInner): void {
		if (m.t !== "req" && m.t !== "watch") return;
		const env = { ...s.envelope }, id = sane(m.id, 64) ? m.id : undefined;
		if (s.busy >= REQUESTS) return void (id && reply(s, id, { status: 429, body: { error: "too_many", reason: "Too many requests in flight." } }));
		s.busy++;
		(m.t === "req" ? request(s, env, m) : watch(s, env, m))
			.catch((error) => { say({ event: "operate-request-failed", session: s.id, error: errorName(error) }); if (id) reply(s, id, { status: 500, body: { error: "failed", reason: "The box could not answer." } }); })
			.finally(() => void s.busy--);
	}

	// ---- Open and receive ---------------------------------------------------------------------------------------------------------------------------------

	const LIMITS = { mirrors: 2, watches: MAX_WATCHES, budget };
	function open(i: OperateIn): void {
		const m = i.message;
		if (m.type !== "open") return;
		const device = d.device(), id = m.session.toString("hex");
		let word: string | undefined;
		const fail = (reason: string): void => {
			const send = transport(i.team, i.from, () => undefined);
			void send({ session: m.session, type: "refuse", reason })?.catch(() => undefined);
			say({ event: "operate-open", team: i.team, from: i.from, session: id, want: m.want, verdict: reason });
		};
		// The policy is watched before the first admit reads it: a change after that is not missed.
		watcher ??= d.watch(() => { guard.onPolicy(); sync(); });
		if (!device) return fail("unavailable");
		if (!m.caps.includes("operate/1")) return fail("unsupported");
		let admitted: ReturnType<typeof guard.admit>;
		try {
			admitted = guard.admit({ id, team: i.team, from: i.from, want: m.want });
		} catch {
			return fail("seen"); // a session id already in use: the id is the operator's choice, so a throw here is a refusal
		}
		if (!admitted.ok) return fail(admitted.reason);
		const gui = d.gui();
		if (!gui) return (guard.release(id), fail("unavailable"));
		const ref: { s?: Live } = {};
		const core = OperateSession.accept({
			now: d.now,
			send: (message) => { if (message.type === "refuse") word = message.reason; return transport(i.team, i.from, (error) => ref.s && failed(ref.s, error))(message); },
			onTransportError: (error) => (ref.s ? failed(ref.s, error) : undefined),
			onInner: (x) => (ref.s ? inner(ref.s, x) : undefined),
			onEnd: (end) => (ref.s ? teardown(ref.s, end) : undefined),
		}, { team: Buffer.from(i.team, "hex"), self: device, from: i.from, open: m, scope: { teams: admitted.scope.teams.map((t) => Buffer.from(t, "hex")), box: admitted.scope.box }, limits: LIMITS, registry });
		if (!core) {
			guard.release(id);
			say({ event: "operate-open", team: i.team, from: i.from, session: id, want: m.want, verdict: word ?? "refused" });
			return;
		}
		const s: Live = {
			id, team: i.team, from: i.from, since: d.now(), core, gui, scope: copy(admitted.scope), opScope: scopeOf(admitted.scope), envelope: { from: i.from, team: i.team },
			screens: new Map(), events: [], snapDirty: true, snapAt: -Infinity, snapSent: undefined, snapping: false, busy: 0, unlisten: undefined, failedAt: -Infinity, ended: false, seam: undefined as unknown as Seam,
		};
		ref.s = s;
		live.set(id, s);
		try {
			s.seam = gui.open(sink(s));
		} catch {
			live.delete(id);
			core.close("unavailable");
			guard.release(id);
			ref.s = undefined;
			say({ event: "operate-open", team: i.team, from: i.from, session: id, want: m.want, verdict: "unavailable" });
			return;
		}
		s.unlisten = gui.changed(() => void (s.snapDirty = true));
		say({ event: "operate-open", team: i.team, from: i.from, session: id, want: m.want, verdict: "accepted" });
		stopPulse ??= d.every(PULSE_MS, pulse);
		void snapshot(s);
	}
	const failed = (s: Live, error: unknown): void => {
		const now = d.now();
		if (now - s.failedAt < WINDOW_MS) return;
		s.failedAt = now;
		say({ event: "operate-send-failed", session: s.id, error: errorName(error), ...((error as { reason?: unknown })?.reason ? { why: String((error as { reason: unknown }).reason).slice(0, 16) } : {}) });
	};

	return {
		/** The holder's `operate` sink: an `open` makes a session, anything else is a frame or close of one. A message under another device's name or on another team is not the session's and is dropped. */
		take(i: OperateIn): void {
			if (i.message.type === "open") return open(i);
			const s = live.get(i.message.session.toString("hex"));
			if (!s) return;
			if (s.team !== i.team || s.from !== i.from) return say({ event: "operate-drop", reason: "wrong-sender", team: i.team, from: i.from });
			s.envelope = { from: i.from, team: i.team };
			s.core.receive(i.message, i.from);
		},
		/** The holder's `onRoster` hook: a roster change (or a team that stopped) rechecks the sessions that touch it. Synchronous, and never waits on the holder's lock. */
		onRoster(team: string): void {
			guard.onRoster(team);
			sync();
		},
		/** The sessions open now, for `/boss link operate` and the tests. */
		sessions: () => [...live.values()].map((s) => ({ session: s.id, team: s.team, from: s.from, since: s.since, scope: copy(s.scope) })),
		/** The server stops: every session ends with a `close`, and the policy watch stops. */
		stop(): void {
			for (const s of [...live.values()]) close(s, "stopped");
			watcher?.stop();
			watcher = undefined;
			stopPulse?.();
			stopPulse = undefined;
		},
		guard,
	};
}
export type OperateBox = ReturnType<typeof createOperateBox>;
