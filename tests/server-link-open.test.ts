import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Level } from "../src/link/config.ts";
import { LinkStore } from "../src/link/store.ts";
import { openTowerFor, towerOpener } from "../src/server/opentower.ts";
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
		await until(async () => (await notices()).some((n) => /is not delivered yet; it waits for the tower of/.test(n.text)), "the inbox notice");
		assert.equal(world.herdr.workspaces.length, base);
		assert.equal(u.log().some((e) => /^tower-open/.test(String(e.event))), false);
	});
}

/** The device is alice's and attended (config.json names the team and the project, no policy file); bob is at `level` (none: `reply`). A workspace `labelled` of the project is open, with a shell and no tower. */
function attended(o: { level?: Level; workspace?: boolean } = {}) {
	const home = join(world.root, "home"), project = join(home, "project");
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link")), entries = rosterOf();
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true }, link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: real, share: "status" } }, ...(o.level ? { trust: { [bob.id]: o.level } } : {}) } }));
	if (o.workspace) {
		world.herdr.workspaces.push({ workspace_id: "wMine", label: "MP Center", tokens: {} });
		world.herdr.addTab("wMine:t1", "work");
		world.herdr.addPane("wMine:p1", "wMine:t1");
		Object.assign(world.herdr.pane("wMine:p1"), { cwd: real });
	}
	const message = async (toWorkspace = "") => {
		const now = Date.now();
		await store.withLock(() => store.putInbox({ v: 1, id: "aa".repeat(16), team: TEAM_HEX, from: bob.id, fromLabel: "bob-mac", fromShort: "bob", seq: 1, sentAt: now, received: now, fromWorkspace: "theirs", toWorkspace, replyExpected: true, text: "wake up" }));
	};
	const log = () => (existsSync(join(world.stateDir, "link", "link.log")) ? readFileSync(join(world.stateDir, "link", "link.log"), "utf8") : "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
	const link = { tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home, policy: { read: () => "{}", stat: () => ({ uid: 0, symlink: false }), writable: () => false, uid: 1000 } };
	return { real, message, log, link };
}
const wakeLines = (u: { log(): Record<string, unknown>[] }) => u.log().filter((e) => /^tower-wake|^tower-woke/.test(String(e.event))).map((e) => e.event);

test("an attended device wakes the tower of a workspace it already has for a teammate at reply: no workspace is made, the tower service takes it, and the message is the server's tower's (todo #122)", async () => {
	const u = attended({ workspace: true });
	const s = await world.start({ link: u.link });
	await s.handle.ready;
	await u.message();
	await until(() => world.expose?.status().some((r) => r.workspace === "wMine"), "the tower service for the workspace that was there");
	await until(() => u.log().some((e) => e.event === "tower-woke"), "the wake to end");
	assert.deepEqual(wakeLines(u), ["tower-wake", "tower-woke"]);
	assert.equal(world.herdr.workspaces.length, base + 1, "no workspace made");
	assert.ok(!u.log().some((e) => /^tower-open/.test(String(e.event))), "an attended device opens nothing");
	assert.equal(world.herdr.panes.filter((p) => p.workspace_id === "wMine" && p.tokens?.sb_role === "tower").length, 1);
});

test("an attended device with no workspace inside the project makes none: the wake says so, and the message waits with the notice that tells the boss what to do (todo #122)", async () => {
	const u = attended({ level: "dispatch" });
	const s = await world.start({ link: u.link });
	await s.handle.ready;
	await u.message();
	await until(() => u.log().some((e) => e.event === "tower-wake-none"), "the outcome");
	assert.deepEqual(wakeLines(u), ["tower-wake", "tower-wake-none"]);
	assert.equal(world.herdr.workspaces.length, base, "no workspace made, whatever the level");
	const record = world.record()!;
	const notices = async () => ((await callControl(record.socket, record.secret, { cmd: "status" })).reply as unknown as { link: { notices: { text: string }[] } }).link.notices;
	await until(async () => (await notices()).some((n) => /no workspace is open for it on this computer \(open the project's workspace/.test(n.text)), "the notice");
});

test("a workspace the sender named that is not open gets no workspace either (todo #122)", async () => {
	const u = attended({ workspace: true });
	const s = await world.start({ link: u.link });
	await s.handle.ready;
	await u.message("not a workspace of mine");
	const record = world.record()!;
	const notices = async () => ((await callControl(record.socket, record.secret, { cmd: "status" })).reply as unknown as { link: { notices: { text: string }[] } }).link.notices;
	await until(async () => (await notices()).some((n) => /no workspace is open for it on this computer/.test(n.text)), "the notice: a name that is no workspace here is answered without a wake (IWR-F002)");
	assert.deepEqual(wakeLines(u), [], "no Herdr call and no log line for it");
	assert.equal(world.herdr.workspaces.length, base + 1);
	assert.ok(!world.expose?.status().some((r) => r.workspace === "wMine"), "the other workspace is not woken for a name it does not have");
});

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
	assert.equal(made!.created, true);
	assert.equal(world.herdr.panes.find((p) => p.workspace_id === made!.workspace)?.cwd, realpathSync(project));
});

test("with `existing`, no workspace is made for a project or a name that has none open: the answer is null", async () => {
	const s = await world.start();
	await s.handle.ready;
	const project = join(world.root, "home", "project");
	mkdirSync(project, { recursive: true });
	assert.equal(await openTowerFor(deps(), project, undefined, true), null);
	assert.equal(await openTowerFor(deps(), project, "chosen by the sender", true), null);
	assert.equal(world.herdr.workspaces.length, base);
	world.herdr.workspaces.push({ workspace_id: "wQ", label: "mine", tokens: {} });
	world.herdr.addTab("wQ:t1", "work");
	world.herdr.addPane("wQ:p1", "wQ:t1");
	Object.assign(world.herdr.pane("wQ:p1"), { cwd: realpathSync(project) });
	assert.deepEqual(await openTowerFor(deps(), realpathSync(project), undefined, true), { workspace: "wQ", created: false });
	await assert.rejects(openTowerFor(deps(), join(world.root, "home", "missing"), undefined, true), /does not exist/);
});

test("a sub workspace with a pane in the project is not woken, and neither is its parent, which `ensure` would give the tower to (IWR-F006, M06)", async () => {
	const s = await world.start();
	await s.handle.ready;
	const project = join(world.root, "home", "project");
	mkdirSync(project, { recursive: true });
	world.herdr.workspaces.push({ workspace_id: "wParent", label: "parent", tokens: {}, worktree: { checkout_path: "/r/parent", is_linked_worktree: false, repo_key: "/r/shared" } });
	world.herdr.addTab("wParent:t1", "work");
	world.herdr.addPane("wParent:p1", "wParent:t1");
	Object.assign(world.herdr.pane("wParent:p1"), { cwd: join(world.root, "elsewhere") });
	world.herdr.workspaces.push({ workspace_id: "wSub", label: "feature", tokens: {}, worktree: { checkout_path: realpathSync(project), is_linked_worktree: true, repo_key: "/r/shared" } });
	world.herdr.addTab("wSub:t1", "work");
	world.herdr.addPane("wSub:p1", "wSub:t1");
	Object.assign(world.herdr.pane("wSub:p1"), { cwd: realpathSync(project) });
	assert.equal(await openTowerFor(deps(), realpathSync(project), undefined, true), null);
	assert.equal(await openTowerFor(deps(), realpathSync(project), "wSub", true), null);
	assert.ok(!world.expose!.status().some((r) => r.workspace === "wParent" || r.workspace === "wSub"), "no tower for either");
});

test("a failed open is told to the controller whose message found no tower, a failed wake is told to nobody; the error reaches the holder with the code its notice maps (IWR-F006, M14; IWR-F007)", async () => {
	const told: string[][] = [];
	const opener = towerOpener({ run: world.herdr.runFor("none"), towers: () => undefined, now: () => Date.now(), home: join(world.root, "home"), agentDir: join(world.root, "home", ".pi", "agent"), failed: (from, project, error) => void told.push([from, project, error.message]) });
	await assert.rejects(opener("/p", undefined, "bob", "wake"), (e: Error & { code?: string }) => e.code === "service");
	assert.deepEqual(told, [], "the boss hears of a failed wake in the notice of the waiting message");
	await assert.rejects(opener("/p", undefined, "bob", "open"), (e: Error & { code?: string }) => e.code === "service");
	assert.deepEqual(told, [["bob", "/p", "the tower service is not running yet"]]);
	const s = await world.start();
	await s.handle.ready;
	await assert.rejects(openTowerFor(deps(), join(world.root, "home", "missing")), (e: Error & { code?: string }) => e.code === "project");
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
