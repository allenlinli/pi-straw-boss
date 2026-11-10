import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { integMark, integratorOf } from "../src/integrator.ts";
import { opener, type OpenRequest } from "../src/opener.ts";
import { World } from "./fakes.ts";
import { sleep } from "./server-world.ts";
import { SHA_A, SHA_B, SHA_C, slip } from "./train-fixtures.ts";

// The tower opens the project's one integrator itself (todo #151, the boss's choice of 2026-11-10: the box's tower opens the integrator, and an ally sends only the car slip): `role: "integrator"` on the opener. The main it opens is
// the tower's own (marked `integ:<project>`, named `integ <project>`, so the new pi is of kind integrator from its first turn), counts toward neither the sender's one main nor the workspace's two, and is never a second one for a project.

let world = new World();
let dir = "";
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-")));
	mkdirSync(join(dir, ".straw-boss"));
	writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "docs", dir: "docs" }] }));
	world.herdr.workspace("wA").worktree = { checkout_path: dir };
});
afterEach(async () => {
	await world.stopAll();
	world = new World();
	rmSync(dir, { recursive: true, force: true });
});

/** A pi started in a tab the tower opened: it carries the name `--name` gave it, as pi's session does, and the role its tab was created with. */
const pis = () => {
	world.herdr.onAgentStart = (pane, args) => void world.agent({ id: `opened-${pane.pane_id}`, name: args[args.indexOf("--name") + 1]!, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } }).start();
};
const handed: { to: string; message: string }[] = [];
/** The opener of workspace wA's tower, over the world's Herdr and broker; `off` turns the merge train off. */
const towerOpener = (workspaceId = "wA", off = false) => {
	handed.length = 0;
	return opener({
		run: world.herdr.runFor(`${workspaceId}:p7`), sleep: (ms) => sleep(Math.min(ms, 2)), workspaceId, cwd: dir, sessions: () => world.broker.sessionList() as never,
		send: async (to, message) => (handed.push({ to, message }), { status: "sent" }), tower: () => ({ id: `tower-${workspaceId}`, name: `tower · ${workspaceId}` }), integrationOff: () => off, stateDir: world.stateDir,
	});
};
async function net() {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const senders = [];
	for (const n of [1, 2, 3]) {
		const a = world.agent({ id: `sender-${n}`, name: `coord-${n}`, pane: `wA:p${n}`, tab: "wA:t1" });
		await a.start();
		senders.push(a);
	}
	await senders[0]!.promote();
	return senders;
}
const car = (over: Record<string, string> = {}): OpenRequest => ({ role: "integrator", project: "acme", request: slip({ coordinator: "sender-1", ...over }), sender: "sender-1" });
const tabs = () => world.herdr.commands("tab", "create");
const paneOf = (id: string) => world.herdr.panes.find((p) => p.pane_id === id)!;

test("a car slip opens the project's integrator as the tower's own main: its tab and session are named integ <project>, its pane is marked integ:<project>, the new pi is of kind integrator, and its handoff names the project and the tower and carries no slip", async () => {
	pis();
	await net();
	const opened = await towerOpener()(car());
	assert.deepEqual(tabs(), [["tab", "create", "--workspace", "wA", "--label", "integ acme", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	assert.deepEqual(world.herdr.commands("agent", "start")[0]!.slice(-2), ["--name", "integ acme"]);
	const pane = paneOf(opened.pane);
	assert.equal(pane.tokens.sb_opened_by, "integ:acme", "the marker names the project, not the slip's sender");
	assert.equal(pane.tokens.sb_role, "main");
	assert.equal(pane.tokens.sb_duty, "integrator", "the name migrates the opened main to the kind before it is handed anything");
	assert.equal(pane.tokens.sb_open_main, undefined, "the one-time token was consumed");
	assert.deepEqual(opened, { tab: pane.tab_id, pane: pane.pane_id, main: `opened-${pane.pane_id}`, sender: "sender-1", integrator: "acme" });
	assert.equal(handed.length, 1);
	assert.equal(handed[0]!.to, opened.main);
	assert.match(handed[0]!.message, /you are the integrator of project acme/);
	assert.match(handed[0]!.message, /Tower: tower · wA \(session id tower-wA\)/);
	assert.doesNotMatch(handed[0]!.message, /car: web/, "the slip follows as the tower's forward, stamped by the code");
	assert.equal(integratorOf(pane.tokens.sb_opened_by), "acme");
	assert.equal(integMark("acme"), "integ:acme");
});

test("a second slip goes to the same integrator: nothing opens, whoever sends it and whatever it carries, and the same slip sent again is answered from the live net, not from a ledger", async () => {
	pis();
	await net();
	const open = towerOpener();
	const first = await open(car());
	const again = await open({ ...car({ head: SHA_B, coordinator: "sender-2" }), sender: "sender-2" });
	assert.deepEqual(again, { ...first, sender: "sender-2", repeated: true });
	assert.deepEqual(await open(car()), { ...first, repeated: true });
	assert.equal(tabs().length, 1);
	assert.equal(handed.length, 1, "the integrator is told who it is once");
	// The integrator reported idle and the tower closed it: the next slip, even the very same one, opens a new one.
	await world.herdr.runFor("wA:p7")(["tab", "close", first.tab]);
	await world.quiet();
	const next = await open(car());
	assert.equal(next.repeated, undefined);
	assert.notEqual(next.pane, first.pane);
	assert.equal(tabs().length, 2);
});

test("the integrator takes none of the two mains' places and none of its sender's: it opens beside two opened mains, one of them the sender's own, and they keep their limits", async () => {
	world.autoMains();
	await net();
	const open = towerOpener();
	await open({ request: "one", sender: "sender-1" });
	await open({ request: "two", sender: "sender-2" });
	await assert.rejects(open({ request: "three", sender: "sender-3" }), /already has 2 mains opened by its tower \(the limit is 2\)/);
	pis();
	const integ = await open(car());
	assert.equal(integ.integrator, "acme");
	assert.equal(tabs().length, 3);
	world.autoMains();
	await assert.rejects(open({ request: "three", sender: "sender-3" }), /the limit is 2/, "the integrator is not one of the two");
	await assert.rejects(open({ request: "again", sender: "sender-1" }), /already has an opened main running/, "the sender's own limit still holds");
});

test("with the integrator open, two mains still open: it uses up no place", async () => {
	pis();
	await net();
	const open = towerOpener();
	await open(car());
	world.autoMains();
	await open({ request: "one", sender: "sender-1" });
	await open({ request: "two", sender: "sender-2" });
	assert.equal(tabs().length, 3);
});

test("never two for one project: a main the boss opened as integ <project> of kind integrator takes the slip, in whatever workspace it runs", async () => {
	pis();
	await net();
	world.herdr.addTab("wB:t9", "integ", "wB:p9");
	const boss = world.agent({ id: "boss-integ", name: "integ acme", pane: "wB:p9" });
	await boss.start();
	await boss.promote();
	await boss.run(); // its first run migrates it by its name (mainduty.ts)
	await world.quiet();
	assert.equal(paneOf("wB:p9").tokens.sb_duty, "integrator");
	const got = await towerOpener()(car());
	assert.deepEqual(got, { tab: "wB:t9", pane: "wB:p9", main: "boss-integ", sender: "sender-1", integrator: "acme", repeated: true });
	assert.deepEqual(tabs(), []);
	// A main opened for a teammate's device that calls itself the project's integrator is not one: the tower's own would open beside it (here the boss's takes the slip).
	world.herdr.addTab("wA:t8", "integ", "wA:p8");
	const peers = world.agent({ id: "peer-integ", name: "integ acme", pane: "wA:p8" });
	await peers.start();
	await peers.promote();
	await peers.run();
	await world.quiet();
	paneOf("wA:p8").tokens.sb_opened_by = `link:${"a".repeat(26)}`;
	assert.equal(paneOf("wA:p8").tokens.sb_duty, "integrator");
	assert.equal((await towerOpener()(car())).main, "boss-integ");
	// Another project's integrator is no one's stand-in.
	const other = await towerOpener()({ ...car(), project: "beta" });
	assert.equal(other.repeated, undefined);
	assert.equal(paneOf(other.pane).tokens.sb_opened_by, "integ:beta");
});

test("never two for one project: a marked pane whose pi has not joined, or whose main is of another kind now, opens no second one and is told as it is; two live integrators of a project are named", async () => {
	pis();
	await net();
	const open = towerOpener();
	// A pane a tower marked a moment ago (or whose pi died): the marker counts at once.
	world.herdr.addTab("wB:t8", "integ acme", "wB:p8", "shell");
	paneOf("wB:p8").tokens.sb_opened_by = "integ:acme";
	await assert.rejects(open(car()), /The integrator of project acme \(pane wB:p8\) has not joined yet or no longer answers/);
	assert.deepEqual(tabs(), []);
	// It joined, and is a coordinator now (it called boss_duty): still the project's one, and no slip goes to it.
	const switched = world.agent({ id: "was-integ", name: "integ acme", pane: "wB:p8" });
	await switched.start();
	await switched.promote();
	await switched.run();
	await switched.tool("boss_duty", { duty: "coordinator", reason: "testing" });
	await world.quiet();
	paneOf("wB:p8").tokens.sb_opened_by = "integ:acme";
	await assert.rejects(open(car()), /The main opened as the integrator of project acme \(integ acme, session was-integ\) is of kind coordinator now/);
	assert.deepEqual(tabs(), []);
	// Two that both answer to the name: nothing is guessed.
	await switched.tool("boss_duty", { duty: "integrator", reason: "back" });
	world.herdr.addTab("wA:t9", "integ", "wA:p9");
	const twin = world.agent({ id: "twin-integ", name: "integ acme", pane: "wA:p9" });
	await twin.start();
	await twin.promote();
	await twin.run();
	await world.quiet();
	await assert.rejects(open(car()), /Project acme has 2 integrators \(session (was-integ|twin-integ), session (was-integ|twin-integ)\); a project has one/);
	assert.deepEqual(tabs(), []);
});

test("a project keeps one name: an app whose trains an integrator's ledger keeps under a project goes to that project, however the tower words it", async () => {
	pis();
	await net();
	mkdirSync(join(world.stateDir, "trains", "acme"), { recursive: true });
	writeFileSync(join(world.stateDir, "trains", "acme", "web.json"), JSON.stringify({ index: [] }));
	mkdirSync(join(world.stateDir, "trains", "other"), { recursive: true });
	writeFileSync(join(world.stateDir, "trains", "other", "api.json"), "{}"); // another app's ledger says nothing of web
	const open = towerOpener();
	await assert.rejects(open({ ...car(), project: "acme-web" }), /The trains of app web are kept under project acme \(trains\/acme\/web\.json in the state folder\), so its cars go to integ acme: name that project, not acme-web\./);
	await assert.rejects(open({ ...car(), project: "other" }), /name that project, not other/);
	assert.deepEqual(tabs(), []);
	assert.equal((await open(car())).integrator, "acme");
});

test("a tower opens at most two integrators in its workspace: a third project waits, and a closed one frees its place", async () => {
	pis();
	await net();
	const open = towerOpener();
	const first = await open(car());
	await open({ ...car(), project: "beta" });
	await assert.rejects(open({ ...car(), project: "gamma" }), /Workspace Alpha already has 2 integrators opened by its tower \(acme, beta; the limit is 2\)/);
	assert.equal(tabs().length, 2);
	await world.herdr.runFor("wA:p7")(["tab", "close", first.tab]);
	await world.quiet();
	await open({ ...car(), project: "gamma" });
	assert.equal(tabs().length, 3);
});

test("an integrator is opened on a car slip of an app that takes the train, and on nothing else: each refusal names what is missing and opens nothing", async () => {
	pis();
	await net();
	const open = towerOpener();
	await assert.rejects(open({ ...car(), request: "please open an integrator for acme" }), /An integrator is opened on a car slip/);
	await assert.rejects(open({ ...car(), project: undefined }), /names its project/);
	await assert.rejects(open({ ...car(), project: "../up" }), /not a path-safe name/);
	await assert.rejects(open(car({ car: "docs" })), /app docs has no integration/);
	await assert.rejects(open(car({ car: "ghost" })), /has no app named ghost/);
	await assert.rejects(open({ ...car(), sender: "nobody" }), /No live session is named or has the id "nobody"/);
	await assert.rejects(open({ ...car(), peer: { id: "link:d1", label: "Ann's laptop", short: "ab12" } }), /not for a teammate's device/);
	await assert.rejects(towerOpener("wA", true)(car()), /integration is off on this computer/);
	await assert.rejects(open({ ...car(), role: "main" }), /role must be "train" or "integrator"/);
	rmSync(join(dir, ".straw-boss", "apps.json"));
	await assert.rejects(open(car()), /apps\.json.* is not there/);
	assert.deepEqual(tabs(), []);
	assert.deepEqual(handed, []);
});

test("a refused or failed integrator open is not kept: the same slip opens one once what refused it is gone", async () => {
	await net();
	const open = towerOpener();
	world.herdr.onAgentStart = () => {}; // pi never joins
	await assert.rejects(open(car()), /did not become the integrator of project acme/);
	assert.equal(world.herdr.closed.length, 1, "the tab of the failed open was closed");
	pis();
	const opened = await open(car());
	assert.equal(opened.repeated, undefined);
	assert.equal(opened.integrator, "acme");
});

test("a new pi that joins as a main of another kind is not handed the project: the open fails, its tab is closed, and nothing is left marked", async () => {
	await net();
	// Its own read of the switch says the merge train is off, so its name does not make it an integrator (mainduty.ts).
	world.herdr.onAgentStart = (pane, args) => void world.agent({ id: `opened-${pane.pane_id}`, name: args[args.indexOf("--name") + 1]!, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main", STRAW_BOSS_INTEGRATION: "off" } }).start();
	await assert.rejects(towerOpener()(car()), /did not become the integrator of project acme \(a main of kind integrator\)/);
	assert.equal(world.herdr.closed.length, 1);
	assert.deepEqual(handed, []);
	assert.equal(world.herdr.panes.some((p) => p.tokens.sb_opened_by === "integ:acme"), false);
});

test("a resident tower session opens no integrator: the door is a run's, where the server holds the messages a slip came in", async () => {
	world.autoMains();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "coord-1", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await assert.rejects(tower.tool("boss_open_main", { ...car(), sender: "sender-1" }), /role integrator works in a tower run of the sb server/);
	assert.deepEqual(tabs(), []);
});

test("the marker is the opener's own: a session whose id reads as one gets no main opened in its name, and a main that carries the marker is not counted for a sender", async () => {
	world.autoMains();
	await net();
	const forged = world.agent({ id: "integ:acme", name: "odd", pane: "wA:p4", tab: "wA:t1" });
	await forged.start();
	const open = towerOpener();
	await assert.rejects(open({ request: "work", sender: "integ:acme" }), /reads as an integrator's marker/);
	assert.deepEqual(tabs(), []);
	assert.equal(integratorOf("integ:"), undefined);
	assert.equal(integratorOf("integ:../up"), undefined);
	assert.equal(integratorOf("link:abc"), undefined);
	assert.equal(integratorOf(undefined), undefined);
	assert.equal(SHA_C.length, 40);
});
