import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type HeadCmdDeps, parseHeadArgs, runHeadCommand } from "../src/headcmd.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { type MemoryCmdDeps, runMemoryCommand } from "../src/memorycmd.ts";
import { gateRun } from "../src/server/rungate.ts";
import { callControl } from "../src/server/socket.ts";
import { World } from "./fakes.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `/boss head …`, `/boss memory -w head`, and the head in `status` (docs/specs/2026-11-04-head-tower.md, Reaching it, Placement; H3): the pi twins of the head page's composer and buttons, each one control command the
// GUI's route reaches too (`head-open`, `head-event`, `head-leave`, `head-new`, `head-close`; `status` for the reads). The writes need a pi with a screen.

function harness(over: Partial<HeadCmdDeps> = {}) {
	const told: { text: string; level: string }[] = [], sent: Record<string, unknown>[] = [], focused: string[] = [];
	let answer: Record<string, unknown> = { ok: true }, head: unknown = null;
	const deps: HeadCmdDeps = {
		lang: "en", interactive: true,
		ask: async (request, start) => (sent.push({ ...request, start }), request.cmd === "status" ? { ok: true, head } : { ok: true, ...answer }),
		focus: async (tab) => void focused.push(tab),
		tell: (text, level = "info") => void told.push({ text, level }),
		...over,
	};
	return { told, sent, focused, deps, say: (a: Record<string, unknown>) => void (answer = a), row: (h: unknown) => void (head = h), run: (line: string) => runHeadCommand(parseHeadArgs(line), deps), last: () => told.at(-1)! };
}

test("the words that are commands: nothing opens, status, leave, new, close alone; anything else is a message for the head tower", () => {
	assert.deepEqual(parseHeadArgs(""), { op: "open" });
	assert.deepEqual(parseHeadArgs("   "), { op: "open" });
	for (const op of ["status", "leave", "new", "close"]) assert.deepEqual(parseHeadArgs(` ${op.toUpperCase()} `), { op });
	assert.deepEqual(parseHeadArgs("start MP-4129 in Alpha"), { op: "say", text: "start MP-4129 in Alpha" });
	for (const prompt of ["new tests for the build", "close the loop with Beta", "status of the deploy", "leave it to docs"]) assert.deepEqual(parseHeadArgs(prompt), { op: "say", text: prompt }, prompt);
});

test("a bare /boss head makes the head workspace and focuses its tab; a message is a boss event that starts the server when it is stopped; leave, new, and close are one command each", async () => {
	const h = harness();
	h.say({ workspace: "wH", tab: "wH:t1", pane: "wH:p1", opened: true });
	await h.run("");
	assert.deepEqual([h.sent.at(-1)!.cmd, h.sent.at(-1)!.start, h.focused], ["head-open", "boss", ["wH:t1"]]);
	assert.match(h.last().text, /^Opened the head tower/);
	h.say({ workspace: "wH", tab: "wH:t1", pane: "wH:p1", opened: false });
	await h.run("");
	assert.match(h.last().text, /^The head tower is open already: focused it/);
	h.say({ queued: "e1" });
	await h.run("start MP-4129 in Alpha");
	assert.deepEqual([h.sent.at(-1)!.cmd, h.sent.at(-1)!.text, h.sent.at(-1)!.start], ["head-event", "start MP-4129 in Alpha", "boss"]);
	assert.match(h.last().text, /^Handed to the head tower/);
	h.say({ left: true });
	await h.run("leave");
	assert.match(h.last().text, /^Left the boss conversation/);
	h.say({ left: true, already: true });
	await h.run("leave");
	assert.match(h.last().text, /closing already/);
	h.say({ fresh: true, left: false });
	await h.run("new");
	assert.match(h.last().text, /^Started over: the next conversation is a new session\./);
	h.say({ closed: true });
	await h.run("close");
	assert.match(h.last().text, /^Closed the head tower\. Its conversation and memory are kept\./);
	assert.deepEqual(h.sent.slice(-4).map((r) => [r.cmd, r.start]), [["head-leave", "never"], ["head-leave", "never"], ["head-new", "never"], ["head-close", "never"]]);
});

test("status reads the head row of the server's status: not open yet, or its state with the queue and the run", async () => {
	const h = harness();
	await h.run("status");
	assert.match(h.last().text, /^The head tower is not open: its first message opens it\.$/);
	h.row({ workspace: "wH", label: "Head tower", id: "sb-head", state: "live", queue: 1, service: { state: "running", queued: 1, run: { kind: "local", startedAt: "2026-11-04T10:00:00Z" }, lastRun: { endedAt: "2026-11-04T09:00:00Z", outcome: "done" }, notices: [{ id: "n", level: "warning", text: "a\u001b[31m notice" }] } });
	await h.run("status");
	assert.match(h.last().text, /^Head tower \(Head tower\): running · 1 queued · run: a local run since \d\d:\d\d · last run \d\d:\d\d: done$/m);
	assert.match(h.last().text, /\[warning\] a\[31m notice/, "control characters are cleaned");
	assert.deepEqual(h.sent.map((r) => [r.cmd, r.start]), [["status", "never"], ["status", "never"]]);
});

test("the server's refusal is shown as it wrote it; a pi with no screen may read but not write", async () => {
	const h = harness({ ask: async () => ({ ok: false, error: "The head tower needs the tower service (towerRuns)" }) });
	await h.run("hello");
	assert.deepEqual(h.last(), { text: "The head tower needs the tower service (towerRuns)", level: "error" });
	const blind = harness({ interactive: false });
	for (const line of ["", "hello", "leave", "new", "close"]) {
		await blind.run(line);
		assert.equal(blind.last().level, "error", line);
		assert.match(blind.last().text, /only in a pi session with a screen/, line);
	}
	assert.deepEqual(blind.sent, [], "nothing was asked");
	await blind.run("status");
	assert.deepEqual((blind.sent as Record<string, unknown>[]).map((r) => String(r.cmd)), ["status"], "a read is allowed");
});

test("in Traditional Chinese the words follow", async () => {
	const h = harness({ lang: "zh-TW" });
	h.say({ workspace: "wH", tab: "wH:t1", pane: "wH:p1", opened: true });
	await h.run("");
	assert.match(h.last().text, /^已開啟主塔台/);
	await h.run("status");
	assert.equal(h.last().text, "主塔台還沒有開：第一則訊息會開啟它。");
	const blind = harness({ lang: "zh-TW", interactive: false });
	await blind.run("hello");
	assert.match(blind.last().text, /有畫面的 pi session/);
});

test("/boss memory -w head reaches the head's memory with the head's key; any other workspace word still looks for a workspace by id or label", async () => {
	const asked: string[] = [], told: string[] = [];
	const deps: MemoryCmdDeps = {
		lang: "en", interactive: true, own: "wA", workspaces: async () => [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wH", label: "Head tower" }],
		ask: async (workspace) => (asked.push(workspace), { ok: true, status: 200, body: { rev: 1, standing: [], decisions: [], waits: [], proposals: [] } }),
		tell: (text) => void told.push(text),
	};
	await runMemoryCommand("-w head", deps);
	assert.deepEqual(asked, [HEAD_KEY]);
	await runMemoryCommand("-w Alpha", deps);
	await runMemoryCommand("-w wH", deps);
	assert.deepEqual(asked, [HEAD_KEY, "wA", "wH"]);
});

test("a run's token may not ask for any head command", () => {
	for (const kind of ["local", "ally", "head"] as const) for (const cmd of ["head-open", "head-event", "head-leave", "head-new", "head-close"]) assert.equal(gateRun({ cmd }, { id: "r", workspace: "wA", kind }).ok, false, `${kind} ${cmd}`);
});

// --- the server ---------------------------------------------------------------------------------------------------------------------------------------------------------

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());
type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);

test("the control commands: status carries a null head until the first message; head-event makes the head and queues the boss's words; head-open names its tab; leave and new say when there is no head; close ends it", async () => {
	const s = await world.start();
	await s.handle.ready;
	assert.equal((await ask(s, { cmd: "status" })).head, null);
	for (const cmd of ["head-leave", "head-new"]) assert.match(String((await ask(s, { cmd })).error), /^The head tower is not open/, cmd);
	assert.equal((await ask(s, { cmd: "head-event" })).ok, false, "a message needs text");
	const said = await ask(s, { cmd: "head-event", text: "tell Alpha to start" });
	assert.equal(said.ok, true, JSON.stringify(said));
	await until(() => world.pis.size === 1, "the head run");
	const status = (await ask(s, { cmd: "status" })).head as { workspace: string; id: string; state: string };
	assert.deepEqual([status.id, status.state], ["sb-head", "live"]);
	assert.equal(((await ask(s, { cmd: "status" })).towers as unknown[]).length, 0, "the head is no row of towers");
	const opened = await ask(s, { cmd: "head-open" });
	assert.deepEqual([opened.ok, opened.workspace, opened.opened], [true, status.workspace, false]);
	assert.ok(opened.tab && opened.pane);
	const closed = await ask(s, { cmd: "head-close" });
	assert.deepEqual([closed.ok, closed.closed], [true, true]);
	assert.equal((await ask(s, { cmd: "status" })).head, null);
	assert.deepEqual(await ask(s, { cmd: "head-close" }).then((r) => [r.ok, r.closed]), [true, false], "closing again is nothing to do");
});

test("with the tower service off the head commands answer in the one sentence", async () => {
	world.setFlag(false);
	const s = await world.start();
	await s.handle.ready;
	for (const cmd of ["head-open", "head-event"]) assert.equal((await ask(s, { cmd, text: "x" })).error, "The head tower needs the tower service (towerRuns)", cmd);
});

test("in a pi session /boss head is the command the harness runs: without the sb server it says so, and the completions list the head's words", async () => {
	const world = new World();
	try {
		const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
		await a.start();
		await a.command("head start MP-4129 in Alpha");
		assert.deepEqual(a.notices.at(-1), { text: "The sb server is not available in this session.", level: "warning" });
		const completions = (a.commands.get("boss") as unknown as { getArgumentCompletions(prefix: string): { value: string }[] | null }).getArgumentCompletions("head");
		assert.deepEqual(completions?.map((c) => c.value), ["head", "head status", "head leave", "head new", "head close"]);
	} finally {
		await world.stopAll();
	}
});
