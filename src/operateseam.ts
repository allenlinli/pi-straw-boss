import { randomBytes } from "node:crypto";
import type { Flags, Reply } from "./control.ts";
import type { createMirrors } from "./mirror.ts";
import type { Net } from "./net.ts";
import { type OperateScope, plan, refusalReply, unitsOfTab } from "./operateroutes.ts";
import { sliceNet } from "./operateslice.ts";
import { store, target as uploadTarget } from "./upload.ts";
import { api, type Hub as Files, image, watchSession, type Watch, watchWorkspace } from "./watch.ts";

// The box's GUI, entered in process for one operate session (docs/specs/2026-11-07-link-operate.md §6.1): no listener, token, cookie or CSRF is involved, and nothing new listens on the box. The bridge (a later task) holds one
// `OperateSession` per operator and carries what comes out of its sink to the controller as sealed frames. Each entry takes the session's `scope` and reads it afresh, so a roster or policy change reaches the next request.
//   snapshot(scope)                          the net, sliced to the scope (operateslice.ts); `changed` says when it moved
//   watch(id, target, on, scope)             the stream's `history` and `cards` for a unit's key, or `w:<workspace>`, to the sink under `id`
//   mirror(key, on, scope)                   the terminal mirror, on a stream of the session's own: the limit of 2 terminals per stream is the session's and the 6 per server the box's
//   request(method, parts, query, body, scope)  one page request on a unit, after the table of operateroutes.ts, through control.ts with every guard of a paired device's request and the box's own (§7)
// A refusal of the table or of a scope is a 403 whose body is `{error: "operate_refused", why, reason}`; a guard's own refusal keeps its own error code. An image answers `{type, base64}`.

/** Where a session's frames go: a watch's under the id it was started with, a mirror's under `m:<key>`. */
export type Sink = (id: string, event: string, data: unknown) => void;
export const MAX_UPLOAD = 2 * 1024 * 1024, MAX_WATCHES = 8;
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

export interface OperateSession {
	watch(id: string, target: string, on: boolean, scope: OperateScope): Promise<Reply>;
	mirror(key: string, on: boolean, scope: OperateScope): Promise<Reply>;
	request(method: "GET" | "POST", parts: string[], query: URLSearchParams, body: Record<string, unknown> | Buffer, scope: OperateScope): Promise<Reply>;
	/** Ends everything the session holds: its watches and its mirrors. */
	stop(): void;
}
export interface Operate {
	open(sink: Sink): OperateSession;
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
	/** Sessions were opened or ended: the server's polling follows `size`. */
	active(): void;
}

export function createOperate({ control, files, mirrors, net, active }: SeamDeps) {
	const sessions = new Set<{ watches: Map<string, Watch>; stop(): void }>(), listeners = new Set<() => void>();
	const FLAGS: Flags = { remote: true, secure: true, operate: true };
	/** The registry as this scope sees it: a key out of scope is unknown, so nothing of it is read from the file system. */
	const scoped = (scope: OperateScope): Files => ({ lookup: (key) => (scope.has(key) ? files.lookup(key) : undefined), workspace: (id) => files.workspace(id).filter((r) => scope.has(r.key)), readers: files.readers });

	const api_: Operate = {
		snapshot: async (scope) => sliceNet(await net(), scope),
		changed: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
		open(sink) {
			const stream = randomBytes(16).toString("hex"), watches = new Map<string, Watch>();
			mirrors.open(stream, (event, data) => sink(`m:${(data as { key?: string }).key ?? ""}`, event, data));
			const self: { watches: Map<string, Watch>; stop(): void } = {
				watches,
				stop() {
					watches.forEach((w) => w.stop());
					watches.clear();
					mirrors.close(stream);
					if (sessions.delete(self)) active();
				},
			};
			sessions.add(self);
			active();
			return {
				stop: self.stop,
				async watch(id, at, on, scope) {
					if (!id || id.length > 64) return no(400, "bad_request", "A watch is named by an id.");
					watches.get(id)?.stop();
					watches.delete(id);
					if (!on) return { status: 200, body: { watching: false } };
					if (watches.size >= MAX_WATCHES) return no(429, "too_many", `A session watches at most ${MAX_WATCHES} things.`);
					const workspace = at.startsWith("w:");
					if (!workspace && !scope.has(at)) return refusalReply({ ok: false, why: "out-of-scope", reason: "That unit is not one this session reaches." });
					await net(); // the registry is filled by reading the net: a watch starts once a reading exists
					const send = (event: string, data: unknown) => sink(id, event, data), hub = scoped(scope);
					const w = workspace ? watchWorkspace(hub, at.slice(2), send) : watchSession(hub, at, send);
					watches.set(id, w);
					void w.refresh().catch(() => {});
					return { status: 200, body: { watching: true } };
				},
				async mirror(key, on, scope) {
					const p = plan("POST", ["sessions", key, "mirror"], {}, scope, "mirror");
					return p.ok ? control.run(["sessions", key, "mirror"], { stream, on }, FLAGS) : refusalReply(p);
				},
				async request(method, parts, query, body, scope) {
					const p = plan(method, parts, body, scope);
					if (!p.ok) return refusalReply(p);
					if (p.tab) {
						// A squad closes with everything in it: every unit the net shows there must be this scope's, and a tab the net does not show is not one to close.
						const units = unitsOfTab(await net(true), p.tab.workspace, p.tab.tab);
						if (!units?.every((key) => scope.has(key))) return refusalReply({ ok: false, why: "out-of-scope", reason: "A unit in that squad is not one this session reaches." });
					}
					const hub = scoped(scope);
					if (method === "GET") {
						try {
							if (parts[0] === "image") {
								const pic = await image(hub, parts.slice(1));
								return pic ? { status: 200, body: { type: pic.type, base64: pic.bytes.toString("base64") } } : no(404, "not_found", "No such image.");
							}
							return await api(hub, parts, query);
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
		/** After every reading: each session's watches retry what could not attach and report what the file events missed. */
		refresh: () => Promise.all([...sessions].flatMap((s) => [...s.watches.values()].map((w) => w.refresh().catch(() => {})))).then(() => undefined),
		/** The server stops: every session ends. */
		stop: () => [...sessions].forEach((s) => s.stop()),
	};
}
