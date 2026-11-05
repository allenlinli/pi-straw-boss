import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { stamp } from "../src/header.ts";
import { createAsks } from "../src/server/asks.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// A tower that sends to a teammate's device for a local session (docs/specs/2026-11-04-link-relay.md, Gap 1): the server, not the model, records who asked, so the device's answer reaches that main
// (the D4 ask of docs/specs/2026-10-26-sb-backend.md, Replies for a main). The requester is the one live main of the workspace that sent this run a `call_tower` expecting an answer; with none or
// with two, nothing is guessed and the tool says so, so the tower does not promise a relay that no code makes.

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const worlds: TowerWorld[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.close();
});
const DEV = "a".repeat(26);
const ask = (w: TowerWorld, r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, w.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const party = (id: string, name: string, role: "main" | "member", workspace = "Alpha") => ({ id, name, role, workspace });
const callTower = (from: ReturnType<typeof party>, text: string, reply = true) => stamp({ from, kind: "call_tower", scope: "tower", to: [{ id: "sb-tower-wa", name: "tower", role: "tower", workspace: "Alpha" }], reply, ...(reply ? { why: "unspecified" as const } : { why: "blocked" as const }) }, text);

/** A claimed local run of the workspace that has taken `texts`, each sent by the session named, and the live sessions: main-1 and main-2 (mains) and member-1 (a member) of the workspace, far-main (a main) and far-member of workspace wB (Beta). */
async function localRun(texts: { from: string; text: string }[]) {
	const world = new TowerWorld();
	worlds.push(world);
	world.setFlag(true);
	const s = await world.start();
	await s.handle.ready;
	await ask(world, s, { cmd: "ensure-tower", workspace: "wA" });
	for (const [pane, role] of [["wA:p20", "main"], ["wA:p21", "main"], ["wA:p22", "member"]] as const) world.herdr.addPane(pane, "wA:t1").tokens = { sb_role: role };
	for (const [pane, role] of [["wB:p30", "main"], ["wB:p31", "member"]] as const) world.herdr.addPane(pane, "wB:t1").tokens = { sb_role: role };
	const where = (paneId: string, id = "wA", label = "Alpha") => ({ paneId, workspace: { id, label } });
	world.sessions = [
		{ id: "main-1", name: "docs-main", herdrLocation: where("wA:p20") } as never,
		{ id: "main-2", name: "api-main", herdrLocation: where("wA:p21") } as never,
		{ id: "member-1", name: "plain", herdrLocation: where("wA:p22") } as never,
		{ id: "far-main", name: "beta-main", herdrLocation: where("wB:p30", "wB", "Beta") } as never,
		{ id: "far-member", name: "beta-member", herdrLocation: where("wB:p31", "wB", "Beta") } as never,
	];
	const parties: Record<string, ReturnType<typeof party>> = { "main-1": party("main-1", "docs-main", "main"), "main-2": party("main-2", "api-main", "main"), "member-1": party("member-1", "plain", "member"), "far-main": party("far-main", "beta-main", "main", "Beta"), "far-member": party("far-member", "beta-member", "member", "Beta") };
	texts.forEach(({ from, text }, n) => world.client("sb-tower-wa")!.incoming({ id: from, name: parties[from]!.name }, { id: `m${n}`, content: { text } } as never));
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	let got: Reply | undefined;
	await until(async () => ((got = await ask(world, s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	const token = String(got!.token);
	for (;;) {
		const event = (await ask(world, s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		assert.equal((await ask(world, s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
	world.linkAnswers.set("send", (b) => ({ ok: true, text: "Sent.", details: { team: "t1", device: DEV, id: "e".repeat(32), asked: b.awaitsReply !== undefined } }));
	return { world, s, token, send: (args: Record<string, unknown>) => ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone", message: "open a main and report", ...args } }) };
}
const NAMES: Record<string, [string, "main" | "member", string]> = { "main-1": ["docs-main", "main", "Alpha"], "main-2": ["api-main", "main", "Alpha"], "member-1": ["plain", "member", "Alpha"], "far-main": ["beta-main", "main", "Beta"], "far-member": ["beta-member", "member", "Beta"] };
const mine = (text: string, who = "main-1", reply = true) => ({ from: who, text: callTower(party(who, ...NAMES[who]!), text, reply) });

test("a send that expects a reply, in a run that took one call_tower from a live main, is an ask for that main: the id goes out, the ask is recorded, and the tool says the answer comes to it", async () => {
	const { world, send } = await localRun([mine("please have the box run trial 7")]);
	const done = await send({ reply: true });
	assert.equal(done.ok, true, JSON.stringify(done));
	const body = world.linkCalls.at(-1)!.body;
	assert.match(String(body.awaitsReply), /^[0-9a-f]{32}$/, "the ask id went to the holder");
	assert.match(String(done.text), /The answer will come to docs-main directly/);
	assert.deepEqual(createAsks(world.slot).openOf("wA").map((a) => [a.ask, a.for, a.forName, a.device, a.team]), [[body.awaitsReply, "main-1", "docs-main", DEV, "t1"]]);
});

test("an explicit for wins over the run's requester", async () => {
	const { world, send } = await localRun([mine("please have the box run trial 7")]);
	const done = await send({ reply: true, for: "api-main" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.deepEqual(createAsks(world.slot).openOf("wA").map((a) => a.for), ["main-2"]);
});

test("nothing is guessed: two mains that asked in this run, a main whose call expected no answer, a member, a send that expects no reply, and a requester that is no longer a main leave the send plain, and the tool says no session gets the answer", async () => {
	const cases: { what: string; texts: { from: string; text: string }[]; args?: Record<string, unknown>; before?: (w: TowerWorld) => void }[] = [
		{ what: "two mains", texts: [mine("a", "main-1"), mine("b", "main-2")] },
		{ what: "a call that expects no answer", texts: [mine("done", "main-1", false)] },
		{ what: "a member", texts: [mine("please", "member-1")] },
		{ what: "no reply expected", texts: [mine("please")], args: { reply: false } },
	];
	for (const c of cases) {
		const { world, send } = await localRun(c.texts);
		const done = await send({ reply: true, ...c.args });
		assert.equal(done.ok, true, `${c.what}: ${JSON.stringify(done)}`);
		assert.equal(world.linkCalls.at(-1)!.body.awaitsReply, undefined, `${c.what}: no ask id`);
		assert.deepEqual(createAsks(world.slot).openOf("wA"), [], `${c.what}: nothing recorded`);
		if (c.args?.reply !== false) assert.match(String(done.text), /No session is bound to this send[^.]*\. The answer reaches an ally run here, not you[^.]*; pass for/, c.what);
	}
});

test("the same main twice still counts once; a main that has left the workspace's panes is no requester", async () => {
	const twice = await localRun([mine("first", "main-1"), mine("second", "main-1")]);
	assert.equal((await twice.send({ reply: true })).ok, true);
	assert.deepEqual(createAsks(twice.world.slot).openOf("wA").map((a) => a.for), ["main-1"]);
	const gone = await localRun([mine("please", "main-1")]);
	gone.world.sessions = [];
	const done = await gone.send({ reply: true });
	assert.equal(done.ok, true);
	assert.equal(gone.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.deepEqual(createAsks(gone.world.slot).openOf("wA"), []);
});

// A tower relaying for a main of another workspace on this computer (docs/specs/2026-11-04-link-relay.md §6): the requester is whoever sent THIS tower the call_tower, whatever its workspace.

test("a main of another workspace that called this tower is the run's requester: the ask is recorded under this tower's workspace, for that main", async () => {
	const { world, send } = await localRun([mine("please have the box run trial 8", "far-main")]);
	const done = await send({ reply: true });
	assert.equal(done.ok, true, JSON.stringify(done));
	const body = world.linkCalls.at(-1)!.body;
	assert.match(String(body.awaitsReply), /^[0-9a-f]{32}$/, "the ask id went to the holder");
	assert.match(String(done.text), /The answer will come to beta-main directly/);
	assert.deepEqual(createAsks(world.slot).openOf("wA").map((a) => [a.ask, a.for, a.forName, a.device, a.workspace]), [[body.awaitsReply, "far-main", "beta-main", DEV, "wA"]]);
});

test("an explicit for naming the main of another workspace that called this tower binds it; one that did not call it is refused, and no ask goes out", async () => {
	const called = await localRun([mine("please have the box run trial 8", "far-main")]);
	const done = await called.send({ reply: true, for: "beta-main" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.deepEqual(createAsks(called.world.slot).openOf("wA").map((a) => a.for), ["far-main"]);
	const byId = await called.send({ reply: true, for: "far-main" });
	assert.equal(byId.ok, true, JSON.stringify(byId));

	// A main of another workspace that never called this tower, a member of it that did (no main), and a session of this workspace's run: only the first two are no target.
	const none = await localRun([mine("please", "main-1")]);
	const refused = await ask(none.world, none.s, { cmd: "run-tool", token: none.token, tool: "tower_send", args: { device: "someone", message: "m", reply: true, for: "beta-main" } });
	assert.equal(refused.ok, false);
	assert.match(String(refused.error), /beta-main is not a main of workspace Alpha, and it did not call this tower in this run/);
	assert.equal(none.world.linkCalls.length, 0, "nothing was sent");
	assert.deepEqual(createAsks(none.world.slot).openOf("wA"), []);

	const member = await localRun([mine("please", "far-member")]);
	const notMain = await member.send({ reply: true, for: "beta-member" });
	assert.equal(notMain.ok, false);
	assert.equal(member.world.linkCalls.length, 0);
	assert.deepEqual(createAsks(member.world.slot).openOf("wA"), []);
});

test("two askers in different workspaces bind nothing; a far main that left binds nothing and the tool says so", async () => {
	const two = await localRun([mine("a", "main-1"), mine("b", "far-main")]);
	const done = await two.send({ reply: true });
	assert.equal(done.ok, true);
	assert.equal(two.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.deepEqual(createAsks(two.world.slot).openOf("wA"), []);
	assert.match(String(done.text), /No session is bound to this send[^.]*\. The answer reaches an ally run here, not you[^.]*; pass for/);
	// With two, each asker can still be named.
	assert.equal((await two.send({ reply: true, for: "beta-main" })).ok, true);
	assert.deepEqual(createAsks(two.world.slot).openOf("wA").map((a) => a.for), ["far-main"]);

	const gone = await localRun([mine("please", "far-main")]);
	gone.world.sessions = gone.world.sessions.filter((x) => x.id !== "far-main");
	const left = await gone.send({ reply: true });
	assert.equal(left.ok, true);
	assert.equal(gone.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.deepEqual(createAsks(gone.world.slot).openOf("wA"), []);
});

test("a far main whose call expected no answer, or whose header does not open as a call_tower, is no requester and no target", async () => {
	const notice = await localRun([mine("done", "far-main", false)]);
	const done = await notice.send({ reply: true });
	assert.equal(done.ok, true);
	assert.equal(notice.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.equal((await notice.send({ reply: true, for: "beta-main" })).ok, false);
	// A call_tower that does not open the message, and a tower_send header that expects a reply, are no call.
	const buried = await localRun([{ from: "far-main", text: `fyi ${mine("please", "far-main").text}` }]);
	assert.equal((await buried.send({ reply: true, for: "beta-main" })).ok, false);
	assert.equal((await buried.send({ reply: true })).ok, true);
	assert.equal(buried.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	const other = stamp({ from: party("far-main", "beta-main", "main", "Beta"), kind: "tower_send", scope: "tower", to: [{ id: "sb-tower-wa", name: "tower", role: "tower", workspace: "Alpha" }], reply: true }, "please");
	const notCall = await localRun([{ from: "far-main", text: other }]);
	assert.equal((await notCall.send({ reply: true, for: "beta-main" })).ok, false);
	assert.equal((await notCall.send({ reply: true })).ok, true);
	assert.equal(notCall.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.deepEqual(createAsks(notCall.world.slot).openOf("wA"), []);
});

test("the requester is looked up by session id only: a main whose name is a departed caller's id is no requester", async () => {
	const own = await localRun([mine("please", "far-main")]);
	own.world.sessions = [...own.world.sessions.filter((x) => x.id !== "far-main" && x.id !== "main-2"), { id: "main-2", name: "far-main", herdrLocation: { paneId: "wA:p21", workspace: { id: "wA", label: "Alpha" } } } as never];
	const done = await own.send({ reply: true });
	assert.equal(done.ok, true);
	assert.equal(own.world.linkCalls.at(-1)!.body.awaitsReply, undefined);
	assert.deepEqual(createAsks(own.world.slot).openOf("wA"), []);
});
