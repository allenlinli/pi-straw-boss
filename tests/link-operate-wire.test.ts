import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { enc, int, list, str } from "../src/link/canon.ts";
import { operateEphemeral, operateKeys, operateOpen, operateSeal, sha256 } from "../src/link/crypto.ts";
import { buildEnvelope, encodeEnvelope, openEnvelope } from "../src/link/envelope.ts";
import { CAPS_FEATURES, LinkHolder, type OperateIn } from "../src/link/holder.ts";
import { decodePlaintext, encodePlaintext, KINDS, operateBody, operateDirectionOk, type Kind, type OperateMessage } from "../src/link/kinds.ts";
import { RelayClient, RateLimitedError } from "../src/link/relay.ts";
import type { DeviceKeys } from "../src/link/device.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { decodeRelayEvent, EventStream, SseParser, type RelayEvent } from "../src/link/sse.ts";
import { LinkStore } from "../src/link/store.ts";
import { receiveState, baseState, NOW } from "./link/envelope-cases.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { liveStream, until } from "./link/fakes.ts";
import { netOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// The wire of Straw Link operate (docs/specs/2026-11-07-link-operate.md §5.1, §5.2, §11 row 1): the `live` class of kind, the `operate` kind and its
// outer structure, the session key and frame AEAD, the SSE `live` event, `postLive`, and the holder's caps-gated, serial send.

const { alice, bob, carol, dave } = DEVICES;
const SESSION = Buffer.alloc(16, 0x11), EPH = Buffer.alloc(32, 0x22);
const open: OperateMessage = { session: SESSION, type: "open", eph: EPH, caps: ["operate/1"], want: "team" };

test("operate is the one live kind: ephemeral, addressed, any sender; every other kind is not live", () => {
	assert.deepEqual(KINDS.operate, { ephemeral: true, wholeTeam: false, sender: "any", live: true });
	for (const k of Object.keys(KINDS) as Kind[]) if (k !== "operate") assert.equal(KINDS[k].live, false, k);
});

test("the outer structure round trips for each type and is decoded strictly", () => {
	const msgs: OperateMessage[] = [
		open,
		{ session: SESSION, type: "accept", eph: EPH, openHash: sha256(operateBody(open)), scope: { teams: [TEAM], box: true }, limits: { mirrors: 2, watches: 4, budget: 900 } },
		{ session: SESSION, type: "refuse", reason: "not-admin" },
		{ session: SESSION, type: "frame", ctr: 1, ct: Buffer.alloc(40, 7) },
		{ session: SESSION, type: "close", reason: "roster" },
	];
	for (const m of msgs) assert.deepEqual(decodePlaintext("operate", encodePlaintext("operate", m)), m, m.type);
	const outer = (v: number, session: Buffer, type: string, body: Buffer) => enc(int(v), session, str(type), body);
	assert.equal(decodePlaintext("operate", outer(2, SESSION, "open", operateBody(open))), null, "version 2");
	assert.equal(decodePlaintext("operate", outer(1, SESSION.subarray(1), "open", operateBody(open))), null, "short session");
	assert.equal(decodePlaintext("operate", outer(1, SESSION, "req", operateBody(open))), null, "unknown type");
	assert.equal(decodePlaintext("operate", outer(1, SESSION, "open", enc(EPH, list([]), str("everything")))), null, "want");
	assert.equal(decodePlaintext("operate", outer(1, SESSION, "open", enc(EPH.subarray(1), list([]), str("box")))), null, "short eph");
	assert.equal(decodePlaintext("operate", outer(1, SESSION, "frame", enc(int(0), Buffer.alloc(40)))), null, "ctr 0");
	assert.equal(decodePlaintext("operate", outer(1, SESSION, "frame", enc(int(1), Buffer.alloc(8)))), null, "no room for a tag");
	assert.equal(decodePlaintext("operate", Buffer.concat([encodePlaintext("operate", open), Buffer.from([0])])), null, "trailing byte");
});

test("direction: an attended sender opens and frames and closes; an unattended one accepts, refuses, frames and closes", () => {
	for (const t of ["open", "frame", "close"] as const) assert.equal(operateDirectionOk(t, true), true, t);
	for (const t of ["accept", "refuse"] as const) assert.equal(operateDirectionOk(t, true), false, t);
	for (const t of ["accept", "refuse", "frame", "close"] as const) assert.equal(operateDirectionOk(t, false), true, t);
	assert.equal(operateDirectionOk("open", false), false);
});

test("the session key: X25519 and HKDF over the spec's info; both ends derive the same two halves, and the nonce and AAD layouts hold", () => {
	const op = operateEphemeral(Buffer.alloc(32, 1)), box = operateEphemeral(Buffer.alloc(32, 2));
	const common = { team: TEAM, session: SESSION, operator: alice.id, box: dave.id, ephOp: op.pub, ephBox: box.pub };
	const a = operateKeys({ ...common, mine: op.key, theirs: box.pub }), b = operateKeys({ ...common, mine: box.key, theirs: op.pub });
	assert.deepEqual(a, b);
	assert.equal(a.toBox.length, 32);
	assert.notDeepEqual(a.toBox, a.toOperator);
	assert.notDeepEqual(operateKeys({ ...common, session: Buffer.alloc(16, 9), mine: op.key, theirs: box.pub }), a, "the session id is in the info");
	assert.notDeepEqual(operateKeys({ ...common, box: bob.id, mine: op.key, theirs: box.pub }), a, "the box id is in the info");
	const ct = operateSeal({ key: a.toBox, dir: "toBox", session: SESSION, ctr: 5, plaintext: Buffer.from("hi") });
	const c = createCipheriv("chacha20-poly1305", a.toBox, Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("0000000000000005", "hex")]), { authTagLength: 16 });
	c.setAAD(Buffer.concat([SESSION, Buffer.from("0000000000000005", "hex")]), { plaintextLength: 2 });
	assert.equal(Buffer.concat([c.update("hi"), c.final(), c.getAuthTag()]).toString("hex"), ct.toString("hex"));
	assert.equal(operateOpen({ key: a.toBox, dir: "toBox", session: SESSION, ctr: 5, ct })?.toString(), "hi");
	assert.equal(operateOpen({ key: a.toBox, dir: "toOperator", session: SESSION, ctr: 5, ct }), null, "wrong direction");
	assert.equal(operateOpen({ key: a.toBox, dir: "toBox", session: SESSION, ctr: 6, ct }), null, "wrong ctr");
	assert.equal(operateOpen({ key: a.toBox, dir: "toBox", session: Buffer.alloc(16, 3), ctr: 5, ct }), null, "wrong session");
	assert.throws(() => operateSeal({ key: a.toBox, dir: "toBox", session: SESSION, ctr: 0, plaintext: Buffer.alloc(1) }), RangeError);
});

test("an operate envelope is ephemeral, seq 0, and its ts has to rise per sender", () => {
	const state = receiveState(baseState());
	const head = state.roster.head;
	const build = (ts: number) => buildEnvelope({ team: TEAM, epoch: state.roster.epoch, teamKey: teamKey(state.roster.epoch), head, from: alice, seq: 9, ts, kind: "operate", to: [bob.id], plaintext: encodePlaintext("operate", open) });
	const e = build(NOW);
	assert.equal(e.header.ephemeral, true);
	assert.equal(e.header.seq, 0);
	const ok = openEnvelope(e, state);
	assert.ok(ok.ok && ok.message && (ok.message as OperateMessage).type === "open");
	const again = openEnvelope(build(NOW), { ...state, lastEphemeral: new Map([[`${alice.id}/operate`, NOW]]) });
	assert.deepEqual(again, { ok: false, reason: "stale-ephemeral" });
});

// ---- SSE ---------------------------------------------------------------------------------------------------------------------------------------------------------

const liveData = (n = 0) => {
	const state = receiveState(baseState());
	const e = buildEnvelope({ team: TEAM, epoch: state.roster.epoch, teamKey: teamKey(state.roster.epoch), head: state.roster.head, from: alice, seq: 0, ts: NOW, kind: "operate", to: [bob.id], plaintext: encodePlaintext("operate", open) });
	return { e, data: JSON.stringify({ id: e.header.id.toString("hex"), from: alice.id, ephemeral: true, ...(n ? { dropped: n } : {}), envelope: encodeEnvelope(e).toString("base64url") }) };
};

test("a live event decodes, carries the dropped hint, ignores an inherited id, and has eid 0 so the cursor never moves", () => {
	const { e, data } = liveData(3);
	const p = new SseParser();
	const out = p.push(`id: 41\nevent: roster\ndata: {}\n\nevent: live\ndata: ${data}\n\n`).messages;
	assert.equal(out[1]!.id, "41", "the parser keeps the last id as the standard says; a live event ignores it");
	const ev = decodeRelayEvent(out[1]!);
	assert.ok(ev?.type === "live" && ev.eid === 0 && ev.dropped === 3 && ev.from === alice.id && ev.id.equals(e.header.id) && ev.envelope.header.kind === "operate");
	const plain = decodeRelayEvent({ event: "live", data: liveData().data });
	assert.ok(plain?.type === "live" && plain.dropped === 0);
	const bad = decodeRelayEvent({ id: "5", event: "live", data: JSON.stringify({ ...JSON.parse(data), dropped: -1 }) });
	assert.equal(bad?.type, "malformed");
	assert.equal(bad?.type === "malformed" && bad.id, undefined, "nothing is acknowledged for a live event");
	const flag = decodeRelayEvent({ event: "live", data: JSON.stringify({ ...JSON.parse(data), ephemeral: false }) });
	assert.equal(flag?.type, "malformed");
	// The event's own fields have to match the envelope's header.
	const mismatch = (patch: Record<string, unknown>) => decodeRelayEvent({ event: "live", data: JSON.stringify({ ...JSON.parse(data), ...patch }) });
	assert.equal(mismatch({ id: "ff".repeat(16) })?.type, "malformed", "id differs from the header's");
	assert.equal(mismatch({ from: bob.id })?.type, "malformed", "from differs from the header's");
	const stored = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: receiveState(baseState()).roster.head, from: alice, seq: 5, ts: NOW, kind: "tower", to: [bob.id], plaintext: encodePlaintext("tower", { fromWorkspace: "a", toWorkspace: "b", replyExpected: false, text: "x" }) });
	assert.equal(stored.header.ephemeral, false);
	assert.equal(mismatch({ id: stored.header.id.toString("hex"), envelope: encodeEnvelope(stored).toString("base64url") })?.type, "malformed", "the envelope itself is not ephemeral");
});

test("a live event reaches the handler but is never acknowledged and never moves the resume cursor", async () => {
	let conn!: ReturnType<typeof liveStream>;
	const seen: RelayEvent[] = [], acked: Buffer[] = [];
	const stream = new EventStream({ open: async (_id, signal) => ((conn = liveStream(signal)), conn.response), onEvent: (e) => { seen.push(e); return "ack"; }, onAck: (id) => acked.push(id), lastEventId: 7, sleep: async () => {} });
	void stream.start();
	await until(() => conn !== undefined, 3000, "the connection");
	conn.push(`id: 8\nevent: caps\ndata: {}\n\nevent: live\ndata: ${liveData().data}\n\n`);
	await until(() => seen.some((e) => e.type === "live"), 3000, "the live event");
	assert.equal(stream.lastEventId, 8, "the unknown event moved it; the live one did not move it further");
	assert.deepEqual(acked, []);
	await stream.stop();
});

// ---- postLive ---------------------------------------------------------------------------------------------------------------------------------------------------

test("postLive answers how many streams took it, and an old relay's unknown-kind and a 429 reach the caller as they are", async () => {
	let status = 201, body: unknown = { id: "00".repeat(16), delivered: 2 };
	const client = new RelayClient({ url: "http://relay.test", device: alice, fetch: async () => new Response(JSON.stringify(body), { status }) });
	const { e } = liveData();
	assert.deepEqual((await client.postLive(TEAM, e)).delivered, 2);
	body = { id: "00".repeat(16), delivered: 0 };
	assert.equal((await client.postLive(TEAM, e)).delivered, 0);
	status = 422; body = { error: "unknown-kind" };
	await assert.rejects(client.postLive(TEAM, e), (err: { code: string }) => err.code === "unknown-kind");
	status = 429; body = { error: "rate-limited" };
	await assert.rejects(client.postLive(TEAM, e), RateLimitedError);
	status = 201; body = { id: "00".repeat(16) };
	await assert.rejects(client.postLive(TEAM, e), /out of shape/);
});

// ---- the holder -----------------------------------------------------------------------------------------------------------------------------------------------

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "psb-operate-wire-")); relay = new FakeRelay(); });
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); rmSync(root, { recursive: true, force: true }); });
/** The relay client each rig built, by device name, for a test that watches what the holder asks of it. */
const clients: Partial<Record<"alice" | "bob" | "carol" | "dave", RelayClient>> = {};
const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const [who, attended] of [["bob", true], ["dave", false], ["carol", false]] as const) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	return log;
})();
function rig(who: "alice" | "bob" | "carol" | "dave", withOperate: boolean, now?: () => number, sink?: (m: OperateIn) => void) {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-p`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const got: OperateIn[] = [];
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who === "alice" || who === "bob", ...(now ? { now } : {}), net: async () => netOf([[`tower-${who}`, `w-${who}`, `l-${who}`, project]]), relay: (url: string, device: DeviceKeys) => (clients[who] = new RelayClient({ url, device, fetch: (i, init) => relay.fetch(i, init), timeoutMs: 2000 })),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: 5,
		...(withOperate ? { operate: sink ?? ((m: OperateIn) => void got.push(m)) } : {}),
	});
	cleanup.push(() => holder.stop());
	return { holder, got };
}

test("operate/1 is in the caps only of a build that takes it; an old peer's caps are unchanged", async () => {
	assert.ok(CAPS_FEATURES.includes("operate/1"));
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", false);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).length > 0 && d.holder.capsFor(TEAM_HEX, alice.id).length > 0, 3000, "caps");
	assert.ok(d.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"));
	assert.ok(!a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), "dave has no operate sink");
});

test("sendLive is refused up front without the peer's operate/1; with it, frames arrive in order with a rising ts, and are never stored", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", true);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "caps");
	const results = await Promise.all([1, 2, 3, 4].map((ctr) => a.holder.sendLive(TEAM_HEX, dave.id, { session: SESSION, type: "frame", ctr, ct: Buffer.alloc(32, ctr) })));
	assert.deepEqual(results.map((r) => r.delivered), [1, 1, 1, 1]);
	await until(() => d.got.length === 4, 3000, "four frames");
	assert.deepEqual(d.got.map((m) => (m.message.type === "frame" ? m.message.ctr : 0)), [1, 2, 3, 4]);
	assert.ok(d.got.every((m) => m.from === alice.id && m.fromAttended && m.dropped === 0));
	assert.equal(relay.stored.filter((s) => s.envelope.header.kind === "operate").length, 0, "a live envelope is never kept");
	assert.deepEqual(relay.liveTs, [...relay.liveTs].sort((x, y) => x - y));
	assert.equal(new Set(relay.liveTs).size, 4, "strictly rising");
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, { session: SESSION, type: "accept", eph: EPH, openHash: Buffer.alloc(32), scope: { teams: [], box: false }, limits: { mirrors: 1, watches: 1, budget: 1 } }), /direction|attended/i);
});

test("a peer without operate/1 is told so; a relay without the kind is told so, left alone, and tried again on a new stream", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", false);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).length > 0, 3000, "dave's caps");
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, open), (e: Error & { reason?: string }) => e.reason === "peer" && /does not take operate yet/.test(e.message));
	await d.holder.stop();
	const d2 = rig("dave", true);
	relay.rejectKinds.add("operate");
	await d2.holder.start();
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "dave's new caps");
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, open), (e: Error & { reason?: string }) => e.reason === "relay" && /relay does not take operate yet/.test(e.message));
	relay.rejectKinds.clear();
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, open), (e: Error & { reason?: string }) => e.reason === "relay", "left alone until a stream opens again");
	relay.dropStreams();
	await until(() => relay.opened.filter((o) => o.device === alice.id).length >= 2, 3000, "alice's stream again");
	assert.equal((await a.holder.sendLive(TEAM_HEX, dave.id, open)).delivered, 1);
});

test("a live event from the wrong direction, or with no sink, is dropped and logged; one in direction reaches the sink", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", true);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => d.holder.capsFor(TEAM_HEX, alice.id).includes("operate/1"), 3000, "caps");
	// dave (unattended) sends an `open`: a wrong direction, refused before it leaves.
	await assert.rejects(d.holder.sendLive(TEAM_HEX, alice.id, open), /direction/i);
	// forged on the wire by a relay test double: alice receives an unattended sender's `open`
	const roster = view(entries);
	const forged = buildEnvelope({ team: TEAM, epoch: roster.epoch, teamKey: teamKey(roster.epoch), head: roster.head, from: dave, seq: 0, ts: Date.now() - 1000, kind: "operate", to: [alice.id], plaintext: encodePlaintext("operate", open) });
	assert.equal(relay.injectLive(TEAM_HEX, forged, alice.id), 1);
	await d.holder.sendLive(TEAM_HEX, alice.id, { session: SESSION, type: "refuse", reason: "no" });
	await until(() => a.got.length === 1, 3000, "the refuse");
	assert.deepEqual(a.got.map((m) => m.message.type), ["refuse"], "the forged open, which came first, was dropped");
	assert.equal(a.got[0]!.fromAttended, false);
	assert.ok(logOf("alice").some((l) => l.event === "drop" && l.reason === "operate-direction" && l.type === "open"));
});

// ---- the review round (RV-F001 to RV-F013) --------------------------------------------------------------------------------------------------------------------

function logOf(who: string) {
	const file = join(root, who, "link", "link.log");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}
const envFor = (from: typeof alice, to: string[], ts: number, m: OperateMessage = open, kind: Kind = "operate") => {
	const r = view(entries);
	return buildEnvelope({ team: TEAM, epoch: r.epoch, teamKey: teamKey(r.epoch), head: r.head, from, seq: 0, ts, kind, to, plaintext: encodePlaintext(kind, kind === "operate" ? m : ({ features: [] } as never)) });
};
const streamOf = (who: typeof alice) => until(() => relay.opened.some((o) => o.device === who.id), 3000, `${who.id}'s stream`);
/** A close sent last, newer than everything before it: events of one stream are handled in order, so once it is taken the ones before it were decided. */
const marker = async (to: typeof alice, from: typeof alice, got: OperateIn[]) => {
	relay.injectLive(TEAM_HEX, envFor(from, [to.id], Date.now() + 5, { session: SESSION, type: "close", reason: "marker" }), to.id);
	await until(() => got.some((m) => m.message.type === "close" && (m.message as { reason: string }).reason === "marker"), 3000, "the marker");
};
const types = (got: OperateIn[]) => got.map((m) => m.message.type);

test("RV-F001: a relay that answers a live post in the stored shape is posted to once, then left alone (fail closed)", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", true);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "caps");
	const orig = relay.fetch;
	let posts = 0;
	relay.fetch = async (input, init) => {
		if (init?.method === "POST" && String(input).endsWith("/envelopes")) return (posts++, new Response(JSON.stringify({ id: "00".repeat(16), duplicate: false }), { status: 201 }));
		return orig(input, init);
	};
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, open), (e: Error & { reason?: string }) => e.reason === "relay");
	await assert.rejects(a.holder.sendLive(TEAM_HEX, dave.id, open), (e: Error & { reason?: string }) => e.reason === "relay");
	assert.equal(posts, 1, "the second send never reaches the relay");
	assert.equal(logOf("alice").filter((l) => l.event === "operate-relay-not-live").length, 1);
});

test("RV-F002: a live envelope older than 60 s is a replay and is dropped; one 30 s old is taken", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const d = rig("dave", true);
	await d.holder.start();
	await streamOf(dave);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], Date.now() - 3600_000), dave.id);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], Date.now() - 61_000, { session: SESSION, type: "close", reason: "late" }), dave.id);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], Date.now() - 30_000, { session: SESSION, type: "close", reason: "fresh enough" }), dave.id);
	await until(() => d.got.length === 1, 3000, "the 30 s one");
	assert.equal((d.got[0]!.message as { reason: string }).reason, "fresh enough");
	assert.equal(logOf("dave").filter((l) => l.reason === "stale-live").length, 2);
});

test("RV-F003: the same live envelope twice in one run is taken once, and a frozen clock still sends a strictly rising ts", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const T = Date.now(), a = rig("alice", true, () => T), d = rig("dave", true);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "caps");
	for (let ctr = 1; ctr <= 3; ctr++) await a.holder.sendLive(TEAM_HEX, dave.id, { session: SESSION, type: "frame", ctr, ct: Buffer.alloc(32, ctr) });
	assert.deepEqual(relay.liveTs, [T, T + 1, T + 2]);
	await until(() => d.got.length === 3, 3000, "three frames");
	const again = envFor(alice, [dave.id], Date.now() + 1, { session: SESSION, type: "close", reason: "twice" });
	relay.injectLive(TEAM_HEX, again, dave.id);
	relay.injectLive(TEAM_HEX, again, dave.id);
	await marker(dave, alice, d.got);
	assert.deepEqual(types(d.got), ["frame", "frame", "frame", "close", "close"], "one `twice` and the marker");
});

test("RV-F004: an operate envelope names exactly one addressee; two are dropped by each of them", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const b = rig("bob", true), d = rig("dave", true);
	await Promise.all([b.holder.start(), d.holder.start()]);
	await Promise.all([streamOf(bob), streamOf(dave)]);
	const two = envFor(alice, [dave.id, bob.id], Date.now(), { session: SESSION, type: "close", reason: "fan-out" });
	relay.injectLive(TEAM_HEX, two, dave.id);
	relay.injectLive(TEAM_HEX, two, bob.id);
	await marker(dave, alice, d.got);
	await marker(bob, alice, b.got);
	assert.deepEqual(types(d.got), ["close"]);
	assert.deepEqual(types(b.got), ["close"]);
	assert.ok(logOf("dave").some((l) => l.reason === "operate-addressees"));
});

test("RV-F005: the session keys are only derived for two real device ids", () => {
	const op = operateEphemeral(Buffer.alloc(32, 1)), box = operateEphemeral(Buffer.alloc(32, 2));
	const common = { team: TEAM, session: SESSION, ephOp: op.pub, ephBox: box.pub, mine: op.key, theirs: box.pub };
	assert.throws(() => operateKeys({ ...common, operator: "ab", box: "c" }), RangeError);
	assert.throws(() => operateKeys({ ...common, operator: alice.id, box: dave.id.slice(1) }), RangeError);
	assert.throws(() => operateKeys({ ...common, operator: alice.id.toUpperCase(), box: dave.id }), RangeError);
});

test("RV-F007: operateOpen answers null, never throws, for a counter 0 or a session of 15 bytes", () => {
	const key = Buffer.alloc(32, 4), ct = operateSeal({ key, dir: "toBox", session: SESSION, ctr: 1, plaintext: Buffer.from("x") });
	assert.equal(operateOpen({ key, dir: "toBox", session: SESSION, ctr: 0, ct }), null);
	assert.equal(operateOpen({ key, dir: "toBox", session: Buffer.alloc(15), ctr: 1, ct }), null);
	assert.equal(operateOpen({ key, dir: "toBox", session: SESSION, ctr: 1, ct: ct.subarray(0, 5) }), null);
});

test("RV-F008: the encoder holds a message to the decoder's limits: a session of 16 bytes and a frame between 16 B and 200 KB", () => {
	assert.throws(() => encodePlaintext("operate", { ...open, session: Buffer.alloc(15) }), RangeError);
	assert.throws(() => encodePlaintext("operate", { session: SESSION, type: "frame", ctr: 1, ct: Buffer.alloc(15) }), RangeError);
	assert.throws(() => encodePlaintext("operate", { session: SESSION, type: "frame", ctr: 1, ct: Buffer.alloc(200 * 1024 + 1) }), RangeError);
	for (const n of [16, 200 * 1024]) assert.ok(decodePlaintext("operate", encodePlaintext("operate", { session: SESSION, type: "frame", ctr: 1, ct: Buffer.alloc(n) })), String(n));
});

test("RV-F009: an open is for the unattended box and an accept or refuse for the attended controller, whoever sent it", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const b = rig("bob", true), c = rig("carol", true);
	await Promise.all([b.holder.start(), c.holder.start()]);
	await Promise.all([streamOf(bob), streamOf(carol)]);
	relay.injectLive(TEAM_HEX, envFor(alice, [bob.id], Date.now()), bob.id);
	relay.injectLive(TEAM_HEX, envFor(dave, [carol.id], Date.now(), { session: SESSION, type: "refuse", reason: "x" }), carol.id);
	relay.injectLive(TEAM_HEX, envFor(alice, [carol.id], Date.now()), carol.id);
	await marker(bob, alice, b.got);
	await marker(carol, alice, c.got);
	assert.deepEqual(types(b.got), ["close"], "attended bob takes no open");
	assert.deepEqual(types(c.got), ["open", "close"], "unattended carol takes the open, not a refuse");
	assert.equal(logOf("bob").filter((l) => l.reason === "operate-role").length, 1);
});

test("RV-F010: an operate that arrives as a stored envelope is dropped unopened and logged, and does not move the replay record", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const d = rig("dave", true);
	await d.holder.start();
	await streamOf(dave);
	const ts = Date.now();
	relay.injectStored(TEAM_HEX, envFor(alice, [dave.id], ts), dave.id);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], ts, { session: SESSION, type: "close", reason: "same ts" }), dave.id);
	await until(() => d.got.length === 1, 3000, "the live one");
	assert.deepEqual(d.got.map((m) => (m.message as { reason?: string }).reason), ["same ts"]);
	assert.ok(logOf("dave").some((l) => l.event === "drop" && l.reason === "live-on-stored-path"));
});

test("RV-F011: a live envelope at a build with no sink, or of another kind, is dropped with its own reason and never reaches a sink", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const d = rig("dave", false), c = rig("carol", true);
	await Promise.all([d.holder.start(), c.holder.start()]);
	await Promise.all([streamOf(dave), streamOf(carol)]);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], Date.now()), dave.id);
	relay.injectLive(TEAM_HEX, envFor(alice, [carol.id], Date.now(), open, "caps"), carol.id);
	await marker(carol, alice, c.got);
	await until(() => logOf("dave").some((l) => l.reason === "operate-unsupported"), 3000, "the no-sink drop");
	assert.deepEqual(types(c.got), ["close"], "a live caps never reaches the sink");
	assert.ok(logOf("carol").some((l) => l.reason === "live-kind" && l.kind === "caps"));
	assert.ok(!logOf("dave").some((l) => l.event === "operate-sink-failed"));
});


// ---- task 5: what the box's bridge relies on --------------------------------------------------------------------------------------------------------------

test("a sink that throws is logged by the error's name only: what it threw may carry the text of a session", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const MARKER = "typed-text-must-not-reach-the-log";
	let calls = 0;
	const d = rig("dave", true, undefined, () => { calls++; throw new Error(MARKER); });
	await d.holder.start();
	await streamOf(dave);
	relay.injectLive(TEAM_HEX, envFor(alice, [dave.id], Date.now()), dave.id);
	await until(() => calls === 1, 3000, "the sink");
	await until(() => logOf("dave").some((l) => l.event === "operate-sink-failed"), 3000, "the log line");
	assert.deepEqual(logOf("dave").filter((l) => l.event === "operate-sink-failed").map((l) => l.error), ["Error"]);
	assert.ok(!readFileSync(join(root, "dave", "link", "link.log"), "utf8").includes(MARKER));
});

test("a live post carries a deadline of its own, so a stalled relay does not hold the serial chain of sends for ever", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, carol.id, dave.id], entries);
	const a = rig("alice", true), d = rig("dave", true);
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), 3000, "caps");
	const client = clients.alice!, orig = client.postLive.bind(client), signals: (AbortSignal | undefined)[] = [];
	client.postLive = (team, envelope, signal) => (signals.push(signal), orig(team, envelope, signal));
	await a.holder.sendLive(TEAM_HEX, dave.id, open);
	assert.equal(signals.length, 1);
	assert.ok(signals[0] instanceof AbortSignal && !signals[0].aborted, "the post is handed an abort signal that has not fired");
});
