import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAnswered } from "../src/answered.ts";
import { createControl } from "../src/control.ts";
import { type Gui, startGui } from "../src/gui.ts";
import { HerdrError } from "../src/herdr.ts";
import type { Found } from "../src/net.ts";

// A chat block's answer is recorded by the server in the very request that sends it (docs/specs/2026-11-07-better-show-host.md, "Answered"): `sessions/<key>/input` with a `block {entry, index, fields}` is begun as pending before
// anything is sent, done once the unit took the message, cancelled when it did not, and read back by every page at `GET answered/<key>`. A block that is pending or done is not sent again, from any device.

const scratch = mkdtempSync(join(tmpdir(), "psb-block-record-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const FILE = "/s/2026_sess-1.jsonl";
async function setup({ disk = { text: undefined as string | undefined, fail: false }, status = "idle", timeout = false }: { disk?: { text: string | undefined; fail: boolean }; status?: string; timeout?: boolean } = {}) {
	const calls: [string, Record<string, unknown>][] = [];
	let hold: Promise<void> | undefined;
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, params]);
		if (method === "pane.get") return { pane: { pane_id: "wA:p1", agent: "pi", agent_status: status, agent_session: { value: FILE } } };
		if (timeout && method === "agent.prompt") throw new HerdrError("timeout", "no answer");
		await hold;
		return {};
	};
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const answered = createAnswered({ load: () => disk.text, save: (text) => { if (disk.fail) throw new Error("ENOSPC"); disk.text = text; } });
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, dir: join(scratch, "bundle"), pollMs: 50, answered });
	running.push(gui);
	return { gui, calls, typed: () => calls.filter(([m]) => m === "agent.prompt"), hold: (p: Promise<void>) => (hold = p), disk };
}
type Out = { status: number; body: Record<string, unknown> };
function ask(gui: Gui, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
	const data = JSON.stringify(body ?? {});
	const headers: Record<string, string> = { host: `127.0.0.1:${gui.port}`, ...(method === "POST" ? { origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data)) } : {}) };
	return new Promise<Out>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method, headers, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(method === "POST" ? data : undefined);
	});
}
const block = (index = 1, fields: unknown = [["text", "Go ahead"]], entry = "e7") => ({ entry, index, fields });
const send = (gui: Gui, extra: Record<string, unknown> = {}) => ask(gui, "sessions/sess-1/input", { text: "Go ahead", as: "send", guarded: true, block: block(), ...extra });

test("a block's answer is recorded in the request that sends it: pending first, done once the unit took it, and every page reads it", async () => {
	const t = await setup();
	let release!: () => void;
	t.hold(new Promise<void>((r) => (release = r)));
	const sending = send(t.gui);
	while (!t.typed().length) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body, { done: [], pending: [["e7", 1]], unreadable: false }, "pending while it is on its way, for any page");
	release();
	assert.equal((await sending).status, 200);
	assert.deepEqual(t.typed().map(([, p]) => p.text), ["Go ahead"], "the block field is the server's: the unit gets the text only");
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body, { done: [["e7", 1, [["text", "Go ahead"]]]], pending: [], unreadable: false });
	assert.deepEqual((await ask(t.gui, "answered/other-key")).body, { done: [], pending: [], unreadable: false }, "the record of another session is not this one's");
});

test("a block that is answered, or on its way, is not sent again from any device: 409 with the fields that went, and nothing reaches the unit", async () => {
	const t = await setup();
	assert.equal((await send(t.gui)).status, 200);
	const again = await send(t.gui, { text: "Stop" });
	assert.equal(again.status, 409);
	assert.deepEqual([again.body.error, again.body.fields], ["answered", [["text", "Go ahead"]]]);
	assert.equal(t.typed().length, 1);
	assert.equal((await send(t.gui, { block: block(2) })).status, 200, "another block of the same message");
	assert.equal((await send(t.gui, { block: block(1, [["text", "x"]], "e8") })).status, 200, "the same index of another message");
	let release!: () => void;
	t.hold(new Promise<void>((r) => (release = r)));
	const first = send(t.gui, { block: block(9) });
	while (t.typed().length < 4) await new Promise((r) => setTimeout(r, 5));
	const pending = await send(t.gui, { block: block(9) });
	assert.deepEqual([pending.status, pending.body.error], [409, "pending"]);
	release();
	await first;
	assert.equal(t.typed().length, 4);
});

test("a message the unit did not take leaves the block open: the record is cancelled, here and after a restart", async () => {
	const t = await setup({ status: "blocked" });
	const r = await send(t.gui);
	assert.equal(r.status, 409);
	assert.equal(r.body.error, "blocked");
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body, { done: [], pending: [], unreadable: false });
	const refused = await send(t.gui, { text: "/boss gui stop" });
	assert.equal(refused.status, 403, "the guards are the composer's own");
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body.done, []);
});

test("a message Herdr did not confirm (504) leaves the block pending, not open: the message may have gone, so no device sends it again", async () => {
	const t = await setup({ timeout: true });
	const first = await send(t.gui);
	assert.equal(first.status, 504);
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body, { done: [], pending: [["e7", 1]], unreadable: false });
	const again = await send(t.gui, { text: "Stop" });
	assert.deepEqual([again.status, again.body.error], [409, "pending"]);
	assert.equal(t.typed().length, 1);
});

test("the record outlives the server: a new server on the same file reads what was answered", async () => {
	const disk = { text: undefined as string | undefined, fail: false };
	const one = await setup({ disk });
	assert.equal((await send(one.gui)).status, 200);
	const two = await setup({ disk });
	assert.deepEqual((await ask(two.gui, "answered/sess-1")).body.done, [["e7", 1, [["text", "Go ahead"]]]]);
	assert.equal((await send(two.gui)).status, 409);
	assert.equal(two.typed().length, 0);
});

test("a record that cannot be written refuses before anything is sent, and says so; one that cannot be written afterwards is told with the 200", async () => {
	const disk = { text: undefined as string | undefined, fail: true };
	const t = await setup({ disk });
	const r = await send(t.gui);
	assert.equal(r.status, 500);
	assert.equal(r.body.error, "unsaved");
	assert.equal(t.typed().length, 0, "nothing was sent");
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body.done, []);
	const late = { text: undefined as string | undefined, fail: false };
	const u = await setup({ disk: late });
	let release!: () => void;
	u.hold(new Promise<void>((r) => (release = r)));
	const sending = send(u.gui);
	while (!u.typed().length) await new Promise((r) => setTimeout(r, 5));
	late.fail = true;
	release();
	const done = await sending;
	assert.equal(done.status, 200, "it was sent");
	assert.equal(done.body.unsaved, true, "and the page is told the record could not be written");
	assert.equal((await send(u.gui)).status, 409, "this server still holds it as answered");
});

test("a block that is not a block is refused before anything: an entry id, an index, and the fields that went", async () => {
	const t = await setup();
	const bad: unknown[] = ["x", {}, { entry: "", index: 0, fields: [] }, { entry: "e", index: -1, fields: [] }, { entry: "e", index: 1.5, fields: [] }, { entry: "e", index: 100_000, fields: [] }, { entry: "e".repeat(300), index: 0, fields: [] }, { entry: "e\u0007", index: 0, fields: [] }, { entry: "e", index: 0, fields: "x" }, { entry: "e", index: 0, fields: [["a"]] }, { entry: "e", index: 0, fields: [["a", 1]] }, { entry: "e", index: 0, fields: Array.from({ length: 65 }, (_, i) => [`f${i}`, "v"]) }, { entry: "e", index: 0, fields: [["a", "x".repeat(13_000)]] }];
	for (const b of bad) assert.equal((await send(t.gui, { block: b })).status, 400, JSON.stringify(b)?.slice(0, 60));
	assert.equal(t.typed().length, 0);
});

test("a message with no block is sent as it always was, and the record is only for blocks", async () => {
	const t = await setup();
	assert.equal((await ask(t.gui, "sessions/sess-1/input", { text: "hello", as: "send" })).status, 200);
	assert.equal(t.typed().length, 1);
	assert.deepEqual((await ask(t.gui, "answered/sess-1")).body.done, []);
});

test("BSR-F007 C01: an operate session writes no record: a `block` in its input is not the box's, so nothing is begun, whatever else the request does", async () => {
	const answers = { has: () => false, replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), commands: async () => undefined, target: async () => undefined, probe: async () => ({ editor: "empty" as const }), pull: async () => ({ pending: false }) };
	const found: Found = { key: "sess-1", base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true };
	const call = async (method: string) => (method === "pane.get" ? { pane: { pane_id: "wA:p1", agent: "pi", agent_status: "idle", agent_session: { value: FILE } } } : {});
	let writes = 0;
	const store = createAnswered({ load: () => undefined, save: () => void writes++ });
	const body = { text: "Go ahead", as: "send", block: block() };
	await createControl({ lookup: () => found, call, csrf: "c".repeat(32), canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers: answers as never, answered: store }).run(["sessions", "sess-1", "input"], body, { remote: true, secure: true, operate: true, foreground: async () => true });
	assert.equal(writes, 0, "the record was not even written to (a begun block that is then cancelled leaves no entry, only a write)");
	assert.deepEqual(store.list("chat", "sess-1"), [], "nothing was recorded for an operate session");
	const same = createControl({ lookup: () => found, call, csrf: "c".repeat(32), canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers: answers as never, answered: store });
	await same.run(["sessions", "sess-1", "input"], body, { remote: true, secure: true });
	assert.ok(writes > 0, "the same request from a paired device is recorded (the control)");
});
