import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { STALE_MS, writeEntry } from "../src/board.ts";
import { boardSeam } from "../src/boardview.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { netSource } from "../src/net.ts";
import { verdictOf } from "../src/operateroutes.ts";
import { CLEARED_NOTICE, createBoardPanel } from "../src/server/boardpanel.ts";

// Clear on the head page's work board (docs/specs/2026-11-09-board-view.md, Server routes): `board/clear {session}` deletes one line, only when the SERVER's own reading now says it is ended or idle over 2 hours, and tells a live writer once.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-boardclear-"))), dirs.at(-1)!);
const MIN = 60_000, HOUR = 60 * MIN, NOW = Date.parse("2026-11-09T10:00:00Z");

const ws = (id: string, label: string, tokens: Record<string, string> = {}): Workspace => ({ workspace_id: id, label, tokens });
const pane = (id: string, tab: string, tokens: Record<string, string>): Pane => ({ pane_id: id, tab_id: tab, workspace_id: "wA", tokens });
const session = (id: string, name: string, p: string, tab: string, status: string): Session => ({ id, name, status, herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "Alpha" }, tab: { id: tab, label: tab } } } as Session);
const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: [pane("wA:p1", "wA:t1", { sb_role: "main" }), pane("wA:p2", "wA:t2", { sb_role: "main" }), pane("wA:p3", "wA:t3", { sb_role: "main" }), pane("wA:p5", "wA:t9", { sb_role: "tower" })] } : { workspaces: [ws("wA", "Alpha", { tower: "tower-a" })] } });
/** Three live mains: `stale-main` idle, `busy-main` working, `fresh-main` idle; the line files are written by the test. */
const sessions = async () => [session("tower-a", "tower", "wA:p5", "wA:t9", "idle"), session("stale-main", "billing", "wA:p1", "wA:t1", "idle"), session("busy-main", "reports", "wA:p2", "wA:t2", "working"), session("fresh-main", "mobile", "wA:p3", "wA:t3", "idle")];
const write = (dir: string, id: string, age: number) => writeEntry(dir, id, { now: `work of ${id}`, items: [{ t: "a", done: false }] }, NOW - age);

function panel(dir: string, o: { told?: boolean; now?: () => number; between?: () => void } = {}) {
	const told: [string, string][] = [];
	const source = netSource({ run: herdr, sessions, sessionDir: "/s", board: boardSeam({ dir, now: o.now ?? (() => NOW) }) });
	const clear = createBoardPanel({ dir, read: async () => { const net = await source.read(); o.between?.(); return net; }, tell: async (id, text) => (told.push([id, text]), o.told ?? true) });
	return { told, clear: (json: Record<string, unknown>) => clear.clear(json) };
}

test("it refuses what is no session id, a path, a missing file, a main that works, and a fresh idle main, and deletes nothing and tells nobody", async () => {
	const dir = state();
	write(dir, "stale-main", STALE_MS + MIN);
	write(dir, "busy-main", STALE_MS + HOUR);
	write(dir, "fresh-main", STALE_MS - HOUR);
	const { clear, told } = panel(dir);
	for (const bad of [{}, { session: 3 }, { session: "" }, { session: "../x" }, { session: "a/b" }, { session: "..\\x" }, { session: ".hidden" }, { session: "a b" }, { session: "x".repeat(200) }]) assert.equal((await clear(bad)).status, 400, JSON.stringify(bad));
	assert.equal((await clear({ session: "no-such-session" })).status, 404, "no file, nothing to clear");
	const busy = await clear({ session: "busy-main" }), fresh = await clear({ session: "fresh-main" });
	assert.deepEqual([busy.status, fresh.status], [409, 409]);
	assert.deepEqual(readdirSync(dir).sort(), ["busy-main.json", "fresh-main.json", "stale-main.json"]);
	assert.deepEqual(told, []);
});

test("the page's claim is never used: a body that says the row is ended, stale, or clearable changes nothing", async () => {
	const dir = state();
	write(dir, "fresh-main", MIN);
	write(dir, "busy-main", 10 * HOUR);
	const { clear, told } = panel(dir);
	for (const session of ["fresh-main", "busy-main"]) assert.equal((await clear({ session, clearable: true, stale: true, state: "ended", force: true, ended: true })).status, 409, session);
	assert.equal(readdirSync(dir).length, 2);
	assert.deepEqual(told, []);
});

test("an ended entry (its session is not a live main) is deleted at any age and its writer is told nothing", async () => {
	const dir = state();
	write(dir, "gone-1", 40 * MIN);
	write(dir, "gone-2", 30 * HOUR);
	const { clear, told } = panel(dir);
	assert.deepEqual(await clear({ session: "gone-1" }), { status: 200, body: { cleared: true, told: false } });
	assert.deepEqual(await clear({ session: "gone-2" }), { status: 200, body: { cleared: true, told: false } });
	assert.deepEqual(readdirSync(dir), []);
	assert.deepEqual(told, [], "an ended writer is gone: there is nobody to tell (B5)");
});

test("a stale line of a live idle main is deleted and its writer is told once, with the notice's exact words; the answer says whether the notice was delivered", async () => {
	const dir = state();
	write(dir, "stale-main", STALE_MS + MIN);
	write(dir, "fresh-main", STALE_MS - MIN);
	const a = panel(dir);
	assert.deepEqual(await a.clear({ session: "stale-main" }), { status: 200, body: { cleared: true, told: true } });
	assert.deepEqual(readdirSync(dir), ["fresh-main.json"], "only that line goes");
	assert.deepEqual(a.told, [["stale-main", CLEARED_NOTICE]]);
	assert.equal(CLEARED_NOTICE, "The boss cleared your work-board line from the head page (it was idle over 2 hours). If you still work on it, write it again with board_set; if the work is over, nothing to do.");
	assert.equal((await a.clear({ session: "stale-main" })).status, 404, "a second click finds no file");
	assert.equal(a.told.length, 1, "told once");
	write(dir, "stale-main", STALE_MS + MIN);
	const b = panel(dir, { told: false });
	assert.deepEqual(await b.clear({ session: "stale-main" }), { status: 200, body: { cleared: true, told: false } }, "the notice could not be delivered: cleared, not told");
	assert.ok(!existsSync(join(dir, "stale-main.json")));
});

test("a line its writer wrote again between the server's reading and the delete is not cleared", async () => {
	const dir = state();
	write(dir, "stale-main", STALE_MS + MIN);
	const { clear, told } = panel(dir, { between: () => void write(dir, "stale-main", MIN) });
	const answer = await clear({ session: "stale-main" });
	assert.equal(answer.status, 409);
	assert.ok(existsSync(join(dir, "stale-main.json")), "the fresh line stands");
	assert.deepEqual(told, []);
});

test("a file the structure check refuses is no row and cannot be cleared by naming it", async () => {
	const dir = state();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "stale-main.json"), "{not json");
	const { clear } = panel(dir);
	assert.equal((await clear({ session: "stale-main" })).status, 409);
	assert.ok(existsSync(join(dir, "stale-main.json")));
});

// The route: this computer's page and a paired device reach it, the operate table refuses it (Straw Link has no way to ask for it).
const scratch = mkdtempSync(join(tmpdir(), "psb-boardroute-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => { await Promise.all(running.map((g) => g.stop())); rmSync(scratch, { recursive: true, force: true }); });
function post(gui: Gui, path: string, body: unknown, port = gui.port, headers: Record<string, string> = {}) {
	const data = JSON.stringify(body);
	return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data)), ...headers } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(data);
	});
}

test("POST board/clear reaches the panel from this computer's page; the answer is the panel's; a body that is not an object, or a key that is not clear, is refused", async () => {
	const seen: Record<string, unknown>[] = [];
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: () => undefined, workspace: () => [] }, board: { clear: async (json) => (seen.push(json), { status: 200, body: { cleared: true, told: false } }) }, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	assert.deepEqual(await post(gui, "board/clear", { session: "s-1" }), { status: 200, body: { cleared: true, told: false } });
	assert.deepEqual(seen, [{ session: "s-1" }]);
	assert.equal((await post(gui, "board/other", { session: "s-1" })).status, 404);
	assert.equal((await post(gui, "board/clear/extra", { session: "s-1" })).status, 404);
	assert.equal(seen.length, 1);
});

test("a paired device clears as this computer's page does", async () => {
	const HOST = "box.tail1.ts.net:8443", LOGIN = "me@example.com", seen: Record<string, unknown>[] = [];
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: () => undefined, workspace: () => [] }, board: { clear: async (json) => (seen.push(json), { status: 200, body: { cleared: true, told: true } }) }, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	gui.access.enable({ host: HOST, login: LOGIN });
	const tailnet = { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" };
	const ask = (path: string, headers: Record<string, string>, method: string, payload?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; body: Record<string, unknown> }>((resolve, reject) => {
		const data = payload === undefined ? "{}" : JSON.stringify(payload);
		const req = request({ host: "127.0.0.1", port: gui.remotePort, path, method, headers: { ...headers, ...(method === "POST" ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(method === "POST" ? data : undefined);
	});
	const cookie = String((await ask(`/${gui.token}/pair/${gui.access.pair()}`, tailnet, "GET")).headers["set-cookie"]).split(";")[0]!;
	const done = await ask(`/${gui.token}/api/board/clear`, { ...tailnet, cookie, origin: `https://${HOST}`, "content-type": "application/json", "x-sb-csrf": gui.csrf }, "POST", { session: "s-1" });
	assert.deepEqual([done.status, done.body, seen], [200, { cleared: true, told: true }, [{ session: "s-1" }]]);
});

test("without a panel the route says it is unavailable", async () => {
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: () => undefined, workspace: () => [] }, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	assert.equal((await post(gui, "board/clear", { session: "s-1" })).status, 503);
});

test("an operate session cannot ask for it: the route table refuses board/**", () => {
	assert.equal(verdictOf("POST", ["board", "clear"]), "refused");
	assert.equal(verdictOf("POST", ["board", "anything"]), "refused");
});

test("the server tells a live session once, under a board_clear header from its own id, and says whether the broker delivered it", async () => {
	const { tellVia } = await import("../src/server/boardpanel.ts");
	const sent: [string, { text: string; messageId?: string }][] = [];
	const client = (delivered: boolean | Error, connected = true) => ({ isConnected: () => connected, send: async (to: string, m: { text: string; messageId?: string }) => { sent.push([to, m]); if (delivered instanceof Error) throw delivered; return { delivered } as never; } });
	assert.equal(await tellVia(() => client(true), "sb-server-id")("sess-1", CLEARED_NOTICE), true);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]![0], "sess-1");
	assert.match(sent[0]![1].text, /^\[straw net from="straw boss" id=sb-server-id role=session kind=board_clear scope=session to="sess-1 \(session\)" reply=none\] The boss cleared your work-board line/);
	assert.ok(sent[0]![1].text.endsWith(CLEARED_NOTICE));
	assert.match(sent[0]![1].messageId!, /^board-clear-/);
	assert.equal(await tellVia(() => client(false), "x")("sess-1", "t"), false, "the broker did not deliver");
	assert.equal(await tellVia(() => client(new Error("down")), "x")("sess-1", "t"), false, "a failed send is not told");
	const before = sent.length;
	assert.equal(await tellVia(() => client(true, false), "x")("sess-1", "t"), false, "not connected: nothing sent");
	assert.equal(await tellVia(() => undefined, "x")("sess-1", "t"), false);
	assert.equal(sent.length, before);
});
