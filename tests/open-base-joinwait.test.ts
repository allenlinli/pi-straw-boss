import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploys } from "../src/deploy.ts";
import { createOpenings } from "../src/openings.ts";
import { createSpawn } from "../src/spawn.ts";
import { World } from "./fakes.ts";

// `joinWaitMs` of open/base (spawn.ts): the wait for the new pi to join is 60 s unless the caller asks for 10 s to 5 min.

const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-open-base-")));
mkdirSync(join(home, "beta"));
const realHome = process.env.HOME;
process.env.HOME = home;
process.on("exit", () => ((process.env.HOME = realHome), rmSync(home, { recursive: true, force: true })));
const dir = join(home, "beta");

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const joins = (pane: { pane_id: string }) => void world.agent({ id: `opened-${pane.pane_id}`, name: "member", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "member" } }).start();
/** A server of this process: its own deploys and in-memory state, the record file of the state folder, and a clock `slept` that the join wait moves. */
function server(file: string, onSleep?: (slept: number) => void) {
	const clock = { slept: 0 };
	const sleep = async (ms: number) => void (clock.slept += ms, onSleep?.(clock.slept), await Promise.resolve());
	const spawn = createSpawn({ run: world.herdr.runFor("wA:p1"), sleep, live: async () => true, home, deploys: createDeploys(), openings: createOpenings(file) });
	return { clock, open: (body: Record<string, unknown>) => spawn(["open", "base"], { dir, label: "", ...body }) };
}
const file = () => join(mkdtempSync(join(tmpdir(), "psb-openings-")), "openings.json");
const made = () => world.herdr.commands("workspace", "create").length;

test("joinWaitMs: a value out of bounds or not a whole number is refused 400 before anything is made", async () => {
	const s = server(file());
	for (const bad of [10_000 - 1, 300_000 + 1, 0, -5, 60_000.5, "60000", null, Number.NaN]) {
		const answer = await s.open({ joinWaitMs: bad });
		assert.deepEqual([answer.status, (answer.body as { error: string }).error], [400, "bad_request"], JSON.stringify(bad));
	}
	assert.equal(made(), 0);
});

test("joinWaitMs: the default join wait stays 60 s, and a longer one is honoured", async () => {
		// Never joins: the wait ends by the clock the test moves.
	world.herdr.onAgentStart = () => {};
	const short = server(file());
	const refused = await short.open({});
	assert.deepEqual([refused.status, (refused.body as { error: string }).error], [502, "open_failed"]);
	assert.match(String((refused.body as { reason: string }).reason), /within 60 s/);
	assert.ok(short.clock.slept >= 60_000 && short.clock.slept < 70_000, `waited ${short.clock.slept} ms`);
	// A pi that joins after 90 s of the wait: the default gives up first, joinWaitMs 120 s sees it.
	let pane: { pane_id: string } | undefined, started = false;
	world.herdr.onAgentStart = (p) => void (pane = p);
	const slow = server(file(), (slept) => {
		if (slept >= 90_000 && pane && !started) (started = true, joins(pane));
	});
	const joined = await slow.open({ joinWaitMs: 120_000 });
	assert.equal(joined.status, 200, JSON.stringify(joined.body));
	assert.ok(slow.clock.slept >= 90_000 && slow.clock.slept < 100_000, `waited ${slow.clock.slept} ms`);
	const timeout = await server(file()).open({ joinWaitMs: 20_000 });
	assert.match(String((timeout.body as { reason: string }).reason), /within 20 s/);
});
