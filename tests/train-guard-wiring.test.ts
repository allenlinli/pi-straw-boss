import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { registerTrainGuard } from "../src/trainguard.ts";
import { World } from "./fakes.ts";
import { sb } from "./train-fixtures.ts";

// The guard as the extension wires it (docs/specs/2026-11-07-train-workers.md §7, task 4): a train opened by a tower is guarded and briefed as a train, a main is not touched, and with the merge train off nothing is registered.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const MANIFEST = "train:\n  project: acme\n  app: web\n  code: 2026-11-06-m\n";
type Blocked = { block?: boolean; reason?: string } | undefined;

async function withTrain() {
	world.herdr.onAgentStart = (pane) => void world.agent({ id: "train-1", name: "train 1106m", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } }).start();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	await tower.tool("boss_open_main", { role: "train", request: MANIFEST, sender: "integ-acme" });
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	return { tower, sender, train: world.agents.find((a) => a.pane === pane.pane_id)! };
}
const call = (agent: { fireResult(type: string, event?: Record<string, unknown>): Promise<unknown> }, toolName: string, input: Record<string, unknown>) => agent.fireResult("tool_call", { toolName, toolCallId: "c1", input }) as Promise<Blocked>;

test("a train opened by the tower is guarded: a todo without a step is blocked, a step passes, a monitor that is no step's is blocked", async () => {
	const { train } = await withTrain();
	await world.quiet();
	assert.equal(train.tokens.sb_role, "train");
	assert.match((await call(train, "todo", { action: "create", subject: "plain" }))?.reason ?? "", /^sb: every todo of a train is a step/);
	assert.equal(await call(train, "todo", { action: "create", subject: "step", metadata: { sb: sb({}, {}) } }), undefined);
	assert.match((await call(train, "MonitorCreate", { command: "npm test" }))?.reason ?? "", /^sb: a train's monitor runs one step: describe it "train 1106m #<id> <kind>"/);
	assert.equal(await call(train, "bash", { command: "ls" }), undefined, "its other tools are none of the guard's");
});

test("a main is not touched, and an integrator's train todo is checked", async () => {
	const { sender } = await withTrain();
	assert.equal(await call(sender, "todo", { action: "create", subject: "plain" }), undefined);
	assert.equal(await call(sender, "MonitorCreate", { command: "npm test", description: "tests" }), undefined);
	assert.match((await call(sender, "todo", { action: "create", subject: "train", metadata: { sb: { v: 1, kind: "merge" } } }))?.reason ?? "", /metadata\.sb\.kind must be train/);
});

test("a train's run starts with the train's own prompt, not the main's", async () => {
	const { train } = await withTrain();
	await world.quiet();
	const sections = await train.run();
	const text = Object.values(sections).join("\n");
	assert.match(text, /You are a train: a worker of the merge train/);
	assert.doesNotMatch(text, /You are a main agent|dispatch/i);
});

test("with the merge train off, nothing is registered: no handler, no guard", () => {
	const handlers: string[] = [];
	const kit = {
		pi: { on: (name: string) => void handlers.push(name), events: { on: () => () => {} } },
		cfg: { env: { STRAW_BOSS_INTEGRATION: "off" }, now: Date.now }, guiDir: "/nonexistent/state", s: { isTrain: false, train: undefined, at: undefined }, role: () => "main", me: () => "x", tell: () => {},
	};
	assert.equal(registerTrainGuard(kit as never, { trainOf: () => undefined } as never), undefined);
	assert.deepEqual(handlers, []);
	const on = { ...kit, cfg: { env: { STRAW_BOSS_INTEGRATION: "on" }, now: Date.now } };
	assert.ok(registerTrainGuard(on as never, { trainOf: () => undefined } as never));
	assert.deepEqual([...new Set(handlers)].sort(), ["tool_call", "tool_result", "turn_end"]);
});

// ---- SB4-F001: the guard is closed while the role is unsettled (§22)

const UNSETTLED = /^sb: this session's train role is not settled yet/;
/** The train's pi runs again in its pane after a /reload, with the entries the first one saved. Nothing waits for it to go quiet. */
async function reloading(train: { entries: unknown[]; stop(reason: string): Promise<void> }, options: { env?: Record<string, string> } = {}) {
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	await train.stop("reload");
	await world.quiet();
	const again = world.agent({ id: "train-1b", pane: pane.pane_id, env: options.env ?? { STRAW_BOSS_ROLE: "train" }, entries: train.entries as never, deps: { couple: false } });
	const started = again.fire("session_start", { reason: "reload" });
	return Object.assign(again, { started });
}

test("after a /reload the train's tools stay closed until its role is settled, in the window before Herdr answers", async () => {
	const { train } = await withTrain();
	await world.quiet();
	const again = await reloading(train);
	// pi's first tool call can come while the start is still in flight; Herdr has not answered.
	assert.match((await call(again, "todo", { action: "create", subject: "x", metadata: { sb: sb({}, {}) } }))?.reason ?? "", UNSETTLED, "before the answer, a step cannot be made");
	assert.match((await call(again, "todo", { action: "update", id: 1, status: "completed", metadata: { sb: sb({}, {}) } }))?.reason ?? "", UNSETTLED);
	assert.match((await call(again, "MonitorCreate", { command: "npm test" }))?.reason ?? "", UNSETTLED);
	assert.equal(await call(again, "bash", { command: "ls" }), undefined, "its other tools are none of the guard's");
	await again.started;
	await world.quiet();
	assert.match((await call(again, "todo", { action: "create", subject: "plain" }))?.reason ?? "", /^sb: every todo of a train is a step/, "settled: the guard of the train");
	assert.equal(await call(again, "todo", { action: "create", subject: "step", metadata: { sb: sb({}, {}) } }), undefined);
});

test("a Herdr that never answers leaves the window open: the tools stay closed", async () => {
	const { train } = await withTrain();
	await world.quiet();
	world.herdr.failReads = true;
	const stuck = await reloading(train);
	await world.quiet();
	assert.match((await call(stuck, "todo", { action: "create", subject: "x", metadata: { sb: sb({}, {}) } }))?.reason ?? "", UNSETTLED);
	assert.match((await call(stuck, "MonitorCreate", { command: "npm test" }))?.reason ?? "", UNSETTLED);
});

test("each local sign of a train closes the window alone: the saved entry without the env, the env without the entry", async () => {
	const { train } = await withTrain();
	await world.quiet();
	world.herdr.failReads = true;
	const entryOnly = await reloading(train, { env: {} });
	assert.match((await call(entryOnly, "todo", { action: "create", subject: "x" }))?.reason ?? "", UNSETTLED, "the entry");
	await entryOnly.stop("reload");
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	const envOnly = world.agent({ id: "train-1c", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, entries: [], deps: { couple: false } });
	await envOnly.fire("session_start", { reason: "startup" });
	assert.match((await call(envOnly, "MonitorCreate", { command: "npm test" }))?.reason ?? "", UNSETTLED, "the env");
});

test("a session with no sign of a train is untouched while Herdr does not answer: a main's todo and monitor pass", async () => {
	world.herdr.failReads = true;
	const plain = world.agent({ id: "plain-1", name: "plain", pane: "wA:p9", tab: "wA:t9" });
	await plain.fire("session_start", { reason: "startup" });
	assert.equal(await call(plain, "todo", { action: "create", subject: "plain" }), undefined);
	assert.equal(await call(plain, "MonitorCreate", { command: "npm test", description: "tests" }), undefined);
});

test("the pending word reads the saved entry, the env and the pane's role record, and a settled session is not asked", () => {
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
	const s = { isTrain: false, train: undefined, trainSettled: false, at: undefined, saved: {} };
	let record: unknown;
	const entries: unknown[] = [];
	const kit = {
		pi: { on: (name: string, fn: never) => void handlers.set(name, fn), events: { on: () => () => {} } },
		cfg: { env: {} as Record<string, string>, now: Date.now }, guiDir: "/nonexistent/state", s, role: () => undefined, me: () => "x", tell: () => {},
	};
	const roles = { trainOf: () => record };
	registerTrainGuard(kit as never, roles as never);
	const ctx = { cwd: "/", sessionManager: { getBranch: () => entries } };
	const todo = () => handlers.get("tool_call")!({ toolName: "todo", toolCallId: "c", input: { action: "create", subject: "x" } }, ctx) as { reason?: string } | undefined;
	assert.equal(todo(), undefined, "no evidence");
	record = { project: "acme", code: "2026-11-06-m" };
	assert.match(todo()?.reason ?? "", UNSETTLED, "the pane's role record");
	s.trainSettled = true;
	assert.equal(todo(), undefined, "settled as no train");
	record = undefined;
	s.trainSettled = false;
	kit.cfg.env.STRAW_BOSS_ROLE = "train";
	assert.match(todo()?.reason ?? "", UNSETTLED, "the env");
	kit.cfg.env.STRAW_BOSS_ROLE = "main";
	assert.equal(todo(), undefined);
	entries.push({ type: "custom", customType: "straw-boss", data: { openedPane: "wA:p2", train: { project: "acme", code: "2026-11-06-m" } } });
	assert.match(todo()?.reason ?? "", UNSETTLED, "the saved entry");
	entries[0] = { type: "custom", customType: "straw-boss", data: { train: { project: "../x", code: "bad" } } };
	assert.equal(todo(), undefined, "an entry that names no train proves nothing");
});

test("a pi in a train's old shell that is no train settles as none once Herdr answers: its todo and monitor pass again", async () => {
	const stray = world.agent({ id: "stray-1", name: "stray", pane: "wA:p9", tab: "wA:t9", env: { STRAW_BOSS_ROLE: "train" } });
	const started = stray.fire("session_start", { reason: "startup" });
	assert.match((await call(stray, "todo", { action: "create", subject: "x" }))?.reason ?? "", UNSETTLED, "while unsettled");
	await started;
	await world.quiet();
	assert.equal(await call(stray, "todo", { action: "create", subject: "x" }), undefined, "settled as no train");
	assert.equal(await call(stray, "MonitorCreate", { command: "npm test", description: "tests" }), undefined);
});
