import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// A main an ally run opened carries its pane's kind into the box's `unit-status` (docs/specs/2026-11-09-agent-kinds.md §11): the tower reads the pane's tokens each time the mains are asked for
// (src/server/towers.ts `mains`), so the word follows the pane, and a pane that names none gives a main with no kind.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26);

test("the kind of an opened main is its pane's word as the tower reads it now: integrator, then train, then none", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.level.set(DEV, "dispatch");
	world.ally.add("m1", DEV, "run it");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		Object.assign(p, { agent_status: "idle" });
		world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const opened = await ask(s, { cmd: "run-tool", token: String(got.token), tool: "boss_open_main", args: { request: "Open one main and run the trial.", sender: `link:${DEV}` } });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const towers = world.expose!, pane = world.sessions.find((x) => x.id === "opened-1")!.herdrLocation!.paneId, tokens = () => world.herdr.pane(pane!).tokens;
	const kinds = async () => (await towers.mains()).map((f) => [f.row.main, f.kind]);
	assert.deepEqual(await kinds(), [["opened-1", undefined]], "a main whose pane names no duty has no kind");
	Object.assign(tokens(), { sb_duty: "integrator" });
	assert.deepEqual(await kinds(), [["opened-1", "integrator"]], "the duty on its pane");
	Object.assign(tokens(), { sb_role: "train", sb_train: "proj/mp-1" });
	assert.deepEqual(await kinds(), [["opened-1", "train"]], "a train is a train whatever else its pane says");
	delete tokens().sb_duty;
	delete tokens().sb_train;
	tokens().sb_role = "main";
	assert.deepEqual(await kinds(), [["opened-1", undefined]], "and it follows the pane back");
});
