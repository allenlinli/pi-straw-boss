import { createHash } from "node:crypto";
import type { Reply } from "../control.ts";
import type { OperateMessage } from "../link/kinds.ts";
import { type OperateEnd, type OperateInner, OPERATE_LIMITS, OperateSession } from "../link/operate.ts";
import type { AllyTeam, OperateIn } from "../link/holder.ts";
import type { Base, Net, RemoteBox, Tab, Unit } from "../net.ts";
import { routeOf } from "../operateroutes.ts";
import { type ReplyKind, type Rewrite, sanitizeCards, sanitizeHistory, sanitizeMirror, sanitizeNet, sanitizeReply } from "./operatesanitize.ts";

// The controller's end of Straw Link operate (docs/specs/2026-11-07-link-operate.md §5.6, §6.4, §11.2): while a GUI page is connected, one operate session per (box, team) to each unattended box this device may try to operate. What a box
// sends is merged into this GUI's net as bases of its own (a `box` field on each), page requests for a box's units go through control.ts to the session that shows the unit, and its streams (history, cards, terminal frames) come back
// to the pages that watch them. The box is treated as hostile: every snapshot, event and reply is rebuilt from a schema (operatesanitize.ts) before a page sees it, and what does not fit is dropped and counted (`operate-bad-frame` in link.log,
// never with content). The controller only forwards what its own pages ask: nothing a box sends makes it send anything.
//
// Ids: a unit key becomes `x<16 hex of sha256(box ‖ key)>`, a base id and a tab id the same with their own tags, so no box key reaches a URL, a box cannot name a local unit, and the same box-own unit shown by two of a box's sessions (the `box` scope
// shows it in each team's session, §4) is one unit with one key. A request for such a unit goes to a live session that shows it (the box scope's first).
// The inner messages are those of §5.3: `snap`, `ev` and `rep` come from the box, `watch` and `req` go to it (`req` carries `id`, `m`, `parts`, `q` as a record, and `body`: a JSON object, or an upload's bytes as base64).

const SHOW = "x";
/** A request waits this long for its `rep` (§5.5), a session is closed this long after the last page left (§5.6), a refusal is remembered this long. */
export const REQUEST_MS = 20_000, IDLE_MS = 60_000, REFUSED_MS = 10 * 60_000, GHOST_MS = 60_000;
/** The pad's rate per session (§5.5), the freshness of a remote terminal for the pad (§6.4), the most one box may make this computer keep in its tables, and a snapshot that follows another within this is held for the next tick. */
export const KEYS_PER_SECOND = 4, FRESH_MS = 5000, MAX_KEYS = 5000, SNAP_MS = 250, PER_STREAM = 2, MAX_UPLOAD = 2 * 1024 * 1024;
/** What `accept.limits` are clamped to: the box's word is a wire integer. */
export const LIMIT_CAPS = { mirrors: 6, watches: 16, budget: 900 } as const;
/** The page actions a box lets through (§6.3), for `RemoteBox.can`; `tower` only for a scope that holds the box part. */
const CAN = ["history", "input", "keys", "answer", "dequeue", "commands", "upload", "mirror", "dismiss", "close-unit", "close-tab"];
/** The words of a box's `refuse` or `close` that reach a page; any other is `other`. */
const WHY = new Set(["not-granted", "not-admin", "out-of-scope", "local-only", "policy", "roster", "seen", "operator-limit", "box-limit", "bad-key", "silence", "no-answer", "unsupported"]);
/** The reasons the host gave `close()` itself: such an end leaves nothing behind. */
const LOCAL = new Set(["idle", "off", "team-stopped", "stop"]);

/** An unattended device of a team, which this one may try to operate: its fresh `caps` list `operate/1`. */
export interface BoxOffer { team: string; teamName: string; device: string; short: string; label: string }
/** The boxes of a holder: unattended devices of its teams whose fresh `caps` list operate/1. */
export function offersOf(holder: { list(): AllyTeam[]; capsFor(team: string, device: string): string[] }): BoxOffer[] {
	return holder.list().flatMap((t) => t.devices.filter((d) => d.unattended && holder.capsFor(t.team, d.id).includes("operate/1")).map((d): BoxOffer => ({ team: t.team, teamName: t.name, device: d.id, short: d.short, label: d.label })));
}

export type Send = (event: string, data: unknown) => void;
export interface Watch { refresh(): Promise<void>; stop(): void }
export interface OperateHostDeps {
	now(): number;
	/** This device's id, once the holder runs. */
	device(): string | undefined;
	boxes(): BoxOffer[];
	/** The holder's `sendLive`: one operate message to one device of a team. It rejects when the peer, the relay or the direction does not take it. */
	send(team: string, device: string, message: OperateMessage): Promise<unknown>;
	/** link.log: names and counts only. */
	log(entry: Record<string, unknown>): void;
	/** The tick of the clock (default 1 s); `false` leaves it to the caller (`tick()`), as a test with a fake clock does. */
	interval?: number | false;
}
/** A claimed request: what the page asked of a unit that belongs to a box. `send` takes the body again only for an upload's bytes. */
export interface Claim { send(bytes?: Buffer): Promise<Reply> }
export interface RemoteBridge {
	/** Whether the request names a unit or base of a box: control.ts and gui.ts take it from there, before any local route. `parts` are those after api/. */
	claim(method: "GET" | "POST", parts: string[], json?: Record<string, unknown>, query?: URLSearchParams): Claim | undefined;
	watch(target: string, send: Send): Watch | undefined;
	mirrorOpen(stream: string, send: Send): void;
	mirrorClose(stream: string): void;
}

type State = "idle" | "opening" | "live" | "unreachable" | "ended";
interface Sess {
	id: string;
	offer: BoxOffer;
	session?: OperateSession;
	state: State;
	scope: { box: boolean };
	limits: { mirrors: number; watches: number; budget: number };
	net?: Net;
	keys: Map<string, string>;
	bases: Map<string, string>;
	tabs: Map<string, { ws: string; tab: string }>;
	/** Keys that came with a stream event, not a snapshot. */
	extra: Map<string, string>;
	openedAt?: number;
	seen?: number;
	retryAt: number;
	refusedUntil: number;
	fails: number;
	why?: string;
	ghostUntil?: number;
	reopening: boolean;
	deferred?: unknown;
	snapAt: number;
	bad: number;
	badLogged: number;
}
interface Pending { sess: Sess; session: OperateSession; kind: ReplyKind; at: number; done(reply: Reply): void; rw: Rewrite }
interface Group { id: string; target: string; subs: Set<Send>; sess?: Sess; issued: boolean }
interface MirrorGroup { device: string; x: string; raw: string; viewers: Map<string, Send>; sess: Sess }

const sha = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
const no = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, reason, ...extra } });
const refusal = (why: string, reason: string): Reply => ({ status: 403, body: { error: "operate_refused", why, reason } });
const UNREACHABLE = no(503, "unreachable", "The box is not answering; its operate session will reopen on its own.");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
const marksOf = (b: Pick<Base, "tower" | "tabs" | "outposts" | "outside">) => [...(b.tower ? [b.tower.mark, ...b.tower.subs.map((c) => c.mark)] : []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...b.outside.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)]), ...b.outposts.map((o) => o.mark)];

/** What kind of answer a request on a box's unit gets, by the route. */
function kindOf(method: "GET" | "POST", parts: string[]): ReplyKind {
	if (method === "GET") return parts[0] === "image" ? "image" : parts[0] === "entry" ? "entry" : "history";
	if (parts[0] === "sessions") return ({ input: "input", keys: "keys", answer: "answer", dequeue: "dequeue", commands: "commands", upload: "upload", mirror: "mirror" } as Record<string, ReplyKind>)[parts[2] ?? ""] ?? "plain";
	return parts[0] === "tower" && parts[2] === "memory" ? "memory" : "plain";
}

export function createOperateHost(deps: OperateHostDeps) {
	const sessions = new Map<string, Sess>(), pending = new Map<string, Pending>(), groups = new Map<string, Group>(), mirrorGroups = new Map<string, MirrorGroup>();
	const streams = new Map<string, Send>(), frameAt = new Map<string, number>(), keysSent = new Map<string, number[]>(), told = new Set<string>(), listeners = new Set<() => void>();
	let pages = 0, leftAt: number | undefined, offUntil = 0, version = 0, counter = 0, timer: ReturnType<typeof setInterval> | undefined, cache: { version: number; bases: Base[]; events: NonNullable<Net["events"]>; dialogs: Map<string, Set<string>> } | undefined;
	const now = () => deps.now();
	const changed = () => { version++; for (const l of [...listeners]) try { l(); } catch { /* a listener's failure is not the host's */ } };

	/** Counted and logged without content: a box that floods bad frames costs the log a few lines, not its rotation. */
	function bad(s: Sess, why: string, kind = "frame") {
		s.bad++;
		if (s.badLogged < 10 || s.bad % 100 === 0) (s.badLogged++, deps.log({ event: "operate-bad-frame", team: s.offer.team, device: s.offer.device, why, kind, count: s.bad }));
	}
	/** The rewrite of one box's ids into this page's, registering what it names in `into` (a snapshot's own maps, or the session's `extra`). */
	function rewrite(s: Sess, into: { keys: Map<string, string>; bases: Map<string, string>; tabs: Map<string, { ws: string; tab: string }> }, capped = false): Rewrite {
		const device = s.offer.device;
		return {
			key: (raw) => { const x = SHOW + sha(device, "key", raw); if (capped && into.keys.size >= MAX_KEYS && !into.keys.has(x)) return x; into.keys.set(x, raw); return x; },
			base: (raw) => { const x = SHOW + sha(device, "base", raw); into.bases.set(x, raw); return x; },
			tab: (ws, raw) => { const x = SHOW + sha(device, "tab", ws, raw); into.tabs.set(x, { ws, tab: raw }); return x; },
			bad: (why) => bad(s, why),
		};
	}
	const live = () => [...sessions.values()].filter((s) => s.state === "live" || s.state === "unreachable");
	const holds = (s: Sess, x: string) => s.state !== "ended" && s.state !== "idle" && (s.keys.has(x) || s.extra.has(x) || s.bases.has(x));
	/** The session to ask for a unit or base: a live one that shows it, the box scope's first; else one that shows it and is unreachable (the request is then refused with 503). */
	function sessionFor(x: string): Sess | undefined {
		const have = [...sessions.values()].filter((s) => holds(s, x));
		return have.filter((s) => s.state === "live").sort((a, b) => Number(b.scope.box) - Number(a.scope.box))[0] ?? have[0];
	}
	const rawOf = (s: Sess, x: string) => s.keys.get(x) ?? s.extra.get(x) ?? s.bases.get(x);

	// ---- sessions ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

	function open(s: Sess) {
		const self = deps.device();
		if (!self) return;
		s.state = s.reopening ? "live" : "opening";
		try {
			const session = OperateSession.open({
				now: deps.now,
				send: (m) => deps.send(s.offer.team, s.offer.device, m).then(() => undefined),
				onTransportError: (error) => { deps.log({ event: "operate-send-failed", team: s.offer.team, device: s.offer.device, error: (error as Error)?.name ?? "Error" }); },
				onOpen: (a) => opened(s, session, a),
				onInner: (inner) => taken(s, session, inner),
				onEnd: (end) => ended(s, session, end),
				onDrop: (d) => bad(s, d.reason, "session"),
			}, { team: Buffer.from(s.offer.team, "hex"), self, peer: s.offer.device, want: "box" });
			s.session = session;
		} catch (error) {
			s.state = "unreachable";
			s.retryAt = now() + 60_000;
			deps.log({ event: "operate-open-failed", team: s.offer.team, device: s.offer.device, error: (error as Error)?.name ?? "Error" });
		}
	}
	function opened(s: Sess, session: OperateSession, a: { scope: { box: boolean }; limits: { mirrors: number; watches: number; budget: number } }) {
		if (s.session !== session) return;
		const clamp = (v: number, cap: number) => (Number.isSafeInteger(v) ? Math.max(0, Math.min(cap, v)) : 0);
		s.scope = { box: a.scope.box === true };
		s.limits = { mirrors: clamp(a.limits.mirrors, LIMIT_CAPS.mirrors), watches: clamp(a.limits.watches, LIMIT_CAPS.watches), budget: clamp(a.limits.budget, LIMIT_CAPS.budget) };
		s.state = "live";
		s.reopening = false;
		s.fails = 0;
		s.why = undefined;
		s.ghostUntil = undefined;
		s.openedAt = s.seen = now();
		deps.log({ event: "operate-open", team: s.offer.team, device: s.offer.device, scope: s.scope.box ? "box" : "team", verdict: "accepted" });
		resume(s);
		changed();
	}
	function ended(s: Sess, session: OperateSession, end: OperateEnd) {
		if (s.session !== session) return;
		s.session = undefined;
		const t = now(), word = end.peer !== undefined && WHY.has(end.peer) ? end.peer : end.peer !== undefined ? "other" : undefined;
		settle((p) => p.sess === s && p.session === session, UNREACHABLE);
		deps.log({ event: "operate-close", team: s.offer.team, device: s.offer.device, by: end.peer !== undefined ? "box" : "controller", reason: LOCAL.has(end.reason) ? end.reason : word ?? (WHY.has(end.reason) || end.reason === "rekey" ? end.reason : "other"), seconds: s.openedAt === undefined ? 0 : Math.round((t - s.openedAt) / 1000) });
		if (end.reason === "rekey") { s.reopening = true; return open(s); } // the base never greys, and the terminals and watches ask again at once: the new session's first snapshot replaces the old
		for (const g of [...mirrorGroups.values()]) if (g.sess === s) dropMirror(g, "The box's operate session ended.");
		if (LOCAL.has(end.reason)) return forget(s);
		s.reopening = false;
		if (end.reason === "refused") {
			s.state = "ended";
			s.why = word ?? "other";
			s.net = undefined;
			s.refusedUntil = t + REFUSED_MS;
			s.retryAt = s.refusedUntil;
			// A refusal shows once per box and team, for a minute (§8): a dispatch-only member sees nothing new after that.
			s.ghostUntil = told.has(s.id) ? -1 : (told.add(s.id), t + GHOST_MS);
			return clear(s);
		}
		if (end.reason === "peer-closed" && word !== undefined && word !== "silence") {
			s.state = "ended";
			s.why = word;
			s.net = undefined;
			s.retryAt = t + 60_000;
			s.ghostUntil = undefined;
			return clear(s);
		}
		// Silence, no answer, a key that would not derive: the base greys (`unreachable`) and the session reopens, later each time.
		s.state = s.net ? "unreachable" : "idle"; // a box that never answered has nothing to grey
		if (end.reason === "silence") s.seen = t - OPERATE_LIMITS.silenceMs;
		s.fails++;
		s.retryAt = t + Math.min(300_000, 5000 * 2 ** Math.min(s.fails - 1, 6));
		changed();
	}
	/** What a session that ended keeps nothing of: its tables, its unit keys (a request for one falls through to the local routes, which do not know it). */
	function clear(s: Sess) {
		s.keys = new Map(); s.bases = new Map(); s.tabs = new Map(); s.extra = new Map();
		changed();
	}
	function forget(s: Sess) {
		sessions.delete(s.id);
		changed();
		pulse();
	}
	function close(s: Sess, reason: string) {
		if (s.session) s.session.close(reason);
		else forget(s);
	}

	/** After a (re)open, the watches and mirrors this session can serve are asked for again: the box starts none of its own. */
	function resume(s: Sess) {
		for (const g of groups.values()) if (!g.issued || g.sess === s || !g.sess || g.sess.state !== "live") issue(g);
		for (const g of mirrorGroups.values()) if (g.sess === s) void mirrorOn(g);
	}

	function taken(s: Sess, session: OperateSession, inner: OperateInner) {
		if (s.session !== session) return;
		s.seen = now();
		try {
			switch (inner.t) {
				case "snap": return snap(s, inner.net);
				case "ev": return event(s, inner);
				case "rep": return reply(s, inner);
				default: return bad(s, "type"); // `watch` and `req` go the other way; anything else is not a message of this version
			}
		} catch {
			bad(s, "throw"); // a schema that throws on a shape nobody foresaw is a refusal of that message, not the end of the host
		}
	}
	function snap(s: Sess, raw: unknown) {
		const t = now();
		if (t - s.snapAt < SNAP_MS) return void (s.deferred = raw); // a box that sends snapshots in a flood is read once per tick
		s.snapAt = t;
		s.deferred = undefined;
		const into = { keys: new Map<string, string>(), bases: new Map<string, string>(), tabs: new Map<string, { ws: string; tab: string }>() };
		const net = sanitizeNet(raw, rewrite(s, into));
		if (!net) return bad(s, "snap");
		s.net = net;
		[s.keys, s.bases, s.tabs] = [into.keys, into.bases, into.tabs];
		if (s.state === "unreachable") s.state = "live";
		for (const g of groups.values()) if (!g.issued) issue(g); // a page that was loaded for a unit before it was shown
		changed();
	}
	function event(s: Sess, inner: OperateInner) {
		const { id, e, d } = inner;
		if (typeof id !== "string" || typeof e !== "string") return bad(s, "ev");
		const into = { keys: s.extra, bases: new Map(), tabs: new Map() }, rw = rewrite(s, into, true);
		if (id.startsWith("m:")) {
			const frame = e === "mirror" ? sanitizeMirror(d, rw) : undefined;
			if (!frame) return e === "mirror" ? undefined : bad(s, "ev");
			const raw = id.slice(2), g = mirrorGroups.get(`${s.offer.device}\0${raw}`);
			if (!g || g.sess !== s) return; // a frame after the last viewer left
			if (frame.key !== g.x) return bad(s, "ev"); // a frame for another unit than the one asked for
			const t = now();
			for (const [stream, send] of g.viewers) { frameAt.set(`${stream}\0${g.x}`, t); send("mirror", frame); }
			if (typeof frame.ended === "string") dropMirror(g, undefined);
			return;
		}
		const g = groups.get(id);
		if (!g || g.sess !== s) return; // a late event of a watch that has stopped
		const out = e === "history" ? sanitizeHistory(d, rw) : e === "cards" ? sanitizeCards(d, rw) : undefined;
		if (out === undefined) return bad(s, "ev");
		for (const send of g.subs) send(e, out);
	}
	function reply(s: Sess, inner: OperateInner) {
		const { id, status, body } = inner;
		if (typeof id !== "string") return bad(s, "rep");
		const p = pending.get(id);
		if (!p || p.sess !== s) return; // late (the page gave up), or a watch's refusal: nothing waits
		pending.delete(id);
		let out: ReturnType<typeof sanitizeReply>;
		try { out = sanitizeReply(p.kind, status, body, p.rw); } catch { out = { ok: false, why: "throw" }; } // the page's request is answered whatever the box sent
		if (!out.ok) { bad(s, out.why, "reply"); return p.done(no(502, "bad_reply", "The box sent an answer this computer does not accept.")); }
		p.done({ status: out.status, body: out.body });
	}
	function settle(match: (p: Pending) => boolean, reply: Reply) {
		for (const [id, p] of [...pending]) if (match(p)) (pending.delete(id), p.done(reply));
	}

	// ---- requests ---------------------------------------------------------------------------------------------------------------------------------------------------------------

	/** One request to the box and its answer; `at` ends it with a 504 after 20 s. */
	function ask(s: Sess, kind: ReplyKind, m: "GET" | "POST", parts: string[], q: Record<string, string>, body: unknown): Promise<Reply> {
		const session = s.session;
		if (!session || s.state !== "live") return Promise.resolve(UNREACHABLE);
		const id = `r${++counter}`;
		return new Promise<Reply>((done) => {
			pending.set(id, { sess: s, session, kind, at: now(), done, rw: rewrite(s, { keys: s.extra, bases: new Map(), tabs: new Map() }, true) });
			try {
				if (!session.send({ t: "req", id, m, parts, q, body })) { pending.delete(id); done(UNREACHABLE); }
			} catch {
				pending.delete(id);
				done(no(413, "too_large", "That is too large to send to the box."));
			}
		});
	}

	function claimed(method: "GET" | "POST", parts: string[], json: Record<string, unknown>): { x: string; sess: Sess }[] {
		const head = parts[0], at: unknown[] = [];
		if (head === "sessions" || head === "tower" || head === "history" || head === "entry" || head === "image") at.push(parts[1]);
		if (method === "POST" && (head === "close" || head === "dismiss" || head === "open" || head === "dirs")) at.push(json.key, json.workspace, json.base);
		return at.flatMap((x) => { const s = typeof x === "string" ? sessionFor(x) : undefined; return s ? [{ x: x as string, sess: s }] : []; });
	}

	function claim(method: "GET" | "POST", parts: string[], json: Record<string, unknown> = {}, query = new URLSearchParams()): Claim | undefined {
		const hits = claimed(method, parts, json);
		if (!hits.length) return undefined;
		return { send: (bytes) => forward(method, parts, json, query, hits, bytes) };
	}

	async function forward(method: "GET" | "POST", parts: string[], json: Record<string, unknown>, query: URLSearchParams, hits: { x: string; sess: Sess }[], bytes?: Buffer): Promise<Reply> {
		const row = routeOf(method, parts);
		if (!row || row.cross === "refused" || row.cross === "local" || row.cross === "snap" || row.cross === "watch") return refusal("route", row?.note ?? "An operate session does not offer this.");
		const sess = hits[0]!.sess;
		if (row.without?.some((field) => json[field] !== undefined)) return refusal("route", row.note); // `dismiss {all}` would reach every team's finished units
		if (row.box && !sess.scope.box) return refusal("out-of-scope", "That belongs to the box itself, which this grant does not reach.");
		if (row.cross === "mirror") return mirrorRequest(hits[0]!.x, json, sess);
		const x = hits[0]!.x, raw = rawOf(sess, x)!;
		let out: string[] = parts.slice(), body: Record<string, unknown> | string = json;
		if (parts[0] === "sessions" || parts[0] === "history" || parts[0] === "entry" || parts[0] === "image") out[1] = raw;
		else if (parts[0] === "tower") out[1] = raw;
		else if (parts[0] === "dismiss" || (parts[0] === "close" && parts[1] === "unit")) {
			if (!sess.keys.has(x) && !sess.extra.has(x)) return no(404, "not_found", "No such unit.");
			body = { ...json, key: raw };
		} else if (parts[0] === "close" && parts[1] === "tab") {
			const tab = typeof json.tab === "string" ? sess.tabs.get(json.tab) : undefined, ws = typeof json.workspace === "string" ? sess.bases.get(json.workspace) : undefined;
			if (!tab || !ws || tab.ws !== ws) return no(404, "not_found", "No such squad.");
			body = { ...json, workspace: ws, tab: tab.tab };
		} else return refusal("route", "An operate session does not offer this.");
		if (sess.state !== "live") return UNREACHABLE;
		if (parts[0] === "sessions" && parts[2] === "keys") {
			const limited = pad(x, json);
			if (limited) return limited;
		}
		if (parts[0] === "sessions" && parts[2] === "upload") {
			if (!bytes?.length) return no(400, "bad_request", "An upload is the file's bytes.");
			if (bytes.length > MAX_UPLOAD) return no(413, "too_large", "The file is larger than 2 MB.");
			body = bytes.toString("base64");
		}
		const q: Record<string, string> = {};
		for (const [k, v] of [...query].slice(0, 8)) if (k.length <= 32 && v.length <= 200) q[k] = v;
		return ask(sess, kindOf(method, parts), method, out, q, body);
	}

	/** The pad's rate (4 a second per unit, §5.5) and its precondition: the page's stream shows the unit's terminal, with a frame in the last 5 s (§6.4). Stop's Escape alone needs neither. */
	function pad(x: string, json: Record<string, unknown>): Reply | undefined {
		const stop = json.key === undefined && Array.isArray(json.keys) && json.keys.length === 1 && json.keys[0] === "esc";
		const t = now(), recent = (keysSent.get(x) ?? []).filter((at) => t - at < 1000);
		if (recent.length >= KEYS_PER_SECOND) return no(429, "rate", `At most ${KEYS_PER_SECOND} keys a second reach a box's unit.`);
		if (!stop && typeof json.stream === "string") {
			const at = frameAt.get(`${json.stream}\0${x}`);
			if (at === undefined || t - at > FRESH_MS) return no(409, "no_mirror", "Keys are sent only while this page shows the session's terminal live; open it again.");
		}
		keysSent.set(x, [...recent, t]);
		for (const [k, ats] of keysSent) if (t - ats.at(-1)! >= 1000) keysSent.delete(k);
	}

	// ---- watches and terminals --------------------------------------------------------------------------------------------------------------------------------------------------

	function issue(g: Group) {
		const x = g.target.startsWith("w:") ? g.target.slice(2) : g.target, s = sessionFor(x);
		g.sess = s;
		g.issued = false;
		if (!s || s.state !== "live" || !s.session) return;
		const raw = rawOf(s, x);
		if (raw === undefined) return;
		g.issued = s.session.send({ t: "watch", id: g.id, target: g.target.startsWith("w:") ? `w:${raw}` : raw, on: true });
	}
	/** A box's key or base (`x` and 16 hex, in a page's address, which may load before the session's first snapshot): the watch starts when the session shows it. Any other target is a local one. */
	function watch(target: string, send: Send): Watch | undefined {
		if (!/^(w:)?x[0-9a-f]{16}$/.test(target)) return undefined;
		let g = [...groups.values()].find((h) => h.target === target);
		if (!g) (g = { id: `w${++counter}`, target, subs: new Set(), issued: false }, groups.set(g.id, g));
		g.subs.add(send);
		issue(g); // a page that joins a running watch gets the first page of history again: the box restarts the watch under the same id
		const group = g;
		return {
			refresh: async () => { if (!group.issued && group.subs.size) issue(group); },
			stop() {
				group.subs.delete(send);
				if (group.subs.size) return;
				groups.delete(group.id);
				if (group.issued && group.sess?.state === "live") group.sess.session?.send({ t: "watch", id: group.id, target: "", on: false });
			},
		};
	}

	async function mirrorOn(g: MirrorGroup): Promise<Reply> {
		const s = sessionFor(g.x);
		if (!s) return no(409, "not_live", "This session is no longer live in a pane.");
		g.sess = s;
		return ask(s, "mirror", "POST", ["sessions", g.raw, "mirror"], {}, { on: true });
	}
	function dropMirror(g: MirrorGroup, reason: string | undefined) {
		mirrorGroups.delete(`${g.device}\0${g.raw}`);
		for (const [stream, send] of g.viewers) { if (reason) send("mirror", { key: g.x, ended: reason }); frameAt.delete(`${stream}\0${g.x}`); }
		g.viewers.clear();
	}
	async function mirrorRequest(x: string, json: Record<string, unknown>, sess: Sess): Promise<Reply> {
		const { stream, on } = json, send = typeof stream === "string" ? streams.get(stream) : undefined;
		if (!send || typeof on !== "boolean") return no(400, "bad_request", "Name this page's stream and whether to show the terminal; reload the page if it reconnected.");
		const raw = rawOf(sess, x)!, key = `${sess.offer.device}\0${raw}`;
		let g = mirrorGroups.get(key);
		if (!on) {
			if (!g?.viewers.delete(stream as string)) return { status: 200, body: { attached: false } };
			frameAt.delete(`${stream as string}\0${x}`);
			if (!g.viewers.size) { mirrorGroups.delete(key); void ask(sess, "mirror", "POST", ["sessions", raw, "mirror"], {}, { on: false }); }
			return { status: 200, body: { attached: false } };
		}
		if (sess.state !== "live") return UNREACHABLE;
		if (!g?.viewers.has(stream as string) && [...mirrorGroups.values()].filter((h) => h.viewers.has(stream as string)).length >= PER_STREAM) return no(429, "too_many", `A page shows at most ${PER_STREAM} terminals; close one first.`);
		const first = !g;
		if (!g) (g = { device: sess.offer.device, x, raw, viewers: new Map(), sess }, mirrorGroups.set(key, g));
		g.viewers.set(stream as string, send);
		const done = await mirrorOn(g); // again for a page that joins a running one: the box then sends every row at once
		if (done.status !== 200) {
			g.viewers.delete(stream as string);
			if (first || !g.viewers.size) mirrorGroups.delete(key);
		}
		return done;
	}

	// ---- the net ----------------------------------------------------------------------------------------------------------------------------------------------------------------

	function merged(): NonNullable<typeof cache> {
		if (cache?.version === version) return cache;
		const bases: Base[] = [], events: NonNullable<Net["events"]> = [], dialogs = new Map<string, Set<string>>(), devices = new Map<string, Sess[]>();
		for (const s of sessions.values()) devices.set(s.offer.device, [...(devices.get(s.offer.device) ?? []), s]);
		for (const [device, list] of devices) {
			const shown = list.filter((s) => s.net && (s.state === "live" || s.state === "unreachable")), byBase = new Map<string, { s: Sess; b: Base }[]>();
			for (const s of shown) for (const b of s.net!.bases) byBase.set(b.id, [...(byBase.get(b.id) ?? []), { s, b }]);
			for (const items of byBase.values()) bases.push(mergeBases(items));
			if (!byBase.size) {
				const ghost = list.find((s) => s.state === "ended" && s.why !== undefined && (s.ghostUntil === undefined || now() < s.ghostUntil));
				if (ghost) bases.push({ id: SHOW + sha(device, "ghost"), label: ghost.offer.label, mark: "unknown", tower: null, tabs: [], outposts: [], outside: [], box: { device, short: ghost.offer.short, label: ghost.offer.label, team: ghost.offer.teamName, scope: "team", can: [], state: "ended", why: ghost.why! } });
			}
			for (const s of shown) {
				if (s.state === "live") for (const b of s.net!.bases) for (const u of unitsOf(b)) if (u.pending?.answer) (dialogs.get(device) ?? dialogs.set(device, new Set()).get(device)!).add(u.pending.answer.dialog);
				for (const e of s.net!.events ?? []) if (!events.some((o) => o.at === e.at && o.key === e.key && o.kind === e.kind)) events.push(e);
			}
		}
		return (cache = { version, bases, events: events.sort((a, b) => a.at - b.at).slice(-160), dialogs });
	}
	function unitsOf(b: Base): Unit[] {
		const all = (u: Unit): Unit[] => [u, ...u.subs.flatMap(all)];
		return [...(b.tower ? [b.tower as unknown as Unit, ...b.tower.subs.flatMap(all)] : []), ...b.tabs.flatMap((t) => t.units.flatMap(all)), ...b.outside.flatMap(all)];
	}
	function mergeBases(items: { s: Sess; b: Base }[]): Base {
		const first = items[0]!, by = [...items].sort((a, b) => Number(b.s.scope.box) - Number(a.s.scope.box));
		const tabs = new Map<string, Tab>(), outside = new Map<string, Unit>(), outposts = new Map<string, Base["outposts"][number]>();
		for (const { b } of items) {
			for (const t of b.tabs) {
				const into = tabs.get(t.id) ?? (tabs.set(t.id, { id: t.id, label: t.label, units: [] }), tabs.get(t.id)!);
				for (const u of t.units) if (!into.units.some((o) => o.key === u.key)) into.units.push(u);
			}
			for (const u of b.outside) if (!outside.has(u.key)) outside.set(u.key, u);
			for (const o of b.outposts) if (!outposts.has(o.id)) outposts.set(o.id, o);
		}
		// The box scope's tower is the whole one; a team-only session shows a stub that holds only that team's live ally runs, which are united when no session has the whole tower.
		let tower = by.find((i) => i.s.scope.box && i.b.tower)?.b.tower ?? by.find((i) => i.b.tower)?.b.tower ?? null;
		if (tower && !by.some((i) => i.s.scope.box && i.b.tower) && tower.service) {
			const runs = new Map<string, NonNullable<typeof tower.service>["allyRuns"][number]>();
			for (const { b } of items) for (const r of b.tower?.service?.allyRuns ?? []) if (!runs.has(r.id)) runs.set(r.id, r);
			tower = { ...tower, service: { ...tower.service, allyRuns: [...runs.values()] } };
		}
		const state: RemoteBox["state"] = items.some((i) => i.s.state === "live") ? "live" : "unreachable", teams = [...new Set(items.map((i) => i.s.offer.teamName))].join(", ");
		const seen = Math.max(...items.map((i) => i.s.seen ?? 0)), scope = items.some((i) => i.s.scope.box) ? "box" : "team";
		const box: RemoteBox = { device: first.s.offer.device, short: first.s.offer.short, label: first.s.offer.label, team: teams, scope, can: scope === "box" ? [...CAN, "tower"] : CAN, state, ...(state === "unreachable" ? { seen } : {}) };
		const parts = { tower, tabs: [...tabs.values()], outposts: [...outposts.values()], outside: [...outside.values()] }, marks = marksOf(parts);
		return { id: first.b.id, label: first.b.label, mark: marks.includes("waiting") ? "waiting" : marks.includes("working") ? "working" : "idle", box, ...parts };
	}

	// ---- the clock and the pages ------------------------------------------------------------------------------------------------------------------------------------------------

	function tick() {
		const t = now();
		for (const s of [...sessions.values()]) {
			try { s.session?.tick(); } catch { /* a handler's failure is not the clock's */ }
			if (s.deferred !== undefined && s.session) { const raw = s.deferred; s.snapAt = 0; snap(s, raw); }
		}
		for (const [id, p] of [...pending]) if (t - p.at >= REQUEST_MS) (pending.delete(id), p.done(no(504, "timeout", "The box did not answer; check before sending again.")));
		if (pages === 0 && leftAt !== undefined && t - leftAt >= IDLE_MS) { for (const s of [...sessions.values()]) close(s, "idle"); leftAt = undefined; return; }
		if (pages === 0 && leftAt === undefined) return;
		for (const offer of deps.boxes()) {
			const id = `${offer.team}/${offer.device}`;
			let s = sessions.get(id);
			if (!s) {
				s = { id, offer, state: "idle", scope: { box: false }, limits: { mirrors: 0, watches: 0, budget: 0 }, keys: new Map(), bases: new Map(), tabs: new Map(), extra: new Map(), retryAt: 0, refusedUntil: 0, fails: 0, reopening: false, snapAt: -Infinity, bad: 0, badLogged: 0 };
				sessions.set(id, s);
			}
			s.offer = offer;
			if (s.session || t < s.retryAt || t < s.refusedUntil || t < offUntil) continue;
			open(s);
		}
		for (const s of sessions.values()) if (s.ghostUntil !== undefined && s.ghostUntil > 0 && t >= s.ghostUntil) (s.ghostUntil = -1, changed());
	}
	const pulse = () => {
		if (deps.interval === false) return;
		if (sessions.size + pages > 0 && !timer) timer = setInterval(tick, deps.interval ?? OPERATE_LIMITS.tickMs).unref();
		if (sessions.size + pages === 0 && timer) (clearInterval(timer), (timer = undefined));
	};

	return {
		bridge: { claim, watch, mirrorOpen: (stream, send) => void streams.set(stream, send), mirrorClose(stream) {
			streams.delete(stream);
			for (const g of [...mirrorGroups.values()]) if (g.viewers.delete(stream)) { frameAt.delete(`${stream}\0${g.x}`); if (!g.viewers.size) { mirrorGroups.delete(`${g.device}\0${g.raw}`); void ask(g.sess, "mirror", "POST", ["sessions", g.raw, "mirror"], {}, { on: false }); } }
		} } satisfies RemoteBridge,
		/** A page's stream connected: the sessions open at the next tick. Returns the call that tells the host it left. */
		page(): () => void {
			pages++;
			leftAt = undefined;
			pulse();
			queueMicrotask(tick);
			let left = false;
			return () => { if (left) return; left = true; if (--pages === 0) leftAt = now(); pulse(); };
		},
		/** The operate message the holder took, from `from` of `team`. Only a box's own messages for a session of ours are used; the core drops the rest. */
		receive(m: OperateIn): void {
			if (m.fromAttended) return;
			const s = sessions.get(`${m.team}/${m.from}`);
			if (!s?.session || !m.message.session.equals(s.session.id)) return;
			try { s.session.receive(m.message, m.from); } catch { /* the sink must not throw */ }
			if (m.dropped > 0 && s.state === "live") resume(s); // the relay dropped frames: whole frames and snapshots cover most, the watches start over
		},
		/** The net with the boxes' bases after the local ones, and the dialogs a box's own base answers no longer shown as forwarded cards (§6.4). */
		merge(net: Net): Net {
			const m = merged(), hidden = net.link?.alerts.filter((a) => a.kind === "dialog" && m.dialogs.get(String(a.data.device))?.has(String(a.data.dialogId)));
			if (!m.bases.length && !m.events.length && !hidden?.length) return net;
			const link = hidden?.length ? { ...net.link!, alerts: net.link!.alerts.filter((a) => !hidden.includes(a)) } : net.link;
			const events = [...(net.events ?? []), ...m.events];
			return { ...net, bases: [...net.bases, ...m.bases], ...(events.length ? { events } : {}), ...(link ? { link } : {}) };
		},
		onChange(fn: () => void): () => void { listeners.add(fn); return () => void listeners.delete(fn); },
		/** The sessions open now, for `/boss link operate`. */
		status: () => [...sessions.values()].map((s) => ({ team: s.offer.team, device: s.offer.device, label: s.offer.label, scope: s.scope.box ? "box" : "team", state: s.state, since: s.openedAt, pages })),
		/** A team stopped (removal, fork, leave): its sessions end now. */
		closeTeam(team: string): void { for (const s of [...sessions.values()]) if (s.offer.team === team) close(s, "team-stopped"); },
		/** `/boss link operate off`: every session ends, and none opens again for a minute (the pages that stay would else reopen them at the next tick). */
		off(): void {
			offUntil = now() + 60_000;
			for (const s of [...sessions.values()]) close(s, "off");
		},
		stop(): void {
			if (timer) (clearInterval(timer), (timer = undefined));
			for (const s of [...sessions.values()]) close(s, "stop");
			settle(() => true, UNREACHABLE);
			groups.clear(); mirrorGroups.clear(); streams.clear(); listeners.clear();
		},
		tick,
	};
}
export type OperateHost = ReturnType<typeof createOperateHost>;
