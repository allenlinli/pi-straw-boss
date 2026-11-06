import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createDeploys } from "../src/deploy.ts";
import { createOpenings, type Opening, type Openings } from "../src/openings.ts";
import { createSpawn, type SpawnDeps } from "../src/spawn.ts";
import { World } from "./fakes.ts";

// An opening id outlives a server restart (spawn.ts, openings.ts): a repeat of open/base with the same `deploy` id finds the workspace the first open made, so the desk app's retry makes no second workspace for one folder.

const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-open-base-")));
mkdirSync(join(home, "beta"));
mkdirSync(join(home, "other"));
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
function server(file: string, onSleep?: (slept: number) => void, extra: Partial<SpawnDeps> = {}, openings: Openings = createOpenings(file)) {
	const clock = { slept: 0 }, deploys = createDeploys(), notes: string[] = [];
	const sleep = async (ms: number) => void (clock.slept += ms, onSleep?.(clock.slept), await Promise.resolve());
	const spawn = createSpawn({ run: world.herdr.runFor("wA:p1"), sleep, live: async () => true, home, deploys, openings, note: (event, facts) => void notes.push(`${event} ${JSON.stringify(facts)}`), ...extra });
	return { clock, deploys, notes, open: (body: Record<string, unknown>) => spawn(["open", "base"], { dir, label: "", ...body }) };
}
const file = () => join(mkdtempSync(join(tmpdir(), "psb-openings-")), "openings.json");
const made = () => world.herdr.commands("workspace", "create").length;
type Made = { workspace: { workspace_id: string }; tab: { tab_id: string }; root_pane: { pane_id: string } };
/** What an old server left: a workspace in `where` and its record in `delivery`, its pi not started (the caller makes it join). */
async function left(record: string, id: string, delivery: Opening["delivery"], where = dir) {
	const ws = JSON.parse(await world.herdr.runFor("wA:p1")(["workspace", "create", "--cwd", where, "--label", "beta"])).result as Made;
	createOpenings(record).set(id, { workspace: ws.workspace.workspace_id, tab: ws.tab.tab_id, pane: ws.root_pane.pane_id, dir, label: "beta", delivery });
	return ws;
}
const prompts = () => {
	const sent: string[] = [];
	return { sent, call: (async (_name: string, args: { text: string }) => void sent.push(args.text)) as unknown as SpawnDeps["call"] };
};
const body = (r: { body: unknown }) => r.body as Record<string, unknown>;

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
	const record = file(), ws = await left(record, "deploy-seam-3", "none");
	let joined = false, answered = false, joinedBeforeReply = false;
	const restarted = server(record, (slept) => {
		if (slept >= 3000 && !joined) (joined = true, joins(ws.root_pane));
	});
	const answer = await restarted.open({ deploy: "deploy-seam-3" }).then((r) => ((answered = true), r));
	joinedBeforeReply = joined && answered;
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.ok(restarted.clock.slept >= 3000, `the repeat waited (${restarted.clock.slept} ms)`);
	assert.ok(joinedBeforeReply, "the reply came after the pi joined");
	assert.deepEqual([body(answer).workspace, body(answer).pane], [ws.workspace.workspace_id, ws.root_pane.pane_id]);
	assert.equal(made(), 1, "the repeat made nothing");
	assert.equal(world.herdr.commands("agent", "start").length, 0, "and started no second pi");
});

test("a repeat's own trust question is shown in its opening: the pane is the opening's while it waits", async () => {
	const record = file(), ws = await left(record, "deploy-seam-9a", "none");
	let at: string | undefined, joined = false;
	const s = server(record, (slept) => {
		at ??= s.deploys.openingOf(ws.root_pane.pane_id);
		if (slept >= 1000 && !joined) (joined = true, joins(ws.root_pane));
	});
	assert.equal((await s.open({ deploy: "deploy-seam-9a" })).status, 200);
	assert.equal(at, "deploy-seam-9a");
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

// F001: a reply that is not a throw leaves the workspace with its pi joined, so the id keeps pointing at it.
test("a first message that did not arrive keeps the workspace and its id: a repeat makes no second base and does not type again", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), call = (async () => { throw new Error("socket gone"); }) as unknown as SpawnDeps["call"];
	const first = await server(record, undefined, { call }).open({ deploy: "deploy-seam-f1", prompt: "hello" });
	assert.deepEqual([first.status, body(first).error, body(first).step], [502, "prompt_failed", "deliver"]);
	assert.equal(world.herdr.commands("workspace", "close").length, 0, "the workspace stays");
	assert.equal(createOpenings(record).get("deploy-seam-f1")?.delivery, "sending", "the record says it may have been typed");
	const typed = prompts(), again = server(record, undefined, { call: typed.call });
	const repeat = await again.open({ deploy: "deploy-seam-f1", prompt: "hello" });
	assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
	assert.equal(body(repeat).delivery, "unknown");
	assert.equal(made(), 1, "one workspace");
	assert.deepEqual(typed.sent, [], "not typed again");
});

// F002: Herdr reuses the ids of closed workspaces.
test("a record is not taken for a workspace of the same id in another folder, and the stale record goes", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f2" })).body as { workspace: string; pane: string };
	world.herdr.workspaces = world.herdr.workspaces.filter((w) => w.workspace_id !== first.workspace);
	world.herdr.panes = world.herdr.panes.filter((p) => p.workspace_id !== first.workspace);
	const other = JSON.parse(await world.herdr.runFor("wA:p1")(["workspace", "create", "--cwd", join(home, "other"), "--label", "other"])).result as Made;
	world.herdr.workspaces.find((w) => w.workspace_id === other.workspace.workspace_id)!.workspace_id = first.workspace; // Herdr hands the id out again
	for (const p of world.herdr.panes) if (p.workspace_id === other.workspace.workspace_id) (p.workspace_id = first.workspace, (p.pane_id = first.pane)); // and the pane's id too
	joins({ pane_id: first.pane });
	const again = await server(record).open({ deploy: "deploy-seam-f2" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.notEqual(world.herdr.panes.find((p) => p.pane_id === body(again).pane)?.cwd, join(home, "other"), "not the other folder's pane");
	assert.equal(made(), 3, "beta got a base of its own");
	assert.equal(world.herdr.panes.find((p) => p.pane_id === body(again).pane)?.cwd, dir);
});

test("an id used again for another folder opens a new base there", async () => {
	world.herdr.onAgentStart = joins;
	const record = file();
	await server(record).open({ deploy: "deploy-seam-f2b" });
	const again = await createSpawn({ run: world.herdr.runFor("wA:p1"), sleep: async () => {}, live: async () => true, home, openings: createOpenings(record) })(["open", "base"], { dir: join(home, "other"), label: "", deploy: "deploy-seam-f2b" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2);
	assert.equal(createOpenings(record).get("deploy-seam-f2b")?.dir, join(home, "other"));
});

test("a record whose pane is gone, with the workspace still there, is stale: no fallback to another pane", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f2c" })).body as { pane: string };
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== first.pane);
	const again = await server(record).open({ deploy: "deploy-seam-f2c" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2);
	assert.notEqual(body(again).pane, first.pane);
});

// OBS2-F004: the workspace still holds another pane in the same folder; it is not the open's pane, so it is not taken for it.
test("a record whose pane is gone is not answered with another pane of the workspace in the same folder", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f2f" })).body as { workspace: string; pane: string };
	const shell = (JSON.parse(await world.herdr.runFor("wA:p1")(["pane", "split", first.pane, "--direction", "right", "--cwd", dir])).result as { pane: { pane_id: string } }).pane.pane_id;
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== first.pane);
	const again = await server(record).open({ deploy: "deploy-seam-f2f" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2, "a base of its own");
	assert.notEqual(body(again).pane, shell, "not the shell beside the pane that went");
	assert.notEqual(body(again).workspace, first.workspace);
});

// OBS2-F003, as the sb owner decided it: a pane that reports no folder (Pane.cwd is optional; a Windows Herdr may not know it yet) counts only when the workspace id, the pane id and the
// workspace's recorded label all still match; anything weaker is a new open, since a wrong workspace is worse than a duplicate.
test("a recorded pane that reports no folder is still the open's when its workspace, pane and label match: the repeat makes no second workspace", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f3n" })).body as { workspace: string; pane: string };
	delete world.herdr.panes.find((p) => p.pane_id === first.pane)!.cwd;
	const again = await server(record).open({ deploy: "deploy-seam-f3n" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 1);
	assert.deepEqual([body(again).workspace, body(again).pane], [first.workspace, first.pane]);
	assert.equal(createOpenings(record).get("deploy-seam-f3n")?.label, "beta", "the label is recorded");
});

test("a pane that reports no folder is not the open's when the workspace's label is another one: a new open, and the record is replaced", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f3p" })).body as { workspace: string; pane: string };
	delete world.herdr.panes.find((p) => p.pane_id === first.pane)!.cwd;
	world.herdr.workspaces.find((w) => w.workspace_id === first.workspace)!.label = "someone else's";
	const again = await server(record).open({ deploy: "deploy-seam-f3p" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2, "a duplicate rather than a workspace that may be another's");
	assert.notEqual(body(again).workspace, first.workspace);
	assert.equal(createOpenings(record).get("deploy-seam-f3p")?.workspace, body(again).workspace);
});

test("a pane that reports no folder is not the open's when the recorded pane is another than the one in the workspace", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f3q" })).body as { workspace: string; pane: string };
	const pane = world.herdr.panes.find((p) => p.pane_id === first.pane)!;
	delete pane.cwd;
	pane.pane_id = `${first.workspace}:p999`; // the workspace id stands, the pane's does not
	const again = await server(record).open({ deploy: "deploy-seam-f3q" });
	assert.equal(again.status, 200, JSON.stringify(again.body));
	assert.equal(made(), 2);
	assert.notEqual(body(again).workspace, first.workspace);
});

test("a pane that reports no folder does not keep a record whose workspace is gone", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f3o" })).body as { workspace: string; pane: string };
	delete world.herdr.panes.find((p) => p.pane_id === first.pane)!.cwd;
	world.herdr.workspaces = world.herdr.workspaces.filter((w) => w.workspace_id !== first.workspace);
	assert.equal((await server(record).open({ deploy: "deploy-seam-f3o" })).status, 200);
	assert.equal(made(), 2, "the workspace is gone: a new open");
});

test("opening a base forgets the records whose workspace is gone", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = (await server(record).open({ deploy: "deploy-seam-f2d" })).body as { workspace: string };
	world.herdr.workspaces = world.herdr.workspaces.filter((w) => w.workspace_id !== first.workspace);
	world.herdr.panes = world.herdr.panes.filter((p) => p.workspace_id !== first.workspace);
	await server(record).open({ deploy: "deploy-seam-f2e" });
	assert.equal(createOpenings(record).get("deploy-seam-f2d"), undefined);
	assert.ok(createOpenings(record).get("deploy-seam-f2e"));
});

// F003: the first message, per id.
test("a repeat after a restart during the join types the first message when the first open never began to", async () => {
	const record = file(), ws = await left(record, "deploy-seam-f3a", "pending"), typed = prompts();
	joins(ws.root_pane);
	const s = server(record, undefined, { call: typed.call });
	const answer = await s.open({ deploy: "deploy-seam-f3a", prompt: "first message" });
	assert.equal(answer.status, 200, JSON.stringify(answer.body));
	assert.deepEqual(typed.sent, ["first message"]);
	assert.equal(body(answer).delivery, "sent");
	assert.equal(createOpenings(record).get("deploy-seam-f3a")?.delivery, "sent");
	const view = s.deploys.get("deploy-seam-f3a")!.view();
	assert.deepEqual([view.finished, view.delivery, view.steps.map((x) => `${x.id}:${x.state}`)], [true, "sent", ["create:done", "start:done", "join:done", "deliver:done"]]);
	const third = await server(record, undefined, { call: typed.call }).open({ deploy: "deploy-seam-f3a", prompt: "first message" });
	assert.equal(body(third).delivery, "sent");
	assert.deepEqual(typed.sent, ["first message"], "a third call does not type it again");
});

test("a repeat does not type a first message that was being typed or was typed, and says so", async () => {
	for (const [state, said] of [["sending", "unknown"], ["sent", "sent"]] as const) {
		const id = `deploy-seam-f3-${state}`, record = file(), ws = await left(record, id, state), typed = prompts();
		joins(ws.root_pane);
		const s = server(record, undefined, { call: typed.call });
		const answer = await s.open({ deploy: id, prompt: "first message" });
		assert.equal(answer.status, 200, JSON.stringify(answer.body));
		assert.deepEqual(typed.sent, [], state);
		assert.equal(body(answer).delivery, said, state);
		const view = s.deploys.get(id)!.view();
		assert.deepEqual([view.finished, view.delivery, view.steps.every((x) => x.state === "done")], [true, said, true], `progress of ${state} has no pending step`);
		assert.equal(createOpenings(record).get(id)?.delivery, state, "the record is as it was");
	}
});

test("a repeat without a message, for an open whose message was never typed, says not_sent", async () => {
	const record = file(), ws = await left(record, "deploy-seam-f3c", "pending");
	joins(ws.root_pane);
	const answer = await server(record).open({ deploy: "deploy-seam-f3c" });
	assert.equal(body(answer).delivery, "not_sent");
	assert.equal(createOpenings(record).get("deploy-seam-f3c")?.delivery, "pending");
});

test("the first open marks the message pending, then sending before it is typed, then sent", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), seen: string[] = [];
	const call = (async () => void seen.push(String(createOpenings(record).get("deploy-seam-f3d")?.delivery))) as unknown as SpawnDeps["call"];
	const first = await server(record, undefined, { call }).open({ deploy: "deploy-seam-f3d", prompt: "hello" });
	assert.equal(body(first).delivery, "sent");
	assert.deepEqual(seen, ["sending"], "at the call the record says sending");
	assert.equal(createOpenings(record).get("deploy-seam-f3d")?.delivery, "sent");
	const bare = await server(file()).open({ deploy: "deploy-seam-f3e" });
	assert.equal(body(bare).delivery, undefined, "no message, no field");
});

test("a server that cannot type leaves the message pending: a repeat on one that can types it", async () => {
	world.herdr.onAgentStart = joins;
	const record = file(), first = await server(record).open({ deploy: "deploy-seam-f3f", prompt: "hello" });
	assert.equal(body(first).error, "unavailable");
	assert.equal(createOpenings(record).get("deploy-seam-f3f")?.delivery, "pending");
	const typed = prompts(), again = await server(record, undefined, { call: typed.call }).open({ deploy: "deploy-seam-f3f", prompt: "hello" });
	assert.equal(again.status, 200);
	assert.deepEqual(typed.sent, ["hello"]);
});

// OBS2-F001: a GUI restart inside the process makes a second spawn over the host's openings and deploys; they share the one-at-a-time lock the host owns (guihost.ts), so the retry is told 429
// and types nothing while the old open is in its join.
test("a retry on a restarted listener (a second spawn of the host) does not type the first message twice, and is told busy", async () => {
	const record = file(), openings = createOpenings(record), deploys = createDeploys(), lock = { busy: false }, typed = prompts();
	let retry: Promise<{ status: number; body: unknown }> | undefined, again: ReturnType<typeof server> | undefined, slept = 0, joined = false;
	// The old open's join wait: the retry comes at 1 s, and the pi joins only once the retry has answered (it answers at once when the lock is shared; without one it waits for this pi, so a
	// short real timer lets the join go on and the test shows the double typing instead of hanging).
	const sleep = async (ms: number) => {
		slept += ms;
		if (slept >= 1000 && !retry) retry = again!.open({ deploy: "deploy-seam-n1", prompt: "first message" });
		if (slept >= 3000 && !joined) {
			joined = true;
			await Promise.race([retry, new Promise((done) => setTimeout(done, 250).unref())]);
			joins(world.herdr.panes.at(-1)!);
		}
		await Promise.resolve();
	};
	const old = server(record, undefined, { call: typed.call, deploys, lock, sleep }, openings);
	again = server(record, undefined, { call: typed.call, deploys, lock }, openings);
	const first = await old.open({ deploy: "deploy-seam-n1", prompt: "first message" });
	const second = await retry!;
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.equal(second.status, 429, JSON.stringify(second.body));
	assert.deepEqual(typed.sent, ["first message"], "typed once");
	assert.equal(made(), 1);
	assert.equal(openings.get("deploy-seam-n1")?.delivery, "sent");
	assert.equal(lock.busy, false, "the lock is free again");
	const later = await again.open({ deploy: "deploy-seam-n1", prompt: "first message" });
	assert.equal(body(later).delivery, "sent", "and a retry after it finished is answered from the record");
	assert.deepEqual(typed.sent, ["first message"]);
});

// OBS2-F005 (and OBS-F008): the host builds the stores and the lock once, not per GUI start (`begin` runs for every start: gui-stop then gui, a token rotation, a moved port).
test("the host owns the openings and the one-at-a-time lock: built beside deploys, passed to every spawn, not made inside begin", () => {
	const source = readFileSync(new URL("../src/server/guihost.ts", import.meta.url), "utf8"), begin = source.indexOf("const begin = async");
	assert.ok(begin > 0);
	for (const make of ["createOpenings(", "createDeploys(", "lock = {"]) {
		const at = source.indexOf(make);
		assert.ok(at > 0 && at < begin, `${make} is built before begin, once per host`);
		assert.equal(source.indexOf(make, begin), -1, `${make} is not built again inside begin`);
	}
	assert.match(source.slice(begin), /createSpawn\(\{[^\n]*\block,[^\n]*openings,/);
});

// F005: a repeat's own failure.
test("a repeat whose pi never joins fails at the join step and leaves the workspace and the record", async () => {
	const record = file(), ws = await left(record, "deploy-seam-f5", "none");
	const answer = await server(record).open({ deploy: "deploy-seam-f5" });
	assert.deepEqual([answer.status, body(answer).error, body(answer).step], [502, "open_failed", "join"]);
	assert.equal(world.herdr.commands("workspace", "close").length, 0);
	assert.equal(createOpenings(record).get("deploy-seam-f5")?.workspace, ws.workspace.workspace_id);
});

// F004, F006, F010: the record itself.
test("a record that cannot be written fails the open, closes the workspace, and names no path", async () => {
	world.herdr.onAgentStart = joins;
	const blocked = join(mkdtempSync(join(tmpdir(), "psb-ro-")), "isafile");
	writeFileSync(blocked, "x");
	const before = world.herdr.workspaces.length, s = server(join(blocked, "openings.json")), answer = await s.open({ deploy: "deploy-seam-f10" });
	assert.deepEqual([answer.status, body(answer).error, body(answer).step], [502, "open_failed", "create"]);
	assert.doesNotMatch(String(body(answer).reason), /isafile|\/tmp|\/var|ENOTDIR/, "no path in the reason");
	assert.equal(world.herdr.commands("workspace", "close").length, 1, "the workspace is closed");
	assert.equal(world.herdr.workspaces.length, before, "nothing is left in Herdr");
	assert.match(s.notes.join("\n"), /opening-record-failed.*isafile/, "the detail goes to the log");
});

// OBS2-F002: every write of the record names no path, whichever step it is at; the cause goes to the log.
/** Records of its own that fail a `set` whose opening `fails`, with the cause a file system gives (a path in it). */
function flaky(fails: (opening: Opening) => boolean) {
	const inner = createOpenings();
	const store = { ...inner, set(id: string, opening: Opening) {
		if (fails(opening)) throw new Error("EACCES: permission denied, open '/secret/state/openings.json.tmp'");
		inner.set(id, opening);
	} };
	return { inner, store: store as Openings };
}
test("a record that cannot be written when the message goes to be typed fails the open without a path, closes the workspace, and types nothing", async () => {
	world.herdr.onAgentStart = joins;
	const typed = prompts(), s = server(file(), undefined, { call: typed.call }, flaky((o) => o.delivery === "sending").store);
	const answer = await s.open({ deploy: "deploy-seam-n2", prompt: "hello" });
	assert.deepEqual([answer.status, body(answer).error, body(answer).step], [502, "open_failed", "deliver"]);
	assert.doesNotMatch(String(body(answer).reason), /secret|EACCES|openings\.json/);
	assert.match(s.notes.join("\n"), /opening-record-failed.*\/secret\/state\/openings\.json\.tmp/);
	assert.deepEqual(typed.sent, [], "nothing typed");
	assert.equal(world.herdr.commands("workspace", "close").length, 1);
});

test("a repeat whose record cannot be written for the message fails without a path and leaves the workspace and its record", async () => {
	const ws = await left(file(), "deploy-seam-n2b", "pending"), typed = prompts(), f = flaky((o) => o.delivery === "sending");
	f.inner.set("deploy-seam-n2b", { workspace: ws.workspace.workspace_id, tab: ws.tab.tab_id, pane: ws.root_pane.pane_id, dir, label: "beta", delivery: "pending" });
	joins(ws.root_pane);
	const s = server(file(), undefined, { call: typed.call }, f.store), answer = await s.open({ deploy: "deploy-seam-n2b", prompt: "hello" });
	assert.deepEqual([answer.status, body(answer).error, body(answer).step], [502, "open_failed", "deliver"]);
	assert.doesNotMatch(String(body(answer).reason), /secret|EACCES|openings\.json/);
	assert.match(s.notes.join("\n"), /opening-record-failed/);
	assert.deepEqual(typed.sent, []);
	assert.equal(world.herdr.commands("workspace", "close").length, 0, "the repeat made no workspace and closes none");
	assert.equal(f.inner.get("deploy-seam-n2b")?.delivery, "pending");
});

test("when the record cannot be written and cannot be dropped, the reply is the first failure", async () => {
	world.herdr.onAgentStart = joins;
	const stub = { get: () => undefined, prune: () => {}, set: () => { throw new Error("SET-FAILED"); }, drop: () => { throw new Error("DROP-FAILED"); } } as unknown as Openings;
	const answer = await server(file(), undefined, {}, stub).open({ deploy: "deploy-seam-f6" });
	assert.equal(answer.status, 502);
	assert.doesNotMatch(String(body(answer).reason), /DROP-FAILED/);
	assert.equal(world.herdr.commands("workspace", "close").length, 1, "the workspace is still closed");
});

test("the record file is mode 600, and the last 64 ids are kept", () => {
	const record = file(), openings = createOpenings(record), opening = (n: number): Opening => ({ workspace: `w${n}`, tab: `w${n}:t1`, pane: `w${n}:p1`, dir, label: "beta", delivery: "none" });
	for (let n = 0; n < 65; n++) openings.set(`id-${n}`, opening(n));
	if (process.platform !== "win32") assert.equal(statSync(record).mode & 0o777, 0o600);
	assert.equal(Object.keys(JSON.parse(readFileSync(record, "utf8"))).length, 64);
	assert.equal(openings.get("id-0"), undefined, "the oldest went");
	assert.ok(openings.get("id-64"));
	assert.equal(Object.keys(JSON.parse(readFileSync(record, "utf8")))[0], "id-1");
	assert.equal(createOpenings(record).get("id-64")?.delivery, "none", "read back after a restart");
});
