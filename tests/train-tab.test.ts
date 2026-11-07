import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** The train's pi runs again in the same pane after a non-quit shutdown (/reload), with the entries the first one saved. */
async function reloaded(train: { entries: unknown[] }, pane: { pane_id: string }) {
	const again = world.agent({ id: "train-1b", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, entries: train.entries as never, deps: { couple: false } });
	await again.fire("session_start", { reason: "reload" });
	await world.quiet();
	return again;
}

test("a train keeps its tokens through a /reload: no later pi in its tab is crowned in the gap, the project's count stays, and the train is back as the train after", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-reload-")));
	try {
		mkdirSync(join(dir, ".straw-boss"));
		writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ integration: { maxTrains: 1 } }));
		world.herdr.workspace("wA").worktree = { checkout_path: dir };
		const { tower, pane, train } = await withTrain();
		const later = world.agent({ id: "later", pane: "wA:p60", tab: pane.tab_id });
		await later.start();
		await world.quiet();
		assert.equal(mainOf(pane.tab_id), undefined, "before the reload");
		await train.stop("reload");
		await world.quiet();
		assert.deepEqual([world.herdr.pane(pane.pane_id).tokens.sb_role, world.herdr.pane(pane.pane_id).tokens.sb_train, world.herdr.pane(pane.pane_id).tokens.sb_opened_by], ["train", "acme/2026-11-06-m", "sender-1"], "the gap leaves the train's tokens");
		assert.equal(mainOf(pane.tab_id), undefined, "the tab channel passed to the later pi, which did not crown itself");
		assert.equal(later.tokens.sb_role, "member");
		// the later pi owns the channel now, and a claim that reaches it (an older client's, forced) is dropped there as well: the owner looks at the tab, not only at itself
		const old = world.agent({ id: "old", pane: "wA:p61", tab: pane.tab_id, noIntercom: true });
		world.broker.register(old, { namespace: hex(pane.tab_id), ownerEligible: false, onReady: (channel: { publish(payload: unknown, options: unknown): void }) => channel.publish({ type: "claim", force: true }, { audience: "owner" }), onEvent: () => {} } as never);
		await world.quiet();
		assert.equal(mainOf(pane.tab_id), undefined, "the owner that is no train dropped the claim");
		await assert.rejects(tower.tool("boss_open_main", { role: "train", request: "project: acme\ncode: 2026-11-06-n", sender: "sender-1" }), /maxTrains is 1/, "the count did not drop in the gap");
		const again = await reloaded(train, pane);
		assert.equal(again.tokens.sb_role, "train");
		assert.equal(later.tokens.sb_role, "member");
		assert.equal(mainOf(pane.tab_id), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a train that quits leaves no tokens behind: the tab is free of the train once it is gone", async () => {
	const { pane, train } = await withTrain();
	await train.stop("quit");
	await world.quiet();
	assert.deepEqual([world.herdr.pane(pane.pane_id).tokens.sb_role, world.herdr.pane(pane.pane_id).tokens.sb_train, world.herdr.pane(pane.pane_id).tokens.sb_opened_by], [undefined, undefined, undefined]);
});

const trainEntries = (train: { entries: { customType: string; data: unknown }[] }) => train.entries.map((e) => ({ ...e }));

test("a /resume of the train's session file in another pane is no train: the saved entry holds only for the pane it was written in", async () => {
	const { pane, train } = await withTrain();
	await train.stop("quit");
	const elsewhere = world.agent({ id: "resumed", pane: "wA:p62", tab: "wA:t5", entries: trainEntries(train) as never, deps: { couple: false } });
	await elsewhere.fire("session_start", { reason: "resume" });
	await world.quiet();
	assert.equal(elsewhere.tokens.sb_role, "member");
	assert.equal(elsewhere.tokens.sb_train, undefined);
	assert.equal(mainOf(pane.tab_id), undefined);
});

test("`pi --session <the train's file>` in the same pane after a quit is no train: a start from scratch takes no role from the entry", async () => {
	const { pane, train } = await withTrain();
	await train.stop("quit");
	const again = world.agent({ id: "again", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, entries: trainEntries(train) as never, deps: { couple: false } });
	await again.fire("session_start", { reason: "startup" });
	await world.quiet();
	assert.equal(again.tokens.sb_role, "member");
	assert.equal(again.tokens.sb_train, undefined);
});

test("a /new in the train's own process is not the train: the next start finds out again and its pane holds no train tokens", async () => {
	const { pane, train } = await withTrain();
	await train.fire("session_shutdown", { reason: "new" });
	assert.equal(world.herdr.pane(pane.pane_id).tokens.sb_train, undefined, "a /new lets go of the tokens that name the train");
	train.entries.length = 0;
	await train.fire("session_start", { reason: "new" });
	await world.quiet();
	assert.equal(train.tokens.sb_role, "member");
	assert.equal(train.tokens.sb_train, undefined);
});
