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
	assert.equal(registerTrainGuard(kit as never), undefined);
	assert.deepEqual(handlers, []);
	const on = { ...kit, cfg: { env: { STRAW_BOSS_INTEGRATION: "on" }, now: Date.now } };
	assert.ok(registerTrainGuard(on as never));
	assert.deepEqual([...new Set(handlers)].sort(), ["tool_call", "tool_result", "turn_end"]);
});
