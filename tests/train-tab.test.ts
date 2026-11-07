import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { stashBase } from "../src/stash.ts";
import { World } from "./fakes.ts";
import { trainBase } from "./train-base-fixture.ts";

// A train's tab (docs/specs/2026-11-07-train-workers.md §3.3, task 3): the train is never crowned main, boss_promote is refused in its tab, a later pi there stays a member the train does not
// command, and a stash that would take the train away is refused with the reason.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const MANIFEST = "train:\n  project: acme\n  app: web\n  code: 2026-11-06-m\n";
const hex = (id: string) => `straw-boss/tab/${Buffer.from(id).toString("hex")}`;
const mainOf = (tab: string) => (world.broker.states.get(hex(tab))?.payload as { main?: string } | undefined)?.main;

/** A tower, a sender, and one train the tower opened; the train's tab and pane. */
async function withTrain() {
	world.herdr.onAgentStart = (pane) => void world.agent({ id: "train-1", name: "train 1106m", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } }).start();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	await tower.tool("boss_open_main", { role: "train", request: MANIFEST, sender: "integ-acme" });
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	const train = world.agents.find((a) => a.pane === pane.pane_id)!;
	return { tower, sender, pane, train };
}

test("a train alone in its tab is never crowned: the tower is live and the tab has no main, and the train stays a train", async () => {
	const { pane, train } = await withTrain();
	assert.equal(pane.tokens.sb_role, "train");
	assert.equal(mainOf(pane.tab_id), undefined, "nobody is the tab's main");
	await world.quiet();
	assert.equal(train.tokens.sb_role, "train");
	assert.equal(mainOf(pane.tab_id), undefined, "the guard's check did not crown it either");
});

test("boss_promote is refused in a train's tab, by the train and by anyone else there, forced or not", async () => {
	const { pane, train } = await withTrain();
	assert.match(await train.promote(), /A train runs in this tab/);
	const other = world.agent({ id: "other", pane: "wA:p50", tab: pane.tab_id });
	await other.start();
	assert.match(await other.promote(), /A train \(train 1106m\) runs in this tab/);
	await other.command("main");
	await world.quiet();
	assert.equal(mainOf(pane.tab_id), undefined);
	assert.deepEqual([train.tokens.sb_role, other.tokens.sb_role], ["train", "member"]);
});

test("a later pi in the train's tab stays a member even with the train's role in its shell: the one-time token authorises only the pi the tower started", async () => {
	const { pane, train } = await withTrain();
	assert.equal(pane.tokens.sb_open_main, undefined);
	await train.stop("new"); // the train's pi leaves; its shell and the tab stay
	const later = world.agent({ id: "later", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, deps: { couple: false } });
	await later.start();
	assert.equal(later.tokens.sb_role, "member");
	assert.equal(later.tokens.sb_train, undefined, "it carries no train token");
});

test("a claim from a session that did not ask first (an older pi-straw-boss) is dropped by the tab's owner while a train lives there", async () => {
	const { pane } = await withTrain();
	const old = world.agent({ id: "old", pane: "wA:p61", tab: pane.tab_id, noIntercom: true }); // not started: it only stands for the old client's channel
	world.broker.register(old, { namespace: hex(pane.tab_id), ownerEligible: false, onReady: (channel: { publish(payload: unknown, options: unknown): void }) => channel.publish({ type: "claim", force: true }, { audience: "owner" }), onEvent: () => {} } as never);
	await world.quiet();
	assert.equal(mainOf(pane.tab_id), undefined);
});

test("the role in the shell alone makes no train: without the tower's one-time token, a pi in a pane that still carries a train token is a member", async () => {
	const { pane, train } = await withTrain();
	await train.stop("new");
	world.herdr.pane(pane.pane_id).tokens.sb_train = "acme/2026-11-06-m"; // left behind in the pane
	const later = world.agent({ id: "later", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, deps: { couple: false } });
	await later.start();
	assert.equal(later.tokens.sb_role, "member");
	assert.equal(later.tokens.sb_opened_by, undefined);
});

test("a pi that joins the train's tab later is a member, and the guard does not crown it as the earliest member while the train lives", async () => {
	const { pane, train } = await withTrain();
	const later = world.agent({ id: "later", pane: "wA:p60", tab: pane.tab_id });
	await later.start();
	await world.quiet();
	assert.equal(later.tokens.sb_role, "member");
	assert.equal(train.tokens.sb_role, "train");
	assert.equal(mainOf(pane.tab_id), undefined);
});

test("a train that dispatches a subagent is not promoted, and says nothing about it", async () => {
	const { pane, train } = await withTrain();
	await train.toolCall("subagent");
	assert.equal(train.tokens.sb_role, "train");
	assert.equal(mainOf(pane.tab_id), undefined);
	assert.deepEqual(train.notices.filter((n) => n.level === "warning"), []);
});

test("a train is never renamed: boss_rename is refused in the role, and the tab keeps its label", async () => {
	const { pane, train } = await withTrain();
	await assert.rejects(train.tool("boss_rename", { name: "my work" }), /A train is named by its code/);
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === pane.tab_id)?.label, "train 1106m");
});

test("a stash refuses a base with a train in it and names the reason", async () => {
	const b = trainBase(), closed: string[] = [];
	const reply = await stashBase({ run: b.run, sleep: async () => {}, sessions: async () => b.live, check: async () => ({}), stateDir: world.stateDir, now: () => 0 } as never, { workspace: "wA", name: "A" }, async (ws) => (closed.push(ws), { status: 200, body: { closed: 2 } }));
	assert.equal(reply.status, 409);
	assert.match(JSON.stringify(reply.body), /a train runs in this tab/);
	assert.deepEqual(closed, [], "nothing closed");
});
