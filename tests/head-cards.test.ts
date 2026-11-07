import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HEAD_REGISTERED_DESCRIPTION } from "../src/runhead.ts";
import { answerAsk, closeAsk, noteAsk, noteToolCall, openAsk, readAsks } from "../src/server/headasks.ts";
import { headId } from "../src/server/record.ts";
import { HEAD_TOOLS } from "../src/server/headbrief.ts";
import { headSeam, TEXTS } from "../src/server/headnet.ts";
import type { Slot } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { HEAD_KEY, towerDir } from "../src/server/towerstore.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The head's broadcast cards (todo #124, docs/specs/2026-11-07-head-log-cards.md): an ask keeps what the boss said and what the head sent whole, a later correction names the ask it replaces, and a tower that took the
// message or acted on it (and answered someone else, not the head) is no longer "waiting" for ever.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-hc-")) }) as Slot;
/** The most bytes the asks of one snapshot take as JSON: the worst case measured by the test below (60 rows, the costliest mix of text; docs/specs/2026-11-07-head-log-cards.md, Data). Before the budget the same rows took about 1.1 MB. */
const SNAPSHOT_MAX = 190_659;
const T0 = Date.parse("2026-11-07T06:00:00Z"), MIN = 60_000, HOUR = 3_600_000;
const send = (slot: Slot, at: number, workspace: string, message: string, extra: { relay?: string; boss?: string; supersedes?: string } = {}) => openAsk(slot, at, { workspace, label: workspace.toUpperCase(), first: message, ...extra });

test("an ask keeps the whole message the head sent (cut at 1,500 characters) and, on the first ask of a relayed broadcast only, the boss's own words from the event the relay names", () => {
	const slot = slotIn();
	const long = `Boss: 「x」. ${"y".repeat(2000)}`;
	const a = send(slot, T0, "wA", `${long}\nsecond line`, { relay: "boss:e1", boss: "幫我打個咖啡因吧" });
	const b = send(slot, T0 + 5_000, "wB", "tailored for B", { relay: "boss:e1", boss: "幫我打個咖啡因吧" });
	const c = send(slot, T0 + 6_000, "wC", "no relay, no boss");
	assert.equal(a.sent!.length, 1500);
	assert.ok(a.sent!.startsWith("Boss: 「x」. yyy"));
	assert.equal(a.first.length <= 120, true, "the first line keeps its own cut");
	assert.equal(a.boss, "幫我打個咖啡因吧");
	assert.equal(b.group, "H1");
	assert.equal(b.boss, undefined, "the group's first ask carries the boss's words once");
	assert.equal(b.sent, "tailored for B");
	assert.equal(c.boss, undefined);
	const rows = headSeam(slot, () => T0 + HOUR).asks();
	assert.deepEqual(rows.map((r) => [r.id, r.boss, r.sent === undefined ? undefined : r.sent.length]), [["H1", "幫我打個咖啡因吧", 1500], ["H2", undefined, 14], ["H3", undefined, 17]]);
});

test("the boss's words are cut at 1,500 characters too, and an empty one is none", () => {
	const slot = slotIn();
	assert.equal(send(slot, T0, "wA", "m", { relay: "boss:e1", boss: "z".repeat(3000) }).boss!.length, 1500);
	assert.equal(send(slot, T0 + 1, "wB", "m", { relay: "boss:e2", boss: "   " }).boss, undefined);
});

test("an ask may name the earlier ask it replaces: it must exist and be older; a made-up id, a later one, or a malformed one is refused and opens nothing; the row names the replaced broadcast's group", () => {
	const slot = slotIn();
	const h1 = send(slot, T0, "wA", "first order", { relay: "boss:e1" });
	const h2 = send(slot, T0 + 1_000, "wB", "first order for B", { relay: "boss:e1" });
	assert.deepEqual([h1.group, h2.group], ["H1", "H1"]);
	for (const bad of ["H9", "H3", "h1", "nope", "H1; drop", ""]) assert.throws(() => send(slot, T0 + 2_000, "wA", "x", { supersedes: bad }), /supersedes/, bad);
	assert.equal(readAsks(slot, T0).length, 2, "a refused one opens no ask");
	const fix = send(slot, T0 + 10 * MIN, "wA", "correction", { relay: "boss:e2", supersedes: "H2" }); // names the second ask of the first broadcast
	const fix2 = send(slot, T0 + 10 * MIN + 1_000, "wB", "correction for B", { relay: "boss:e2", supersedes: "H1" });
	const own = send(slot, T0 + 20 * MIN, "wC", "again", { supersedes: "H3" });
	assert.equal(fix.supersedes, "H2");
	assert.equal(own.supersedes, "H3", "an ask may replace one of the same file, whatever its workspace");
	const rows = headSeam(slot, () => T0 + HOUR).asks();
	assert.deepEqual(rows.map((r) => [r.id, r.group, r.supersedes]), [["H1", "H1", undefined], ["H2", "H1", undefined], ["H3", "H3", "H1"], ["H4", "H3", "H1"], ["H5", "H5", "H3"]], "the group of the ask it names, not the ask");
});

test("an ask that names an ask of its own broadcast replaces nothing", () => {
	const slot = slotIn();
	send(slot, T0, "wA", "order", { relay: "boss:e1" });
	send(slot, T0 + 1_000, "wB", "order", { relay: "boss:e1", supersedes: "H1" });
	assert.deepEqual(headSeam(slot, () => T0 + HOUR).asks().map((r) => r.supersedes), [undefined, undefined]);
});

test("a named ask the file no longer holds (it was cut from the newest 100) still shows its id: the row says what the head named", () => {
	const slot = slotIn();
	send(slot, T0, "wA", "a");
	send(slot, T0 + HOUR, "wA", "b", { supersedes: "H1" });
	const file = join(towerDir(slot, HEAD_KEY), "asks.json"), f = JSON.parse(readFileSync(file, "utf8")) as { next: number; asks: { id: string }[] };
	writeFileSync(file, JSON.stringify({ ...f, asks: f.asks.slice(1) }));
	assert.deepEqual(headSeam(slot, () => T0 + 2 * HOUR).asks().map((r) => [r.id, r.supersedes]), [["H2", "H1"]]);
});

test("the state of an ask: answered (an answer to the head) over handled (the tower acted and answered someone else) over received (the tower took it) over waiting over silent; a note never moves the 24 hours", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "one"), b = send(slot, T0, "wB", "two"), c = send(slot, T0, "wC", "three"), d = send(slot, T0, "wD", "four");
	const state = (now: number) => Object.fromEntries(headSeam(slot, () => now).asks().map((r) => [r.id, r.state]));
	assert.deepEqual(state(T0 + MIN), { H1: "waiting", H2: "waiting", H3: "waiting", H4: "waiting" });
	assert.equal(noteAsk(slot, T0 + 2 * MIN, { id: b.id, workspace: "wB", what: "read" }), true);
	assert.equal(noteAsk(slot, T0 + 3 * MIN, { id: c.id, workspace: "wC", what: "acted" }), true);
	answerAsk(slot, T0 + 4 * MIN, { id: d.id, workspace: "wD", text: "done" });
	assert.deepEqual(state(T0 + 5 * MIN), { H1: "waiting", H2: "received", H3: "handled", H4: "answered" });
	// acted after an answer, read after acted: the best state stays; acting counts as having read it
	noteAsk(slot, T0 + 6 * MIN, { id: d.id, workspace: "wD", what: "acted" });
	noteAsk(slot, T0 + 7 * MIN, { id: c.id, workspace: "wC", what: "read" });
	assert.deepEqual(state(T0 + 8 * MIN), { H1: "waiting", H2: "received", H3: "handled", H4: "answered" });
	const asks = readAsks(slot, T0);
	assert.equal(asks.find((x) => x.id === c.id)!.read !== undefined, true, "acted implies read");
	assert.equal(asks.find((x) => x.id === b.id)!.last, T0, "a note is not a forward or an answer: the 24 hours count from where they did");
	// a day later: the unheard one is silent, the read one stays received (it was read: it is not a failure), the handled one stays handled
	assert.deepEqual(state(T0 + 25 * HOUR), { H1: "silent", H2: "received", H3: "handled", H4: "answered" });
	void a;
});

test("a note is the workspace's own: another workspace's, an unknown id, and a closed ask's are ignored or kept honest", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "one");
	assert.equal(noteAsk(slot, T0, { id: a.id, workspace: "wB", what: "acted" }), false, "another workspace is not the tower asked");
	assert.equal(noteAsk(slot, T0, { id: "H99", workspace: "wA", what: "read" }), false);
	assert.equal(noteAsk(slot, T0, { id: "nope", workspace: "wA", what: "read" }), false);
	assert.equal(readAsks(slot, T0)[0]!.read, undefined);
	closeAsk(slot, a.id);
	assert.equal(noteAsk(slot, T0, { id: a.id, workspace: "wA", what: "read" }), true, "a send that failed after the tower had it still shows what the tower did");
});

test("an asks.json from before the fields reads: no sent, boss, supersedes, read, or acted; the row has none either", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "plain");
	const row = headSeam(slot, () => T0 + MIN).asks()[0]!;
	assert.deepEqual([row.id, row.first, row.state, row.boss, row.supersedes], [a.id, "plain", "waiting", undefined, undefined]);
});

// --- through the server ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	Object.defineProperty(world, "sessions", {
		configurable: true,
		set() {},
		get: () => world.clients.filter((c) => c.registered && c.connected).map((c) => {
			const pane = world.herdr.panes.find((p) => p.pane_id === c.registered!.herdrPaneId), ws = world.herdr.workspaces.find((w) => w.workspace_id === pane?.workspace_id), tab = world.herdr.tabs.find((t) => t.tab_id === pane?.tab_id);
			return { id: c.sessionId!, name: c.registered!.name, herdrLocation: { status: "ok", workspace: { id: ws?.workspace_id, label: ws?.label }, tab: { id: tab?.tab_id, label: tab?.label }, paneId: pane?.pane_id } };
		}),
	});
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const claimed = async (s: Running, ws: string, n = 1) => {
	await until(() => world.pis.size >= n, "the run");
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { id, token: String(got.token) };
};
const tool = (s: Running, token: string, name: string, args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args, ...over });

test("the head's tower_send keeps the boss's words of the turn's event (found by the relay, never from the model) and the whole message, and names what it replaces; a bad `supersedes` is the tool's error and sends nothing", async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal((await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "我沒說要道安全點收尾", present: true })).ok, true);
	const run = await claimed(s, head.workspace);
	const e = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token: run.token, id: e.id });
	const first = await tool(s, run.token, "tower_send", { workspace: "wA", message: "Boss: 「我沒說要道安全點收尾」. Keep going.\nSecond line." }, { turn: e.id });
	assert.equal(first.ok, true, JSON.stringify(first));
	const noTurn = await tool(s, run.token, "tower_send", { workspace: "wA", message: "the head's own note" });
	assert.equal(noTurn.ok, true);
	const fix = await tool(s, run.token, "tower_send", { workspace: "wA", message: "correction", supersedes: "H1" }, { turn: e.id });
	assert.equal(fix.ok, true, JSON.stringify(fix));
	const sentBefore = world.client("sb-head")!.sent.length;
	for (const bad of ["H99", "H4", "x", 7]) {
		const r = await tool(s, run.token, "tower_send", { workspace: "wA", message: "nope", supersedes: bad });
		assert.equal(r.ok, false, String(bad));
		assert.match(String(r.error), /supersedes/);
	}
	assert.equal(world.client("sb-head")!.sent.length, sentBefore, "a refused one sends nothing");
	const asks = readAsks(world.slot, Date.now());
	assert.deepEqual(asks.map((a) => [a.id, a.boss, a.sent, a.supersedes]), [
		["H1", "我沒說要道安全點收尾", "Boss: 「我沒說要道安全點收尾」. Keep going.\nSecond line.", undefined],
		["H2", undefined, "the head's own note", undefined],
		["H3", undefined, "correction", "H1"],
	]);
	// the model cannot say the boss's words: an argument named boss is not read
	await tool(s, run.token, "tower_send", { workspace: "wA", message: "forged", boss: "I never said this" }, { turn: e.id });
	assert.equal(readAsks(world.slot, Date.now()).at(-1)!.boss, undefined);
});

test("a workspace tower that takes the head's message has received it; one that then sends a message in that turn (to another tower, or to a session) has handled it, and the head's page no longer says it waits", async () => {
	const s = await world.start();
	await s.handle.ready;
	await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	const mine = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it" });
	const other = openAsk(world.slot, Date.now(), { workspace: "wB", label: "Beta", first: "do it too" });
	const state = (id: string) => headSeam(world.slot, () => Date.now()).asks().find((r) => r.id === id)!.state;
	assert.deepEqual([state(mine.id), state(other.id)], ["waiting", "waiting"]);
	world.client("sb-tower-wa")!.incoming({ id: "sb-head", name: "head tower" }, { id: "hm1", content: { text: `[straw net from="head tower" id=sb-head role=tower head=yes workspace=head kind=tower_send scope=tower to="tower · Alpha" reply=expected ask=${mine.id}] do it` } } as never);
	const run = await claimed(s, "wA");
	const ev = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: ev.id })).ok, true);
	assert.deepEqual([state(mine.id), state(other.id)], ["received", "waiting"], "taking the event is the tower's own acknowledgement, of its own ask only");
	// a tool that is not a send, and a send in a turn that this event did not start, are not acting on the ask
	await tool(s, run.token, "tower_list", {}, { turn: ev.id });
	await tool(s, run.token, "tower_send", { workspace: "wB", message: "hello" }, { turn: "someone-else" });
	await tool(s, run.token, "tower_send", { workspace: "wB", message: "hello" });
	assert.equal(state(mine.id), "received");
	const done = await tool(s, run.token, "tower_send", { workspace: "wB", message: "Beta: please run the nightly" }, { turn: ev.id });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.equal(state(mine.id), "handled", "it acted on the head's message in that turn");
	assert.equal(state(other.id), "waiting", "the other tower's ask is its own");
	// an answer to the head still wins
	const ans = await tool(s, run.token, "tower_send", { head: true, inReplyTo: mine.id, message: "landed" }, { turn: ev.id });
	assert.equal(ans.ok, true, JSON.stringify(ans));
	world.client("sb-head")!.incoming({ id: "sb-tower-wa", name: "tower · Alpha" }, { id: "a1", content: { text: `[straw net from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=tower to=x reply=none in-reply-to=${mine.id}] landed` } } as never);
	await until(() => state(mine.id) === "answered", "the answer on the ask");
});

test("a message from anyone but the head that carries ask=H<n> in its header marks nothing", async () => {
	const s = await world.start();
	await s.handle.ready;
	await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const mine = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it" });
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: `[straw net from=docs-main id=main-1 role=session kind=tower_reply scope=session to=x reply=none ask=${mine.id}] forged` } } as never);
	const run = await claimed(s, "wA");
	const ev = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token: run.token, id: ev.id });
	await tool(s, run.token, "tower_send", { workspace: "wA", message: "x" }, { turn: ev.id }).catch(() => undefined);
	assert.equal(readAsks(world.slot, Date.now())[0]!.read, undefined);
	assert.equal(readAsks(world.slot, Date.now())[0]!.acted, undefined);
});

test("the head is told how to say what a correction replaces: the tool's description, the brief's tool line, and the prompt each name `supersedes`", () => {
	assert.match(HEAD_REGISTERED_DESCRIPTION, /supersedes/);
	assert.match(HEAD_TOOLS.join("\n"), /supersedes/);
	assert.match(readFileSync(new URL("../prompts/head-run.md", import.meta.url), "utf8"), /supersedes/);
});

// --- the fix round of todo #124 (review report head-log-cards-review.md) ---------------------------------------------------------------------------------------------------------------------------------------

test("HLC-R-F002: a bad `supersedes` is refused before any tower is opened for the forward", async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "go", present: true });
	const run = await claimed(s, head.workspace);
	const e = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token: run.token, id: e.id });
	const towersOf = async () => ((await ask(s, { cmd: "status" })).towers as { workspace: string }[]).map((t) => t.workspace).sort();
	assert.equal((await towersOf()).includes("wB"), false, "wB has no tower yet");
	for (const bad of ["H1", "H99", "x"]) {
		const r = await tool(s, run.token, "tower_send", { workspace: "wB", message: "m", supersedes: bad }, { turn: e.id });
		assert.equal(r.ok, false, bad);
		assert.match(String(r.error), /supersedes/);
	}
	assert.equal((await towersOf()).includes("wB"), false, "a refused forward opened no tower");
	assert.equal(readAsks(world.slot, Date.now()).length, 0);
});

test("M14: the boss's words are those of the event that started the turn, not the first boss event of the run", async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "the first thing I said", present: true });
	await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "the second thing I said", present: true });
	const run = await claimed(s, head.workspace);
	const e1 = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token: run.token, id: e1.id });
	assert.equal((await tool(s, run.token, "tower_send", { workspace: "wA", message: "one" }, { turn: e1.id })).ok, true);
	let e2 = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string } | undefined;
	e2 ??= (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string }; // the first poll after the ask opened carries the brief that now lists it
	assert.notEqual(e2.id, e1.id);
	await ask(s, { cmd: "run-taken", token: run.token, id: e2.id });
	assert.equal((await tool(s, run.token, "tower_send", { workspace: "wA", message: "two" }, { turn: e2.id })).ok, true);
	assert.deepEqual(readAsks(world.slot, Date.now()).map((a) => [a.sent, a.boss]), [["one", "the first thing I said"], ["two", "the second thing I said"]]);
});

test("M1: an id below the file's `next` that was pruned is not an ask to correct", () => {
	const slot = slotIn();
	send(slot, T0, "wA", "a");
	send(slot, T0 + 1, "wA", "b");
	const file = join(towerDir(slot, HEAD_KEY), "asks.json"), f = JSON.parse(readFileSync(file, "utf8")) as { next: number; asks: { id: string }[] };
	writeFileSync(file, JSON.stringify({ ...f, asks: f.asks.slice(1) })); // H1 is gone, next is 3
	assert.throws(() => send(slot, T0 + 2, "wA", "c", { supersedes: "H1" }), /supersedes/);
	assert.equal(send(slot, T0 + 3, "wA", "d", { supersedes: "H2" }).supersedes, "H2");
});

test("M7: a tower that acted has read the message at once: `read` is set by the `acted` note itself", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "one");
	assert.equal(noteAsk(slot, T0 + MIN, { id: a.id, workspace: "wA", what: "acted" }), true);
	const kept = readAsks(slot, T0)[0]!;
	assert.deepEqual([kept.read, kept.acted], [T0 + MIN, T0 + MIN]);
});

test("M19: the kept text is cut by characters, not UTF-16 units: a pair straddling the cut is whole or gone, never half", () => {
	const slot = slotIn();
	const text = `${"a".repeat(1499)}😀tail`;
	const a = send(slot, T0, "wA", text, { relay: "boss:e1", boss: text });
	for (const kept of [a.sent!, a.boss!]) {
		assert.equal(Array.from(kept).length, 1500);
		assert.equal(kept.endsWith("😀"), true, "the pair is whole");
		assert.doesNotMatch(kept, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, "no lone surrogate");
	}
});

test("HLC-R-F005: a new field of the wrong type is ignored on read and the ask still draws", () => {
	const slot = slotIn();
	send(slot, T0, "wA", "one");
	send(slot, T0 + 1, "wA", "two");
	const file = join(towerDir(slot, HEAD_KEY), "asks.json"), f = JSON.parse(readFileSync(file, "utf8")) as { next: number; asks: Record<string, unknown>[] };
	f.asks[0] = { ...f.asks[0], sent: 5, boss: { x: 1 }, supersedes: "nope", read: "yes", acted: null };
	f.asks[1] = { ...f.asks[1], sent: "kept", boss: "kept too", supersedes: "H1", read: 5, acted: 6 };
	writeFileSync(file, JSON.stringify(f));
	const [bad, good] = readAsks(slot, T0);
	assert.deepEqual([bad!.id, bad!.sent, bad!.boss, bad!.supersedes, bad!.read, bad!.acted], ["H1", undefined, undefined, undefined, undefined, undefined]);
	assert.deepEqual([good!.sent, good!.boss, good!.supersedes, good!.read, good!.acted], ["kept", "kept too", "H1", 5, 6]);
	const rows = headSeam(slot, () => T0 + MIN).asks();
	assert.deepEqual(rows.map((r) => [r.id, r.sent, r.boss, r.supersedes, r.state]), [["H1", undefined, undefined, undefined, "waiting"], ["H2", "kept", "kept too", "H1", "handled"]]);
	// a non-finite number is no time either
	f.asks[1] = { ...f.asks[1], read: "NaN", acted: Infinity };
	writeFileSync(file, JSON.stringify(f));
	assert.deepEqual([readAsks(slot, T0)[1]!.read, readAsks(slot, T0)[1]!.acted], [undefined, undefined]);
});

const taking = async (s: Running, ws: string, label: string, id: string, n = 1) => {
	world.client(`sb-tower-${ws.toLowerCase()}`)!.incoming({ id: "sb-head", name: "head tower" }, { id: `hm-${id}`, content: { text: `[straw net from="head tower" id=sb-head role=tower head=yes workspace=head kind=tower_send scope=tower to="tower · ${label}" reply=expected ask=${id}] do it` } } as never);
	const run = await claimed(s, ws, n);
	const ev = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: ev.id })).ok, true);
	return { run, ev };
};

test("HLC-R3-F001: a tower's tower_reply to the head is refused at the tool, before anything is sent, and says how to answer; the ask records nothing but that the tower took the message", async () => {
	const s = await world.start();
	await s.handle.ready;
	await world.expose!.head.ensure();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const a = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it" });
	const state = (id: string) => headSeam(world.slot, () => Date.now()).asks().find((r) => r.id === id)!.state;
	const one = await taking(s, "wA", "Alpha", a.id);
	const sentBefore = world.client("sb-head")!.sent.length;
	const reply = await tool(s, one.run.token, "tower_reply", { to: "sb-head", message: "landed" }, { turn: one.ev.id });
	assert.equal(reply.ok, false, JSON.stringify(reply));
	assert.match(String(reply.error), /not delivered/i);
	assert.match(String(reply.error), /tower_send/);
	assert.match(String(reply.error), /head: true/);
	assert.match(String(reply.error), /inReplyTo/);
	assert.equal(world.client("sb-head")!.sent.length, sentBefore, "nothing was sent to the head");
	assert.equal(world.client("sb-tower-wa")!.sent.some((x) => x.to === "sb-head"), false, "the tower's own client sent nothing to the head");
	const byName = await tool(s, one.run.token, "tower_reply", { to: "head tower", message: "landed" }, { turn: one.ev.id });
	assert.equal(byName.ok, false, "the head's name is refused like its id");
	assert.match(String(byName.error), /not delivered/i);
	assert.equal(world.client("sb-tower-wa")!.sent.some((x) => x.to === "sb-head"), false, "still nothing sent after the refusal by name");
	assert.equal(readAsks(world.slot, Date.now())[0]!.answers.length, 0, "no answer is recorded for a reply the head never got");
	assert.equal(state(a.id), "received", "a failed call records nothing beyond what the run's taking noted");
});

test("HLC-R-F004: which calls of a tower's turn count: a send or reply to anyone, and boss_open_main, are handled; a tower_reply to the head is handled and marked as not reaching it, never an answer; a tool that is not an act is nothing", () => {
	const slot = slotIn(), head = headId(slot), event = (id: string) => ({ from: { id: head }, text: `[straw net from="head tower" id=${head} role=tower head=yes workspace=head kind=tower_send scope=tower to=x reply=expected ask=${id}] go` });
	const [a, b, c, d, e, f, g, h] = ["wA", "wB", "wC", "wD", "wE", "wF", "wG", "wH"].map((ws) => send(slot, T0, ws, "go"));
	const state = (id: string) => headSeam(slot, () => T0 + MIN).asks().find((r) => r.id === id)!.state;
	noteToolCall(slot, T0 + 1, "wA", event(a!.id), { name: "boss_open_main", args: { request: "x", sender: "y" }, details: { tab: "t1" } });
	noteToolCall(slot, T0 + 1, "wB", event(b!.id), { name: "tower_reply", args: { to: "main-1", message: "m" }, details: { to: "main-1" } });
	noteToolCall(slot, T0 + 1, "wC", event(c!.id), { name: "tower_reply", args: { to: head, message: "landed it" }, details: { to: head } });
	noteToolCall(slot, T0 + 1, "wG", event(g!.id), { name: "tower_reply", args: { to: "main-1", message: "m" } });
	noteToolCall(slot, T0 + 1, "wH", event(h!.id), { name: "tower_send", args: { head: true, inReplyTo: h!.id, message: "m" } });
	noteToolCall(slot, T0 + 1, "wD", event(d!.id), { name: "tower_list", args: {}, details: {} });
	noteToolCall(slot, T0 + 1, "wE", event(e!.id), { name: "tower_send", args: { head: true, inReplyTo: e!.id, message: "m" }, details: { to: "head", ask: e!.id } });
	noteToolCall(slot, T0 + 1, "wF", { from: { id: "main-9" }, text: event(f!.id).text }, { name: "tower_send", args: { message: "m" }, details: {} });
	assert.deepEqual([a, b, c, d, e, f, g, h].map((x) => state(x!.id)), ["handled", "handled", "handled", "waiting", "handled", "waiting", "waiting", "waiting"], "wE's answer reaches the head by its own intake, which records it; the head's header from anyone else marks nothing; a call with no result (it failed) marks nothing");
	assert.equal(readAsks(slot, T0).find((x) => x.id === c!.id)!.answers.length, 0, "a tower_reply to the head is not an answer: the head's gate refuses it");
	const rows = headSeam(slot, () => T0 + MIN).asks();
	assert.deepEqual([b, c, e].map((x) => rows.find((r) => r.id === x!.id)!.missed), [undefined, true, undefined], "only the reply to the head is marked as not reaching it");
	// an ask that is no longer open cannot take an answer: the reply to the head is still an act
	closeAsk(slot, a!.id);
	noteToolCall(slot, T0 + 2, "wA", event(a!.id), { name: "tower_reply", args: { to: head, message: "late" }, details: { to: head } });
	assert.equal(readAsks(slot, T0).find((x) => x.id === a!.id)!.answers.length, 0);
	assert.equal(state(a!.id), "handled");
});

test("the snapshot sends one copy of a broadcast's message: a tower's copy equal to the first tower's is left out, a tailored one is kept, and the page's reading falls back to the first's", () => {
	const slot = slotIn();
	send(slot, T0, "wA", "same for all", { relay: "boss:e1", boss: "boss words" });
	send(slot, T0 + 1, "wB", "same for all", { relay: "boss:e1" });
	send(slot, T0 + 2, "wC", "tailored for C", { relay: "boss:e1" });
	send(slot, T0 + 3, "wD", "same for all", { relay: "boss:e1" });
	const rows = headSeam(slot, () => T0 + MIN).asks();
	assert.deepEqual(rows.map((r) => [r.id, r.sent, r.boss]), [["H1", "same for all", "boss words"], ["H2", undefined, undefined], ["H3", "tailored for C", undefined], ["H4", undefined, undefined]]);
});

test("the snapshot carries at most TEXTS units of whole text: the newest broadcasts whole while they fit, then the first that does not and every older one without (their cards show the first line)", () => {
	const slot = slotIn(), big = (c: string) => c.repeat(1500);
	// one-tower broadcasts of 1,500 + 1,500 units = 3,000 each; ten are 30,000 > TEXTS
	for (let i = 0; i < 10; i++) send(slot, T0 + i * 5 * MIN, `w${i}`, big(String(i)), { relay: `boss:e${i}`, boss: big("b") });
	const rows = headSeam(slot, () => T0 + HOUR).asks();
	assert.deepEqual(rows.filter((r) => r.sent !== undefined).map((r) => r.id), ["H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10"], "the newest eight fit 24,000 exactly; the oldest two are first lines");
	assert.equal(rows.every((r) => r.first.length > 0), true);
	assert.equal(rows.filter((r) => r.boss !== undefined).length, 8);
	assert.equal(rows.reduce((n, r) => n + (r.sent?.length ?? 0) + (r.boss?.length ?? 0), 0) <= TEXTS, true);
	// an older broadcast that is small does not jump the queue: once one does not fit, the rest are first lines too
	const slot2 = slotIn();
	send(slot2, T0, "wA", "small", { relay: "boss:s", boss: "small" });
	for (let i = 0; i < 9; i++) send(slot2, T0 + (i + 1) * 5 * MIN, `v${i}`, big("x"), { relay: `boss:f${i}`, boss: big("y") });
	send(slot2, T0 + HOUR, "wZ", "newest small", { relay: "boss:z", boss: "z" });
	assert.deepEqual(headSeam(slot2, () => T0 + 2 * HOUR).asks().filter((r) => r.sent !== undefined).map((r) => r.id), ["H4", "H5", "H6", "H7", "H8", "H9", "H10", "H11"], "newest first (2 + 7 × 3,000 fit): the two oldest large ones and the small oldest one are cut together");
});

test("the budget counts every tower's own copy: broadcasts whose towers got different texts cost all of them", () => {
	const slot = slotIn(), copy = (n: number) => String(n).padStart(2, "0").repeat(740);
	// ten broadcasts of three towers, each tower with its own 1,480-unit copy: 4,440 each, so five fit 24,000 (a cost that counted only the first tower's would keep all ten)
	for (let g = 0; g < 10; g++) for (let t = 0; t < 3; t++) send(slot, T0 + g * 5 * MIN + t, `w${g}${t}`, copy(g * 3 + t), { relay: `boss:e${g}` });
	const rows = headSeam(slot, () => T0 + HOUR).asks();
	assert.equal(rows.filter((r) => r.sent !== undefined).length, 15, "only the newest five broadcasts (fifteen copies) are whole");
	assert.equal(rows.reduce((n, r) => n + (r.sent?.length ?? 0), 0) <= TEXTS, true);
});

test("worst case, measured: the asks of one snapshot stay within the bound the spec states, for text that costs the most bytes (escaped control characters), 4-byte emoji, and CJK", () => {
	const measured: Record<string, number> = {};
	// "mixed" has the costliest first line and answer too: 120 CJK characters, then 1,379 escaped control characters
	for (const [kind, text] of [["control", "\u0001".repeat(1500)], ["emoji", "😀".repeat(750)], ["cjk", "字".repeat(1500)], ["mixed", `${"字".repeat(120)}\n${"\u0001".repeat(1379)}`]] as const) {
		const slot = slotIn();
		for (let i = 0; i < 100; i++) {
			const a = send(slot, T0 + i * 1000, `w${i}`, text, { relay: `boss:e${i}`, boss: text });
			answerAsk(slot, T0 + i * 1000 + 1, { id: a.id, workspace: `w${i}`, text: "字".repeat(120) });
		}
		const rows = headSeam(slot, () => T0 + HOUR).asks();
		assert.equal(rows.length <= 60, true, "the newest broadcasts, as many as the cap allows");
		assert.equal(rows.reduce((n, r) => n + (r.sent?.length ?? 0) + (r.boss?.length ?? 0), 0) <= TEXTS, true, kind);
		measured[kind] = Buffer.byteLength(JSON.stringify(rows));
	}
	for (const [kind, bytes] of Object.entries(measured)) assert.equal(bytes <= SNAPSHOT_MAX, true, `${kind}: ${bytes}`);
});
