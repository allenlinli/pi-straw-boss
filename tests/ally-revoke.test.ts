import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRoutes } from "../src/server/allyroute.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// G4 (docs/specs/2026-11-05-link-shared-box.md, Ending what a controller started): an ally run claimed at `dispatch` ends when its device leaves the team or falls below `dispatch`, and so does a main such a run opened.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26), TEAM = "team-1";

async function allyRun(level: string, over: { revokeMs?: number } = {}) {
	if (over.revokeMs) world.revokeMs = over.revokeMs;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.level.set(DEV, level);
	world.ally.add("m1", DEV, "run it");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { s, id, pi, token: String(got.token), run: (tool: string, args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token: String(got.token), tool, args }) };
}
/** The watcher has made `n` more whole ticks (it asks whether the pi lives once per run per tick). */
const ticks = async (n: number) => {
	const before = world.aliveCalls;
	await until(() => world.aliveCalls >= before + n, `${n} ticks`);
};
const command = async (s: Running, token: string) => (await ask(s, { cmd: "run-poll", token, idle: true })).command as { type: string } | undefined;

test("a run claimed at dispatch whose device falls below it is told to quit on the second tick that sees it, ends quit with the reason, and its notice names the device and team", async () => {
	const { s, id, pi, token } = await allyRun("dispatch");
	world.ally.level.set(DEV, "forward");
	await until(async () => (await command(s, token))?.type === "quit", "the quit order");
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the run to end");
	assert.equal(readRun(world.slot, "wA", id)!.detail, "the sender lost dispatch");
	const ended = world.signals.find((x) => x.kind === "ended");
	assert.ok(ended && ended.kind === "ended");
	assert.deepEqual([ended.outcome, ended.detail, ended.device, ended.team], ["quit", "the sender lost dispatch", DEV, TEAM]);
});

test("one tick that sees the device short of dispatch ends nothing: a level back at dispatch by the next tick keeps the run", async () => {
	const { s, token } = await allyRun("dispatch");
	// The tick reads the level once per run; the level is back before the second tick can read it.
	let reads = 0;
	const real = world.ally.standing.bind(world.ally);
	world.ally.standing = (device: string) => (++reads === 1 ? { level: "forward" } : real(device));
	await until(() => reads >= 2, "two reads");
	await ticks(3);
	assert.equal(await command(s, token), undefined);
});

test("a run that is still at dispatch keeps going", async () => {
	const { s, token } = await allyRun("dispatch");
	await ticks(4);
	assert.equal(await command(s, token), undefined);
});

test("a run claimed below dispatch is left alone whatever its device is at, since it was never a controller's dispatch", async () => {
	const { s, token } = await allyRun("forward");
	world.ally.level.set(DEV, "reply");
	await ticks(4);
	assert.equal(await command(s, token), undefined);
});

test("while the holder cannot tell who is in the team, a low level ends nothing; once it can, the run ends", async () => {
	const { s, token } = await allyRun("dispatch");
	world.ally.unknown.add(TEAM);
	world.ally.level.set(DEV, "reply");
	await ticks(4);
	assert.equal(await command(s, token), undefined);
	world.ally.unknown.delete(TEAM);
	await until(async () => (await command(s, token))?.type === "quit", "the quit order once the roster is known");
});

test("a sender that left the team ends its run with the reason in the notice", async () => {
	const { s, id, pi, token } = await allyRun("dispatch");
	world.ally.gone.add(DEV);
	await until(async () => (await command(s, token))?.type === "quit", "the quit order");
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the run to end");
	assert.equal(readRun(world.slot, "wA", id)!.detail, "the sender left the team");
});

test("a main the run opened at dispatch is asked to quit when its device loses dispatch; the admins' notice says it ended, and its route goes", async () => {
	const { s, id, pi, token, run } = await allyRun("dispatch", { revokeMs: 30 });
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		Object.assign(p, { agent_status: "idle" });
		world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const opened = await run("boss_open_main", { request: "Open one main and run the trial.", sender: `link:${DEV}` });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.device, r.kind, r.level]), [["opened-1", DEV, "opened", "dispatch"]], "the route keeps the level the run had");
	// Finish the run so only the main is left of what the device started.
	for (;;) {
		const ev = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!ev) break;
		await ask(s, { cmd: "run-taken", token, id: ev.id });
	}
	assert.equal((await ask(s, { cmd: "run-done", token, note: "opened a main" })).ok, true);
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome, "the run to end");
	world.ally.level.set(DEV, "reply");
	const tower = world.client("sb-tower-wa")!;
	await until(() => tower.frames.some((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main"), "the close ask");
	const frame = tower.frames.find((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main")!;
	assert.equal((frame.payload as { to: string }).to, "opened-1");
	tower.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "opened-1", payload: { version: 1, type: "close-main-result", to: "sb-tower-wa", reqId: (frame.payload as { reqId: string }).reqId, accepted: true } });
	world.sessions = [];
	await until(() => world.signals.some((x) => x.kind === "revoked"), "the notice");
	const revoked = world.signals.find((x) => x.kind === "revoked");
	assert.ok(revoked && revoked.kind === "revoked");
	assert.deepEqual([revoked.ended, revoked.device, revoked.team, revoked.main], [true, DEV, TEAM, "opened-1"]);
	assert.match(revoked.text, /was ended: the device lost dispatch\.$/);
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
});
