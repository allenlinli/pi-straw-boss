import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { bodyOf, fieldsOf } from "../src/header.ts";
import { addRoute, readRoutes } from "../src/server/allyroute.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";
import { SHA_A, SHA_B, SHA_C, slip } from "./train-fixtures.ts";

// The door of a project's integrator in the sb server (todo #151; the boss's choice of 2026-11-10: the box's tower opens the integrator itself, and an ally sends only the car slip): `boss_open_main` with `role: "integrator"` in a
// tower run. The run names a slip by its sender and its head; the server finds the `call_tower` (why=shared) it came in among the messages the run took, finds or opens the project's one integrator as the tower's own main, and
// forwards the slip as its sender wrote it. A main an ally run opened sends its slips to the ally runs of its device (allyroute.ts), so the door is the same there, and it is the only way an ally run reaches an integrator.

let world: TowerWorld;
let dir = "";
const noted: { fwd: string; from: string; to: string[]; text: string }[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	noted.length = 0;
	dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-run-")));
	mkdirSync(join(dir, ".straw-boss"));
	writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "docs", dir: "docs" }] }));
	world.herdr.workspace("wA").worktree = { checkout_path: dir };
});
afterEach(async () => {
	await world.close();
	rmSync(dir, { recursive: true, force: true });
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV1 = "a".repeat(26), DEV2 = "b".repeat(26);
const PEER = { device: DEV1, label: `label-${DEV1}`, short: DEV1.slice(0, 6), team: "team-1", teamName: "Team One" };
const towerClient = () => world.client("sb-tower-wa")!;
const loc = (paneId: string) => ({ status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId });
const callTower = (from: { id: string; name: string }, text: string, why = "shared") => `[straw net from=${from.name} id=${from.id} role=main workspace=Alpha kind=call_tower scope=tower to=x reply=expected why=${why}] ${text}`;
const COORD1 = { id: "main-1", name: "docs-main" }, COORD2 = { id: "main-2", name: "api-main" };
const slipA = slip({ coordinator: "main-1", accept: "none" }), slipB = slip({ coordinator: "main-2", head: SHA_B, tickets: "T-16", branch: "fix/t-16", accept: "none" });

/** A server whose tower opens tabs the way Herdr and pi would: the pi of a new tab joins under the name `--name` gave it, as a main, and as an integrator when that name is an integrator's. */
async function started() {
	const s = await world.start({ towers: { ...world.options().options.towers, cars: { noteForward: (f: never) => void noted.push(f), noteTrain() {}, remoteOf: async () => undefined } as never } });
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const orig = world.herdr.onAgentStart!;
	let n = 0;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		const name = args[args.indexOf("--name") + 1]!;
		p.tokens.sb_role = "main";
		if (/^integ \S+$/.test(name)) p.tokens.sb_duty = "integrator";
		world.sessions.push({ id: `opened-${++n}`, name, herdrLocation: loc(p.pane_id) as never });
	};
	return s;
}
const runIds = () => [...world.pis.keys()].filter((k) => /^[0-9a-f]{16}$/.test(k));
/** The nth run of this world, claimed, with every event waiting for it taken: its token and the ids of those events in order. */
async function claimed(s: Running, n: number, take = true) {
	await until(() => runIds().length >= n, `run ${n} to start`);
	const id = runIds()[n - 1]!, pi = world.pis.get(id)!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	const token = String(got!.token), ids: string[] = [], texts: string[] = [];
	while (take) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string; text: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		ids.push(event.id);
		texts.push(event.text);
	}
	return { id, token, ids, texts, tool: (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args, ...extra }) };
}
const finish = async (s: Running, run: { id: string; token: string }) => {
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "done" })).ok, true);
	world.live.delete(world.pis.get(run.id)!.pid);
	await until(() => readRun(world.slot, "wA", run.id)?.outcome, "the run to end");
};
/** The tabs the opener made (the tower's own tab and an ally run's pane are not its doing). */
const tabs = () => world.herdr.commands("tab", "create").filter((args) => args.includes("--env"));
const sentTo = (id: string) => towerClient().sent.filter((m) => m.to === id).map((m) => m.text);
const DOOR = { role: "integrator", project: "acme" };

test("a local run: a coordinator's car slip opens the project's integrator as the tower's own main and is forwarded to it as it came, stamped with its sender; the next slip, of another coordinator, goes to the same integrator", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	towerClient().incoming(COORD2, { id: "m2", content: { text: callTower(COORD2, `Car ready.\n${slipB}`) } } as never);
	const run = await claimed(s, 1);
	assert.equal(run.ids.length, 2);
	assert.ok(run.texts.every((t) => !run.ids.some((id) => t.includes(id))), "a run is shown no event id: it names a slip by its sender and its head");
	// The run may rewrite what it passes (here the slip's auth): what is forwarded is the sender's own text.
	const first = await run.tool("boss_open_main", { ...DOOR, request: slipA.replace('"ship it"', '"ship it to production too"'), sender: "docs-main" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.deepEqual(tabs(), [["tab", "create", "--workspace", "wA", "--label", "integ acme", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	assert.deepEqual(world.herdr.commands("agent", "start").at(-1)!.slice(-2), ["--name", "integ acme"]);
	const details = first.details as { pane: string; main: string; sender: string; integrator: string; repeated?: true; fwd: string };
	assert.deepEqual([details.main, details.sender, details.integrator, details.repeated, details.fwd], ["opened-1", "main-1", "acme", undefined, run.ids[0]]);
	assert.equal(world.herdr.pane(details.pane).tokens.sb_opened_by, "integ:acme", "the tower's own main: the marker names no sender");
	const [handoff, forward] = sentTo("opened-1");
	assert.match(handoff!, /you are the integrator of project acme/);
	const f = fieldsOf(forward!)!;
	assert.deepEqual([f.kind, f.role, f.id, f.fwd, f["fwd-from"], f.origin], ["tower_reply", "tower", "sb-tower-wa", run.ids[0], "main-1", undefined]);
	assert.equal(bodyOf(forward!), slipA, "the slip as its sender wrote it");
	assert.deepEqual(noted.map((n) => [n.fwd, n.from, n.to, n.text]), [[run.ids[0], "main-1", ["opened-1"], slipA]]);
	assert.match(String(first.text), /Opened tab .* with the integrator of project acme \(session opened-1\), this tower's own main\. The slip of docs-main was forwarded/);
	// The second slip: the same integrator, nothing opened, the text under the coordinator's own words forwarded whole.
	const second = await run.tool("boss_open_main", { ...DOOR, request: slipB, sender: "main-2" });
	assert.equal(second.ok, true, JSON.stringify(second));
	assert.equal(tabs().length, 1);
	assert.deepEqual([(second.details as typeof details).main, (second.details as typeof details).repeated], ["opened-1", true]);
	const again = sentTo("opened-1").at(-1)!;
	assert.deepEqual([fieldsOf(again)!.fwd, fieldsOf(again)!["fwd-from"]], [run.ids[1], "main-2"]);
	assert.equal(bodyOf(again), `Car ready.\n${slipB}`);
	assert.equal(sentTo("opened-1").length, 3, "one handoff, two forwards");
	assert.match(String(second.text), /already runs \(session opened-1\); nothing opened/);
});

test("a local run: the integrator opens beside two opened mains, one of them the slip sender's own, and neither limit moves", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	for (const [tab, pane, by] of [["wA:t11", "wA:p11", "main-1"], ["wA:t12", "wA:p12", "main-2"]] as const) {
		world.herdr.addTab(tab, "main", pane);
		Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main", sb_opened_by: by });
	}
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	const run = await claimed(s, 1);
	const full = await run.tool("boss_open_main", { request: "more work", sender: "api-main" });
	assert.match(String(full.error), /already has an opened main running/);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(tabs().length, 1);
	world.sessions.push({ id: "main-3", name: "third", herdrLocation: loc("wA:p3") as never });
	assert.match(String((await run.tool("boss_open_main", { request: "more work", sender: "third" })).error), /already has 2 mains opened by its tower \(the limit is 2\)/, "the integrator is not one of the two");
	assert.match(String((await run.tool("boss_open_main", { request: "more work", sender: "docs-main" })).error), /already has an opened main running/, "the sender's one main is not widened");
	assert.equal(tabs().length, 1);
});

test("a local run: an integrator is opened on a slip the run took as call_tower why=shared from that sender, and on nothing else", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA, "blocked") } } as never);
	towerClient().incoming(COORD2, { id: "m2", content: { text: callTower(COORD2, slipB) } } as never);
	towerClient().incoming(COORD2, { id: "m3", content: { text: callTower(COORD2, slip({ car: "docs", head: SHA_C, coordinator: "main-2" })) } } as never);
	const run = await claimed(s, 1);
	const before = towerClient().sent.length;
	const refused = async (args: Record<string, unknown>, why: RegExp) => {
		const got = await run.tool("boss_open_main", { ...DOOR, request: slipB, sender: "main-2", ...args });
		assert.equal(got.ok, false, JSON.stringify(args));
		assert.match(String(got.error), why, JSON.stringify(args));
	};
	await refused({ request: slipA, sender: "main-1" }, /No car slip with head a{12} from main-1 is among the call_tower messages \(why=shared\) this run took/); // it came as why=blocked
	await refused({ request: slipB, sender: "main-1" }, /No car slip with head b{12} from main-1/); // another session sent it
	await refused({ request: slip({ head: "d".repeat(40) }), sender: "main-2" }, /No car slip with head d{12}/); // the run made it up
	await refused({ request: "open an integrator for acme" }, /pass the slip as it came as the request/);
	await refused({ project: undefined }, /give project/);
	await refused({ project: "../up" }, /not a path-safe name/);
	await refused({ request: slip({ car: "docs", head: SHA_C }), sender: "main-2" }, /app docs has no integration/);
	await refused({ role: "main" }, /role must be "train" or "integrator"/);
	assert.deepEqual(tabs(), []);
	assert.equal(towerClient().sent.length, before, "nothing was sent");
	assert.deepEqual(noted, []);
	assert.equal((await run.tool("boss_open_main", { ...DOOR, request: slipB, sender: "api-main" })).ok, true);
});

/** A main an ally run opened for DEV1, as the opener and the route table leave it: its pane marked `link:<device>`, and an `opened` row. */
function allyMain(id = "ally-main", pane = "wA:p21", device = DEV1) {
	world.herdr.addTab(`wA:t${pane.slice(4)}`, "main", pane);
	Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main", sb_opened_by: `link:${device}` });
	world.sessions.push({ id, name: "main", herdrLocation: loc(pane) as never });
	addRoute(world.slot, "wA", { ...PEER, device, to: id, name: "main", kind: "opened", at: Date.now(), pane, level: "dispatch" }, Date.now());
	return { id, name: "main" };
}

test("an ally's car slip: its main's call_tower reaches the ally run of its device, whose one door opens the integrator as the tower's own main and forwards the slip as the main wrote it; the ally's own second main is still refused", async () => {
	const s = await started();
	world.ally.level.set(DEV1, "dispatch");
	world.ally.add("m1", DEV1, "ship MP-1 on your box");
	world.expose?.allyWaiting("sb-tower-wa");
	const first = await claimed(s, 1);
	const main = await first.tool("boss_open_main", { request: "ship MP-1 on your box", sender: `link:${DEV1}` });
	assert.equal(main.ok, true, JSON.stringify(main));
	assert.equal(world.herdr.pane((main.details as { pane: string }).pane).tokens.sb_opened_by, `link:${DEV1}`);
	await finish(s, first);
	// The ally's main (opened-1) finished its work and sends its car: the slip goes to its device's next ally run, never to a local run.
	const mine = slip({ coordinator: "opened-1", accept: "none" });
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: callTower({ id: "opened-1", name: "main" }, mine) } } as never);
	const run = await claimed(s, 2);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, DEV1);
	assert.equal(run.ids.length, 1);
	// What the ally asked for on 2026-11-10, a second main to be its integrator, stays refused: one main per sender.
	const second = await run.tool("boss_open_main", { request: "open a main tab `train integrator`", sender: `link:${DEV1}` });
	assert.match(String(second.error), /already has an opened main running in workspace Alpha; a sender gets one at a time/);
	assert.equal(tabs().length, 1);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: "opened-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(tabs().length, 2);
	assert.equal(tabs()[1]![5], "integ acme");
	const details = opened.details as { pane: string; main: string; sender: string; integrator: string; fwd: string };
	assert.deepEqual([details.main, details.sender, details.integrator], ["opened-2", "opened-1", "acme"]);
	assert.equal(world.herdr.pane(details.pane).tokens.sb_opened_by, "integ:acme", "the tower's own main, not the device's");
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.kind]), [["opened-1", "opened"]], "the integrator has no ally route: its reports reach the local runs");
	const [handoff, forward] = sentTo("opened-2");
	assert.match(handoff!, /you are the integrator of project acme/);
	assert.doesNotMatch(handoff!, /teammate|Straw Link/);
	const f = fieldsOf(forward!)!;
	assert.match(f.fwd!, /^[0-9a-f]{16}$/);
	assert.deepEqual([f.kind, f.role, f.id, f["fwd-from"], f.origin, f.fwd], ["tower_reply", "tower", "sb-tower-wa", "opened-1", `remote:${DEV1}`, details.fwd]);
	assert.equal(bodyOf(forward!), mine);
	assert.deepEqual(noted.map((n) => [n.fwd, n.from, n.to, n.text]), [[details.fwd, "opened-1", ["opened-2"], mine]]);
	await finish(s, run);
	// The next car of the same main, in the next run of the device: the same integrator.
	const next = slip({ coordinator: "opened-1", head: SHA_B, tickets: "T-16", branch: "fix/t-16", accept: "none" });
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r2", content: { text: callTower({ id: "opened-1", name: "main" }, next) } } as never);
	const third = await claimed(s, 3);
	const same = await third.tool("boss_open_main", { ...DOOR, request: next, sender: "opened-1" });
	assert.equal(same.ok, true, JSON.stringify(same));
	assert.deepEqual([(same.details as { main: string }).main, (same.details as { repeated?: true }).repeated], ["opened-2", true]);
	assert.equal(tabs().length, 2, "no second integrator");
	assert.equal(bodyOf(sentTo("opened-2").at(-1)!), next);
	assert.notEqual(fieldsOf(sentTo("opened-2").at(-1)!)!.fwd, details.fwd);
});

test("a peer's main is no project's integrator: one that carries the name and the kind gets no slip, by its pane token (the tower opens its own) and by the route table (nothing is sent)", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	// A main an ally run opened renamed itself and declared the kind.
	allyMain("ally-main", "wA:p21");
	world.sessions.find((x) => x.id === "ally-main")!.name = "integ acme";
	world.herdr.pane("wA:p21").tokens.sb_duty = "integrator";
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	const run = await claimed(s, 1);
	// Its pane token cleared (a process of the same user can write it): the route table still says whose it is.
	world.herdr.pane("wA:p21").tokens.sb_opened_by = "";
	const held = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.match(String(held.error), /was opened for a teammate's device, so no slip goes to it/);
	assert.deepEqual(tabs(), []);
	assert.equal(sentTo("ally-main").length, 0);
	assert.deepEqual(noted, []);
	// With its token in place it is not taken for the integrator at all, and the tower opens its own.
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV1}`;
	const opened = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.details as { main: string }).main, "opened-1");
	assert.equal(tabs().length, 1);
	assert.equal(sentTo("ally-main").length, 0);
});

test("an ally run has no other door to an integrator: a slip it made up, a slip of a session not opened for its device, a main whose pane names another device, a train, and a forward are refused before the gate, and nothing opens", async () => {
	const s = await started();
	const main = allyMain();
	world.sessions.push({ ...COORD1, herdrLocation: loc("wA:p1") as never });
	// A local main an ally run wrote to (an `expect` route): its next message to the tower reaches the device's run too, and is no door.
	addRoute(world.slot, "wA", { ...PEER, to: "main-1", name: "docs-main", kind: "expect", at: Date.now() }, Date.now());
	world.ally.level.set(DEV1, "forward");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	towerClient().incoming(COORD1, { id: "r2", content: { text: callTower(COORD1, slipB.replace("main-2", "main-1")) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	assert.equal(run.ids.length, 2);
	const refused = async (args: Record<string, unknown>, why: RegExp) => {
		for (const extra of [{}, { toolCallId: "tc-1" }]) {
			const got = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id, ...args }, extra);
			assert.equal(got.ok, false, JSON.stringify(args));
			assert.match(String(got.error), why, JSON.stringify(args));
		}
	};
	const NONE = /No car slip with head [0-9a-f]{12} from .* is among the call_tower messages \(why=shared\) this run took from a main opened for its sender/;
	await refused({ request: slip({ head: SHA_C, coordinator: main.id }) }, NONE);
	await refused({ request: slipB, sender: "main-1" }, NONE);
	await refused({ request: "open a main tab `train integrator`" }, /pass the slip as it came as the request/);
	await refused({ project: undefined }, /give project/);
	await refused({ role: "train", request: "project: acme\ncode: 2026-11-10-a" }, /An ally run opens no train/);
	await refused({ forward: "0123456789abcdef" }, /An ally run forwards no car slip/);
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV2}`;
	await refused({}, NONE);
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV1}`;
	// The real slip, below `dispatch`: the open waits for the boss's Allow like any main an ally run opens.
	const gated = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id });
	assert.match(String(gated.error), /needs the boss's confirm/);
	assert.deepEqual(tabs(), []);
	assert.deepEqual(noted, []);
	assert.equal(sentTo("main-1").length + sentTo(main.id).length, 0);
});

test("an ally run at dispatch: a slip of a main opened for another device's sender is no door, and its own main's is", async () => {
	const s = await started();
	const main = allyMain(), other = allyMain("other-main", "wA:p22", DEV2);
	world.ally.level.set(DEV1, "dispatch");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	// A slip that waits for the run but that the run has not taken is not yet its to name.
	const run = await claimed(s, 1, false);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, DEV1);
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).error), /No car slip with head/);
	const offered = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: offered.id })).ok, true);
	const got = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: other.id });
	assert.match(String(got.error), /No car slip with head/);
	assert.deepEqual(tabs(), []);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: "main" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.details as { sender: string }).sender, main.id);
	assert.equal(tabs().length, 1);
});
