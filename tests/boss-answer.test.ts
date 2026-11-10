import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { parseAnswer, readStream } from "../src/bossanswer.ts";
import { registerBoss } from "../src/boss.ts";
import { createBossPaths, type Post } from "../src/bosspaths.ts";
import { localOnlyText } from "../src/control.ts";
import type { GuiRecord } from "../src/handover.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Pending } from "../src/ask.ts";
import type { Kit } from "../src/state.ts";
import { hereWorld } from "./here.ts";

// `/boss answer` (todo #34, the audit's row 11; the boss's decision of 2026-11-10: allowed from pi, except a secret): the open dialogs of other sessions listed from the page's own stream and answered through the page's
// own route, on this computer only, with a secret listed as present and never answered. Each test names what it pins; the secret refusal has tests that fail without it.

const HERE_ONLY = Symbol.for("pi-straw-boss.here-only");
const D1 = "1".repeat(64), D2 = "2".repeat(64), D3 = "3".repeat(64);
const SELECT = { dialog: "d-sel", digest: D1, cancel: true as const, select: { title: "Deploy to staging?", choices: [{ label: "Yes" }, { label: "No", hereOnly: true as const }, { label: "Later" }] } };
const ONE_Q = { dialog: "d-one", digest: D2, questions: [{ question: "Which branch?", multiple: false, options: [{ title: "main" }, { title: "dev" }, { title: "next" }] }] };
const TWO_Q = { dialog: "d-two", digest: D3, questions: [{ question: "Which branch?", multiple: false, options: [{ title: "main" }] }, { question: "Which checks?", multiple: true, options: [{ title: "unit" }, { title: "e2e" }] }] };
const SECRET = "It waits for a secret.";

const unit = (key: string, name: string, pending?: Pending, extra: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role: "main", mark: pending ? "waiting" : "working", subs: [], ...(pending ? { pending } : {}), ...extra }) as Unit;
const base = (label: string, units: Unit[], extra: Record<string, unknown> = {}) => ({ id: `w-${label}`, label, mark: "waiting", tower: null, tabs: [{ id: "t1", label: "tab", units }], outposts: [], outside: [], ...extra });
const NET = (over: Unit[] = []): Net => ({
	bases: [
		base("Shop", [
			unit("k-worker-0001", "worker one", { callId: "c1", tool: "robot_hand", answer: SELECT }),
			unit("k-asker-00002", "asker", { callId: "c2", tool: "ask_user_question", answer: ONE_Q }),
			unit("k-pair-000003", "pair", { callId: "c3", tool: "ask_user_question", answer: TWO_Q }),
			unit("k-drop-000004", "dropper", { callId: "c4", tool: "secret_drop", why: SECRET }),
			unit("k-dial-000005", "secret dialog", { callId: "c5", tool: "robot_hand", why: SECRET }),
			unit("k-crafted-006", "crafted", { callId: "c6", tool: "secret_drop", why: SECRET, answer: SELECT }),
			unit("k-crafted-007", "crafted two", { callId: "c7", tool: "robot_hand", why: SECRET, answer: SELECT }),
			unit("k-several-008", "several", { callId: "c8", tool: "bash", why: "It waits on more than one dialog." }),
			unit("m1", "me", { callId: "c9", tool: "robot_hand", answer: SELECT }),
			unit("k-idle-0000009", "idle"),
			...over,
		]),
		base("Box", [unit("k-box-00000010", "on a box", { callId: "c10", tool: "robot_hand", answer: SELECT })], { box: { label: "far" } }),
	],
}) as unknown as Net;

interface Options { ui?: boolean; confirm?: boolean; selects?: (string | undefined)[]; inputs?: (string | undefined)[]; lang?: string; net?: Net; reply?: Awaited<ReturnType<Post>> | ((path: string) => Awaited<ReturnType<Post>>) }
function world({ ui = true, confirm = true, selects = [], inputs = [], lang = "en", net = NET(), reply }: Options = {}) {
	const hw = hereWorld("wA:p1"), during: { kind: string; marked: boolean }[] = [];
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [], asked: { title: string; body: string; opts?: Record<symbol, unknown> }[] = [], selected: { title: string; options: string[] }[] = [];
	const selectQueue = [...selects], inputQueue = [...inputs];
	const post: Post = async (_r, path, json) => (posted.push({ path, json }), typeof reply === "function" ? reply(path) : (reply ?? { status: 200, body: { outcome: "accepted" } }));
	const screen = {
		confirm: async (title: string, body: string, opts?: Record<symbol, unknown>) => (asked.push({ title, body, ...(opts ? { opts } : {}) }), during.push({ kind: "confirm", marked: hw.marked() }), confirm),
		select: async (title: string, options: string[]) => (selected.push({ title, options }), during.push({ kind: "select", marked: hw.marked() }), selectQueue.shift()),
		input: async () => inputQueue.shift(),
		notify: () => {},
	};
	const kit = { pi: {}, cfg: { env: { LANG: lang }, run: async () => "{}" }, s: { at: { workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1" }, ui: ui ? screen : undefined }, guiDir: "/nowhere", me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }) } as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, post, here: hw.here, stream: async () => net });
	const run = (line: string) => ((a) => paths.answer(a.query, a.cancel, a.text))(parseAnswer(line));
	return { run, told, posted, asked, selected, during, hw, last: () => told.at(-1)! };
}

test("parseAnswer reads no session (the list), a session with a number or words, a quoted name, and --cancel", () => {
	assert.deepEqual([parseAnswer(""), parseAnswer(undefined), parseAnswer("  ")], Array(3).fill({ query: "", cancel: false, text: "" }));
	assert.deepEqual([parseAnswer(" worker 2"), parseAnswer('"worker one" Use the dev branch, please'), parseAnswer("worker --cancel"), parseAnswer("worker")], [{ query: "worker", cancel: false, text: "2" }, { query: "worker one", cancel: false, text: "Use the dev branch, please" }, { query: "worker", cancel: true, text: "" }, { query: "worker", cancel: false, text: "" }]);
});

test("the list shows each open dialog of the other sessions with numbered choices, a secret as present and not answerable, and leaves out this session, a box's unit, and a session that waits on nothing", async () => {
	const w = world();
	await w.run("");
	const text = w.last().text;
	assert.match(text, /worker one \(in Shop\) \[k-worker-0001\]\n    Deploy to staging\?\n      1\. Yes\n      2\. No\n      3\. Later\n    \(cancel it: \/boss answer "worker one" --cancel\)/);
	assert.match(text, /asker .*\n    Which branch\?\n      1\. main\n      2\. dev\n      3\. next/);
	assert.match(text, /pair .*\n    1\) Which branch\?\n      1\. main\n    2\) Which checks\? \(several\)\n      1\. unit/);
	assert.match(text, /dropper .*\n    it waits for a secret: only its terminal takes it, and \/boss answer never does/);
	assert.match(text, /secret dialog .*\n    it waits for a secret/);
	assert.match(text, /crafted .*\n    it waits for a secret/, "a secret wait is listed as a secret even when something answerable rides along");
	assert.match(text, /several .*\n    it cannot be answered from here: It waits on more than one dialog\./);
	assert.doesNotMatch(text, /\bme\b|on a box|idle/);
	assert.equal(w.posted.length, 0, "a list posts nothing");
	assert.equal(w.asked.length, 0);
});

test("the list writes out what a session wrote: control and bidi characters in a name, a title, and a choice cannot repaint it", async () => {
	const evil = { dialog: "d-evil", digest: D1, select: { title: "Run it?\x1b[2K\rfine", choices: [{ label: "Yes\u202eevil" }, { label: "No" }] } };
	const w = world({ net: NET([unit("k-evil-0000011", "bad\x1b]52;c;x\x07name", { callId: "c11", tool: "robot_hand", answer: evil })]) });
	await w.run("");
	assert.doesNotMatch(w.last().text, /[\x1b\x07\u202e]/);
	assert.match(w.last().text, /bad\\x1b\]52;c;x\\x07name/);
	assert.match(w.last().text, /Run it\?\\x1b\[2K\\x0dfine/);
});

test("an empty list says so; with no other session waiting there is nothing to answer", async () => {
	const w = world({ net: { bases: [] } as unknown as Net });
	await w.run("");
	assert.equal(w.last().text, "No other session waits on a dialog");
});

test("an answer by number posts the page's route with the dialog, its digest, a fresh id, and the choice, after a hereOnly confirm opened with the pane marked", async () => {
	const w = world();
	await w.run('"worker one" 3');
	assert.equal(w.posted.length, 1, JSON.stringify(w.told));
	const [{ path, json }] = w.posted;
	assert.equal(path, "sessions/k-worker-0001/answer");
	assert.deepEqual({ ...json, answerId: undefined }, { dialog: "d-sel", digest: D1, answerId: undefined, choice: 2 });
	assert.match(String(json.answerId), /^[A-Za-z0-9_-]{16,64}$/);
	assert.equal(w.asked.length, 1);
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true, "only this computer may answer it");
	assert.match(w.asked[0]!.body, /worker one \(in Shop\) waits on:\nDeploy to staging\?\n\nYour answer: 3\. Later/);
	assert.deepEqual(w.during, [{ kind: "confirm", marked: true }], "the pane is marked while the screen waits");
	assert.equal(w.hw.marked(), false);
	assert.deepEqual(w.last(), { text: "Answered worker one", level: undefined });
	assert.notEqual(w.posted[0]!.json.answerId, undefined);
});

test("a second answer carries a new id; a key, a key's start from six characters, and the name in any case pick the session", async () => {
	const w = world();
	for (const q of ["k-worker-0001", "k-worke", "WORKER ONE"]) await w.run(`"${q}" 1`);
	assert.equal(w.posted.length, 3);
	assert.equal(new Set(w.posted.map((p) => p.json.answerId)).size, 3);
	assert.ok(w.posted.every((p) => p.path === "sessions/k-worker-0001/answer"));
});

test("a question dialog takes a number, several numbers, or words, and asks each question in pi when none is typed", async () => {
	const one = world();
	await one.run("asker 2");
	assert.deepEqual(one.posted[0]!.json.answers, [{ choices: [1] }]);
	const words = world();
	await words.run("asker Use the release branch");
	assert.deepEqual(words.posted[0]!.json.answers, [{ text: "Use the release branch" }]);
	const two = world({ selects: ["1. main", "x"], inputs: ["1, 2"] });
	await two.run("pair");
	assert.deepEqual(two.posted[0]!.json.answers, [{ choices: [0] }, { choices: [0, 1] }]);
	const bad = world();
	await bad.run("asker 9");
	assert.equal(bad.posted.length, 0);
	assert.match(bad.last().text, /choice number from 1 to 3/);
});

test("with no choice typed pi asks which (hereOnly, pane marked); leaving the prompt sends nothing", async () => {
	const pick = world({ selects: ["2. No"] });
	await pick.run('"worker one"');
	assert.deepEqual(pick.posted[0]!.json.choice, 1);
	assert.deepEqual(pick.during.map((d) => d.kind), ["select", "confirm"]);
	assert.ok(pick.during.every((d) => d.marked));
	const left = world({ selects: [undefined] });
	await left.run('"worker one"');
	assert.equal(left.posted.length, 0);
	assert.equal(left.last().text, "Nothing was sent");
});

test("a declined confirm sends nothing, and a pi with no screen cannot answer (the list still works)", async () => {
	const no = world({ confirm: false });
	await no.run('"worker one" 1');
	assert.equal(no.posted.length, 0);
	assert.equal(no.last().text, "Nothing was sent");
	const none = world({ ui: false });
	await none.run('"worker one" 1');
	assert.equal(none.posted.length, 0);
	assert.equal(none.last().text, "This needs the pi screen to ask you first");
	await none.run("");
	assert.match(none.last().text, /worker one/);
});

test("--cancel posts a cancel for a dialog that takes one, and is refused for one that does not", async () => {
	const w = world();
	await w.run('"worker one" --cancel');
	assert.deepEqual({ ...w.posted[0]!.json, answerId: undefined }, { dialog: "d-sel", digest: D1, answerId: undefined, cancel: true });
	const no = world();
	await no.run("asker --cancel");
	assert.equal(no.posted.length, 0);
	assert.equal(no.last().text, "This dialog takes no cancel here");
});

test("a secret is refused, with nothing asked and nothing posted: the secret_drop tool, a secret dialog, and a secret wait that carries an answer all the same", async () => {
	for (const name of ["dropper", "secret dialog", "crafted", "crafted two"]) {
		const w = world();
		await w.run(`"${name}" 1`);
		assert.equal(w.posted.length, 0, name);
		assert.equal(w.asked.length, 0, name);
		assert.equal(w.selected.length, 0, name);
		assert.equal(w.last().level, "error", name);
		assert.match(w.last().text, /waits for a secret, and a secret is entered in its terminal only\. Nothing was sent/, name);
		const cancel = world();
		await cancel.run(`"${name}" --cancel`);
		assert.equal(cancel.posted.length, 0, `${name} --cancel`);
	}
});

test("a secret is refused before the screen is needed, and no request of any answer carries a value", async () => {
	const w = world({ ui: false });
	await w.run("dropper 1");
	assert.match(w.last().text, /secret is entered in its terminal only/);
	const all = world();
	await all.run('"worker one" 1');
	await all.run("asker 1");
	assert.ok(all.posted.every((p) => !("value" in p.json)));
});

test("a dialog the page cannot answer, no match, and more than one match are told and send nothing", async () => {
	const w = world();
	await w.run("several 1");
	assert.match(w.last().text, /cannot be answered from here \(It waits on more than one dialog\.\)\. Nothing was sent/);
	await w.run("nobody 1");
	assert.equal(w.last().text, 'No other session waits on a dialog under "nobody": /boss answer lists them');
	await w.run("me 1");
	assert.match(w.last().text, /No other session waits/, "this session's own dialog is answered in its own terminal");
	await w.run('"on a box" 1');
	assert.match(w.last().text, /No other session waits/, "a box's units are the page's");
	await w.run("idle 1");
	assert.match(w.last().text, /No other session waits/);
	const twin = world({ net: NET([unit("k-worker-0099", "worker one", { callId: "c12", tool: "robot_hand", answer: SELECT })]) });
	await twin.run('"worker one" 1');
	assert.match(twin.last().text, /More than one session matches "worker one"; nothing was done[\s\S]*\[k-worker-0001\][\s\S]*\[k-worker-0099\]/);
	assert.equal([w, twin].reduce((n, x) => n + x.posted.length, 0), 0);
});

test("what the server says back: a stale dialog, a changed one, an unconfirmed one, a refusal; an accepted answer that goes on in a terminal says so", async () => {
	const said = async (reply: Awaited<ReturnType<Post>>) => { const w = world({ reply }); await w.run('"worker one" 1'); return w.last(); };
	assert.deepEqual(await said({ status: 200, body: { outcome: "stale", by: "local" } }), { text: "The dialog was closed already (local); nothing was changed", level: "error" });
	assert.match((await said({ status: 409, body: { error: "changed", reason: "The question changed or is no longer open here; read it again." } })).text, /\/boss answer lists what is open now/);
	assert.match((await said({ status: 200, body: { outcome: "unknown" } })).text, /did not confirm the answer/);
	assert.deepEqual(await said({ status: 400, body: { reason: "Pick one of its choices." } }), { text: "Pick one of its choices.", level: "error" });
	assert.deepEqual(await said({ status: 200, body: { outcome: "rejected", reason: "closed" } }), { text: "closed", level: "error" });
	assert.equal((await said({ status: 200, body: { outcome: "accepted", then: { pane: null } } })).text, "Answered worker one It goes on in that session's terminal.");
	assert.deepEqual(await said({ status: 0, body: {} }), { text: "the GUI server did not answer", level: "error" });
});

test("the words come in Traditional Chinese when the locale is", async () => {
	const w = world({ lang: "zh-TW" });
	await w.run("");
	assert.match(w.last().text, /其他工作階段開著的對話框/);
	assert.match(w.last().text, /它在等一個秘密/);
	await w.run("dropper 1");
	assert.match(w.last().text, /在等一個秘密，秘密只在它的終端機輸入。什麼都沒送出/);
	await w.run('"worker one" 1');
	assert.match(w.last().text, /已回答 worker one/);
});

// ---- The /boss command: which line reaches it, and who may type it --------------------------------------------------------------------------

function boss(active: boolean) {
	const called: string[] = [], told: string[] = [];
	let command: { handler: (args: string, ctx: { ui: object; hasUI: boolean; cwd: string }) => Promise<void>; getArgumentCompletions: (p: string) => { value: string }[] | null } | undefined;
	const answer = async (...a: unknown[]) => void called.push(JSON.stringify(a));
	const kit = { pi: { registerCommand: (_n: string, c: typeof command) => (command = c) }, cfg: { env: {} }, s: {}, guiDir: "/nowhere", tell: (t: string) => void told.push(t) } as unknown as Kit;
	const never = new Proxy({}, { get: (_t, k) => async () => void called.push(`other ${String(k)}`) });
	registerBoss(kit, { runMode: { active: () => active }, host: never as never, membership: never as never, reach: never as never, closeSelf: () => undefined, stashing: { names: () => [] } as never, paths: { answer } as never });
	return { run: (line: string) => command!.handler(line, { ui: {}, hasUI: true, cwd: "/work" }), complete: (p: string) => command!.getArgumentCompletions(p)?.map((i) => i.value) ?? null, called, told };
}
const LINES = ["answer", "answer worker 2", 'answer "worker one" --cancel', "answer  worker  Use the dev branch"];

test("each line reaches the answer path with the session, the cancel, and the words", async () => {
	const b = boss(false);
	for (const line of LINES) await b.run(line);
	assert.deepEqual(b.called, ['["",false,""]', '["worker",false,"2"]', '["worker one",true,""]', '["worker",false,"Use the dev branch"]']);
	assert.deepEqual(b.complete("ans"), ["answer"]);
	assert.ok(b.complete("")!.includes("answer"));
});

test("a tower run or an ally run reaches none of them: it is the boss's typed input", async () => {
	const b = boss(true);
	for (const line of LINES) await b.run(line);
	assert.deepEqual(b.called, []);
	assert.equal(b.told.length, LINES.length);
	assert.ok(b.told.every((t) => /takes no \/boss command/.test(t)));
});

test("a paired device's composer cannot type it (a slip guard like link decide), nor hide it in /boss send or /boss open; other text passes", () => {
	for (const text of ["/boss answer", "/boss answer worker 2", "/boss  answer  worker --cancel", "  /boss answer x", "/boss send other /boss answer worker 1", "/boss open main ~/x /boss answer w 1"]) assert.equal(localOnlyText(text), true, text);
	for (const text of ["/boss answers", "/boss status", "answer worker 1", "/boss send other hello"]) assert.equal(localOnlyText(text), false, text);
});

// ---- The stream reader ----------------------------------------------------------------------------------------------------------------------

async function serve(frames: string[], status = 200) {
	const seen: { path?: string; host?: string }[] = [];
	const server = createServer((req, res) => {
		seen.push({ path: req.url, host: req.headers.host });
		res.writeHead(status, { "content-type": "text/event-stream" });
		for (const f of frames) res.write(f);
		if (status !== 200) res.end("no"); // a refusal's headers go out with its body
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const record = { port: (server.address() as AddressInfo).port, token: "tok", pid: 1 } as GuiRecord;
	return { record, seen, stop: () => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))) };
}

test("readStream takes the first plain message of the page's own stream, past hello and ping, and closes it", async () => {
	const net = { bases: [{ id: "w", label: "L", tabs: [] }] };
	const s = await serve(["event: hello\ndata: {\"stream\":\"x\"}\n\n", "event: ping\ndata: \n\n", `data: ${JSON.stringify(net)}\n\n`]);
	try {
		assert.deepEqual(await readStream(s.record, 2000), net);
		assert.deepEqual(s.seen, [{ path: "/tok/events", host: `127.0.0.1:${s.record.port}` }]);
	} finally { await s.stop(); }
});

test("readStream fails with the stream's own words: a problem event, a refusal, no net in time, and a frame that is no net", async () => {
	const problem = await serve(["event: problem\ndata: \"herdr is down\"\n\n"]);
	const refused = await serve([], 403);
	const slow = await serve(["event: hello\ndata: {}\n\n"]);
	const odd = await serve(["data: [1,2]\n\n"]);
	try {
		await assert.rejects(readStream(problem.record, 2000), /herdr is down/);
		await assert.rejects(readStream(refused.record, 2000), /answered 403/);
		await assert.rejects(readStream(slow.record, 150), /did not send the net in time/);
		await assert.rejects(readStream(odd.record, 2000), /no net/);
	} finally { await Promise.all([problem, refused, slow, odd].map((x) => x.stop())); }
});
