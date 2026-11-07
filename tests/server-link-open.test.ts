import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Level } from "../src/link/config.ts";
import { LinkStore } from "../src/link/store.ts";
import { openTowerFor } from "../src/server/opentower.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { callControl } from "../src/server/socket.ts";
import { until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// Opening a tower for a controller of an unattended device (docs/specs/2026-10-26-sb-backend.md, Unattended devices): the real link holder of the server, with a policy file in a fake file system and a fake Herdr.

let world: TowerWorld, relay: FakeRelay, base: number;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	relay = new FakeRelay();
	base = world.herdr.workspaces.length; // the fake Herdr starts with workspaces of its own
});
afterEach(() => world.close());

/** The device is alice's; the policy file says it is unattended, bob is at `level`, and the team's project is a folder under the home. */
function unattended(level: Level | undefined) {
	const home = join(world.root, "home"), project = join(home, "project");
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link")), entries = rosterOf();
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	const text = JSON.stringify({ unattended: true, ...(level ? { trust: { [bob.id]: level } } : {}), teams: { [TEAM_HEX]: { project: real } } });
	const link = { tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home, policy: { read: () => text, stat: () => ({ uid: 0, symlink: false }), writable: () => false, uid: 1000 } };
	const message = async () => {
		const now = Date.now();
		await store.withLock(() => store.putInbox({ v: 1, id: "aa".repeat(16), team: TEAM_HEX, from: bob.id, fromLabel: "bob-mac", fromShort: "bob", seq: 1, sentAt: now, received: now, fromWorkspace: "theirs", toWorkspace: "", replyExpected: true, text: "build it" }));
	};
	const log = () => readFileSync(join(world.stateDir, "link", "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	return { real, message, log, link };
}

test("a dispatch sender's message on an unattended device gets a workspace at the project root, a tower for it, and the message waits for the server's tower", async () => {
	const u = unattended("dispatch");
	const s = await world.start({ link: u.link });
	await s.handle.ready;
	await u.message();
	await until(() => world.herdr.workspaces.length === base + 1, "the workspace");
	const made = world.herdr.workspaces.at(-1)!;
	assert.equal(world.herdr.panes.find((p) => p.workspace_id === made.workspace_id)?.cwd, u.real);
	assert.equal(made.label, "project");
	await until(() => world.expose?.status().some((r) => r.workspace === made.workspace_id), "the tower service");
	await until(() => u.log().some((e) => e.event === "tower-opened"), "the open to end");
	assert.deepEqual(u.log().filter((e) => /^tower-open/.test(String(e.event))).map((e) => [e.event, e.project]), [["tower-open", u.real], ["tower-opened", u.real]]);
	assert.equal(world.herdr.panes.filter((p) => p.workspace_id === made.workspace_id && p.tokens?.sb_role === "tower").length, 1, "one tower pane");
});

for (const level of ["reply", "forward", undefined] as const) {
	test(`a sender at ${String(level)} gets no workspace: the message waits in the inbox with a notice`, async () => {
		const u = unattended(level);
		const s = await world.start({ link: u.link });
		await s.handle.ready;
		await u.message();
		const record = () => world.record()!;
		const notices = async () => ((await callControl(record().socket, record().secret, { cmd: "status" })).reply as unknown as { link: { notices: { text: string }[] } }).link.notices;
		await until(async () => (await notices()).some((n) => /waits in the inbox/.test(n.text)), "the inbox notice");
		assert.equal(world.herdr.workspaces.length, base);
		assert.equal(u.log().some((e) => /^tower-open/.test(String(e.event))), false);
	});
}

// openTowerFor itself, against the fake Herdr.
const deps = () => ({ home: join(world.root, "home"), agentDir: join(world.root, "home", ".pi", "agent"), run: world.herdr.runFor("none"), ensure: (r: Parameters<NonNullable<typeof world.expose>["ensure"]>[0]) => world.expose!.ensure(r), now: () => Date.now() });

test("a workspace of the project that has no tower is the one opened; none is made", async () => {
	const s = await world.start();
	await s.handle.ready;
	const project = join(world.root, "home", "project", "sub");
	mkdirSync(project, { recursive: true });
	const root = realpathSync(join(world.root, "home", "project"));
	world.herdr.workspaces.push({ workspace_id: "wX", label: "mine", tokens: {} });
	world.herdr.addTab("wX:t1", "work");
	world.herdr.addPane("wX:p1", "wX:t1");
	Object.assign(world.herdr.pane("wX:p1"), { cwd: realpathSync(project) });
	const made = await openTowerFor(deps(), root);
	assert.deepEqual(made, { workspace: "wX", created: false });
	assert.equal(world.herdr.workspaces.length, base + 1);
	assert.ok(world.expose!.status().some((r) => r.workspace === "wX"));
});

test("a workspace named by its Herdr id (a reply to an ask a tower made for a main) is the one opened, as one named by its label (todo #119)", async () => {
	const s = await world.start();
	await s.handle.ready;
	const project = join(world.root, "home", "project");
	mkdirSync(project, { recursive: true });
	world.herdr.workspaces.push({ workspace_id: "wZ", label: "MP Center", tokens: {} });
	world.herdr.addTab("wZ:t1", "work");
	world.herdr.addPane("wZ:p1", "wZ:t1");
	Object.assign(world.herdr.pane("wZ:p1"), { cwd: realpathSync(project) });
	assert.deepEqual(await openTowerFor(deps(), realpathSync(project), "wZ"), { workspace: "wZ", created: false });
	assert.equal(world.herdr.workspaces.length, base + 1, "none made");
});

test("a folder that does not exist, or a named workspace with none inside the project, is refused and nothing is made; a workspace outside the project does not count", async () => {
	const s = await world.start();
	await s.handle.ready;
	await assert.rejects(openTowerFor(deps(), join(world.root, "home", "missing")), /does not exist/);
	const project = join(world.root, "home", "project");
	mkdirSync(project, { recursive: true });
	await assert.rejects(openTowerFor(deps(), project, "chosen by the sender"), /makes none for a name the sender chose/);
	assert.equal(world.herdr.workspaces.length, base);
	// A workspace whose pane is outside the project is no workspace of it.
	world.herdr.workspaces.push({ workspace_id: "wY", label: "else", tokens: {} });
	world.herdr.addTab("wY:t1", "work");
	world.herdr.addPane("wY:p1", "wY:t1");
	Object.assign(world.herdr.pane("wY:p1"), { cwd: join(world.root, "elsewhere") });
	const made = await openTowerFor(deps(), project);
	assert.equal(made.created, true);
	assert.equal(world.herdr.panes.find((p) => p.workspace_id === made.workspace)?.cwd, realpathSync(project));
});

test("a project that now leads to the home folder, to ~/.pi, or to the agent folder gets no workspace, however it is spelled", async () => {
	const s = await world.start();
	await s.handle.ready;
	const home = join(world.root, "home"), pi = join(home, ".pi"), agent = join(pi, "agent");
	mkdirSync(agent, { recursive: true });
	symlinkSync(home, join(world.root, "to-home"));
	symlinkSync(agent, join(home, "to-agent"));
	for (const [project, why] of [[home, /home folder/], [join(world.root, "to-home"), /home folder/], [pi, /contain or be inside|~\/\.pi|inside/], [join(home, "to-agent"), /~\/\.pi|agent folder/]] as const) {
		await assert.rejects(openTowerFor(deps(), project), why, project);
	}
	assert.equal(world.herdr.workspaces.length, base, "nothing was made");
});

test("a project that is pointed at another folder while the workspaces are read gets no workspace", async () => {
	const s = await world.start();
	await s.handle.ready;
	const home = join(world.root, "home"), one = join(home, "one"), two = join(home, "two"), link = join(home, "link");
	mkdirSync(one, { recursive: true });
	mkdirSync(two, { recursive: true });
	symlinkSync(one, link);
	const run = world.herdr.runFor("none");
	let swapped = false;
	const swapping = async (args: string[]) => {
		if (!swapped && args[0] === "pane" && args[1] === "list") {
			swapped = true;
			rmSync(link);
			symlinkSync(two, link);
		}
		return run(args);
	};
	await assert.rejects(openTowerFor({ ...deps(), run: swapping }, link), /moved while its tower was being opened/);
	assert.equal(swapped, true);
	assert.equal(world.herdr.workspaces.length, base, "nothing was made");
});
