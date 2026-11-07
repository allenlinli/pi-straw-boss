import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope } from "../src/link/envelope.ts";
import { LinkHolder, type OperateIn } from "../src/link/holder.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import type { DeviceKeys } from "../src/link/device.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { netOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// A device that restarts quickly (todo #121 wiring, review OW-F001): the relay replays a peer's `caps` only past the restarted device's cursor, and a queued envelope moves the cursor past the peer's last `caps`, so the restarted
// holder's empty memory must be refilled by the peer. The first `caps` of a holder after it starts carries the word `hello`, and a peer that reads it sends its own once (never sooner than the minimum spacing, and with no word of its own).

const { alice, carol, dave } = DEVICES;
let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "psb-caps-restart-")); relay = new FakeRelay(); });
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); rmSync(root, { recursive: true, force: true }); });
const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const [who, attended] of [["bob", true], ["dave", false], ["carol", false]] as const) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	return log;
})();

function rig(who: "alice" | "dave", o: { capsMinMs?: number; now?: () => number; operateOn?: () => boolean; operateChanged?: (on: boolean) => void } = {}) {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-p`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	if (!existsSync(join(dir, "device.json"))) writeDevice(store, keys, LABELS[who]);
	if (!existsSync(join(dir, "teams", `${TEAM_HEX}.json`))) writeTeam(store, entries, keys);
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who === "alice", net: async () => netOf([[`tower-${who}`, `w-${who}`, `l-${who}`, project]]), relay: (url: string, device: DeviceKeys) => new RelayClient({ url, device, fetch: (i, init) => relay.fetch(i, init), timeoutMs: 2000 }),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: o.capsMinMs ?? 5,
		operate: (_m: OperateIn) => undefined, ...(o.now ? { now: o.now } : {}),
		...(o.operateOn ? { operateOn: o.operateOn } : {}), ...(o.operateChanged ? { operateChanged: o.operateChanged } : {}),
	});
	cleanup.push(() => holder.stop());
	return { holder, store };
}
/** The cursor a queued envelope would have moved this device's stored cursor to (past every `caps` the relay holds): what a restart meets after any dispatch or reply in the team. */
function pastEverything(store: LinkStore, keys: DeviceKeys) {
	writeTeam(store, entries, keys, { lastEventId: 1_000_000 });
}
const capsOf = (from: DeviceKeys) => relay.stored.filter((s) => s.envelope.header.kind === "caps" && s.envelope.header.from === from.id);

async function both() {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	const a = rig("alice"), d = rig("dave");
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1") && d.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"), 3000, "caps both ways");
	return { a, d };
}

test("OW-F001: a box that restarts quickly learns the controller's operate/1 again, though the relay replays nothing past its cursor", async () => {
	const { a, d } = await both();
	await d.holder.stop();
	pastEverything(d.store, dave);
	const again = rig("dave");
	await again.holder.start();
	await until(() => again.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"), 3000, "the box to know the controller takes operate");
	assert.ok(a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"));
});

test("OW-F001: a controller that restarts quickly learns the box's operate/1 again", async () => {
	const { a, d } = await both();
	await a.holder.stop();
	pastEverything(a.store, alice);
	const again = rig("alice");
	await again.holder.start();
	await until(() => again.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "the controller to know the box takes operate");
	assert.ok(d.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"));
});

test("OW-F001: the word is in a holder's first caps only, the answer to it has none, and nothing more is sent: no storm, no ping-pong", async () => {
	const { d } = await both();
	await d.holder.stop();
	pastEverything(d.store, dave);
	const again = rig("dave");
	await again.holder.start();
	await until(() => again.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"), 3000, "the box to know the controller");
	await new Promise((r) => setTimeout(r, 300));
	const words = (from: DeviceKeys) => capsOf(from).map((s) => s.envelope.header.id.toString("hex"));
	const total = relay.stored.filter((s) => s.envelope.header.kind === "caps").length;
	assert.ok(total <= 5, `caps posted: ${total}`); // alice 1 (+1 answer), dave 1 (+1 after the restart) + 1 answer: a handful, and then nothing
	assert.equal(words(alice).length + words(dave).length, total);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(relay.stored.filter((s) => s.envelope.header.kind === "caps").length, total, "quiet afterwards");
	assert.ok(!again.holder.capsFor(TEAM_HEX, alice.id).includes("hello"), "the word is not a feature the caller sees");
});

test("OW-F001/OW-F005: a hello from a member is answered with one caps within the minimum spacing, however many come; the answer does not fire at once on every presence", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	const a = rig("alice", { capsMinMs: 400 });
	await a.holder.start();
	await until(() => capsOf(alice).length >= 1, 3000, "alice's first caps");
	const before = capsOf(alice).length;
	const roster = view(entries);
	const hello = (ts: number) => buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: carol, seq: 0, ts, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: ["hello"] }) });
	const now = Date.now();
	for (let i = 0; i < 5; i++) relay.injectStored(TEAM_HEX, hello(now + i), alice.id);
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(capsOf(alice).length, before, "the minimum spacing holds: the answer waits for it");
	await until(() => capsOf(alice).length === before + 1, 3000, "the one answer");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(capsOf(alice).length, before + 1, "five hellos, one answer");
	assert.deepEqual(a.holder.capsFor(TEAM_HEX, carol.id), [], "the word is no feature of its sender");
});

test("OW-F001: a hello that comes back from this device itself is not answered", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	const a = rig("alice", { capsMinMs: 5 });
	await a.holder.start();
	await until(() => capsOf(alice).length >= 1, 3000, "alice's first caps");
	await new Promise((r) => setTimeout(r, 100));
	const before = capsOf(alice).length, roster = view(entries);
	const own = buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: alice, seq: 0, ts: Date.now() + 5000, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: ["hello"] }) });
	relay.injectStored(TEAM_HEX, own, alice.id);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(capsOf(alice).length, before);
});

test("OW-F005: a presence that comes after a gap of more than 90 s marks caps due, and they go at the next tick the minimum spacing allows, not at once", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	let clock = Date.now();
	const a = rig("alice", { capsMinMs: 200_000, now: () => clock });
	await a.holder.start();
	await until(() => capsOf(alice).length === 1, 3000, "alice's first caps");
	const roster = view(entries);
	const presence = (ts: number) => buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: carol, seq: 0, ts, kind: "presence", to: [], plaintext: encodePlaintext("presence", { label: "carol", headSeq: roster.head.seq, headHash: roster.head.hash, workspaces: [] }) });
	relay.injectStored(TEAM_HEX, presence(clock), alice.id);
	await new Promise((r) => setTimeout(r, 100));
	clock += 100_000; // carol was silent for more than 90 s
	relay.injectStored(TEAM_HEX, presence(clock), alice.id);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(capsOf(alice).length, 1, "the minimum spacing holds: 100 s since the last caps is under the 200 s this holder keeps");
	clock += 101_000;
	await until(() => capsOf(alice).length === 2, 3000, "the due caps once the spacing is over");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(capsOf(alice).length, 2, "and once");
});

test("OW-F001: a caps with no word asks nothing of the peer", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	const a = rig("alice", { capsMinMs: 5 });
	await a.holder.start();
	await until(() => capsOf(alice).length >= 1, 3000, "alice's first caps");
	await new Promise((r) => setTimeout(r, 100));
	const before = capsOf(alice).length, roster = view(entries);
	const plain = (ts: number) => buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: carol, seq: 0, ts, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: ["unit-stop"] }) });
	relay.injectStored(TEAM_HEX, plain(Date.now()), alice.id);
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(capsOf(alice).length, before);
	assert.deepEqual(a.holder.capsFor(TEAM_HEX, carol.id), ["unit-stop"]);
});

// ---- operate/1 only where a policy grants operate (review OW-F002) ---------------------------------------------------------------------------------------------------------

test("OW-F002: a box whose policy grants nobody does not list operate/1, lists it when the policy gains a grant and drops it when the grant goes; the operate side is told each change", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	let granted = false;
	const told: boolean[] = [];
	const a = rig("alice"), d = rig("dave", { operateOn: () => granted, operateChanged: (on) => void told.push(on) });
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).length > 0, 3000, "the box's caps");
	assert.ok(!a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), "no grant, no entry: no controller offers this box");
	assert.deepEqual(told, [false], "the operate side is told once at the first tick");
	granted = true;
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "the caps after the grant came");
	granted = false;
	await until(() => !a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "the caps after the grant went");
	assert.deepEqual(told, [false, true, false]);
});

test("OW-F002: an operateOn that throws reads as no grant", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id, carol.id], entries);
	const a = rig("alice"), d = rig("dave", { operateOn: () => { throw new Error("policy unreadable"); } });
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).length > 0, 3000, "the box's caps");
	assert.ok(!a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"));
});
