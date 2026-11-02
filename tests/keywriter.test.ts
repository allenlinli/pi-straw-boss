import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { type Write, keywriter } from "../gui/keywriter.ts";
const { m } = await import("../gui/paraglide/messages.js");

// The key writes of gui/keywriter.ts that the pad and the terminal card share: one at a time, spaced by 130 ms on a clock the test moves, and a
// refusal, a confirm, or a network failure dropping what still waited.

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
type Reply = { ok: boolean; status: number; body: Record<string, unknown> };
function rig() {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const posts: { at: number; body: Record<string, unknown> }[] = [], replies: ((r: Reply | Error) => void)[] = [], heard: string[] = [];
	const w = keywriter({
		stream: () => "st",
		post: (action, body) => (assert.equal(action, "keys"), posts.push({ at: Date.now(), body }), new Promise((resolve, reject) => replies.push((r) => (r instanceof Error ? reject(r) : resolve(r as never))))),
		busy: () => void heard.push(`busy:${w.busy()}`),
		clear: () => void heard.push("clear"),
		ask: (write, reason, token) => void heard.push(`ask:${write.key}:${token}:${reason}`),
		error: (text) => void heard.push(`error:${text}`),
		sent: (x: Write) => void heard.push(`sent:${JSON.stringify(x)}`),
		taken: (x: Write) => void heard.push(`taken:${JSON.stringify(x)}`),
		failed: (x: Write) => void heard.push(`failed:${JSON.stringify(x)}`),
	});
	const reply = async (status: number, body: Record<string, unknown> = {}) => (replies.shift()!({ ok: status < 300, status, body }), await settle());
	return { w, posts, heard, reply, fail: async () => (replies.shift()!(new Error("net")), await settle()), tick: (ms: number) => mock.timers.tick(ms), done: () => mock.timers.reset() };
}

test("writes go one at a time in order, each at least 130 ms after the one before, with the stream", async () => {
	const r = rig();
	try {
		r.w.push({ key: "up" });
		r.w.push({ key: "down" });
		r.w.push({ key: "enter" });
		assert.deepEqual(r.posts.map((p) => p.body), [{ key: "up", stream: "st" }], "the first goes at once");
		await r.reply(200);
		assert.equal(r.posts.length, 1, "the next waits for the gap");
		r.tick(129);
		assert.equal(r.posts.length, 1);
		r.tick(1);
		assert.deepEqual(r.posts.map((p) => p.body.key), ["up", "down"]);
		await r.reply(200);
		r.tick(130);
		await r.reply(200);
		assert.deepEqual(r.posts.map((p) => p.body.key), ["up", "down", "enter"]);
		assert.ok(r.posts.every((p, i) => i === 0 || p.at - r.posts[i - 1]!.at >= 130));
	} finally { r.done(); }
});

test("nothing goes while a write is on its way, however long the reply takes", async () => {
	const r = rig();
	try {
		r.w.push({ key: "up" });
		r.w.push({ key: "down" });
		r.tick(5000);
		assert.equal(r.posts.length, 1);
		assert.equal(r.w.busy(), true);
		await r.reply(200);
		assert.equal(r.posts.length, 2, "then the next, the gap long past");
	} finally { r.done(); }
});

test("typed characters join the text still queued, in pieces of at most 64 code points, and control characters are dropped", async () => {
	const r = rig();
	try {
		r.w.push({ key: "up" });
		assert.equal(r.w.text("a\u0007b\u009f"), true);
		assert.equal(r.w.text("\u0001\u007f"), false, "nothing left to write");
		r.w.text("c".repeat(70));
		r.w.text("😀");
		await r.reply(200);
		const sent: string[] = [];
		for (let i = 0; i < 2; i++) (r.tick(130), sent.push(String(r.posts.at(-1)!.body.text)), await r.reply(200));
		assert.deepEqual(sent.map((t) => [...t].length), [64, 9]);
		assert.equal(sent.join(""), `ab${"c".repeat(70)}😀`);
		r.tick(1000);
		assert.equal(r.posts.length, 3, "nothing more");
	} finally { r.done(); }
});

test("a paste goes as pastes of at most 4000 characters, line ends folded to \\n and controls dropped", async () => {
	const r = rig();
	try {
		assert.equal(r.w.paste("\u0000\u0001"), false);
		assert.equal(r.w.paste(`a\r\nb\u0007${"x".repeat(4000)}`), true);
		await r.reply(200);
		r.tick(130);
		assert.deepEqual(r.posts.map((p) => [...String(p.body.paste)].length), [4000, 3]);
		assert.ok(String(r.posts[0]!.body.paste).startsWith("a\nbx"));
	} finally { r.done(); }
});

test("a refused write says why in the page's words by its code and drops what still waited, so an Enter never follows a text that did not land", async () => {
	const r = rig();
	try {
		r.w.text("hello");
		r.w.push({ key: "enter" });
		await r.reply(409, { error: "no_mirror", reason: "Keys are sent only while live." });
		r.tick(1000);
		assert.deepEqual(r.posts.map((p) => p.body), [{ text: "hello", stream: "st" }], "no Enter");
		assert.deepEqual(r.heard, ["busy:true", "clear", 'sent:{"text":"hello"}', 'failed:{"text":"hello"}', `error:${m.refuse_no_mirror()}`, "busy:false"]);
		r.w.push({ key: "up" });
		r.tick(1000);
		await r.reply(409, { error: "a_new_code", reason: "The server's own words." });
		assert.ok(r.heard.includes("error:The server's own words."), "a code the page does not know shows the server's text");
		assert.equal(r.w.queued(), 0);
	} finally { r.done(); }
});

test("a refusal without a reason says its status; a network failure says unreachable and drops the queue", async () => {
	const r = rig();
	try {
		r.w.push({ key: "up" });
		r.w.push({ key: "down" });
		await r.reply(429);
		assert.ok(r.heard.includes(`error:${m.refused({ status: 429 })}`));
		assert.equal(r.w.queued(), 0);
		r.heard.length = 0;
		r.tick(200);
		r.w.push({ key: "up" });
		r.w.push({ key: "down" });
		await r.fail();
		assert.deepEqual(r.heard.filter((x) => x.startsWith("error") || x.startsWith("failed")), ['failed:{"key":"up"}', `error:${m.unreachable()}`]);
		assert.equal(r.w.queued(), 0);
	} finally { r.done(); }
});

test("a confirm drops the queue and asks with the token; confirm() sends the same key with exactly that token, and only when idle", async () => {
	const r = rig();
	try {
		r.w.push({ key: "enter" });
		r.w.push({ key: "up" });
		await r.reply(409, { error: "confirm", confirm: "command", reason: "This runs a command." });
		assert.ok(r.heard.includes("ask:enter:command:This runs a command."));
		assert.ok(!r.heard.some((x) => x.startsWith("error")), "a confirm is not an error");
		assert.equal(r.w.queued(), 0);
		r.tick(130);
		r.w.confirm("enter", "command");
		assert.deepEqual(r.posts.at(-1)!.body, { key: "enter", stream: "st", confirmed: "command" });
		r.w.confirm("enter", "command");
		assert.equal(r.posts.length, 2, "busy: nothing more");
		await r.reply(200);
		assert.ok(r.heard.includes('taken:{"key":"enter"}'), "a confirmed Enter that the server took");
		assert.equal(r.heard.filter((x) => x.startsWith("taken")).length, 1);
	} finally { r.done(); }
});

test("a text write's token is never invented: nothing is confirmed unless confirm() was given one, and a confirm for a text is not asked", async () => {
	const r = rig();
	try {
		r.w.text("x");
		await r.reply(409, { error: "confirm", confirm: "command", reason: "r" });
		assert.ok(!r.heard.some((x) => x.startsWith("ask")), "only a key can be confirmed");
		assert.ok(r.posts.every((p) => !("confirmed" in p.body)));
	} finally { r.done(); }
});
