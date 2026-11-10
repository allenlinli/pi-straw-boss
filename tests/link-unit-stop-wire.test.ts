import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { CanonError, bool, dec, enc, list, readList, str } from "../src/link/canon.ts";
import { CAPS_FEATURES, LinkHolder } from "../src/link/holder.ts";
import { decodePlaintext, encodePlaintext, KINDS, LIMITS, type MainStatus } from "../src/link/kinds.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// The wire of an admin's remote stop (docs/specs/2026-11-07-link-remote-stop.md §3): the `unit-stop` kind, the optional `mains` of `unit-status`, and the `caps` that gate both. alice is an attended
// controller at dispatch, bob another, dave and eve unattended boxes.

const { alice, bob, dave, eve } = DEVICES;
const STOP = "00112233445566778899aabbccddeeff", HANDLE = "0123456789abcdef";
const main = (over: Partial<MainStatus> = {}): MainStatus => ({ handle: HANDLE, unit: "build", name: "docs", state: "idle", by: alice.id, stopping: false, ...over });

test("unit-stop is a queued kind for one box, from attended senders only", () => {
	assert.deepEqual(KINDS["unit-stop"], { ephemeral: false, wholeTeam: false, sender: "attended", live: false });
});

test("a unit-stop round trips and is decoded strictly: 4 fields, a stop id of 32 and a handle of 16 lowercase hex digits", () => {
	const plain = { stopId: STOP, handle: HANDLE, mode: "interrupt", reason: "never idles" };
	assert.deepEqual(decodePlaintext("unit-stop", encodePlaintext("unit-stop", plain)), plain);
	const four = (id: string, handle: string, mode = "quit", reason = "") => enc(str(id), str(handle), str(mode), str(reason));
	assert.equal(decodePlaintext("unit-stop", four(STOP.toUpperCase(), HANDLE)), null);
	assert.equal(decodePlaintext("unit-stop", four(STOP.slice(1), HANDLE)), null);
	assert.equal(decodePlaintext("unit-stop", four(STOP, HANDLE.slice(1))), null);
	assert.equal(decodePlaintext("unit-stop", four(STOP, HANDLE.toUpperCase())), null);
	assert.equal(decodePlaintext("unit-stop", enc(str(STOP), str(HANDLE), str("quit"))), null, "three fields");
	assert.equal(decodePlaintext("unit-stop", enc(str(STOP), str(HANDLE), str("quit"), str(""), str("x"))), null, "five fields");
	assert.throws(() => encodePlaintext("unit-stop", { ...plain, stopId: "nope" }), RangeError);
	assert.throws(() => encodePlaintext("unit-stop", { ...plain, handle: "nope" }), RangeError);
	assert.equal(dec(encodePlaintext("unit-stop", plain)).length, 4);
});

test("a mode this build does not know decodes, so the box can refuse it by name; the reason is one line of at most 200 bytes", () => {
	assert.equal(decodePlaintext("unit-stop", enc(str(STOP), str(HANDLE), str("kill"), str("")))!.mode, "kill");
	assert.equal(decodePlaintext("unit-stop", encodePlaintext("unit-stop", { stopId: STOP, handle: HANDLE, mode: "quit", reason: "a".repeat(300) }))!.reason.length, LIMITS.stopReason);
	assert.equal(decodePlaintext("unit-stop", encodePlaintext("unit-stop", { stopId: STOP, handle: HANDLE, mode: "quit", reason: "one\ntwo\r\x1b[3Gthree" }))!.reason, "one two  [3Gthree");
	assert.equal(decodePlaintext("unit-stop", enc(str(STOP), str(HANDLE), str("quit"), str("x\ny")))!.reason, "x y", "a sender that skipped its own cleaning is cleaned on the way in");
});

test("a unit-status takes 1 or 2 fields; the second is the mains, cut to 20 entries and names of 40 characters", () => {
	const units = [{ unit: "build", state: "working", monitors: [], report: "r" }];
	assert.equal(dec(encodePlaintext("unit-status", { units })).length, 1, "no mains: the field is not written");
	assert.deepEqual(decodePlaintext("unit-status", encodePlaintext("unit-status", { units })), { units });
	const two = { units, mains: [main(), main({ handle: "fedcba9876543210", name: "api", state: "working", stopping: true })] };
	assert.equal(dec(encodePlaintext("unit-status", two)).length, 2);
	assert.deepEqual(decodePlaintext("unit-status", encodePlaintext("unit-status", two)), two);
	assert.deepEqual(decodePlaintext("unit-status", encodePlaintext("unit-status", { units, mains: [] })), { units, mains: [] });
	assert.equal(decodePlaintext("unit-status", encodePlaintext("unit-status", { units, mains: Array.from({ length: 25 }, (_, i) => main({ name: `m${i}` })) }))!.mains!.length, LIMITS.mains);
	assert.equal(decodePlaintext("unit-status", encodePlaintext("unit-status", { units, mains: [main({ name: "n".repeat(60) })] }))!.mains![0]!.name.length, 40);
	const body = dec(encodePlaintext("unit-status", { units }))[0]!;
	assert.equal(decodePlaintext("unit-status", enc(body, list([]), str("x"))), null, "three fields");
	assert.equal(decodePlaintext("unit-status", enc()), null, "none");
	assert.throws(() => dec(enc(body, list([]), str("x")), 2), CanonError);
	assert.equal(decodePlaintext("unit-status", enc(body, enc(str("x")))), null, "a mains field that is not a list of mains");
});

test("this build lists unit-stop, unit-status.mains and unit-status.kind in its caps", () => {
	assert.ok(CAPS_FEATURES.includes("unit-stop") && CAPS_FEATURES.includes("unit-status.mains") && CAPS_FEATURES.includes("unit-status.kind"));
	assert.ok(CAPS_FEATURES.length <= LIMITS.capsFeatures);
});

test("a main's kind is an optional seventh field of its entry: the word of a coordinator, integrator, standing main or a train, cut to 16 bytes; a six-field entry has none", () => {
	const units = [{ unit: "build", state: "working", monitors: [], report: "r" }];
	assert.equal(LIMITS.mainKind, 16);
	const six = encodePlaintext("unit-status", { units, mains: [main()] }), seven = encodePlaintext("unit-status", { units, mains: [main({ kind: "integrator" })] });
	const entry = (b: Buffer) => readList(dec(b)[1]!)[0]!;
	assert.equal(dec(entry(six)).length, 6, "no kind: the field is not written, so a box of before wrote the same bytes");
	assert.equal(dec(entry(seven)).length, 7);
	assert.deepEqual(decodePlaintext("unit-status", seven), { units, mains: [main({ kind: "integrator" })] });
	assert.equal(decodePlaintext("unit-status", six)!.mains![0]!.kind, undefined, "an entry of six fields has no kind key at all");
	for (const kind of ["coordinator", "integrator", "standing", "train"]) assert.equal(decodePlaintext("unit-status", encodePlaintext("unit-status", { units, mains: [main({ kind })] }))!.mains![0]!.kind, kind);
	assert.equal(decodePlaintext("unit-status", encodePlaintext("unit-status", { units, mains: [main({ kind: "k".repeat(40) })] }))!.mains![0]!.kind!.length, LIMITS.mainKind);
	const eight = enc(str(HANDLE), str("build"), str("docs"), str("idle"), str(alice.id), bool(false), str("train"), str("x"));
	assert.equal(decodePlaintext("unit-status", enc(dec(six)[0]!, list([eight]))), null, "eight fields");
});

// ---- the holder: caps gate both ways ------------------------------------------------------------------------------------------------------------------------

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-unit-stop-wire-"));
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
let skew = 0;
function rig(who: "alice" | "dave" | "eve", o: { trust?: Record<string, "reply" | "forward" | "dispatch">; capsMs?: number } = {}) {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const stops: unknown[] = [];
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who === "alice", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(Object.entries(o.trust ?? {})), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: o.capsMs ?? 3600_000, capsMinMs: 5,
		unitStop: (a) => void stops.push(a), now: () => Date.now() + skew,
	});
	cleanup.push(() => holder.stop());
	return { holder, store, stops };
}
const caps = (r: ReturnType<typeof rig>, device: string) => r.holder.capsFor(TEAM_HEX, device);
const log = (r: ReturnType<typeof rig>) => {
	try {
		return readFileSync(join(r.store.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const UNITS = [{ unit: "build", state: "working", monitors: [], report: "r" }];
beforeEach(() => void (skew = 0));

test("a controller asks a box to stop only when the box's fresh caps list unit-stop; the answer says sent, or why not", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	const a = rig("alice", { trust: {} }), d = rig("dave", { trust: { [alice.id]: "dispatch" } }), e = rig("eve");
	await a.holder.start();
	const before = await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "quit" });
	assert.equal(before.ok, false);
	assert.match(before.ok ? "" : before.error, /does not take stop requests yet/, "no caps seen: nothing is sent");
	await Promise.all([d.holder.start(), e.holder.start()]);
	await until(() => caps(a, dave.id).includes("unit-stop"), 3000, "dave's caps");
	const sent = await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "interrupt", reason: "never idles" });
	assert.ok(sent.ok && sent.status === "sent" && /^[0-9a-f]{32}$/.test(sent.stopId));
	await until(() => d.stops.length === 1, 3000, "the stop on dave");
	const got = d.stops[0] as { stopId: string; handle: string; mode: string; reason: string; from: string };
	assert.deepEqual([got.stopId, got.handle, got.mode, got.reason, got.from], [sent.stopId, HANDLE, "interrupt", "never idles", alice.id]);
	assert.equal((await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: "nope", mode: "quit" })).ok, false, "a handle that is not one");
	assert.equal((await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "kill" })).ok, false, "a mode this build does not take");
	assert.equal((await a.holder.requestUnitStop(TEAM_HEX, bob.id, { handle: HANDLE, mode: "quit" })).ok, false, "an attended device takes no stop");
	assert.equal((await a.holder.requestUnitStop(TEAM_HEX, alice.id, { handle: HANDLE, mode: "quit" })).ok, false, "not itself");
	assert.equal((await e.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "quit" })).ok, false, "an unattended device asks no one");
	skew += 3 * 3600_000;
	assert.equal((await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "quit" })).ok, false, "caps older than 2 hours count as none");
});

test("a relay that does not know unit-stop refuses it for good, and the answer says so", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	relay.rejectKinds.add("unit-stop");
	const a = rig("alice"), d = rig("dave");
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => caps(a, dave.id).includes("unit-stop"), 3000, "dave's caps");
	const refused = await a.holder.requestUnitStop(TEAM_HEX, dave.id, { handle: HANDLE, mode: "quit" });
	assert.equal(refused.ok, false);
	assert.match(refused.ok ? "" : refused.error, /relay does not take stop requests yet/);
	assert.equal(d.stops.length, 0);
});

test("a box writes mains only to a controller whose caps list unit-status.mains; any other gets the one-field status of before", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	relay.rejectKinds.add("caps");
	const a = rig("alice"), d = rig("dave");
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => log(a).some((x) => x.event === "caps-unsupported") && log(d).some((x) => x.event === "caps-unsupported"), 3000, "no caps on either side");
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main()]);
	await until(() => a.holder.summary().units.length === 1, 3000, "the status on alice");
	assert.equal(a.holder.summary().units[0]!.mains, undefined, "dave had seen no caps of alice: one field");
	relay.rejectKinds.clear();
	skew += 90 * 60_000;
	await until(() => caps(d, alice.id).includes("unit-status.mains"), 3000, "alice's caps on dave");
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main({ name: "api", stopping: true })]);
	await until(() => a.holder.summary().units[0]!.mains !== undefined, 3000, "the mains on alice");
	assert.deepEqual(a.holder.summary().units[0]!.mains, [main({ name: "api", stopping: true })]);
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS);
	await until(() => a.holder.summary().units[0]!.mains === undefined, 3000, "a status without mains replaces the last");
	skew += 3 * 3600_000;
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main()]);
	await until(() => a.holder.summary().units.length === 1, 3000, "the new status on alice (the earlier one has aged out)");
	assert.equal(a.holder.summary().units[0]?.mains, undefined, "alice's caps are stale at dave: one field again");
	assert.ok(!log(d).some((x) => x.reason === "bad-plaintext"));
});

test("a box writes a main's kind only to a controller whose caps list unit-status.kind; a controller that lists unit-status.mains alone gets the six-field entries of before", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);
	relay.rejectKinds.add("caps");
	const a = rig("alice"), d = rig("dave");
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => log(a).some((x) => x.event === "caps-unsupported") && log(d).some((x) => x.event === "caps-unsupported"), 3000, "no caps on either side");
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main({ kind: "integrator" })]);
	await until(() => a.holder.summary().units.length === 1, 3000, "the status on alice");
	assert.equal(a.holder.summary().units[0]!.mains, undefined, "no caps seen: no mains, so no kind");
	relay.rejectKinds.clear();
	skew += 90 * 60_000;
	await until(() => caps(d, alice.id).includes("unit-status.kind"), 3000, "alice's caps on dave");
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main({ kind: "integrator" }), main({ handle: "fedcba9876543210", name: "api", kind: "train" })]);
	await until(() => a.holder.summary().units[0]!.mains?.length === 2, 3000, "the mains on alice");
	assert.deepEqual(a.holder.summary().units[0]!.mains!.map((x) => x.kind), ["integrator", "train"]);
	// A peer that lists mains but not kind (a build before this one): the box strips the kind, so its decoder, which takes six fields, still reads the entry.
	const old = (d.holder as unknown as { runs: Map<string, { caps: Map<string, { at: number; features: string[] }> }> }).runs.get(TEAM_HEX)!.caps;
	old.set(alice.id, { at: Date.now() + skew, features: ["unit-status.mains"] });
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main({ kind: "standing" })]);
	await until(() => a.holder.summary().units[0]!.mains?.length === 1, 3000, "the six-field entry on alice");
	assert.equal(a.holder.summary().units[0]!.mains![0]!.kind, undefined);
	assert.ok(!log(a).some((x) => x.reason === "bad-plaintext"));
});
