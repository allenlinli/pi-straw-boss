import { randomBytes } from "node:crypto";
import type { Flags, Reply } from "./control.ts";
import { piInForeground } from "./foreground.ts";
import type { HerdrCall } from "./herdr.ts";
import type { createMirrors } from "./mirror.ts";
import type { Net } from "./net.ts";
import { type OperateScope, plan, refusalReply, unitsOfTab } from "./operateroutes.ts";
import { sliceNet } from "./operateslice.ts";
import { store, target as uploadTarget } from "./upload.ts";
import { api, type Hub as Files, image, type Transcripts, watchSession, type Watch, watchWorkspace } from "./watch.ts";

// The box's GUI, entered in process for one operate session (docs/specs/2026-11-07-link-operate.md §6.1): no listener, token, cookie or CSRF is involved, and nothing new listens on the box. The bridge (a later task) holds one
// `OperateSession` per operator and carries what comes out of its sink to the controller as sealed frames. Each entry takes the session's `scope` and reads it afresh, so a roster or policy change reaches the next request.
//   snapshot(scope)                          the net, sliced to the scope (operateslice.ts); `changed` says when it moved
//   watch(id, target, on, scope)             the stream's `history` and `cards` for a unit's key, or `w:<workspace>`, to the sink under `id`
//   mirror(key, on, scope)                   the terminal mirror, on a stream of the session's own: the limit of 2 terminals per stream is the session's and the 6 per server the box's
//   request(method, parts, query, body, scope)  one page request on a unit, after the table of operateroutes.ts, through control.ts with every guard of a paired device's request and the box's own (§7)
// A refusal of the table or of a scope is a 403 whose body is `{error: "operate_refused", why, reason}`; a guard's own refusal keeps its own error code. An image answers `{type, base64}`.

/** Where a session's frames go: a watch's under the id it was started with, a mirror's under `m:<key>`. */
export type Sink = (id: string, event: string, data: unknown) => void;
/** What a reply carries at most: an image's bytes, and one entry's whole body (§6.4 and §9 drop what is larger at the controller; here it is refused clearly, before it is sealed). */
export const MAX_UPLOAD = 2 * 1024 * 1024, MAX_WATCHES = 8, MAX_REPLY = 1024 * 1024;
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

interface Held { w: Watch; scope: OperateScope; /** The unit a session watch is of; a workspace's cards follow the scope on their own. */ key?: string }
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
/** An entry's reply as the box sends it: over 1 MB its images go (`picsCut`, they are fetched one by one), and still over 1 MB it is refused. */
function bounded(read: Reply): Reply {
	if (read.status !== 200 || size(read.body) <= MAX_REPLY) return read;
	const { pics: _pics, ...rest } = read.body as { pics?: unknown };
	return size(rest) <= MAX_REPLY ? { status: 200, body: { ...rest, picsCut: true } } : no(413, "too_large", "The entry is larger than 1 MB.");
}

export interface OperateSession {
	watch(id: string, target: string, on: boolean, scope: OperateScope): Promise<Reply>;
	mirror(key: string, on: boolean, scope: OperateScope): Promise<Reply>;
	/** The scope changed (a roster or policy change, task 5): every watch and mirror whose unit `scope` does not hold ends now, and the rest follow `scope` from here on. */
	rescope(scope: OperateScope): Promise<void>;
	request(method: "GET" | "POST", parts: string[], query: URLSearchParams, body: Record<string, unknown> | Buffer, scope: OperateScope): Promise<Reply>;
	/** Ends everything the session holds: its watches and its mirrors. */
	stop(): void;
}
export interface Operate {
	/** `transcripts` are the finished runs this session's scope reaches (server/operateledger.ts `within`, §9): its hub lists them, and a `t<id>` key it holds is read and watched like a unit in scope. */
	open(sink: Sink, transcripts?: Transcripts): OperateSession;
	snapshot(scope: OperateScope): Promise<Net>;
	/** Calls back after each reading of the net that differs from the one before; returns the way to stop. */
	changed(listener: () => void): () => void;
}
export interface SeamDeps {
	control: { run(parts: string[], json: Record<string, unknown>, flags: Flags): Promise<Reply> };
	files: Files;
	mirrors: Pick<ReturnType<typeof createMirrors>, "open" | "close">;
	/** The last reading of the net, or one made now (`fresh`, or when there is none); it throws when the net cannot be read. */
	net(fresh?: boolean): Promise<Net>;
	/** Herdr's socket, to list a squad's panes before it closes; without it a squad is not closed from here. */
	call?: HerdrCall;
	/** Sessions were opened or ended: the server's polling follows `size`. */
	active(): void;
}

export function createOperate({ control, files, mirrors, net, call, active }: SeamDeps) {
	const sessions = new Set<{ enforce(scope?: OperateScope): Promise<void>; refresh(): Promise<void>; stop(): void }>(), listeners = new Set<() => void>();
	/** Herdr says `pi` while pi lives, whatever runs below it; the process list says whether pi is in the foreground, and control.ts asks right before each write (the bridge's raw-mode report says the rest, probe.ts). */
	const foreground = async (pane: string) => piInForeground(await call?.("pane.process_info", { pane_id: pane }).then((r) => (r as { process_info?: unknown })?.process_info as Parameters<typeof piInForeground>[0], () => undefined));
	const FLAGS: Flags = { remote: true, secure: true, operate: true, foreground };
	/** The registry as this scope sees it: a key out of scope is unknown, so nothing of it is read from the file system. */
	const scoped = (at: () => OperateScope, transcripts?: Transcripts): Files => ({ lookup: (key) => (at().has(key) ? files.lookup(key) : undefined), workspace: (id) => files.workspace(id).filter((r) => at().has(r.key)), readers: files.readers, ...(transcripts ? { transcripts } : {}) });
	const TKEY = /^t[0-9a-f]{16}$/;
	const roleOf = (key: string) => files.lookup(key)?.role;

	const api_: Operate = {
		snapshot: async (scope) => sliceNet(await net(), scope),
		changed: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
		open(sink, transcripts) {
			/** The scope for what a session reads: a `t<id>` its ledger shows it is in scope (the ledger holds the scope itself), and every other key is the scope's own. Only reads and watches take it: nothing else is done to a transcript. */
			const reads = (scope: OperateScope): OperateScope => (transcripts ? { box: scope.box, has: (key) => scope.has(key) || (TKEY.test(key) && transcripts.has(key)) } : scope);
			const stream = randomBytes(16).toString("hex"), watches = new Map<string, Held>(), mirrored = new Map<string, OperateScope>();
			/** The scope the last `rescope` set and how many there were: a watch or mirror that began before one finishes under it, since `enforce` cannot see an entry that is still being set up. */
			let latest: OperateScope | undefined, epoch = 0, ended = false, ticket = 0;
			/** The newest request of each watch id: an earlier one still setting up when a later one (or `stop`) came does not register, so no watch lives outside `watches`, where `enforce` and `stop` reach it. */
			const newest = new Map<string, number>();
			mirrors.open(stream, (event, data) => sink(`m:${(data as { key?: string }).key ?? ""}`, event, data));
			/** Each watch and mirror keeps the scope it was asked under; whatever unit has left it ends here (§1.5: an admin's removal ends open operate streams at once). */
			const enforce = async (next?: OperateScope) => {
				for (const [id, held] of watches) {
					if (next) held.scope = reads(next);
					if (held.key === undefined || held.scope.has(held.key)) continue;
					held.w.stop();
					watches.delete(id);
					sink(id, "history", { key: held.key, state: "unknown", reset: false, items: [] });
				}
				for (const [key, scope] of mirrored) {
					const now = next ?? scope;
					if (now.has(key)) { mirrored.set(key, now); continue; }
					mirrored.delete(key);
					await control.run(["sessions", key, "mirror"], { stream, on: false }, FLAGS).catch(() => undefined); // not through `plan`: the key is out of scope, which is why it ends
				}
			};
			const self = {
				enforce,
				refresh: async () => { await enforce(); await Promise.all([...watches.values()].map((h) => h.w.refresh().catch(() => {}))); },
				stop() {
					ended = true;
					newest.clear();
					watches.forEach((h) => h.w.stop());
					watches.clear();
					mirrored.clear();
					mirrors.close(stream);
					if (sessions.delete(self)) active();
				},
			};
			sessions.add(self);
			active();
			return {
				stop: self.stop,
				rescope: (scope) => (epoch++, (latest = scope), enforce(scope)),
				async watch(id, at, on, scope) {
					if (!id || id.length > 64) return no(400, "bad_request", "A watch is named by an id.");
					const mine = ++ticket;
					newest.set(id, mine);
					watches.get(id)?.w.stop();
					watches.delete(id);
					try {
						if (!on) return { status: 200, body: { watching: false } };
						if (watches.size >= MAX_WATCHES) return no(429, "too_many", `A session watches at most ${MAX_WATCHES} things.`);
						const workspace = at.startsWith("w:"), held: Held = { w: undefined as unknown as Watch, scope: reads(scope), ...(workspace ? {} : { key: at }) };
						if (held.key !== undefined && !held.scope.has(held.key)) return refusalReply({ ok: false, why: "out-of-scope", reason: "That unit is not one this session reaches." });
						const began = epoch;
						await net(); // the registry is filled by reading the net: a watch starts once a reading exists
						if (ended || newest.get(id) !== mine) return no(409, "superseded", "The session ended, or this watch was asked for again meanwhile.");
						if (epoch !== began) held.scope = reads(latest!); // a `rescope` ran meanwhile
						if (held.key !== undefined && !held.scope.has(held.key)) return refusalReply({ ok: false, why: "out-of-scope", reason: "That unit is not one this session reaches." }); // the scope may have narrowed while the net was read
						const send = (event: string, data: unknown) => sink(id, event, data), hub = scoped(() => held.scope, transcripts);
						held.w = workspace ? watchWorkspace(hub, at.slice(2), send) : watchSession(hub, at, send);
						watches.set(id, held);
						void held.w.refresh().catch(() => {});
						return { status: 200, body: { watching: true } };
					} finally {
						if (newest.get(id) === mine) newest.delete(id);
					}
				},
				async mirror(key, on, scope) {
					const p = plan("POST", ["sessions", key, "mirror"], {}, scope, "mirror", roleOf);
					if (!p.ok) return refusalReply(p);
					const began = epoch, done = await control.run(["sessions", key, "mirror"], { stream, on }, FLAGS);
					if (done.status !== 200) return done;
					if (!on) return mirrored.delete(key), done;
					const now = epoch !== began ? latest! : scope; // a `rescope` ran while the mirror was being attached
					if (!now.has(key)) {
						await control.run(["sessions", key, "mirror"], { stream, on: false }, FLAGS).catch(() => undefined); // not through `plan`: the key is out of scope, which is why it ends
						return refusalReply({ ok: false, why: "out-of-scope", reason: "That unit is not one this session reaches." });
					}
					mirrored.set(key, now);
					return done;
				},
				async request(method, parts, query, body, given) {
					const scope = method === "GET" && (parts[0] === "history" || parts[0] === "entry" || parts[0] === "image") ? reads(given) : given;
					const p = plan(method, parts, body, scope, "request", roleOf);
					if (!p.ok) return refusalReply(p);
					const hub = scoped(() => scope, transcripts);
					if (p.tab) {
						// A squad closes with everything in it, and Herdr's tab close takes every pane in it: every unit the net shows there must be this scope's, a tab the net does not show is not one to close, and so is one whose panes
						// are not all those units' (a shell, a pane an answer opened, a unit that joined since the reading) — read from Herdr now.
						const units = unitsOfTab(await net(true), p.tab.workspace, p.tab.tab), refuse = () => refusalReply({ ok: false, why: "out-of-scope", reason: "A unit in that squad is not one this session reaches." });
						if (!units?.every((key) => scope.has(key))) return refuse();
						const mine = new Set(units.map((key) => files.lookup(key)?.pane).filter((pane) => pane !== undefined));
						const here = await call?.("pane.list", { workspace_id: p.tab.workspace }).then((r) => (r as { panes: { pane_id: string; tab_id: string }[] }).panes, () => undefined);
						if (!here || here.some((pane) => pane.tab_id === p.tab!.tab && !mine.has(pane.pane_id))) return refuse();
					}
					if (method === "GET") {
						try {
							if (parts[0] === "image") {
								const pic = await image(hub, parts.slice(1));
								if (pic && pic.bytes.length > MAX_REPLY) return no(413, "too_large", "The image is larger than 1 MB.");
								return pic ? { status: 200, body: { type: pic.type, base64: pic.bytes.toString("base64") } } : no(404, "not_found", "No such image.");
							}
							const read = await api(hub, parts, query);
							return parts[0] === "entry" ? bounded(read) : read;
						} catch {
							return no(404, "not_found", "Nothing to read there.");
						}
					}
					if (p.row.path === "sessions/*/upload") {
						if (!Buffer.isBuffer(body)) return no(400, "bad_request", "An upload is the file's bytes.");
						if (body.length > MAX_UPLOAD) return no(413, "too_large", "The file is larger than 2 MB.");
						return uploadTarget(hub.lookup(parts[1]!)) ?? (await store(body, query.get("name")));
					}
					if (Buffer.isBuffer(body)) return no(400, "bad_request", "The body is not a JSON object.");
					// The pad's keys need this session's own live mirror (keys.ts): the controller's page names its own stream, which means nothing here.
					return control.run(parts, p.row.path === "sessions/*/keys" && typeof body.stream === "string" ? { ...body, stream } : body, FLAGS);
				},
			} satisfies OperateSession;
		},
	};
	return {
		api: api_,
		/** Sessions open now: the server reads the net while any is. */
		size: () => sessions.size,
		/** A reading of the net that moved: the sessions' listeners hear it. */
		notify: () => listeners.forEach((l) => { try { l(); } catch { /* a listener's failure is not the net's problem */ } }),
		/** After every reading: each session first ends what left its scope, then its watches retry what could not attach and report what the file events missed. */
		refresh: () => Promise.all([...sessions].map((s) => s.refresh().catch(() => {}))).then(() => undefined),
		/** The server stops: every session ends. */
		stop: () => [...sessions].forEach((s) => s.stop()),
	};
}
