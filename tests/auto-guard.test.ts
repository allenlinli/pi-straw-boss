import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAuto, gistOf } from "../src/auto.ts";
import { asBoss } from "../src/autoscope.ts";
import { AUTO_FILE, autoOnForTrust, seal } from "../src/autostate.ts";
import { CALL_TOWER_LINE, cancelledText, NO_CONFIRM, refusedText, SHOW_DOC_LINE, tailOf } from "../src/autotext.ts";
import { createAutoMode } from "../src/server/automode.ts";
import { createAsk } from "../src/trust/ask.ts";
import { type Agent, settle, World } from "./fakes.ts";

// The session's guard (docs/specs/2026-11-09-auto-mode.md, §3 and §4; task 2): every source row refused with the kind's text, Escape only inside tool calls, the gate and the trust question answered at once.

let world: World, dir = "", clock = 1_800_000_000_000;
const notes: Record<string, unknown>[] = [];
beforeEach(() => {
	world = new World();
	dir = world.stateDir;
	notes.length = 0;
});
afterEach(() => world.stopAll());

/** Auto mode on, written by the real server module, so the own record vouches for the file. */
const switchOn = (where = dir) => {
	const auto = createAutoMode({ dir: where, now: () => clock, log: () => {} });
	auto.start();
	auto.switchOn({ via: "pi", name: "test" });
	return auto;
};
const member = async (over: { env?: Record<string, string>; id?: string } = {}) => {
	const agent = world.agent({ id: over.id ?? "m1", pane: "wA:p1", tab: "wA:t1", ui: true, env: over.env, deps: { ask: async (request) => (notes.push(request), { ok: false, error: "no server" }) } });
	await agent.start();
	return agent;
};
const call = async (agent: Agent, toolName: string, input: Record<string, unknown> = {}, toolCallId = "tc") => (await agent.fireResult("tool_call", { toolName, toolCallId, input })) as { block?: boolean; reason?: string } | undefined;

const ROWS: [string, Record<string, unknown>][] = [
	["ask_user_question", { questions: [{ header: "Which database", question: "Which?", options: [] }] }],
	["question", { question: "Proceed?" }],
	["robot_hand", { command: "ls -la" }],
	["secret_drop", { label: "the registry token", destination: "env" }],
	["link_request", { action: "invite" }],
	["mcp", { action: "auth-start", server: "x" }],
	["mcp", { action: "auth-complete", server: "x" }],
];
const PASSES: [string, Record<string, unknown>][] = [
	["call_tower", { message: "m", why: "milestone" }], ["intercom", { action: "ask", to: "x", message: "m" }], ["caller_ping", { message: "m" }], ["goal_wait", { reason: "r" }], ["MonitorCreate", { command: "sleep 1" }],
	["LoopCreate", { trigger: "5m" }], ["subagent", { agent: "scout", name: "look" }], ["show_doc", { paths: ["a.md"] }], ["bash", { command: "ls" }], ["mcp", { action: "list" }], ["mcp", { tool: "x" }],
];

test("while off nothing is refused", async () => {
	const agent = await member();
	for (const [tool, input] of [...ROWS, ...PASSES]) assert.equal(await call(agent, tool, input), undefined, tool);
});

test("each source row is refused at tool_call in a member, a main, and a child, with the kind's text; the calls that wait on an agent pass", async () => {
	switchOn();
	const kinds: [string, string, Record<string, string> | undefined][] = [["member", "main", undefined], ["child", "subagent", { PI_SUBAGENT_ID: "kid-1" }]];
	for (const [label, kind, env] of kinds) {
		const agent = await member({ env, id: `agent-${label}` });
		if (label === "member") assert.equal(await agent.promote().then((t) => /main/i.test(t) || true), true);
		for (const [tool, input] of ROWS) {
			const out = await call(agent, tool, input);
			assert.equal(out?.block, true, `${label}: ${tool}`);
			assert.match(out!.reason!, /^sb: auto mode is on \(since \d\d:\d\d; the boss is away\): /, `${label}: ${tool} text`);
			assert.ok(out!.reason!.includes(`${tool} waits for the boss and is refused. ${tailOf(kind as never, tool)}`), `${label}: ${tool} tail`);
		}
		for (const [tool, input] of PASSES) assert.equal(await call(agent, tool, input), undefined, `${label}: ${tool} is not refused`);
	}
});

test("the tail per kind: it opens and ends alike, a train and a tower run get theirs, and a secret_drop names the secret, never its value", () => {
	for (const kind of ["main", "subagent", "train", "run"] as const) {
		const tail = tailOf(kind, "robot_hand");
		assert.ok(tail.startsWith("Do not ask again or wait."), kind);
		assert.ok(tail.endsWith("Only the boss or the head tower ends auto mode."), kind);
		assert.ok(!tail.includes("Name the secret"));
	}
	assert.match(tailOf("main", "x"), /call_tower why: blocked/);
	assert.match(tailOf("subagent", "x"), /caller_ping your dispatcher/);
	assert.match(tailOf("train", "x"), /call_tower blocked with reply: false/);
	assert.match(tailOf("run", "x"), /tower_memory/);
	assert.match(tailOf("main", "secret_drop"), /Name the secret, never its value\. Only the boss/);
	assert.match(refusedText("2026-11-09T23:10:00", "robot_hand", "main"), /^sb: auto mode is on \(since 23:10; the boss is away\): robot_hand waits for the boss and is refused\. Do not ask again or wait\./);
	assert.match(cancelledText("2026-11-09T23:10:00", "robot_hand", "main"), /^sb: auto mode started at 23:10: this robot_hand was cancelled by sb, not by the boss, who is away\. Do not ask again or wait\./);
});

test("the guard of a train and of a tower run is told by kind", async () => {
	const kit = { pi: { on: (type: string, h: (e: unknown) => unknown) => void handlers.set(type, h) }, cfg: { env: {}, now: () => clock }, s: { isTrain: true, ui: undefined }, guiDir: dir, me: () => "x" };
	const handlers = new Map<string, (e: unknown) => unknown>();
	switchOn();
	const guard = createAuto(kit as never);
	const out = handlers.get("tool_call")!({ toolName: "robot_hand", toolCallId: "t", input: {} }) as { reason: string };
	assert.match(out.reason, /call_tower blocked with reply: false/);
	guard.running(() => true);
	assert.match((handlers.get("tool_call")!({ toolName: "secret_drop", toolCallId: "t", input: {} }) as { reason: string }).reason, /tower_memory.*Name the secret/);
});

test("a refusal is noted to the server with a gist; a secret-shaped gist is withheld", async () => {
	switchOn();
	const agent = await member();
	await call(agent, "ask_user_question", ROWS[0]![1]);
	await call(agent, "robot_hand", { command: "export TOKEN=abc12345def67890ghi" });
	await settle();
	const sent = notes.filter((n) => n.cmd === "auto-note");
	assert.equal(sent.length, 2);
	assert.deepEqual([sent[0]!.tool, sent[0]!.kind, sent[0]!.gist], ["ask_user_question", "refused", "Which database"]);
	assert.equal(sent[1]!.gist, "(withheld)");
	assert.equal(gistOf("secret_drop", { label: "x".repeat(300) }).length, 120);
});

test("a dialog opened inside a tool call is Escape at once, never drawn, and the call's result says why; with no call in flight, and under the boss's own command, it is drawn", async () => {
	switchOn();
	const agent = await member();
	await agent.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
	assert.equal(await (agent.ui.confirm as (t: string, m: string) => Promise<unknown>)("Allow rm?", "rm -rf x"), false);
	assert.equal(await (agent.ui.select as (t: string, o: string[]) => Promise<unknown>)("Pick", ["a", "b"]), undefined);
	assert.equal(await (agent.ui.input as (t: string) => Promise<unknown>)("Name?"), undefined);
	assert.equal(await (agent.ui.editor as (t: string) => Promise<unknown>)("Text?"), undefined);
	assert.equal(agent.dialogs.length, 0, "none was drawn");
	const result = (await agent.fireResult("tool_result", { toolName: "bash", toolCallId: "c1", input: {}, content: [{ type: "text", text: "denied" }], isError: false })) as { content: { text: string }[] };
	assert.equal(result.content[0]!.text, "denied");
	assert.match(result.content[1]!.text, /^sb: auto mode is on \(since \d\d:\d\d; the boss is away\): a dialog inside bash waits for the boss and is refused\./);
	// the boss's own command, mid-turn: drawn
	const drawn = asBoss(() => (agent.ui.confirm as (t: string, m: string) => Promise<unknown>)("Stop it?", "body"));
	await settle();
	assert.equal(agent.dialogs.length, 1, "a /boss command's confirm draws, with a bash call in flight");
	agent.dialogs[0]!.settle(true);
	assert.equal(await drawn, true);
	await agent.fire("tool_execution_end", { toolCallId: "c1" });
	// idle: drawn
	const idle = (agent.ui.confirm as (t: string, m: string) => Promise<unknown>)("Idle?", "x");
	await settle();
	assert.equal(agent.dialogs.length, 2);
	agent.dialogs[1]!.settle(true);
	assert.equal(await idle, true);
});

test("the /boss command itself runs under the boss's mark: its confirm draws with a bash call in flight", async () => {
	switchOn();
	const agent = await member();
	await agent.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash" });
	const running = agent.command("gui unpair all");
	await settle();
	assert.equal(agent.dialogs.some((d) => /unpair/i.test(d.title)), true, "the unpair confirm is drawn");
	agent.dialogs.forEach((d) => d.settle(false));
	await running;
});

test("call_tower blocked and show_doc results gain their lines while on, and nothing while off", async () => {
	const agent = await member();
	const result = (toolName: string, input: Record<string, unknown>) => agent.fireResult("tool_result", { toolName, toolCallId: "x", input, content: [{ type: "text", text: "ok" }], isError: false }) as Promise<{ content: { text: string }[] } | undefined>;
	assert.equal(await result("call_tower", { why: "blocked" }), undefined);
	switchOn();
	assert.deepEqual((await result("call_tower", { why: "blocked" }))!.content.map((c) => c.text), ["ok", CALL_TOWER_LINE]);
	assert.equal(await result("call_tower", { why: "milestone" }), undefined);
	assert.deepEqual((await result("show_doc", {}))!.content.map((c) => c.text), ["ok", SHOW_DOC_LINE]);
});

test("a file that is unreadable keeps the last state; a garbage file with no earlier state is off", async () => {
	const agent = await member();
	writeFileSync(join(dir, AUTO_FILE), "{ nope");
	assert.equal(await call(agent, "robot_hand", {}), undefined);
	rmSync(join(dir, AUTO_FILE));
	switchOn();
	assert.equal((await call(agent, "robot_hand", {}))?.block, true);
	writeFileSync(join(dir, AUTO_FILE), "{ nope");
	assert.equal((await call(agent, "robot_hand", {}))?.block, true, "the last good state stays");
});

// --- the trust question ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const trust = (auto?: Parameters<typeof createAsk>[0]["auto"]) => {
	const d = {
		env: { HERDR_PANE_ID: "p" }, dir: join(dir, "trust"), stdin: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} }, proc: process, write() {}, saved: () => null, defaultTrust: () => "ask",
		up: async () => false, first: () => true, now: () => clock, sleep: async () => {}, watch: () => () => {}, startOf: () => undefined, uuid: () => "id", ...(auto ? { auto } : {}),
	};
	return createAsk(d as never);
};

test("trust: answered 'not trusted for this session' at once when the files say on and are the server's own, and listed", async () => {
	switchOn();
	const listed: string[] = [];
	const decide = trust({ on: () => autoOnForTrust(dir), note: (gist) => void listed.push(gist) });
	assert.deepEqual(await decide("/proj", { mode: "tui", hasUI: true }), { trusted: "no" });
	assert.match(listed[0]!, /not trusted for this session/);
});

test("trust: a foreign file asks as usual and is noted; off asks as usual", async () => {
	const listed: string[] = [];
	const auto = { on: () => autoOnForTrust(dir), note: (gist: string) => void listed.push(gist) };
	assert.deepEqual(await trust(auto)("/proj", { mode: "tui", hasUI: true }), { trusted: "undecided" }, "off");
	switchOn();
	writeFileSync(join(dir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev: 9, on: true, since: "2026-11-09T00:00:00Z", by: { via: "pi", name: "forged" } }))}\n`);
	assert.deepEqual(await trust(auto)("/proj", { mode: "tui", hasUI: true }), { trusted: "undecided" });
	assert.match(listed.join("\n"), /not the server's own write/);
});

// --- the Straw Link gate ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("the gate of a remote turn is denied at once under auto mode, with the neutral words", async () => {
	const { computer } = await import("./link/remote-world.ts");
	const { bob, remoteMessage } = await import("./link/remote-world.ts");
	const { FakeRelay } = await import("./link/fake-relay.ts");
	const root = mkdtempSync(join(tmpdir(), "psb-auto-gate-"));
	const c = computer(root, new FakeRelay(), "a", { ui: true, gateMs: 5000 });
	try {
		await c.tower.start();
		switchOn(c.world.stateDir);
		const pending: unknown[] = [];
		c.tower.on("straw-link:gate:pending", (d) => void pending.push(d));
		await c.tower.fire("message_start", { message: remoteMessage(bob, "bob-mac") });
		const out = (await c.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } })) as { block?: boolean; reason?: string };
		assert.deepEqual(out, { block: true, reason: NO_CONFIRM });
		assert.equal(pending.length, 0, "no gate dialog was opened");
	} finally {
		await c.world.stopAll();
		rmSync(root, { recursive: true, force: true });
	}
});
