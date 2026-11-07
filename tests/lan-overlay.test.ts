import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createControl, type ControlDeps, type Reply } from "../src/control.ts";
import { createFaces, LEASE_MS, SETTLE_MS } from "../src/lan/faces.ts";
import type { Found } from "../src/net.ts";
import { fakeClock } from "./fake-clock.ts";

// Writes while the /boss gui lan overlay is open (docs/specs/2026-10-30-sb-gui-lan.md, *Not from a paired device*, D9; Tests, "Writes while the overlay is open"; Steps L5). A paired device may write into a session's pane by the composer
// (`input`), the key pad and paste (`keys`), and the queue's take-back (`dequeue`); while a face holds a mark on that pane all of them answer 409 `lan_overlay_open` with no Herdr call made, except Escape on `keys`. The routes are
// driven through `createControl` directly, with a fake Herdr that records every call.

const ORIGIN = "https://weis-mbp.local:8445", CSRF = "c".repeat(32), FILE = "/s/2026_sess-1.jsonl", PANE = "wA:p1", TAKE = "0000000000000001";
const found = (over: Partial<Found> = {}): Found => ({ key: "sess-1", base: "wA", name: "billing", role: "main", file: FILE, pane: PANE, live: true, ...over });

function world(over: Partial<ControlDeps> = {}) {
	const clock = fakeClock(5_000_000), faces = createFaces(clock.now);
	const calls: [string, Record<string, unknown>][] = [];
	const hooks: { onGet?: () => void; onProbe?: () => void; markAtHas?: number } = {};
	let has = 0;
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, params]);
		if (method === "pane.get") {
			hooks.onGet?.();
			return { pane: { pane_id: PANE, agent: "pi", agent_status: "idle", agent_session: { value: FILE } } };
		}
		return {};
	};
	const answers: NonNullable<ControlDeps["answers"]> = {
		has: () => (++has === hooks.markAtHas && void faces.open(PANE), false), replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: { outcome: "accepted" } }), commands: async () => undefined, target: async () => undefined,
		probe: async () => (hooks.onProbe?.(), { editor: "empty" as const }),
		pull: async (_key, phase) => (phase === "begin" ? { pending: true, ticket: "t1", key: "alt+up" } : { text: "queued" }),
	};
	const handle = createControl({ lookup: (k) => (k === "sess-1" ? found() : undefined), call, csrf: CSRF, canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers, overlay: faces, ...over });
	const open = (kind: string, body: unknown, remote = true): Promise<Reply> => {
		const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
		return handle(req, ORIGIN, ["open", kind], remote);
	};
	const send = (parts: string[], body: unknown, remote = true): Promise<Reply> => {
		const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
		return handle(req, ORIGIN, parts, remote);
	};
	const post = (action: string, body: unknown, remote = true): Promise<Reply> => send(["sessions", "sess-1", action], body, remote);
	/** What was written into a pane: every call but the pane look. */
	const written = () => calls.filter(([m]) => m !== "pane.get").map(([m, p]) => [m, p.keys ?? p.text ?? p.target]);
	return { clock, faces, calls, hooks, post, send, open, written };
}
const STREAM = "stream-1";
const refused = (r: Reply) => [r.status, (r.body as { error?: string }).error];

test("with a mark on the pane, a paired device's composer text, Enter, and follow-up are refused 409 lan_overlay_open and nothing reaches Herdr", async () => {
	const w = world();
	w.faces.open(PANE);
	for (const body of [{ text: "4821", as: "send" }, { text: "y", as: "send" }, { text: "yes", as: "followUp" }]) assert.deepEqual(refused(await w.post("input", body)), [409, "lan_overlay_open"], JSON.stringify(body));
	assert.deepEqual(w.written(), [], "no Herdr write of any kind");
});

test("a paired device's composer cannot run the boss's pairing, remote, Wi-Fi, or server commands; this computer's page can", async () => {
	for (const text of ["/boss gui devices", "/boss gui unpair abc123", "/boss gui unpair all", "/boss gui rotate", "/boss gui stop", "/boss gui remote", "/boss gui remote off", "/boss gui lan reset", "/boss server stop", "/boss server logs 20", "  /boss  server", "/boss gui view geek", "/boss gui view zen", "/boss gui view auto", "/boss link decide ab12 approve", "/boss  link  decide ab12 refuse"]) {
		const w = world();
		assert.deepEqual(refused(await w.post("input", { text, as: "send" })), [403, "local_only"], text);
		assert.deepEqual(w.written(), [], `${text}: nothing reached Herdr`);
	}
	const local = world();
	assert.deepEqual((await local.post("input", { text: "/boss gui devices", as: "send" }, false)).body, { accepted: true }, "this computer's own page keeps it");
	assert.equal(local.written().length, 1);
	const phone = world();
	assert.deepEqual((await phone.post("input", { text: "/boss status", as: "send" })).body, { accepted: true }, "other boss commands are not the device class");
	assert.deepEqual((await phone.post("input", { text: "/boss gui view", as: "send" })).body, { accepted: true }, "showing the view is read-only");
	for (const text of ["/boss link", "/boss link status", "/boss open member"]) assert.deepEqual((await phone.post("input", { text, as: "send" })).body, { accepted: true }, `${text}: the page lets a paired device read its teams and open a unit`);
});

test("a paired device's composer cannot hide a gated /boss command in the first message of /boss open, at any depth; this computer's page and plain messages pass", async () => {
	for (const text of ["/boss open main ~/x /boss server stop", "/boss open main ~/x /boss link decide abcd refuse", "/boss open main ~/x /boss gui rotate", "  /boss  open  base ~/x /boss gui stop", "/boss open main ~/x /boss open main ~/y /boss server stop", '/boss open main "~/a b" /boss gui devices']) {
		const w = world();
		assert.deepEqual(refused(await w.post("input", { text, as: "send" })), [403, "local_only"], text);
		assert.deepEqual(w.written(), [], `${text}: nothing reached Herdr`);
	}
	const local = world();
	assert.deepEqual((await local.post("input", { text: "/boss open main ~/x /boss server stop", as: "send" }, false)).body, { accepted: true }, "this computer's own page keeps it");
	const phone = world();
	for (const text of ["/boss open main ~/x fix the build", "/boss open main ~/x /boss status", "/boss open member ~/x", "/boss open main ~/x /boss open main ~/y fix it"]) assert.deepEqual((await phone.post("input", { text, as: "send" })).body, { accepted: true }, text);
});

test("a new session's first message from a paired device cannot be a gated /boss command; this computer's page and ordinary prompts pass", async () => {
	const opened: Record<string, unknown>[] = [];
	const spawn: ControlDeps["spawn"] = async (_p, json) => (opened.push(json), { status: 200, body: { ok: true } });
	for (const kind of ["main", "member", "base"]) for (const prompt of ["/boss gui devices", "/boss server stop", "\n /boss gui view geek", "\n /boss gui view zen", "/boss link decide ab12 approve", "/boss open main ~/y /boss server stop"]) {
		assert.deepEqual(refused(await world({ spawn }).open(kind, { prompt, dir: "/x" })), [403, "local_only"], `${kind} ${prompt}`);
	}
	assert.deepEqual(opened, [], "nothing was opened");
	assert.equal((await world({ spawn }).open("main", { prompt: "/boss gui devices", dir: "/x" }, false)).status, 200, "this computer's page keeps it");
	assert.equal((await world({ spawn }).open("main", { prompt: "/boss status", dir: "/x" })).status, 200, "other prompts pass");
});

test("with a mark, a paired device's pad keys, digits, Enter, typed text, and paste are refused; Escape (a key or Stop's) goes through", async () => {
	// The key pad takes 8 keys a second per session, so the bodies are shared out over two servers.
	for (const bodies of [[{ key: "1" }, { key: "9" }, { key: "enter" }, { key: "tab" }, { text: "y" }], [{ text: "n" }, { text: "r" }, { text: "u" }, { paste: "4821\n" }]]) {
		const w = world();
		w.faces.open(PANE);
		for (const body of bodies) assert.deepEqual(refused(await w.post("keys", { stream: STREAM, ...body })), [409, "lan_overlay_open"], JSON.stringify(body));
		assert.deepEqual(w.written(), [], "the editor was not even asked, and nothing was written");
	}
	// (a second Escape within a second asks to be confirmed, as it does without a mark: two servers again)
	for (const body of [{ stream: STREAM, key: "esc" }, { keys: ["esc"] }]) {
		const w = world();
		w.faces.open(PANE);
		assert.deepEqual((await w.post("keys", body)).body, { accepted: true }, JSON.stringify(body));
		assert.deepEqual(w.written(), [["pane.send_input", ["esc"]]]);
	}
});

test("with a mark, a paired device's take-back (dequeue) is refused and no key is sent", async () => {
	const w = world();
	w.faces.open(PANE);
	assert.deepEqual(refused(await w.post("dequeue", { take: TAKE })), [409, "lan_overlay_open"]);
	assert.deepEqual(w.written(), []);
	const none = world();
	assert.deepEqual((await none.post("dequeue", { take: TAKE })).body, { text: "queued" }, "with no mark it takes the queue back");
	assert.deepEqual(none.written(), [["pane.send_input", ["alt+up"]]]);
});

test("this computer's own page is not refused by the mark", async () => {
	const w = world();
	w.faces.open(PANE);
	assert.deepEqual((await w.post("input", { text: "hello", as: "send" }, false)).body, { accepted: true });
	assert.deepEqual((await w.post("keys", { stream: STREAM, key: "enter" }, false)).body, { accepted: true });
	assert.equal(w.written().length, 2);
});

test("after the face closes, or 5 s after its last renewal, the writes go through again; a close or renewal with another id changes nothing", async () => {
	const w = world();
	const id = w.faces.open(PANE)!;
	w.faces.close("0".repeat(32));
	w.faces.renew("0".repeat(32));
	assert.deepEqual(refused(await w.post("input", { text: "x", as: "send" })), [409, "lan_overlay_open"], "another face's id closed nothing");
	assert.equal(w.faces.close(id), true);
	assert.deepEqual((await w.post("input", { text: "x", as: "send" })).body, { accepted: true }, "closed");
	const lapsing = w.faces.open(PANE)!;
	w.clock.advance(LEASE_MS - 1);
	assert.equal(w.faces.renew(lapsing), true);
	w.clock.advance(LEASE_MS - 1);
	assert.deepEqual(refused(await w.post("input", { text: "y", as: "send" })), [409, "lan_overlay_open"], "renewed, still marked");
	w.clock.advance(2);
	assert.deepEqual((await w.post("input", { text: "z", as: "send" })).body, { accepted: true }, "5 s after the last renewal a pi that hung no longer holds the pane");
});

test("an open naming another pane marks only that pane", async () => {
	const w = world();
	w.faces.open("wA:p9");
	assert.deepEqual((await w.post("input", { text: "x", as: "send" })).body, { accepted: true });
});

test("the mark is looked at right before each write: one set during the pane look refuses the prompt, and one set during the editor probe refuses Enter", async () => {
	const prompt = world();
	prompt.hooks.onGet = () => void prompt.faces.open(PANE);
	assert.deepEqual(refused(await prompt.post("input", { text: "4821", as: "send" })), [409, "lan_overlay_open"], "set while the pane was being looked at");
	assert.deepEqual(prompt.written(), []);

	const enter = world();
	enter.hooks.onProbe = () => void enter.faces.open(PANE);
	assert.deepEqual(refused(await enter.post("keys", { stream: STREAM, key: "enter" })), [409, "lan_overlay_open"], "set while the editor was probed");
	assert.deepEqual(enter.written(), []);

	// The last look is the one that counts: the link_request check right before each write of a key (`answers.has`, 2nd call for a pad key and a take-back: the guard made the 1st) is the last thing awaited, and a face that opened during it still refuses the write.
	for (const [action, body] of [["keys", { stream: STREAM, key: "1" }], ["dequeue", { take: TAKE }]] as const) {
		const late = world();
		late.hooks.markAtHas = 2;
		assert.deepEqual(refused(await late.post(action, body)), [409, "lan_overlay_open"], `${action}: a mark set between the last check and the write`);
		assert.deepEqual(late.written(), [], `${action}: no key went`);
	}
	// The one plan with two writes is a confirmed double Escape, which the mark never refuses; every other key is one write, checked right before it.
});

test("a paired device's write is noted at the write, so a face that opens within 1.5 s refuses its own answers; Escape and this computer's page leave no note", async () => {
	const w = world();
	assert.deepEqual((await w.post("input", { text: "4821", as: "send" })).body, { accepted: true });
	w.clock.advance(SETTLE_MS - 1);
	assert.deepEqual(w.faces.accepts(w.faces.open(PANE)), { ok: false, error: "typed_into" });
	w.clock.advance(SETTLE_MS * 3);
	assert.deepEqual(w.faces.accepts(w.faces.open(PANE)), { ok: true }, "a write long before is past");

	const esc = world();
	await esc.post("keys", { keys: ["esc"] });
	await esc.post("keys", { stream: STREAM, key: "esc" });
	assert.deepEqual(esc.faces.accepts(esc.faces.open(PANE)), { ok: true }, "Escape is not noted");

	const local = world();
	await local.post("input", { text: "hello", as: "send" }, false);
	assert.deepEqual(local.faces.accepts(local.faces.open(PANE)), { ok: true }, "this computer's page is not a paired device");

	const refusedWrite = world();
	const id = refusedWrite.faces.open(PANE)!;
	await refusedWrite.post("input", { text: "y", as: "send" });
	refusedWrite.faces.close(id);
	assert.deepEqual(refusedWrite.faces.accepts(refusedWrite.faces.open(PANE)), { ok: true }, "a write the mark refused wrote nothing, so it taints nothing");
});

test("the head tower's composer from a paired device writes into no pane, so an open overlay does not touch it and no Herdr call is made (the overlay's rules are unchanged for every session)", async () => {
	const events: string[] = [];
	const w = world({
		lookup: (k) => (k === "sb-head" ? { key: k, base: "@head", name: "head tower", role: "head", live: true, pane: PANE, file: FILE } : k === "sess-1" ? found() : undefined),
		tower: { has: (ws) => ws === "@head", live: () => true, event: async (_ws, text) => (events.push(text), { ok: true }), act: async () => ({ ok: true }) },
	});
	w.faces.open(PANE);
	assert.deepEqual(refused(await w.post("input", { text: "4821", as: "send" })), [409, "lan_overlay_open"], "a session's pane is still guarded");
	const sent = await w.send(["sessions", "sb-head", "input"], { text: "tell Alpha to start", as: "send" });
	assert.deepEqual([sent.status, sent.body], [200, { accepted: true, woke: true }]);
	assert.deepEqual(events, ["tell Alpha to start"]);
	assert.deepEqual(w.written(), [], "nothing reached Herdr");
});

// PTP-F001: `/boss send <B> <text>` posts B's input from this computer, and a paired device can make a session run it (the composer, or the key pad letter by letter). The post carries `guarded: true`, and the server
// holds it to every guard a paired device's own write meets, whatever its address; the text of a `/boss send` (or one nested in `/boss open`) is judged as the text it will type.
test("PTP-F001: an input posted with guarded: true meets every remote guard though it comes from this computer: the overlay's mark, a gated command, an open link_request; without it this computer's page is free", async () => {
	const w = world();
	w.faces.open(PANE);
	assert.deepEqual(refused(await w.post("input", { text: "4821", as: "send", guarded: true }, false)), [409, "lan_overlay_open"], "the Wi-Fi approval number cannot be typed into the marked pane");
	assert.deepEqual(refused(await w.post("input", { text: "4821", as: "followUp", guarded: true }, false)), [409, "lan_overlay_open"]);
	assert.deepEqual(w.written(), [], "nothing reached Herdr");
	assert.deepEqual((await w.post("input", { text: "4821", as: "send" }, false)).body, { accepted: true }, "this computer's own page is not limited by the mark");
	for (const guarded of [false, "true", 1]) assert.deepEqual((await world().post("input", { text: "/boss server stop", as: "send", guarded }, false)).body, { accepted: true }, `guarded: ${JSON.stringify(guarded)} is not the flag`);
	for (const text of ["/boss server stop", "/boss gui rotate", "/boss link decide ab12 approve", "/boss open main ~/x /boss gui stop"]) {
		const g = world();
		assert.deepEqual(refused(await g.post("input", { text, as: "send", guarded: true }, false)), [403, "local_only"], text);
		assert.deepEqual(g.written(), [], text);
	}
	const asking = world({ linkRequest: async () => true });
	assert.deepEqual(refused(await asking.post("input", { text: "y", as: "send", guarded: true }, false)), [403, "local_only"], "an open link_request would take the prompt's Enter as Yes");
	assert.deepEqual(refused(await asking.post("input", { text: "y", as: "send", guarded: true }, true)), [403, "local_only"]);
	assert.deepEqual(asking.written(), []);
	assert.deepEqual((await asking.post("input", { text: "y", as: "send" }, false)).body, { accepted: true }, "this computer's page keeps typing into it");
	const plain = world();
	assert.deepEqual((await plain.post("input", { text: "run the build", as: "send", guarded: true }, false)).body, { accepted: true }, "a plain message passes the guards when none holds");
});

test("PTP-F001: a paired device's composer cannot hide a gated command in a /boss send, with or without --after or a quoted name, at any depth; plain sends, other commands, and this computer's page pass", async () => {
	for (const text of [
		"/boss send b /boss server stop", "/boss send b --after /boss gui rotate", '/boss send "fix login" /boss gui devices', '/boss send "fix login" --after /boss link decide ab12 approve', "  /boss  send  b  /boss  gui  unpair all",
		"/boss send b /boss send c /boss server stop", "/boss send b /boss open main ~/x /boss server stop", "/boss open main ~/x /boss send b /boss server stop", "/boss send b\n/boss server stop",
	]) {
		const w = world();
		assert.deepEqual(refused(await w.post("input", { text, as: "send" })), [403, "local_only"], JSON.stringify(text));
		assert.deepEqual(w.written(), [], `${text}: nothing reached Herdr`);
	}
	const local = world();
	assert.deepEqual((await local.post("input", { text: "/boss send b /boss server stop", as: "send" }, false)).body, { accepted: true }, "this computer's own page keeps it (the server it reaches then guards the post)");
	const phone = world();
	for (const text of ["/boss send b 4821", "/boss send b --after fix the build", '/boss send "fix login" hello', "/boss send b /boss status", "/boss send b", "/boss stop b", "/boss send b /boss open main ~/x fix it"]) assert.deepEqual((await phone.post("input", { text, as: "send" })).body, { accepted: true }, text);
});
