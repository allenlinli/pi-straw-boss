import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { get, request } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import { createControl, type ControlDeps, type Reply, type TowerPanel } from "../src/control.ts";
import { readRecord as readGui } from "../src/handover.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { Found } from "../src/net.ts";
import { HEAD_NEEDS_SERVICE } from "../src/server/head.ts";
import { callControl } from "../src/server/socket.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The head tower's routes (docs/specs/2026-11-04-head-tower.md, The GUI channel; H3): the composer of the session key `sb-head` is a boss event for the head, `/quit` and `/new` are Leave and New, the buttons are `POST api/head/<action>`,
// and a paired device may do exactly what it may do for a tower. The routes run the tower panel's functions with the head's key; the first test pins that with a fake panel, the last ones run a real server.

const ORIGIN = "https://weis-mbp.local:8445", CSRF = "c".repeat(32);
type Calls = [string, ...unknown[]][];

function control(over: { has?: (w: string) => boolean; live?: boolean; event?: TowerPanel["event"]; withMemory?: boolean; withClose?: boolean } = {}) {
	const calls: Calls = [], herdr: string[] = [];
	const ok = async () => ({ ok: true });
	const tower: TowerPanel = {
		has: over.has ?? ((w) => w === "wA" || w === HEAD_KEY), live: () => over.live ?? false,
		event: over.event ?? (async (w, text) => (calls.push(["event", w, text]), { ok: true })),
		act: async (w, what, id) => (calls.push(["act", w, what, id]), { ok: true }),
		conversation: async (w, what) => (calls.push(["conversation", w, what]), what === "leave" ? { ok: true, left: true } : { ok: true, fresh: true }),
		...(over.withMemory === false ? {} : { memory: async (w, json) => (calls.push(["memory", w, json]), { status: 200, body: { rev: 1 } }) }),
		...(over.withClose === false ? {} : { close: async (w) => (calls.push(["close", w]), { ok: true }) }),
	};
	const lookup = (key: string): Found | undefined => (key === "sb-head" ? { key, base: HEAD_KEY, name: "head tower", role: "head", live: true } : key === "sb-tower-wa" ? { key, base: "wA", name: "tower", role: "tower", live: true } : undefined);
	const call: ControlDeps["call"] = async (method) => (herdr.push(method), {}) as never;
	const handle = createControl({ lookup, call, csrf: CSRF, canonical: (f) => f, secret: async () => false, tower });
	const post = (parts: string[], body: unknown, remote = false): Promise<Reply> => {
		const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
		return handle(req, ORIGIN, parts, remote);
	};
	return { post, calls, herdr };
}
const bodyOf = (r: Reply) => r.body as { accepted?: boolean; woke?: boolean; command?: string; left?: boolean; fresh?: boolean; error?: string; reason?: string };

test("the composer of the head is a boss event for the head and types nothing; exactly /quit and /new are Leave and New; empty text and a control character are refused as for a tower", async () => {
	const c = control();
	const sent = await c.post(["sessions", "sb-head", "input"], { text: "start MP-4129 in Alpha", as: "send" });
	assert.deepEqual([sent.status, sent.body], [200, { accepted: true, woke: true }]);
	assert.deepEqual((await c.post(["sessions", "sb-head", "input"], { text: " /quit ", as: "send" })).body, { accepted: true, command: "leave" });
	assert.deepEqual((await c.post(["sessions", "sb-head", "input"], { text: "/new", as: "send" })).body, { accepted: true, command: "new" });
	assert.deepEqual(c.calls, [["event", HEAD_KEY, "start MP-4129 in Alpha"], ["conversation", HEAD_KEY, "leave"], ["conversation", HEAD_KEY, "new"]]);
	assert.equal((await c.post(["sessions", "sb-head", "input"], { text: "  ", as: "send" })).status, 400);
	assert.equal((await c.post(["sessions", "sb-head", "input"], { text: "a\u0001b", as: "send" })).status, 400);
	assert.deepEqual(c.herdr, [], "nothing reached Herdr");
});

test("the head's buttons run the tower functions with the head's key: leave, new, memory, retry, deliver, drop, close", async () => {
	const c = control();
	assert.deepEqual(bodyOf(await c.post(["head", "leave"], {})), { left: true });
	assert.deepEqual(bodyOf(await c.post(["head", "new"], {})), { fresh: true });
	assert.deepEqual((await c.post(["head", "memory"], { op: "read" })).body, { rev: 1 });
	assert.equal((await c.post(["head", "retry"], {})).status, 200);
	assert.equal((await c.post(["head", "deliver"], { id: "e1" })).status, 200);
	assert.equal((await c.post(["head", "drop"], { id: "e2" })).status, 200);
	assert.equal((await c.post(["head", "close"], {})).status, 200);
	assert.deepEqual(c.calls, [["conversation", HEAD_KEY, "leave"], ["conversation", HEAD_KEY, "new"], ["memory", HEAD_KEY, { op: "read" }], ["act", HEAD_KEY, "retry", undefined], ["act", HEAD_KEY, "deliver", "e1"], ["act", HEAD_KEY, "drop", "e2"], ["close", HEAD_KEY]]);
});

test("the 409 words are the server's; a parked event needs its id; an unknown action is 404; a panel without the function, or with no tower service, says so", async () => {
	const refusing = control({ event: async () => ({ ok: false, error: HEAD_NEEDS_SERVICE }) });
	const no = await refusing.post(["sessions", "sb-head", "input"], { text: "x", as: "send" });
	assert.deepEqual([no.status, bodyOf(no).error, bodyOf(no).reason], [409, "refused", HEAD_NEEDS_SERVICE]);
	const c = control();
	assert.equal((await c.post(["head", "deliver"], {})).status, 400);
	assert.equal((await c.post(["head", "drop"], { id: "x".repeat(65) })).status, 400);
	assert.equal((await c.post(["head", "explode"], {})).status, 404);
	assert.equal((await c.post(["head", "leave", "extra"], {})).status, 404);
	assert.equal((await control({ withClose: false }).post(["head", "close"], {})).status, 404);
	assert.equal((await control({ withMemory: false }).post(["head", "memory"], { op: "read" })).status, 404);
	const off = control({ has: () => false });
	for (const parts of [["head", "leave"], ["head", "memory"], ["head", "close"], ["sessions", "sb-head", "input"]]) {
		const r = await off.post(parts, { text: "x", as: "send", op: "read" });
		assert.deepEqual([r.status, bodyOf(r).error, bodyOf(r).reason], [409, "refused", HEAD_NEEDS_SERVICE], parts.join("/"));
	}
});

test("with no run live the head has no terminal: keys, mirror, and focus are 409 standing in the tower's words, and its queue is the server's to take back", async () => {
	const c = control({ live: false });
	for (const [action, body] of [["keys", { key: "esc", stream: "s1" }], ["mirror", { stream: "s1", on: true }], ["focus", {}]] as const) {
		const r = await c.post(["sessions", "sb-head", action], body);
		assert.deepEqual([r.status, bodyOf(r).error], [409, "standing"], action);
		assert.match(String(bodyOf(r).reason), /^The head tower is standing by: no run is live/);
	}
	assert.equal(bodyOf(await c.post(["sessions", "sb-head", "dequeue"], { take: "a".repeat(16) })).error, "server_queue");
	assert.deepEqual(c.herdr, []);
	// A live run has a pane to key into: the generic route takes it from here (this key has no pane in the fake net, so it says so).
	const live = control({ live: true });
	assert.equal(bodyOf(await live.post(["sessions", "sb-head", "focus"], {})).error, "not_live");
});

test("a paired device may do for the head exactly what it may do for a tower: every route answers it as it answers the same request from this computer's page and the same request to a tower", async () => {
	const routes: [string[], string[], Record<string, unknown>][] = [
		[["sessions", "sb-head", "input"], ["sessions", "sb-tower-wa", "input"], { text: "/boss server stop and then more", as: "send" }],
		[["sessions", "sb-head", "input"], ["sessions", "sb-tower-wa", "input"], { text: "/quit", as: "send" }],
		[["sessions", "sb-head", "input"], ["sessions", "sb-tower-wa", "input"], { text: "/new", as: "send" }],
		[["head", "leave"], ["tower", "wA", "leave"], {}], [["head", "new"], ["tower", "wA", "new"], {}], [["head", "memory"], ["tower", "wA", "memory"], { op: "read" }],
		[["head", "retry"], ["tower", "wA", "retry"], {}], [["head", "deliver"], ["tower", "wA", "deliver"], { id: "e1" }], [["head", "drop"], ["tower", "wA", "drop"], { id: "e1" }],
		[["sessions", "sb-head", "keys"], ["sessions", "sb-tower-wa", "keys"], { key: "esc", stream: "s1" }], [["sessions", "sb-head", "focus"], ["sessions", "sb-tower-wa", "focus"], {}],
	];
	for (const remote of [true, false]) {
		const c = control();
		for (const [head, tower, body] of routes) {
			const [h, t] = [await c.post(head, body, remote), await c.post(tower, body, remote)];
			assert.deepEqual([h.status, bodyOf(h).error], [t.status, bodyOf(t).error], `${head.join("/")} for ${remote ? "a paired device" : "this computer"}`);
		}
	}
	// What a paired device may not do for a tower, it may not do for the head: a head route needs the CSRF secret and the page's own origin like every write.
	const c = control(), req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
	void c;
	const handle = createControl({ lookup: () => undefined, csrf: CSRF, canonical: (f) => f, tower: { has: () => true, live: () => false, event: async () => ({ ok: true }), act: async () => ({ ok: true }) } });
	assert.equal((await handle(req, ORIGIN, ["head", "leave"], true)).status, 403);
});

// --- a real server -----------------------------------------------------------------------------------------------------------------------------------------------------

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

const gui = () => readGui(world.slot.dir)!;
const post = (path: string, body: Record<string, unknown>) => {
	const g = gui(), data = JSON.stringify(body);
	return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: g.port, path: `/${g.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${g.port}`, origin: `http://127.0.0.1:${g.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": g.csrf!, "content-length": Buffer.byteLength(data) } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(data);
	});
};
/** A page's stream: the net is read, and the registry filled, while one is open. Resolves once the first reading arrived; `end()` closes it. */
function stream(watch?: string) {
	const g = gui();
	return new Promise<{ events: { event: string; data: unknown }[]; end(): void }>((resolve, reject) => {
		const events: { event: string; data: unknown }[] = [];
		const req = get({ host: "127.0.0.1", port: g.port, path: `/${g.token}/events${watch ? `?watch=${watch}` : ""}`, agent: false, headers: { host: `127.0.0.1:${g.port}` } }, (res) => {
			let buffer = "";
			res.setEncoding("utf8").on("data", (chunk: string) => {
				buffer += chunk;
				for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
					const block = buffer.slice(0, cut);
					buffer = buffer.slice(cut + 2);
					const event = /^event: (.*)$/m.exec(block)?.[1] ?? "net", data = /^data: (.*)$/m.exec(block)?.[1];
					if (data) events.push({ event, data: JSON.parse(data) });
					if (event === "net" && events.length === 1) resolve({ events, end: () => req.destroy() });
				}
			});
		});
		req.on("error", (e) => (e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(e)).end();
	});
}
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Record<string, unknown> & { ok: boolean });

test("a message typed into the head page makes the head workspace and wakes a run; /new before a conversation exists and the buttons answer in the server's words", async () => {
	const s = await world.start();
	await s.handle.ready;
	const page = await stream();
	assert.equal(world.herdr.workspaces.some((w) => w.tokens?.sb_head), false, "nothing before the first message");
	const net = page.events[0]!.data as { head?: { key: string; state: string } };
	assert.deepEqual([net.head?.key, net.head?.state], ["sb-head", "absent"], "the page can write to the head before it exists");
	// Before the head exists: its buttons say so in the server's words, and its memory (the boss's own file) is reachable.
	for (const action of ["leave", "new", "retry"]) {
		const r = await post(`head/${action}`, {});
		assert.deepEqual([r.status, r.body.error, String(r.body.reason)], [409, "refused", "The head tower is not open: its first message opens it."], action);
	}
	assert.equal((await post("head/close", {})).status, 200, "closing a head that is not open is nothing to do");
	const memory = await post("head/memory", { op: "read" });
	assert.equal(memory.status, 200, JSON.stringify(memory.body));
	assert.equal(typeof memory.body.rev, "number");
	const sent = await post("sessions/sb-head/input", { text: "tell Alpha to start", as: "send" });
	assert.deepEqual([sent.status, sent.body], [200, { accepted: true, woke: true }]);
	assert.ok(world.herdr.workspaces.some((w) => w.tokens?.sb_head), "the head workspace was made");
	await until(() => world.pis.size === 1, "the head run");
	// A conversation is live only once the run claims; the buttons refuse in the server's words until then, and 404 is only for an unknown action.
	assert.equal((await post("head/explode", {})).status, 404);
	const closed = await post("head/close", {});
	assert.equal(closed.status, 200);
	assert.equal(world.herdr.workspaces.some((w) => w.tokens?.sb_head), false, "close ends the head service and its workspace");
	page.end();
	void ask;
});

test("the head has one route family, api/head/…: api/tower/@head/… and api/tower/<head workspace>/… are 404 (review HH3-F003)", async () => {
	const s = await world.start();
	await s.handle.ready;
	const page = await stream();
	assert.equal((await post("sessions/sb-head/input", { text: "go", as: "send" })).status, 200);
	const head = world.herdr.workspaces.find((w) => w.tokens?.sb_head)!.workspace_id;
	for (const key of ["@head", head]) {
		for (const action of ["memory", "leave", "new", "retry", "deliver", "drop"]) {
			const r = await post(`tower/${key}/${action}`, { op: "read", id: "e1" });
			assert.deepEqual([r.status, r.body.error], [404, "not_found"], `${key}/${action}`);
		}
	}
	assert.equal((await post("head/memory", { op: "read" })).status, 200, "the head's own family still answers");
	page.end();
});
