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
const party = (id: string, name: string, role: "main" | "member") => ({ id, name, role, workspace: "Alpha" });
const callTower = (from: ReturnType<typeof party>, text: string, reply = true) => stamp({ from, kind: "call_tower", scope: "tower", to: [{ id: "sb-tower-wa", name: "tower", role: "tower", workspace: "Alpha" }], reply, ...(reply ? { why: "unspecified" as const } : { why: "blocked" as const }) }, text);

/** A claimed local run of the workspace that has taken `texts`, each sent by the session named, and the live sessions of the workspace: main-1 and main-2 (mains), member-1 (a member). */
async function localRun(texts: { from: string; text: string }[]) {
	const world = new TowerWorld();
	worlds.push(world);
	world.setFlag(true);
	const s = await world.start();
	await s.handle.ready;
	await ask(world, s, { cmd: "ensure-tower", workspace: "wA" });
	for (const [pane, role] of [["wA:p20", "main"], ["wA:p21", "main"], ["wA:p22", "member"]] as const) world.herdr.addPane(pane, "wA:t1").tokens = { sb_role: role };
	const where = (paneId: string) => ({ paneId, workspace: { id: "wA", label: "Alpha" } });
	world.sessions = [
		{ id: "main-1", name: "docs-main", herdrLocation: where("wA:p20") } as never,
		{ id: "main-2", name: "api-main", herdrLocation: where("wA:p21") } as never,
		{ id: "member-1", name: "plain", herdrLocation: where("wA:p22") } as never,
	];
	const parties: Record<string, ReturnType<typeof party>> = { "main-1": party("main-1", "docs-main", "main"), "main-2": party("main-2", "api-main", "main"), "member-1": party("member-1", "plain", "member") };
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
	return { world, s, send: (args: Record<string, unknown>) => ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone", message: "open a main and report", ...args } }) };
}
const mine = (text: string, who = "main-1", reply = true) => ({ from: who, text: callTower(party(who, who === "main-1" ? "docs-main" : who === "main-2" ? "api-main" : "plain", who === "member-1" ? "member" : "main"), text, reply) });

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
