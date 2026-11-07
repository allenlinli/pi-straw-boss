import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { wireId } from "../src/board.ts";
import { addRoute, dropOpened, readRoutes, setStop, spendRoute } from "../src/server/allyroute.ts";
import { createRevoker, type OpenedMain } from "../src/server/revoke.ts";
import type { RunSignal } from "../src/server/runs.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { until as untilWorld, World } from "./fakes.ts";

// Todo #100 task 3 (docs/specs/2026-11-07-link-remote-stop.md, section 5): a stop the box accepted is written on the route row and carried out by the revoker as a second reason, on its first sweep and whatever
// the device's level is; the main of this build answers an `interrupt` by aborting its turn; the route keeps the stop through renewals, restarts, and the row caps.

const DEV = "n".repeat(26), ADM = "m".repeat(26), T = "t".repeat(16), BOX = "x".repeat(26);
const STOP = { by: ADM, at: 1_000, stopId: "0".repeat(32), mode: "quit" };
const main = (over: Partial<OpenedMain> = {}): OpenedMain => ({ workspace: "wA", label: "Alpha", main: "m-1", name: "main", device: DEV, team: T, deviceLabel: "dev-mac", level: "dispatch", stop: STOP, ...over });
const stopSignals = (signals: RunSignal[]) => signals.flatMap((s) => (s.kind === "main-stop" ? [[s.outcome, s.main, s.stopId, s.device, s.team] as const] : []));

function rig(rows: OpenedMain[], levels: Record<string, string | undefined> = {}) {
	const closes: string[] = [], forgot: string[] = [], signals: RunSignal[] = [], logs: Record<string, unknown>[] = [], audits: Record<string, unknown>[] = [];
	const world = { rows, levels, closeError: undefined as string | undefined, known: true, paneGone: true, errors: [] as (string | undefined)[], told: true };
	const revoker = createRevoker({
		opened: () => world.rows, known: () => world.known,
		standing: (device) => (world.levels[device] ? { level: world.levels[device]! } : undefined),
		close: async (workspace, m, mode) => {
			closes.push(`${workspace}/${m}/${mode ?? "quit"}`);
			const next = world.errors.length ? world.errors.shift() : world.closeError;
			if (next) throw new Error(next);
		},
		paneGone: async () => world.paneGone,
		forget: (workspace, m) => void (forgot.push(`${workspace}/${m}`), (world.rows = world.rows.filter((x) => !(x.workspace === workspace && x.main === m)))),
		label: (_team, device) => (device === ADM ? "admin-mac" : "dev-mac"),
		signal: (s) => (signals.push(s), world.told), log: (e) => void logs.push(e), audit: (e) => void audits.push(e),
	});
	return { revoker, closes, forgot, signals, logs, audits, world };
}

test("a stopped main is asked on the first sweep, whatever the device's level and whether or not the holder can read the roster; the mode goes with the ask", async () => {
	const r = rig([main(), main({ main: "m-2", stop: { ...STOP, mode: "interrupt", stopId: "1".repeat(32) } })], { [DEV]: "dispatch" });
	r.world.known = false;
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1/quit", "wA/m-2/interrupt"], "a signed stop is no read of the policy: no second look, no level");
});

test("a main with no stop on it keeps the revoke rules: a device still at dispatch ends nothing", async () => {
	const r = rig([main({ stop: undefined })], { [DEV]: "dispatch" });
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.closes, []);
});

test("a stop that is busy is told once as pending, asked again at every sweep, and a quit ends it with main-stopped, the route let go, and a unit-stop-done line", async () => {
	const r = rig([main()], { [DEV]: "dispatch" });
	r.world.closeError = "main is working; try again when it is idle";
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.closes.length, 3);
	assert.deepEqual(stopSignals(r.signals), [["pending", "m-1", STOP.stopId, DEV, T]], "told once");
	const pending = r.signals[0]!;
	assert.ok(pending.kind === "main-stop" && /admin-mac/.test(pending.text) && /busy|working/.test(pending.text));
	r.world.closeError = undefined;
	await r.revoker.sweep();
	assert.deepEqual(stopSignals(r.signals).map((s) => s[0]), ["pending", "stopped"]);
	assert.deepEqual(r.forgot, ["wA/m-1"]);
	assert.deepEqual(r.audits.map((a) => [a.event, a.stopId, a.workspace, a.main]), [["unit-stop-done", STOP.stopId, "wA", "m-1"]]);
	await r.revoker.sweep();
	assert.equal(r.closes.length, 4, "a forgotten main is asked no more");
});

test("a stopped main that is gone needs two sweeps and its pane absent, then goes without a notice; a pane Herdr still lists keeps it, and the admins are told it still runs", async () => {
	const gone = rig([main({ pane: "p-1" })]);
	gone.world.closeError = "No live session is named or has the id \"m-1\"";
	await gone.revoker.sweep();
	assert.deepEqual(gone.forgot, [], "one miss forgets nothing");
	await gone.revoker.sweep();
	assert.deepEqual(gone.forgot, ["wA/m-1"]);
	assert.deepEqual(gone.signals, []);
	const still = rig([main({ pane: "p-1" })]);
	still.world.closeError = "No live session is named or has the id \"m-1\"";
	still.world.paneGone = false;
	for (let i = 0; i < 4; i++) await still.revoker.sweep();
	assert.deepEqual(still.forgot, []);
	assert.deepEqual(stopSignals(still.signals).map((s) => s[0]), ["pending"]);
});

test("a main the box cannot end (the boss opened it) is told once as main-stop-manual, not as pending", async () => {
	const r = rig([main({ pane: "p-1" })]);
	r.world.closeError = "main was not opened by a tower (the boss opened it), so only the boss closes it";
	r.world.paneGone = false;
	for (let i = 0; i < 4; i++) await r.revoker.sweep();
	assert.deepEqual(stopSignals(r.signals).map((s) => s[0]), ["manual"]);
	assert.match((r.signals[0] as { text: string }).text, /Close it by hand/);
});

test("a notice nobody could be told of is sent again at a later sweep", async () => {
	const r = rig([main()]);
	r.world.closeError = "main is working; try again when it is idle";
	r.world.told = false;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 3, "asked again each sweep while nobody was told");
	r.world.told = true;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 4, "once told, never again");
});

test("a main that lost its device's dispatch and has a stop is told by the stop's notices, not the revoke's", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.signals.map((s) => s.kind), ["main-stop"]);
});

// The route row: the stop is written on it and outlives a server restart (it is on the file), a report that renews the row, a re-add, and the caps.
let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());
const peer = (device: string) => ({ device, label: "l", short: "s", team: T, teamName: "tn" });
const opened = (device: string, to: string, at: number) => ({ ...peer(device), to, name: "opened main", kind: "opened" as const, at });

test("setStop writes the stop on the opened row, once: a second stop of the same main changes nothing and answers the first", () => {
	const now = 10_000;
	addRoute(world.slot, "wA", opened(DEV, "m-1", now), now);
	assert.deepEqual(setStop(world.slot, "wA", "m-1", STOP, now, "tester"), { set: true });
	const again = setStop(world.slot, "wA", "m-1", { ...STOP, stopId: "9".repeat(32) }, now + 1);
	assert.deepEqual(again, { set: false, stop: STOP });
	const row = readRoutes(world.slot, "wA", now + 2)[0]!;
	assert.deepEqual([row.stop, row.name], [STOP, "tester"], "the row's name is the main's real one");
	assert.throws(() => setStop(world.slot, "wA", "no-such", STOP, now), /no opened route/);
});

test("the stop stays through a report that renews the row, an opened row written again for the same main, and a main's closing takes it with the row", () => {
	const now = 10_000;
	addRoute(world.slot, "wA", opened(DEV, "m-1", now), now);
	setStop(world.slot, "wA", "m-1", STOP, now);
	spendRoute(world.slot, "wA", readRoutes(world.slot, "wA", now)[0]!, now + 5000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 5000)[0]!.stop, STOP);
	assert.equal(readRoutes(world.slot, "wA", now + 5000)[0]!.at, now + 5000, "renewed");
	addRoute(world.slot, "wA", opened(DEV, "m-1", now + 6000), now + 6000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 6000)[0]!.stop, STOP);
	dropOpened(world.slot, "wA", "m-1", now + 7000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 7000), []);
});

test("the row caps never drop a row with a pending stop before rows without one, even the oldest and a dead one", () => {
	const now = 1_000_000_000;
	addRoute(world.slot, "wA", opened(DEV, "stopped", now), now);
	setStop(world.slot, "wA", "stopped", STOP, now);
	// Eight more rows of the same device, each newer: the per-device cap of 8 drops one, and it is not the stopped one.
	for (let i = 0; i < 8; i++) addRoute(world.slot, "wA", opened(DEV, `m-${i}`, now + 1 + i), now + 1 + i, new Set(["m-0", "m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"]));
	const kept = readRoutes(world.slot, "wA", now + 20).map((r) => r.to);
	assert.equal(kept.length, 8);
	assert.ok(kept.includes("stopped"), "the oldest row has a stop, so another row goes");
	assert.ok(!kept.includes("m-0"), "the oldest row without one went");
	// And among rows that are all dead, the one with a stop is last to go.
	const live = new Set<string>();
	addRoute(world.slot, "wA", opened(DEV, "late", now + 30), now + 30, live, new Set());
	assert.ok(readRoutes(world.slot, "wA", now + 40).some((r) => r.to === "stopped"));
});

// The end of the chain on the box: the sink of the holder, the route, the immediate sweep, the ask with its mode, and the notices.
type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
async function boxWithMain() {
	world.ally.self = BOX;
	world.ally.admins.add(`${T}\n${ADM}`);
	world.ally.labels.set(ADM, "admin-mac");
	world.ally.projects.set(T, "/proj");
	world.ally.level.set(DEV, "dispatch");
	world.ally.level.set(ADM, "dispatch");
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV, "run it", { team: T });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	const token = String(got.token);
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		p.tokens.sb_opened_by = `link:${DEV}`;
		Object.assign(p, { agent_status: "working" });
		world.sessions.push({ id: "opened-1", name: "tester", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const opened = await ask(s, { cmd: "run-tool", token, tool: "boss_open_main", args: { request: "Open one main and run the trial.", sender: `link:${DEV}` } });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	return { s };
}
const closeAsks = () => world.client("sb-tower-wa")!.frames.filter((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main").map((f) => f.payload as { to: string; reqId: string; interrupt?: boolean });
const accept = (reqId: string) => world.client("sb-tower-wa")!.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "opened-1", payload: { version: 1, type: "close-main-result", to: "sb-tower-wa", reqId, accepted: true } });
const HANDLE = () => wireId(BOX, "opened-1");

test("an accepted stop goes on the row, sweeps at once (no wait for the 15 s), asks a working main with interrupt, and quitting ends it with the notices and the audit lines", async () => {
	await boxWithMain();
	const sink = world.expose!.unitStop!;
	await sink({ team: T, from: ADM, stopId: "a".repeat(32), handle: HANDLE(), mode: "interrupt", reason: "the stuck main", at: Date.now() });
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now())[0]!.stop && [readRoutes(world.slot, "wA", Date.now())[0]!.stop!.by, readRoutes(world.slot, "wA", Date.now())[0]!.stop!.mode], [ADM, "interrupt"]);
	await until(() => closeAsks().length >= 1, "the ask, before any 15 s sweep");
	assert.equal(closeAsks()[0]!.interrupt, true, "the main is working and the tower asks anyway");
	assert.equal(closeAsks()[0]!.to, "opened-1");
	accept(closeAsks()[0]!.reqId);
	world.sessions = [];
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "stopped"), "the stopped notice");
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
	assert.deepEqual(world.ally.audits.map((a) => a.event), ["unit-stop-pending", "unit-stop-done"]);
	assert.ok(!JSON.stringify(world.ally.audits).includes("the stuck main"), "no reason text in link.log");
});

test("a quit stop does not interrupt: a working main is refused before it is even asked, and the notice says it is still pending", async () => {
	await boxWithMain();
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "b".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "pending"), "the pending notice");
	assert.deepEqual(closeAsks(), [], "the tower's own check says the main is working");
});

// The main's side of `interrupt`: a main of this build that is not idle aborts its turn and answers busy; the next ask finds it idle.
let fake = new World();
afterEach(async () => {
	await fake.stopAll();
	fake = new World();
});
async function openedMain() {
	fake.autoMains();
	const towerA = fake.tower("tower-wA", "wA:t7", "wA:p7"), a1 = fake.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	await Promise.all(fake.agents.map((agent) => agent.start()));
	await a1.promote();
	await towerA.tool("boss_open_main", { request: "Fix the export button.", sender: "api-main" });
	const m = fake.agents.find((a) => a.id === "opened-wA:p101")!;
	fake.herdr.pane("wA:p101").agent_status = "idle";
	return { m };
}
const askMain = (m: { id: string; regs: Map<string, { onEvent(e: unknown): void }> }, reqId: string, extra: Record<string, unknown> = {}) => m.regs.get("straw-boss/control")!.onEvent({ type: "message", fromSessionId: "tower-wA", payload: { version: 1, type: "close-main", to: m.id, reqId, ...extra } });
const results = () => fake.broker.published.map((p) => p.payload as { type: string; reqId: string; accepted: boolean; reason?: string; busy?: boolean }).filter((p) => p.type === "close-main-result");

test("a main asked with interrupt aborts the turn it is in and answers busy; asked again, idle, it quits. Without interrupt it never aborts", async () => {
	const { m } = await openedMain();
	m.idle = false;
	askMain(m, "r0");
	await untilWorld(() => results().length === 1, "the plain refusal");
	assert.equal(m.aborted, 0, "a plain quit never aborts");
	assert.equal(results()[0]!.busy, true);
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 2, "the interrupt's answer");
	assert.equal(m.aborted, 1);
	assert.deepEqual([results()[1]!.accepted, results()[1]!.busy], [false, true]);
	assert.match(results()[1]!.reason!, /interrupt/);
	m.idle = true;
	askMain(m, "r2", { interrupt: true });
	await untilWorld(() => results().length === 3 && m.stopped, "the quit");
	assert.equal(m.aborted, 1, "an idle main is not aborted");
	assert.equal(results()[2]!.accepted, true);
});

test("an interrupt does not end what an abort does not: a running subagent, a monitor, or an open dialog still refuse, and nothing is aborted", async () => {
	const { m } = await openedMain();
	m.idle = false;
	m.emit("monitor:started", { monitorId: "1", command: "npm run dev" });
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 1, "the refusal");
	assert.equal(m.aborted, 0);
	assert.match(results()[0]!.reason!, /monitor/);
	assert.equal(results()[0]!.accepted, false);
});
