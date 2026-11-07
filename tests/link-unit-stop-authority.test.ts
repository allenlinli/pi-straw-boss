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
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// The holder's half of §4 of docs/specs/2026-11-07-link-remote-stop.md: dave is the unattended box; alice (attended, dispatch), bob (attended, reply) and eve (unattended) are the others. The server's half
// (a main's handle, its team, its dispatcher, the second witness) lives with the box in task 3 of the spec.

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

type Who = "alice" | "bob" | "dave";
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
		store, isHolder: () => true, attended: () => who !== "dave", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
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
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(noticesOf(b), []);
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
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(d.stops.length, 1);
	assert.ok(drops(d, "stale-seq") >= 1);
});
