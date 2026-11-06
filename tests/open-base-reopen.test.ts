import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploys } from "../src/deploy.ts";
import { createOpenings } from "../src/openings.ts";
import { createSpawn } from "../src/spawn.ts";
import { World } from "./fakes.ts";

// An opening id outlives a server restart (spawn.ts, openings.ts): a repeat of open/base with the same `deploy` id finds the workspace the first open made, so the desk app's retry makes no second workspace for one folder.

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

test("a repeat of an opening id after a server restart finds the workspace the first open made, and makes no second one", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = await server(record).open({ deploy: "deploy-seam-1" });
	assert.equal(first.status, 200, JSON.stringify(first.body));
	const restarted = await server(record).open({ deploy: "deploy-seam-1" }); // a new process: nothing of the first one is in memory
	assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
	assert.equal(made(), 1, "one workspace for one folder");
	const [a, b] = [first.body, restarted.body] as { workspace: string; tab: string; pane: string }[];
	assert.deepEqual([b.workspace, b.tab, b.pane], [a.workspace, a.tab, a.pane], "the second call returns the first's workspace");
	const other = await server(record).open({ deploy: "deploy-seam-2" });
	assert.equal(made(), 2, "another id is another open");
	assert.notEqual((other.body as { workspace: string }).workspace, a.workspace);
});

test("a repeat of an id whose pi is still starting waits for that pi, on the same workspace", async () => {
	const record = file(), run = world.herdr.runFor("wA:p1");
	// What the old server left: the workspace it made and its record, the pi started and not yet joined.
	const ws = JSON.parse(await run(["workspace", "create", "--cwd", dir, "--label", "beta"])).result as { workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } };
	createOpenings(record).set("deploy-seam-3", { workspace: ws.workspace.workspace_id, tab: ws.tab.tab_id, pane: ws.root_pane.pane_id });
	let joined = false;
	const restarted = server(record, (slept) => {
		if (slept >= 3000 && !joined) (joined = true, joins(ws.root_pane));
	});
	const answer = await restarted.open({ deploy: "deploy-seam-3" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual([(answer.body as { workspace: string }).workspace, (answer.body as { pane: string }).pane], [ws.workspace.workspace_id, ws.root_pane.pane_id]);
	assert.equal(made(), 1, "the repeat made nothing");
	assert.equal(world.herdr.commands("agent", "start").length, 0, "and started no second pi");
});

test("an open that fails closes its workspace and forgets the id, so a repeat opens a new one", async () => {
	world.herdr.onAgentStart = () => {}; // pi never joins
	const record = file();
	assert.equal((await server(record).open({ deploy: "deploy-seam-5" })).status, 502);
	assert.equal(world.herdr.commands("workspace", "close").length, 1);
	assert.equal(createOpenings(record).get("deploy-seam-5"), undefined);
	world.herdr.onAgentStart = joins;
	assert.equal((await server(record).open({ deploy: "deploy-seam-5" })).status, 200);
	assert.equal(made(), 2);
});

test("an id whose workspace was closed since opens a new one", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-4" })).body as { workspace: string };
	world.herdr.workspaces = world.herdr.workspaces.filter((w) => w.workspace_id !== first.workspace);
	world.herdr.panes = world.herdr.panes.filter((p) => p.workspace_id !== first.workspace);
	const again = await server(record).open({ deploy: "deploy-seam-4" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2);
	assert.notEqual((again.body as { workspace: string }).workspace, first.workspace);
});

test("without an id there is nothing to find: two opens make two workspaces", async () => {
	world.herdr.onAgentStart = joins;
	const record = file();
	await server(record).open({});
	await server(record).open({});
	assert.equal(made(), 2);
});

