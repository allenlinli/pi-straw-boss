import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope } from "../src/link/envelope.ts";
import { LinkHolder, type UnitStopInput } from "../src/link/holder.ts";
import { enc, str } from "../src/link/canon.ts";
import { RelayClient } from "../src/link/relay.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { wireId } from "../src/board.ts";
import type { Notice } from "../src/link/kinds.ts";
import type { OpenedMain } from "../src/server/revoke.ts";
import type { RunSignal } from "../src/server/runs.ts";
import { createUnitStop, type Stop } from "../src/server/unitstop.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// The holder's half of §4 of docs/specs/2026-11-07-link-remote-stop.md: dave is the unattended box; alice (attended, dispatch), bob (attended, reply) and eve (unattended) are the others. The server's half
// (a main's handle, its team, its dispatcher, the second witness) is at the end of this file, against `createUnitStop` with fake deps.
// UW-F007: the sink runs in a microtask inside the locked receive, so a lock takeover can run it twice on a redelivery, and a sink that rejects after the ack loses the stop. `unitstop.ts` is idempotent per pending handle and tells the sender when it fails (both tested below).

const { alice, bob, dave, eve } = DEVICES;
const STOP = "00112233445566778899aabbccddeeff", HANDLE = "0123456789abcdef", REASON = "the secret reason of the stop";
let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-unit-stop-auth-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});
const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const [who, attended] of [["bob", true], ["dave", false], ["eve", false]] as const) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	return log;
})();

type Who = "alice" | "bob" | "dave" | "eve";
interface Rig { holder: LinkHolder; store: LinkStore; stops: UnitStopInput[] }
function rig(who: Who, trust: Record<string, "reply" | "forward" | "dispatch"> = {}, sink = true): Rig {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const stops: UnitStopInput[] = [];
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who !== "dave" && who !== "eve", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(Object.entries(trust)), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: 5,
		...(sink ? { unitStop: (a: UnitStopInput) => void stops.push(a) } : {}),
	});
	cleanup.push(() => holder.stop());
	return { holder, store, stops };
}
const events = (r: Rig) => {
	try {
		return readFileSync(join(r.store.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const drops = (r: Rig, reason: string) => events(r).filter((e) => e.reason === reason).length;
/** A unit-stop built by hand from any device, with any seq, ts, and fields: what the holder's own checks have to hold against. */
async function forge(from: typeof alice, seq: number, to: typeof alice, over: { ts?: number; mode?: string } = {}) {
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: stateOf(entries, alice).head, from, seq, ts: over.ts ?? Date.now(), kind: "unit-stop", to: [to.id], plaintext: enc(str(STOP), str(HANDLE), str(over.mode ?? "quit"), str(REASON)) });
	await new RelayClient({ url: "http://relay.test", device: from, fetch: relay.fetch }).postEnvelope(TEAM, envelope);
}
async function start(trust: Record<string, "reply" | "forward" | "dispatch"> = { [alice.id]: "dispatch", [bob.id]: "reply" }) {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	const d = rig("dave", trust), a = rig("alice"), b = rig("bob");
	await Promise.all([d.holder.start(), a.holder.start(), b.holder.start()]);
	return { d, a, b };
}
const noticesOf = (r: Rig) => r.holder.summary().alerts.filter((x) => x.kind === "notice").map((x) => [String(x.data.what), String(x.data.text)] as const);

test("an attended sender at dispatch gets its stop to the server's sink, with the request as sent; the log names ids and a verdict, never the reason", async () => {
	const { d, a } = await start();
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("unit-stop"), 3000, "dave's caps");
	const sent = await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "quit", reason: REASON });
	assert.ok(sent.ok);
	await until(() => d.stops.length === 1, 3000, "the stop on dave");
	assert.deepEqual([d.stops[0]!.team, d.stops[0]!.from, d.stops[0]!.stopId, d.stops[0]!.handle, d.stops[0]!.mode, d.stops[0]!.reason], [TEAM_HEX, alice.id, sent.stopId, HANDLE, "quit", REASON]);
	assert.ok(Math.abs(d.stops[0]!.at - Date.now()) < 60_000, "at is the request's own ts");
	assert.deepEqual(events(d).filter((e) => e.event === "unit-stop-in").map((e) => [e.team, e.from, e.stopId, e.handle, e.verdict]), [[TEAM_HEX, alice.id, sent.stopId, HANDLE, "accepted"]]);
	assert.ok(!JSON.stringify(events(d)).includes("secret reason"), "no reason text in the log");
	assert.deepEqual(noticesOf(a), [], "an accepted stop is no refusal");
});

test("a sender below dispatch, and a sender the policy does not name (a refused policy gives every device reply), is refused: no sink, a drop line, and a unit-stop-refused notice to the sender", async () => {
	const { d, b } = await start();
	await forge(bob, 50, dave);
	await until(() => drops(d, "unit-stop-level") === 1, 3000, "the drop");
	assert.equal(d.stops.length, 0, "nothing reached the server");
	await until(() => noticesOf(b).length === 1, 3000, "the notice on bob");
	assert.deepEqual(noticesOf(b)[0]![0], "unit-stop-refused");
	assert.match(noticesOf(b)[0]![1], /level/);
	assert.ok(!JSON.stringify(noticesOf(b)).includes("secret reason"));
	assert.ok(!JSON.stringify(events(d)).includes("secret reason"));
	assert.deepEqual(events(d).filter((e) => e.event === "unit-stop-in").map((e) => e.verdict), ["level"]);
});

test("a policy that names nobody makes alice a reply-level sender too", async () => {
	const { d, a } = await start({});
	await forge(alice, 50, dave);
	await until(() => drops(d, "unit-stop-level") === 1, 3000, "the drop");
	await until(() => noticesOf(a).length === 1, 3000, "the notice on alice");
	assert.equal(d.stops.length, 0);
});

test("a request older than 15 minutes at the box is refused as stale; one just inside is taken", async () => {
	const { d, a } = await start();
	await forge(alice, 50, dave, { ts: Date.now() - 16 * 60_000 });
	await until(() => drops(d, "unit-stop-stale") === 1, 3000, "the stale drop");
	await until(() => noticesOf(a).length === 1, 3000, "the notice");
	assert.match(noticesOf(a)[0]![1], /stale/);
	assert.equal(d.stops.length, 0);
	await forge(alice, 51, dave, { ts: Date.now() - 14 * 60_000 });
	await until(() => d.stops.length === 1, 3000, "the fresh one");
});

test("a mode this build does not take is refused by name", async () => {
	const { d, a } = await start();
	await forge(alice, 50, dave, { mode: "kill" });
	await until(() => drops(d, "unit-stop-mode") === 1, 3000, "the drop");
	await until(() => noticesOf(a).length === 1, 3000, "the notice");
	assert.match(noticesOf(a)[0]![1], /mode/);
	assert.equal(d.stops.length, 0);
	await forge(alice, 51, dave, { mode: "interrupt" });
	await until(() => d.stops.length === 1, 3000, "interrupt is taken");
	assert.equal(d.stops[0]!.mode, "interrupt");
});

test("an attended device takes no stop at all: it drops it and tells no one", async () => {
	const { a, b } = await start();
	await forge(bob, 50, alice);
	await until(() => drops(a, "unit-stop-attended-device") === 1, 3000, "the drop on alice");
	assert.equal(a.stops.length, 0);
	// A positive marker instead of a wait: dave refuses bob's stop (reply level) and tells bob once; by then alice's drop has long been answered, and had she told bob, there would be two.
	await forge(bob, 51, dave);
	await until(() => noticesOf(b).length === 1, 3000, "dave's notice on bob");
	assert.equal(noticesOf(b).length, 1, "only dave's: alice told no one");
});

test("a box with no server sink drops an otherwise valid stop as unhandled", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	const d = rig("dave", { [alice.id]: "dispatch" }, false), a = rig("alice");
	await Promise.all([d.holder.start(), a.holder.start()]);
	await forge(alice, 50, dave);
	await until(() => drops(d, "unit-stop-unhandled") === 1, 3000, "the drop");
});

test("a second request with the same seq is dropped by the sequence guard: a replay stops nothing twice", async () => {
	const { d } = await start();
	await forge(alice, 50, dave);
	await until(() => d.stops.length === 1, 3000, "the first");
	await forge(alice, 50, dave);
	await until(() => drops(d, "stale-seq") >= 1, 3000, "the replay's drop");
	assert.equal(d.stops.length, 1);
});

test("a box lists unit-stop in its caps only when a server sink is wired to act on it", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	const d = rig("dave", { [alice.id]: "dispatch" }, false), e = rig("eve", {}, true), a = rig("alice");
	await Promise.all([d.holder.start(), e.holder.start(), a.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, eve.id).includes("unit-stop"), 3000, "eve's caps");
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("tower-reply"), 3000, "dave's caps");
	assert.ok(!a.holder.capsFor(TEAM_HEX, dave.id).includes("unit-stop"), "dave has no sink: no unit-stop");
});

// ---- The server's half: unitstop.ts -------------------------------------------------------------------------------------------------------------------------------------------

const BOX = "x".repeat(26), DISP = "d".repeat(26), ADMIN = "a".repeat(26), THIRD = "c".repeat(26), FOREIGN = "f".repeat(26), T1 = "1".repeat(16), T2 = "2".repeat(16);
const row = (over: Partial<OpenedMain> = {}): OpenedMain => ({ workspace: "wA", label: "Alpha", main: "sess-1", name: "opened main", device: DISP, deviceLabel: "dev-mac", team: T1, level: "dispatch", ...over });
const input = (over: Partial<Parameters<ReturnType<typeof createUnitStop>["handle"]>[0]> = {}) => ({ team: T1, from: DISP, stopId: "5".repeat(32), handle: wireId(BOX, "sess-1"), mode: "quit", reason: REASON, at: Date.now(), ...over });
function stopRig(rows: OpenedMain[] = [row()], admins: Record<string, string[]> = { [T1]: [ADMIN], [T2]: [FOREIGN] }) {
	const out = { signals: [] as RunSignal[], told: [] as { team: string; device: string; notice: Notice }[], records: [] as { main: string; stop: Stop; name: string | undefined }[], audits: [] as Record<string, unknown>[], sweeps: 0 };
	const world = { rows, token: { device: DISP as string | undefined, name: "tester" as string | undefined } as { device?: string; name?: string } | undefined, witnessError: undefined as string | undefined, pending: undefined as Stop | undefined, box: BOX as string | undefined };
	const unit = createUnitStop({
		box: () => world.box, opened: () => world.rows, admin: (team, device) => admins[team]?.includes(device) ?? false,
		witness: async () => { if (world.witnessError) throw new Error(world.witnessError); return world.token; },
		record: (r, stop, name) => (world.pending ? { set: false, stop: world.pending } : (out.records.push({ main: r.main, stop, name }), (world.pending = stop), { set: true })),
		sweep: () => void out.sweeps++, signal: (s) => void out.signals.push(s), tell: async (team, device, notice) => void out.told.push({ team, device, notice }),
		label: (_team, device) => (device === ADMIN ? "admin-mac" : device === THIRD ? "third-mac" : "dev-mac"), audit: (e) => void out.audits.push(e), now: () => 1_000_000,
	});
	const nothingSpent = () => assert.deepEqual([out.records.length, out.sweeps, out.audits.filter((e) => e.event === "unit-stop-pending").length], [0, 0, 0], "a refusal writes no stop, asks for no sweep, and audits no pending stop");
	const noReason = () => assert.ok(!JSON.stringify(out).includes("secret reason"), "the reason text is nowhere: not in a notice, a signal, an audit line, or a log");
	return { ...out, out, world, unit, nothingSpent, noReason };
}
const refused = (r: ReturnType<typeof stopRig>) => r.out.told.map((t) => [t.device, t.notice.kind, t.notice.text.match(/refused: ([a-z-]+)/)?.[1]] as const);

test("server: the dispatcher's own main is accepted; the stop goes on the route as {by, at, stopId, mode} with the main's real name, the box sweeps at once, and link.log gets unit-stop-pending", async () => {
	const r = stopRig();
	await r.unit.handle(input());
	assert.deepEqual(r.records, [{ main: "sess-1", stop: { by: DISP, at: 1_000_000, stopId: "5".repeat(32), mode: "quit" }, name: "tester" }]);
	assert.equal(r.out.sweeps, 1);
	assert.deepEqual(r.audits.map((a) => [a.event, a.stopId, a.workspace, a.main]), [["unit-stop-pending", "5".repeat(32), "wA", "sess-1"]]);
	assert.deepEqual([r.out.told, r.out.signals], [[], []]);
	r.noReason();
});

test("server: an admin of the main's team is accepted, and the interrupt mode is kept", async () => {
	const r = stopRig();
	await r.unit.handle(input({ from: ADMIN, mode: "interrupt" }));
	assert.deepEqual([r.records[0]!.stop.by, r.records[0]!.stop.mode], [ADMIN, "interrupt"]);
});

test("server: an unknown handle, and the old handle of a main that restarted under the same name (a new session id), are refused as gone, to the sender alone, and spend nothing", async () => {
	const r = stopRig([row({ main: "sess-2" })]);
	await r.unit.handle(input({ handle: wireId(BOX, "sess-1") }));
	await r.unit.handle(input({ handle: "0123456789abcdef", stopId: "6".repeat(32) }));
	assert.deepEqual(refused(r), [[DISP, "unit-stop-refused", "gone"], [DISP, "unit-stop-refused", "gone"]]);
	assert.deepEqual(r.out.signals, [], "told to nobody else");
	assert.deepEqual(r.audits.map((a) => [a.event, a.verdict, a.from]), [["unit-stop-refused", "gone", DISP], ["unit-stop-refused", "gone", DISP]], "link.log names who tried and the verdict");
	r.nothingSpent();
	r.noReason();
});

test("server: a row of another team does not match: a stop that came on team 2 for a main of team 1 is gone", async () => {
	const r = stopRig();
	await r.unit.handle(input({ team: T2, from: FOREIGN }));
	assert.deepEqual(refused(r), [[FOREIGN, "unit-stop-refused", "gone"]]);
	r.nothingSpent();
});

test("server: a dev who is neither the dispatcher nor an admin of the team, and an admin of another team only, are refused as not-recipient, and the requester's scope (it reaches the team's admins) is told", async () => {
	for (const from of [THIRD, FOREIGN]) {
		const r = stopRig();
		await r.unit.handle(input({ from }));
		assert.deepEqual(r.out.told, [], "not a direct tell: the scope carries it");
		assert.equal(r.out.signals.length, 1);
		const s = r.out.signals[0]!;
		assert.ok(s.kind === "main-stop" && s.outcome === "refused");
		assert.deepEqual([s.device, s.team, s.stopId], [from, T1, "5".repeat(32)]);
		assert.match(s.text, /not-recipient/);
		assert.match(s.text, from === THIRD ? /third-mac/ : /dev-mac/, "the requester's label");
		r.nothingSpent();
		r.noReason();
	}
});

test("server: a pane token that names another device refuses the stop (the second witness), even for the dispatcher; a token naming the row's device, or none, passes", async () => {
	const r = stopRig();
	r.world.token = { device: THIRD, name: "tester" };
	await r.unit.handle(input());
	assert.deepEqual(refused(r), [[DISP, "unit-stop-refused", "gone"]]);
	r.nothingSpent();
	const ok = stopRig();
	ok.world.token = { name: "tester" };
	await ok.unit.handle(input());
	assert.equal(ok.records.length, 1, "no token to disagree");
});

test("server: a second stop of a main whose stop is pending is a no-op logged with the first stopId; it tells no one and sweeps no more", async () => {
	const r = stopRig();
	await r.unit.handle(input());
	await r.unit.handle(input({ stopId: "7".repeat(32), mode: "interrupt", from: ADMIN }));
	assert.equal(r.records.length, 1);
	assert.equal(r.out.sweeps, 1);
	const noop = r.audits.find((l) => l.event === "unit-stop-noop");
	assert.deepEqual([noop?.stopId, noop?.first], ["7".repeat(32), "5".repeat(32)]);
	assert.deepEqual([r.out.told, r.out.signals], [[], []]);
});

test("server: a stop whose handling fails (the pane cannot be read, this device has no id) is told to the sender as unit-stop-refused: failed, and the reason is kept out of the log (UW-F007)", async () => {
	const r = stopRig();
	r.world.witnessError = "Herdr did not answer";
	await r.unit.handle(input());
	assert.deepEqual(refused(r), [[DISP, "unit-stop-refused", "failed"]]);
	assert.ok(r.audits.some((l) => l.event === "unit-stop-failed"));
	r.nothingSpent();
	r.noReason();
	const nobox = stopRig();
	nobox.world.box = undefined;
	await nobox.unit.handle(input());
	assert.deepEqual(refused(nobox), [[DISP, "unit-stop-refused", "failed"]]);
});
