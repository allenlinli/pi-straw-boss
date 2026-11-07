import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { operateEphemeral, operateKeys, operateOpen, operateSeal, sha256 } from "../src/link/crypto.ts";
import { operateBody, type OperateMessage } from "../src/link/kinds.ts";
import { joinKeys, OPERATE_LIMITS, OperateRegistry, OperateSession, refuseOpen, TEST_ENTROPY, type OperateDeps, type OperateDrop, type OperateEnd, type OperateInner } from "../src/link/operate.ts";
import { fakeClock } from "./fake-clock.ts";
import { DEVICES, TEAM } from "./link/scenario.ts";

// The operate session core (docs/specs/2026-11-07-link-operate.md §5.2, §5.3, §11 row 2): open, accept, refuse, close, the two keys, the counters, parts and deflate, pings, the
// 45 s silence, the 12 h rekey. A pure module over a fake transport and a fake clock: nothing here sleeps.

const { alice, dave } = DEVICES;
const V = JSON.parse(readFileSync(join(import.meta.dirname, "link", "vectors.json"), "utf8")).operateCases;
const h = (hex: string) => Buffer.from(hex, "hex");

type Opening = Extract<OperateMessage, { type: "open" }>;
type Accepted = Extract<OperateMessage, { type: "accept" }>;
const SCOPE = { teams: [TEAM], box: true }, LIMITS = { mirrors: 2, watches: 4, budget: 900 };

/** One end: what it sent, what it was told, on the shared clock. `send` can be made to fail. */
function end(clock: ReturnType<typeof fakeClock>, extra: Partial<OperateDeps> = {}) {
	const sent: OperateMessage[] = [], inner: OperateInner[] = [], ended: OperateEnd[] = [], drops: OperateDrop[] = [], opened: unknown[] = [], transportErrors: unknown[] = [];
	const deps: OperateDeps = {
		now: clock.now,
		send: (m) => void sent.push(m),
		onOpen: (a) => void opened.push(a),
		onInner: (i) => void inner.push(i),
		onEnd: (e) => void ended.push(e),
		onDrop: (d) => void drops.push(d),
		onTransportError: (e) => void transportErrors.push(e),
		...extra,
	};
	return { deps, sent, inner, ended, drops, opened, transportErrors };
}

/** An operator (alice) and a box (dave) that have run the handshake. `deliver` hands everything one sent to the other; `a` is the operator and `b` the box. */
function pair(clock = fakeClock(1_800_000_000_000)) {
	const a = end(clock), b = end(clock), registry = new OperateRegistry(clock.now);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const opening = a.sent[0] as Opening;
	const box = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open: opening, scope: SCOPE, limits: LIMITS, registry })!;
	const accepted = b.sent[0] as Accepted;
	op.receive(accepted, dave.id);
	const mark = { a: 1, b: 1 };
	const deliver = () => {
		for (const m of a.sent.slice(mark.a)) box.receive(m, alice.id);
		for (const m of b.sent.slice(mark.b)) op.receive(m, dave.id);
		mark.a = a.sent.length;
		mark.b = b.sent.length;
	};
	return { clock, a, b, op, box, opening, accepted, deliver, registry };
}

/** Both ends tick and trade what they sent, `steps` times, `ms` apart. */
function idle(p: ReturnType<typeof pair>, ms: number, steps: number) {
	for (let i = 0; i < steps; i++) {
		p.clock.advance(ms);
		p.op.tick();
		p.box.tick();
		p.deliver();
	}
}

const frames = (sent: OperateMessage[]) => sent.filter((m): m is Extract<OperateMessage, { type: "frame" }> => m.type === "frame");

// ---- the handshake --------------------------------------------------------------------------------------------------------------------------------------------

test("open sends an open with a fresh ephemeral key, accept answers with the hash of the open body, and both ends then hold the same two keys", () => {
	const p = pair();
	assert.equal(p.opening.type, "open");
	assert.deepEqual(p.opening.caps, ["operate/1"]);
	assert.equal(p.opening.want, "team");
	assert.equal(p.opening.session.length, 16);
	assert.equal(p.opening.eph.length, 32);
	assert.equal(p.accepted.type, "accept");
	assert.deepEqual(p.accepted.session, p.opening.session);
	assert.deepEqual(p.accepted.openHash, sha256(operateBody(p.opening)), "the box's signature will cover the operator's key");
	assert.deepEqual(p.accepted.scope, SCOPE);
	assert.deepEqual(p.accepted.limits, LIMITS);
	assert.equal(p.op.state, "open");
	assert.equal(p.box.state, "open");
	assert.deepEqual(p.a.opened, [{ scope: SCOPE, limits: LIMITS }], "what the box said, unclamped: task 6 clamps it");
	// A frame goes both ways and arrives whole.
	assert.equal(p.op.send({ t: "req", id: 1, m: "GET" }), true);
	assert.equal(p.box.send({ t: "snap", net: { bases: [] } }), true);
	p.deliver();
	assert.deepEqual(p.b.inner, [{ t: "req", id: 1, m: "GET" }]);
	assert.deepEqual(p.a.inner, [{ t: "snap", net: { bases: [] } }]);
});

test("every open uses a fresh ephemeral key and a fresh session id, so a reopen never resumes a counter", () => {
	const clock = fakeClock(1_800_000_000_000), a = end(clock);
	OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "box" });
	OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "box" });
	const [x, y] = a.sent as Opening[];
	assert.notDeepEqual(x!.eph, y!.eph);
	assert.notDeepEqual(x!.session, y!.session);
});

test("a refuse ends the opening session, with the box's word kept apart from ours; it does nothing to a session that is already open", () => {
	const clock = fakeClock(), a = end(clock);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const session = (a.sent[0] as Opening).session;
	op.receive({ session, type: "refuse", reason: "not-admin" }, dave.id);
	assert.equal(op.state, "closed");
	assert.deepEqual(a.ended, [{ reason: "refused", peer: "not-admin" }]);
	const p = pair();
	p.op.receive({ session: p.opening.session, type: "refuse", reason: "replayed" }, dave.id);
	assert.equal(p.op.state, "open", "a replayed open makes the box refuse a live session id; the live session ignores it");
	assert.equal(p.a.drops.at(-1)?.reason, "state");
	// refuseOpen is the box's one-line answer to an open it will not take.
	const b = end(clock);
	refuseOpen(b.deps, p.opening.session, "seen");
	assert.deepEqual(b.sent, [{ session: p.opening.session, type: "refuse", reason: "seen" }]);
});

test("an accept for another open, a wrong hash, another session or another sender is dropped and the session stays opening", () => {
	const clock = fakeClock(), a = end(clock), b = end(clock);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const opening = a.sent[0] as Opening;
	OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open: opening, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now) });
	const good = b.sent[0] as Accepted;
	op.receive({ ...good, openHash: Buffer.alloc(32, 1) }, dave.id);
	assert.equal(a.drops.at(-1)?.reason, "hash");
	op.receive({ ...good, session: Buffer.alloc(16, 5) }, dave.id);
	assert.equal(a.drops.at(-1)?.reason, "session");
	op.receive(good, DEVICES.eve.id);
	assert.equal(a.drops.at(-1)?.reason, "from");
	assert.equal(op.state, "opening");
	op.receive(good, dave.id);
	assert.equal(op.state, "open");
	op.receive(good, dave.id);
	assert.equal(a.drops.at(-1)?.reason, "state", "a second accept does not rekey");
});

test("an open does not answer for ever: 20 s with no accept ends it", () => {
	const clock = fakeClock(), a = end(clock);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	clock.advance(OPERATE_LIMITS.openWaitMs - 1);
	op.tick();
	assert.equal(op.state, "opening");
	clock.advance(1);
	op.tick();
	assert.equal(op.state, "closed");
	assert.deepEqual(a.ended, [{ reason: "no-answer" }]);
	assert.equal(a.sent.at(-1)?.type, "close", "a late accept finds no live session at the controller; the box learns it from the close");
});

test("a low-order ephemeral key is refused, never thrown: an open names one, or an accept does", () => {
	const lowOrder = [Buffer.alloc(32, 0), Buffer.from([1, ...Buffer.alloc(31, 0)]), h("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"), h("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157")];
	for (const eph of lowOrder) {
		const clock = fakeClock(), b = end(clock);
		const open: Opening = { session: Buffer.alloc(16, 9), type: "open", eph, caps: ["operate/1"], want: "team" };
		let got: OperateSession | undefined;
		assert.doesNotThrow(() => (got = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now) })), eph.toString("hex"));
		assert.equal(got, undefined);
		assert.deepEqual(b.sent, [{ session: open.session, type: "refuse", reason: "bad-key" }]);
		assert.deepEqual(b.ended, [], "no session was made, so none ends");

		const a = end(clock);
		const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
		const opening = a.sent[0] as Opening;
		assert.doesNotThrow(() => op.receive({ session: opening.session, type: "accept", eph, openHash: sha256(operateBody(opening)), scope: SCOPE, limits: LIMITS }, dave.id));
		assert.equal(op.state, "closed");
		assert.deepEqual(a.ended, [{ reason: "bad-key" }]);
		assert.equal(a.sent.at(-1)?.type, "close");
	}
});

test("close ends both ends at once and drops the keys: nothing is sent or taken after it", () => {
	const p = pair();
	p.op.close("page-left");
	assert.equal(p.op.state, "closed");
	assert.deepEqual(p.a.ended, [{ reason: "page-left" }]);
	assert.equal(p.op.send({ t: "req" }), false, "a closed session sends nothing");
	const closeMsg = p.a.sent.at(-1)!;
	assert.deepEqual(closeMsg, { session: p.opening.session, type: "close", reason: "page-left" });
	p.deliver();
	assert.equal(p.box.state, "closed");
	assert.deepEqual(p.b.ended, [{ reason: "peer-closed", peer: "page-left" }]);
	p.op.close("again");
	assert.equal(p.a.ended.length, 1, "closing twice ends once");
	const frameBefore = frames(p.b.sent).length;
	p.box.send({ t: "snap" });
	assert.equal(frames(p.b.sent).length, frameBefore);
});

test("only the session's own peer can close it", () => {
	const p = pair();
	p.box.receive({ session: p.opening.session, type: "close", reason: "x" }, DEVICES.eve.id);
	assert.equal(p.box.state, "open");
	assert.equal(p.b.drops.at(-1)?.reason, "from");
});

test("an end drops its keys: a frame the peer sealed before the end does not open afterwards", () => {
	const p = pair();
	p.box.send({ t: "snap" });
	const late = frames(p.b.sent).at(-1)!;
	p.op.close("done");
	p.op.receive(late, dave.id);
	assert.deepEqual(p.a.inner, []);
	assert.equal(p.a.drops.length, 0, "a closed session says nothing more");
});

// ---- counters ---------------------------------------------------------------------------------------------------------------------------------------------

test("the send counter is the session's own: ctr starts at 1, rises by 1, and never repeats", () => {
	const p = pair();
	for (let i = 0; i < 5; i++) p.op.send({ t: "req", id: i });
	assert.deepEqual(frames(p.a.sent).map((f) => f.ctr), [1, 2, 3, 4, 5]);
	// No two frames of one direction share a nonce: the ciphertexts of one repeated message differ.
	assert.notDeepEqual(frames(p.a.sent)[0]!.ct, frames(p.a.sent)[1]!.ct);
	assert.deepEqual(frames(p.a.sent).map((f) => f.ct.length > 16), [true, true, true, true, true]);
});

test("a replayed frame and a reordered one are dropped; a gap is fine", () => {
	const p = pair();
	for (let i = 1; i <= 4; i++) p.op.send({ t: "req", id: i });
	const [f1, f2, f3, f4] = frames(p.a.sent) as [OperateMessage & { type: "frame" }, OperateMessage & { type: "frame" }, OperateMessage & { type: "frame" }, OperateMessage & { type: "frame" }];
	p.box.receive(f1, alice.id);
	p.box.receive(f1, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "replay", "the same frame twice");
	p.box.receive(f3, alice.id);
	p.box.receive(f2, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "replay", "a lower ctr after a higher one");
	p.box.receive(f4, alice.id);
	assert.deepEqual(p.b.inner.map((i) => i.id), [1, 3, 4], "ctr 2 was lost to the reorder and the stream goes on without it");
});

test("a frame that does not open (wrong ciphertext, wrong direction, wrong counter) is dropped and does not burn the counter", () => {
	const p = pair();
	p.op.send({ t: "req", id: 1 });
	p.op.send({ t: "req", id: 2 });
	const [f1, f2] = frames(p.a.sent);
	const flipped = Buffer.from(f1!.ct);
	flipped[3] = flipped[3]! ^ 1;
	p.box.receive({ ...f1!, ct: flipped }, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "unsealed");
	p.box.receive({ ...f2!, ctr: 99 }, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "unsealed", "a ctr the sender did not seal");
	p.box.receive(f1!, alice.id);
	p.box.receive(f2!, alice.id);
	assert.deepEqual(p.b.inner.map((i) => i.id), [1, 2], "the junk did not move the counter past the real frames");
	// A frame of the operator's own direction, reflected back at it, does not open (the nonce tag differs).
	p.op.receive(f1!, dave.id);
	assert.equal(p.a.drops.at(-1)?.reason, "unsealed", "reflected");
});

test("wrong direction at the outer layer: an operator takes no open, a box takes no accept or refuse, and a frame before the accept is dropped", () => {
	const p = pair();
	p.op.receive(p.opening, dave.id);
	assert.equal(p.a.drops.at(-1)?.reason, "role");
	p.box.receive(p.accepted, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "role");
	p.box.receive({ session: p.opening.session, type: "refuse", reason: "x" }, alice.id);
	assert.equal(p.b.drops.at(-1)?.reason, "role");
	const clock = fakeClock(), a = end(clock);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	op.receive({ session: (a.sent[0] as Opening).session, type: "frame", ctr: 1, ct: Buffer.alloc(40) }, dave.id);
	assert.equal(a.drops.at(-1)?.reason, "state");
	assert.deepEqual([p.op.state, p.box.state, op.state], ["open", "open", "opening"]);
});

test("a frame from a device that is not the peer is dropped even when it opens", () => {
	const p = pair();
	p.op.send({ t: "req", id: 1 });
	p.box.receive(frames(p.a.sent)[0]!, DEVICES.eve.id);
	assert.equal(p.b.drops.at(-1)?.reason, "from");
	assert.deepEqual(p.b.inner, []);
});

// ---- inner messages: JSON, deflate, parts -----------------------------------------------------------------------------------------------------------

test("an inner message is JSON compressed with deflateRaw, and a frame that inflates past 4 MB is dropped", () => {
	const p = pair();
	const big = { t: "snap", net: "x".repeat(100_000) };
	p.box.send(big);
	const f = frames(p.b.sent).at(-1)!;
	assert.ok(f.ct.length < 2000, `deflated: ${f.ct.length}`);
	p.deliver();
	assert.deepEqual(p.a.inner.at(-1), big);
	// A bomb: a small frame, sealed with the real key, that inflates to 5 MB. Rebuilt with the vectors' known keys below, here by a second pair whose keys the test knows.
	const clock = fakeClock(), a = end(clock), seedOp = Buffer.alloc(32, 1), seedBox = Buffer.alloc(32, 2), session = Buffer.alloc(16, 7);
	const known = knownBox(clock, session, seedOp, seedBox);
	const bomb = deflateRawSync(Buffer.from(JSON.stringify({ t: "snap", net: "y".repeat(5 * 1024 * 1024) })));
	assert.ok(bomb.length < 20_000);
	known.box.receive({ session, type: "frame", ctr: 1, ct: operateSeal({ key: known.keys.toBox, dir: "toBox", session, ctr: 1, plaintext: bomb }) }, alice.id);
	assert.equal(known.b.drops.at(-1)?.reason, "inflate");
	assert.deepEqual(known.b.inner, []);
});

/** A box session whose two ephemeral keys and session id are fixed, with the operator's side of the keys derived the way the spec says. */
function knownBox(clock: ReturnType<typeof fakeClock>, session: Buffer, seedOp: Buffer, seedBox: Buffer) {
	const b = end(clock);
	const op = operateEphemeral(seedOp), boxEph = operateEphemeral(seedBox);
	const open: Opening = { session, type: "open", eph: op.pub, caps: ["operate/1"], want: "team" };
	const box = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now), [TEST_ENTROPY]: { ephemeral: () => operateEphemeral(seedBox) } })!;
	const keys = operateKeys({ team: TEAM, session, operator: alice.id, box: dave.id, ephOp: op.pub, ephBox: boxEph.pub, mine: op.key, theirs: boxEph.pub });
	return { b, box, keys };
}

test("junk inside a frame that opens is dropped by name: not JSON, not an object, no type", () => {
	const clock = fakeClock(), session = Buffer.alloc(16, 7);
	const known = knownBox(clock, session, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
	let ctr = 0;
	const sendRaw = (plain: Buffer) => known.box.receive({ session, type: "frame", ctr: ++ctr, ct: operateSeal({ key: known.keys.toBox, dir: "toBox", session, ctr, plaintext: plain }) }, alice.id);
	sendRaw(Buffer.from("not deflate"));
	assert.equal(known.b.drops.at(-1)?.reason, "inflate");
	sendRaw(deflateRawSync(Buffer.from("{nope")));
	assert.equal(known.b.drops.at(-1)?.reason, "malformed");
	sendRaw(deflateRawSync(Buffer.from("[1]")));
	assert.equal(known.b.drops.at(-1)?.reason, "malformed");
	sendRaw(deflateRawSync(Buffer.from(JSON.stringify({ x: 1 }))));
	assert.equal(known.b.drops.at(-1)?.reason, "malformed");
	sendRaw(deflateRawSync(Buffer.from(JSON.stringify({ t: "x".repeat(40) }))));
	assert.equal(known.b.drops.at(-1)?.reason, "malformed");
	assert.deepEqual(known.b.inner, []);
	sendRaw(deflateRawSync(Buffer.from(JSON.stringify({ t: "req", id: 1 }))));
	assert.deepEqual(known.b.inner, [{ t: "req", id: 1 }], "the counter moved with each junk frame (they opened) and a good one still gets through");
});

test("a message over 160 KB deflated goes in parts of at most 120 KB, each its own frame, and arrives whole", () => {
	const p = pair();
	// Incompressible, so the deflated size is about the raw one.
	const noise = Buffer.alloc(400_000);
	for (let i = 0; i < noise.length; i += 32) sha256(Buffer.from(String(i))).copy(noise, i);
	const msg = { t: "ev", id: "m:1", e: "history", d: noise.toString("base64") };
	assert.equal(p.box.send(msg), true);
	const fs = frames(p.b.sent);
	assert.ok(fs.length >= 4 && fs.length <= 8, `${fs.length} frames`);
	for (const f of fs) assert.ok(f.ct.length <= OPERATE_LIMITS.frameBytes, `a part frame is ${f.ct.length}`);
	assert.deepEqual(fs.map((f) => f.ctr), fs.map((_, i) => i + 1), "contiguous counters");
	p.deliver();
	assert.deepEqual(p.a.inner, [msg], "one message, not its parts");
	assert.deepEqual(p.a.drops, []);
});

test("a message that fits in one frame is not split, and one over 4 MB is refused by the sender", () => {
	const p = pair();
	p.op.send({ t: "req", id: 1, body: "z".repeat(300_000) });
	assert.equal(frames(p.a.sent).length, 1);
	const noise = Buffer.alloc(3_200_000);
	for (let i = 0; i < noise.length; i += 32) sha256(Buffer.from(String(i))).copy(noise, i);
	assert.throws(() => p.op.send({ t: "snap", net: noise.toString("base64") }), RangeError, "4.3 MB of JSON is over the message cap");
	assert.throws(() => p.op.send({ t: "part", of: 1 }), RangeError, "part is the core's own");
	assert.throws(() => p.op.send({ t: "" }), RangeError);
});

/** Parts built by hand with the known keys, so a test can hold some back or lie in them. */
function partsWorld() {
	const clock = fakeClock(), session = Buffer.alloc(16, 7);
	const known = knownBox(clock, session, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
	let ctr = 0;
	const frameOf = (inner: unknown) => known.box.receive({ session, type: "frame", ctr: ++ctr, ct: operateSeal({ key: known.keys.toBox, dir: "toBox", session, ctr, plaintext: deflateRawSync(Buffer.from(JSON.stringify(inner))) }) }, alice.id);
	const part = (of: number, i: number, n: number, chunk: Buffer) => frameOf({ t: "part", of, i, n, bytes: chunk.toString("base64") });
	/** The deflated bytes of a message, cut in `n` parts. */
	const cut = (message: unknown, n: number) => {
		const z = deflateRawSync(Buffer.from(JSON.stringify(message))), size = Math.ceil(z.length / n);
		return Array.from({ length: n }, (_, i) => z.subarray(i * size, (i + 1) * size));
	};
	return { clock, known, frameOf, part, cut };
}

test("parts arrive in any order; the message is delivered when the last one is in", () => {
	const w = partsWorld();
	const msg = { t: "ev", id: "m:1", e: "mirror", d: Array.from({ length: 200 }, (_, i) => `line ${i} ${"q".repeat(i)}`) };
	const cut = w.cut(msg, 3);
	w.part(5, 2, 3, cut[2]!);
	w.part(5, 0, 3, cut[0]!);
	assert.deepEqual(w.known.b.inner, []);
	w.part(5, 1, 3, cut[1]!);
	assert.deepEqual(w.known.b.inner, [msg]);
});

test("a part missing for 10 s drops the message, and a late part then starts nothing that can finish", () => {
	const w = partsWorld();
	const cut = w.cut({ t: "ev", id: "m:1", e: "history", d: "d".repeat(5000) }, 3);
	w.part(5, 0, 3, cut[0]!);
	w.part(5, 1, 3, cut[1]!);
	w.clock.advance(OPERATE_LIMITS.partMs - 1);
	w.known.box.tick();
	assert.equal(w.known.b.drops.some((d) => d.reason === "part-timeout"), false);
	w.clock.advance(1);
	w.known.box.tick();
	assert.deepEqual(w.known.b.drops.filter((d) => d.reason === "part-timeout"), [{ reason: "part-timeout", type: "part" }]);
	w.part(5, 2, 3, cut[2]!);
	assert.deepEqual(w.known.b.inner, [], "the last part alone is a message that waits for its first two, and the 10 s will drop it too");
	w.clock.advance(OPERATE_LIMITS.partMs);
	w.known.box.tick();
	assert.equal(w.known.b.drops.filter((d) => d.reason === "part-timeout").length, 2);
});

test("a part's 10 s runs from the last part of that message, so a slow message that keeps coming finishes", () => {
	const w = partsWorld();
	const msg = { t: "ev", id: "m:1", e: "history", d: "d".repeat(5000) }, cut = w.cut(msg, 3);
	for (let i = 0; i < 3; i++) {
		w.part(5, i, 3, cut[i]!);
		w.clock.advance(OPERATE_LIMITS.partMs - 1);
		w.known.box.tick();
	}
	assert.deepEqual(w.known.b.inner, [msg]);
});

test("a lying part is dropped with its message: a changed count, a repeated index, an index out of range, no bytes, a nested part", () => {
	const w = partsWorld();
	const cut = w.cut({ t: "ev", id: "m:1", e: "history", d: "d".repeat(5000) }, 3);
	const last = () => w.known.b.drops.at(-1)?.reason;
	w.part(1, 0, 3, cut[0]!);
	w.part(1, 1, 4, cut[1]!);
	assert.equal(last(), "part-mismatch");
	w.part(2, 0, 3, cut[0]!);
	w.part(2, 0, 3, cut[0]!);
	assert.equal(last(), "part-duplicate");
	w.part(3, 3, 3, cut[0]!);
	assert.equal(last(), "part-invalid", "i = n");
	w.part(3, 0, 1, cut[0]!);
	assert.equal(last(), "part-invalid", "one part is not parts");
	w.part(3, 0, 1000, cut[0]!);
	assert.equal(last(), "part-invalid", "a count over the cap");
	w.part(3, 0, 3, Buffer.alloc(0));
	assert.equal(last(), "part-invalid", "no bytes");
	w.part(0, 0, 3, cut[0]!);
	assert.equal(last(), "part-invalid", "of = 0");
	w.frameOf({ t: "part", of: 9, i: 0, n: 3, bytes: 7 });
	assert.equal(last(), "part-invalid", "bytes not a string");
	// A message that, put together, is itself a part.
	const inner = w.cut({ t: "part", of: 11, i: 0, n: 2, bytes: "AAAA" }, 2);
	w.part(4, 0, 2, inner[0]!);
	w.part(4, 1, 2, inner[1]!);
	assert.equal(last(), "part-nested");
	assert.deepEqual(w.known.b.inner, []);
});

test("reassembly is capped: 4 MB for one message, 8 MB for the session, 16 messages at a time", () => {
	const chunk = Buffer.alloc(OPERATE_LIMITS.partBytes, 1);
	const w = partsWorld(), last = () => w.known.b.drops.at(-1)?.reason;
	// One message: 34 parts of 120 KB are 3.98 MB, the 35th passes 4 MB and the whole message goes.
	for (let i = 0; i < 34; i++) w.part(1, i, 64, chunk);
	assert.equal(last(), undefined);
	w.part(1, 34, 64, chunk);
	assert.equal(last(), "part-limit");
	w.part(1, 35, 64, chunk);
	w.part(1, 34, 64, chunk);
	assert.equal(w.known.b.drops.filter((d) => d.reason === "part-limit").length, 1, "the dropped message's later parts start a new, small one rather than a second drop");
	// The session: two messages of 33 parts are 7.7 MB; a third has room for two parts and its third passes 8 MB.
	const s = partsWorld(), lastS = () => s.known.b.drops.at(-1)?.reason;
	for (const id of [2, 3]) for (let i = 0; i < 33; i++) s.part(id, i, 64, chunk);
	s.part(4, 0, 64, chunk);
	s.part(4, 1, 64, chunk);
	assert.equal(lastS(), undefined);
	s.part(4, 2, 64, chunk);
	assert.equal(lastS(), "part-limit");
	// 16 messages at a time.
	const x = partsWorld();
	for (let id = 1; id <= 16; id++) x.part(id, 0, 2, Buffer.alloc(10, 1));
	assert.equal(x.known.b.drops.length, 0);
	x.part(17, 0, 2, Buffer.alloc(10, 1));
	assert.equal(x.known.b.drops.at(-1)?.reason, "part-limit");
});

// ---- liveness: pings, silence, rekey ---------------------------------------------------------------------------------------------------------------

test("a ping goes out when nothing was sent for 15 s, from either end; any frame counts as a sign of life", () => {
	const p = pair();
	p.clock.advance(OPERATE_LIMITS.pingMs - 1);
	p.op.tick();
	p.box.tick();
	assert.equal(frames(p.a.sent).length + frames(p.b.sent).length, 0);
	p.clock.advance(1);
	p.op.tick();
	p.box.tick();
	assert.equal(frames(p.a.sent).length, 1);
	assert.equal(frames(p.b.sent).length, 1);
	p.deliver();
	assert.deepEqual([p.a.inner, p.b.inner], [[], []], "a ping is the core's, not the host's");
	// Traffic is a ping's work already.
	p.op.send({ t: "req", id: 1 });
	p.clock.advance(OPERATE_LIMITS.pingMs - 1);
	p.op.tick();
	assert.equal(frames(p.a.sent).length, 2, "the req, no ping");
	p.clock.advance(1);
	p.op.tick();
	assert.equal(frames(p.a.sent).length, 3);
});

test("no frame for 45 s ends the session on either side, with a close sent; a frame at 44.9 s keeps it", () => {
	const p = pair();
	// 45 s of silence from the box's side only: the operator hears nothing, the box hears the operator's pings.
	p.clock.advance(OPERATE_LIMITS.silenceMs - 1);
	p.op.tick();
	assert.equal(p.op.state, "open");
	p.box.send({ t: "snap" });
	p.deliver();
	p.clock.advance(OPERATE_LIMITS.silenceMs - 1);
	p.op.tick();
	assert.equal(p.op.state, "open", "the snap at 44.999 s restarted the 45 s");
	p.clock.advance(1);
	p.op.tick();
	assert.equal(p.op.state, "closed");
	assert.deepEqual(p.a.ended, [{ reason: "silence" }]);
	assert.deepEqual(p.a.sent.at(-1), { session: p.opening.session, type: "close", reason: "silence" });
	// The box heard nothing either for that long, so it ends too.
	p.box.tick();
	assert.equal(p.box.state, "closed");
	assert.deepEqual(p.b.ended, [{ reason: "silence" }]);
});

test("pings keep a quiet session alive for as long as both ends tick", () => {
	const p = pair();
	idle(p, 1000, 600);
	assert.equal(p.op.state, "open");
	assert.equal(p.box.state, "open");
	assert.equal(p.a.drops.length + p.b.drops.length, 0);
	assert.ok(frames(p.a.sent).length >= 600 / 15 - 1);
});

test("a junk frame is no sign of life: only a frame that opens restarts the 45 s", () => {
	const p = pair();
	p.clock.advance(44_000);
	p.op.receive({ session: p.opening.session, type: "frame", ctr: 1, ct: Buffer.alloc(40) }, dave.id);
	p.clock.advance(1000);
	p.op.tick();
	assert.equal(p.op.state, "closed");
});

test("the session ends at 12 h so the controller can open a new one: operator first, and the box follows its close", () => {
	const p = pair();
	const HOURS_12 = 12 * 3600_000;
	idle(p, 15_000, HOURS_12 / 15_000 - 1);
	assert.equal(p.op.state, "open", "11 h 59 min 45 s");
	assert.equal(p.box.state, "open");
	p.clock.advance(15_000 - 1);
	p.op.tick();
	assert.equal(p.op.state, "open", "1 ms short of 12 h");
	p.clock.advance(1);
	p.op.tick();
	assert.equal(p.op.state, "closed");
	assert.deepEqual(p.a.ended, [{ reason: "rekey" }]);
	p.deliver();
	assert.deepEqual(p.b.ended, [{ reason: "peer-closed", peer: "rekey" }]);
	// The next open is a new session: another id, another ephemeral key, a counter from 1.
	const next = OperateSession.open(p.a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const reopened = p.a.sent.at(-1) as Opening;
	assert.notDeepEqual(reopened.session, p.opening.session);
	assert.notDeepEqual(reopened.eph, p.opening.eph);
	assert.equal(next.state, "opening");
});

test("the box ends a session that the controller leaves open past 12 h, by its own clock, after the grace period", () => {
	const p = pair();
	for (let t = 0; t < OPERATE_LIMITS.rekeyMs + OPERATE_LIMITS.rekeyGraceMs && p.box.state === "open"; t += 15_000) {
		p.clock.advance(15_000);
		p.op.send({ t: "req" });
		p.deliver();
		p.box.tick();
		p.deliver();
	}
	assert.equal(p.box.state, "closed");
	assert.deepEqual(p.b.ended, [{ reason: "rekey" }]);
	assert.equal(p.clock.elapsed(), OPERATE_LIMITS.rekeyMs + OPERATE_LIMITS.rekeyGraceMs);
});

// ---- the transport ----------------------------------------------------------------------------------------------------------------------------------------

test("a send that fails is reported and does not end the session: a lost frame is lost, the silence timer decides", async () => {
	const clock = fakeClock(), a = end(clock);
	let fail = false;
	const deps: OperateDeps = { ...a.deps, send: (m) => { if (fail) return Promise.reject(new Error("429")); a.sent.push(m); } };
	const op = OperateSession.open(deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const b = end(clock);
	const box = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open: a.sent[0] as Opening, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now) })!;
	op.receive(b.sent[0]!, dave.id);
	fail = true;
	assert.equal(op.send({ t: "req", id: 1 }), true);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(a.transportErrors.length, 1);
	assert.equal(op.state, "open");
	fail = false;
	op.send({ t: "req", id: 2 });
	for (const m of a.sent.slice(1)) box.receive(m, alice.id);
	assert.deepEqual(b.inner, [{ t: "req", id: 2 }], "ctr 1 never left, ctr 2 is above the box's last and goes through");
	const thrower: OperateDeps = { ...a.deps, send: () => { throw new Error("boom"); } };
	const t = OperateSession.open(thrower, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	assert.equal(t.state, "opening");
	assert.equal(a.transportErrors.length, 2, "a throw from the transport is reported the same way");
});

test("an operator's open names two real device ids and a team of 16 bytes, or it throws before sending", () => {
	const clock = fakeClock(), a = end(clock);
	assert.throws(() => OperateSession.open(a.deps, { team: TEAM, self: "alice", peer: dave.id, want: "team" }), RangeError);
	assert.throws(() => OperateSession.open(a.deps, { team: TEAM.subarray(1), self: alice.id, peer: dave.id, want: "team" }), RangeError);
	assert.deepEqual(a.sent, []);
});

// ---- the vectors ------------------------------------------------------------------------------------------------------------------------------------------

test("vectors: a session built from the fixed seeds derives the vectors' keys at both ends, and its frames are sealed with them", () => {
	const c = V.keys[0], clock = fakeClock(1_800_000_000_000);
	const session = h(c.session), team = h(c.team);
	const opSeed = h(c.ephOpSeed), boxSeed = h(c.ephBoxSeed);
	const a = end(clock), b = end(clock);
	const op = OperateSession.open(a.deps, { team, self: c.operatorId, peer: c.boxId, want: "team", [TEST_ENTROPY]: { ephemeral: () => operateEphemeral(opSeed), sessionId: () => session } });
	const opening = a.sent[0] as Opening;
	assert.equal(opening.eph.toString("hex"), c.ephOp);
	assert.deepEqual(opening.session, session);
	const box = OperateSession.accept(b.deps, { team, self: c.boxId, from: c.operatorId, open: opening, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now), [TEST_ENTROPY]: { ephemeral: () => operateEphemeral(boxSeed) } })!;
	assert.equal((b.sent[0] as Accepted).eph.toString("hex"), c.ephBox);
	assert.deepEqual((b.sent[0] as Accepted).openHash, sha256(operateBody(opening)));
	op.receive(b.sent[0]!, c.boxId);
	// Each end's first frame opens under the vectors' key for its direction, with ctr 1, and holds the deflated JSON.
	op.send({ t: "req", id: 1 });
	box.send({ t: "snap", net: {} });
	const toBox = frames(a.sent)[0]!, toOperator = frames(b.sent)[0]!;
	assert.equal(toBox.ctr, 1);
	assert.equal(toOperator.ctr, 1);
	const plainBox = operateOpen({ key: h(c.toBox), dir: "toBox", session, ctr: 1, ct: toBox.ct })!, plainOp = operateOpen({ key: h(c.toOperator), dir: "toOperator", session, ctr: 1, ct: toOperator.ct })!;
	assert.deepEqual(JSON.parse(inflateRawSync(plainBox).toString()), { t: "req", id: 1 });
	assert.deepEqual(JSON.parse(inflateRawSync(plainOp).toString()), { t: "snap", net: {} });
	// And a frame sealed by the vectors' own key is taken by the session: the keys really are the derived ones.
	const sealed = (key: string, dir: "toBox" | "toOperator", ctr: number, inner: object) => operateSeal({ key: h(key), dir, session, ctr, plaintext: deflateRawSync(Buffer.from(JSON.stringify(inner))) });
	box.receive({ session, type: "frame", ctr: 2, ct: sealed(c.toBox, "toBox", 2, { t: "req", id: 2 }) }, c.operatorId);
	op.receive({ session, type: "frame", ctr: 2, ct: sealed(c.toOperator, "toOperator", 2, { t: "snap", id: 2 }) }, c.boxId);
	assert.deepEqual(b.inner.at(-1), { t: "req", id: 2 });
	assert.deepEqual(a.inner.at(-1), { t: "snap", id: 2 });
	// The vectors' frame cases still hold for the primitives the session sits on.
	for (const f of V.frames) assert.equal(operateSeal({ key: h(f.key), dir: f.dir, session: h(f.session), ctr: f.ctr, plaintext: h(f.plaintext) }).toString("hex"), f.ct);
});

// ---- the box's registry of session ids ------------------------------------------------------------------------------------------------------------------

test("the registry refuses a session id it has seen, 2 open sessions per operator device per team, and 6 in all", () => {
	const clock = fakeClock(), reg = new OperateRegistry(clock.now);
	const sid = (n: number) => Buffer.alloc(16, n);
	const team = TEAM.toString("hex");
	assert.equal(reg.admit(team, alice.id, sid(1)), "ok");
	assert.equal(reg.admit(team, alice.id, sid(1)), "seen", "a replayed open");
	assert.equal(reg.admit(team, alice.id, sid(2)), "ok");
	assert.equal(reg.admit(team, alice.id, sid(3)), "operator-limit");
	assert.equal(reg.admit(Buffer.alloc(16, 1).toString("hex"), alice.id, sid(10)), "ok", "the limit is per team");
	for (const [n, who] of [[4, DEVICES.bob.id], [5, DEVICES.carol.id], [6, DEVICES.eve.id], [7, DEVICES.mallory.id]] as const) {
		const got = reg.admit(team, who, sid(n));
		assert.equal(got, n <= 6 ? "ok" : "box-limit", `session ${n}`);
	}
	reg.release(sid(1));
	assert.equal(reg.admit(team, alice.id, sid(1)), "seen", "a released id is still seen: a replay of its open finds it");
	assert.equal(reg.admit(team, alice.id, sid(8)), "ok", "a release frees its slot");
	assert.equal(reg.admit(team, DEVICES.mallory.id, sid(9)), "box-limit");
});

test("the registry forgets a session id after the replay window, so its memory is bounded", () => {
	const clock = fakeClock(), reg = new OperateRegistry(clock.now);
	const team = TEAM.toString("hex");
	for (let i = 1; i <= 50; i++) {
		assert.equal(reg.admit(team, alice.id, Buffer.alloc(16, i)), "ok");
		reg.release(Buffer.alloc(16, i));
	}
	assert.equal(reg.size, 50);
	clock.advance(OPERATE_LIMITS.seenMs);
	assert.equal(reg.admit(team, alice.id, Buffer.alloc(16, 200)), "ok");
	assert.equal(reg.size, 1);
});

// ---- review round r2 (OSR-F001 to F007) -------------------------------------------------------------------------------------------------------------------------

type Internals = { keys?: Buffer; pending: Map<number, unknown>; pendingBytes: number };
const inside_ = (s: OperateSession) => s as unknown as Internals;
const zero = (b: Buffer) => b.every((v) => v === 0);

test("OSR-F001: a wall clock that steps back does not stop the pings or end a healthy session", () => {
	const p = pair();
	p.clock.advance(-60_000);
	idle(p, 1000, 120);
	assert.equal(p.op.state, "open");
	assert.equal(p.box.state, "open");
	assert.deepEqual([p.a.ended, p.b.ended], [[], []]);
	assert.ok(frames(p.a.sent).length >= 7, "the operator kept pinging every 15 s of real time");
});

test("OSR-F001: a step back does not keep a dead session alive for the length of the step", () => {
	const p = pair();
	p.clock.advance(-60_000);
	// The peer is gone: nothing is delivered. 45 s of ticks end the box's silence, not 105 s.
	for (let i = 0; i < 46; i++) { p.clock.advance(1000); p.box.tick(); }
	assert.equal(p.box.state, "closed");
	assert.deepEqual(p.b.ended, [{ reason: "silence" }]);
});

test("OSR-F001: the registry's clock does not step back either: an id is forgotten after seenMs of real time", () => {
	const clock = fakeClock(), reg = new OperateRegistry(clock.now), team = TEAM.toString("hex"), sid = Buffer.alloc(16, 3);
	assert.equal(reg.admit(team, alice.id, sid), "ok");
	reg.release(sid);
	clock.advance(-60_000);
	reg.admit(team, DEVICES.bob.id, Buffer.alloc(16, 4)); // a read of the clock after the step
	clock.advance(OPERATE_LIMITS.seenMs - 1);
	assert.equal(reg.admit(team, alice.id, sid), "seen");
	clock.advance(1);
	assert.equal(reg.admit(team, alice.id, sid), "ok", "the 60 s step added nothing to the id's life");
});

test("OSR-F002: the operator counts its 12 h from its open, so a slow accept never lets the box end first; the box gives it a grace period", () => {
	const clock = fakeClock(1_800_000_000_000), a = end(clock), b = end(clock), registry = new OperateRegistry(clock.now);
	const op = OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	clock.advance(1300);
	const box = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open: a.sent[0] as Opening, scope: SCOPE, limits: LIMITS, registry })!;
	clock.advance(1300); // the accept's trip
	op.receive(b.sent[0]!, dave.id);
	const p = { clock, a, b, op, box, deliver: () => { for (const m of a.sent.slice(mark.a)) box.receive(m, alice.id); for (const m of b.sent.slice(mark.b)) op.receive(m, dave.id); mark.a = a.sent.length; mark.b = b.sent.length; } };
	const mark = { a: 1, b: 1 };
	// 12 h after the open (the 2.6 s the handshake took are in the box's budget, not the operator's).
	const opened = clock.now() - 2600;
	while (op.state === "open") {
		clock.advance(1000);
		op.tick();
		box.tick();
		p.deliver();
	}
	assert.deepEqual(a.ended, [{ reason: "rekey" }], "the controller ends on its own word");
	assert.deepEqual(b.ended, [{ reason: "peer-closed", peer: "rekey" }], "the box learns it from the controller's close");
	assert.ok(clock.now() - opened < OPERATE_LIMITS.rekeyMs + 1000, "the operator ended within a tick of 12 h after its open, not after the accept");
	assert.ok(clock.now() - opened >= OPERATE_LIMITS.rekeyMs);
});

test("OSR-F003: a refused open (a bad key, a seen id, a limit) holds no slot: six bad opens do not lock the box", () => {
	const clock = fakeClock(), registry = new OperateRegistry(clock.now);
	for (let n = 1; n <= 6; n++) {
		const b = end(clock);
		const open: Opening = { session: Buffer.alloc(16, n), type: "open", eph: Buffer.alloc(32), caps: ["operate/1"], want: "team" };
		assert.equal(OperateSession.accept(b.deps, { team: Buffer.alloc(16, n), self: dave.id, from: alice.id, open, scope: SCOPE, limits: LIMITS, registry }), undefined);
		assert.deepEqual(b.sent, [{ session: open.session, type: "refuse", reason: "bad-key" }]);
	}
	const a = end(clock), b = end(clock);
	OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const box = OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: alice.id, open: a.sent[0] as Opening, scope: SCOPE, limits: LIMITS, registry });
	assert.equal(box?.state, "open", "no slot leaked");
});

test("OSR-F003: accept admits and the session's end releases; the registry's refusals go out as a refuse and make no session", () => {
	const clock = fakeClock(), registry = new OperateRegistry(clock.now);
	const mk = (n: number, who = alice.id) => {
		const a = end(clock), b = end(clock);
		OperateSession.open(a.deps, { team: TEAM, self: who, peer: dave.id, want: "team" });
		const open = a.sent[0] as Opening;
		return { open, b, box: OperateSession.accept(b.deps, { team: TEAM, self: dave.id, from: who, open, scope: SCOPE, limits: LIMITS, registry }) };
	};
	const one = mk(1), two = mk(2), three = mk(3);
	assert.equal(one.box?.state, "open");
	assert.equal(two.box?.state, "open");
	assert.equal(three.box, undefined);
	assert.deepEqual(three.b.sent, [{ session: three.open.session, type: "refuse", reason: "operator-limit" }]);
	assert.equal(OperateSession.accept(one.b.deps, { team: TEAM, self: dave.id, from: alice.id, open: one.open, scope: SCOPE, limits: LIMITS, registry }), undefined);
	assert.deepEqual(one.b.sent.at(-1), { session: one.open.session, type: "refuse", reason: "seen" });
	one.box!.close("bye");
	assert.equal(mk(4).box?.state, "open", "the end of a session frees its slot with no call by the host");
});

test("OSR-F004: an id that is still open is never admitted again, however long it has run, and stays seen for seenMs after its release", () => {
	const clock = fakeClock(), reg = new OperateRegistry(clock.now), t = TEAM.toString("hex"), sid = Buffer.alloc(16, 1);
	assert.equal(reg.admit(t, alice.id, sid), "ok");
	clock.advance(OPERATE_LIMITS.seenMs * 3);
	assert.equal(reg.admit(t, alice.id, sid), "seen");
	assert.equal(reg.admit(t, alice.id, Buffer.alloc(16, 2)), "ok");
	assert.equal(reg.admit(t, alice.id, Buffer.alloc(16, 3)), "operator-limit", "the replayed id did not take a second slot");
	reg.release(sid);
	clock.advance(OPERATE_LIMITS.seenMs - 1);
	assert.equal(reg.admit(t, alice.id, sid), "seen", "seen counts from the release");
	clock.advance(1);
	assert.equal(reg.admit(t, alice.id, sid), "ok");
});

test("OSR-F005: an onTransportError that throws is swallowed, on a rejected send, a thrown send and a refuse", async () => {
	const rejections: unknown[] = [], on = (e: unknown) => void rejections.push(e);
	process.on("unhandledRejection", on);
	try {
		const clock = fakeClock(), bug = () => { throw new Error("host bug"); };
		assert.doesNotThrow(() => OperateSession.open({ now: clock.now, send: () => Promise.reject(new Error("429")), onTransportError: bug, onInner: () => {}, onEnd: () => {} }, { team: TEAM, self: alice.id, peer: dave.id, want: "team" }));
		assert.doesNotThrow(() => OperateSession.open({ now: clock.now, send: () => { throw new Error("boom"); }, onTransportError: bug, onInner: () => {}, onEnd: () => {} }, { team: TEAM, self: alice.id, peer: dave.id, want: "team" }));
		assert.doesNotThrow(() => refuseOpen({ send: () => Promise.reject(new Error("429")), onTransportError: bug }, Buffer.alloc(16, 1), "seen"));
		assert.doesNotThrow(() => refuseOpen({ send: () => { throw new Error("boom"); }, onTransportError: bug }, Buffer.alloc(16, 1), "seen"));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(rejections, []);
	} finally {
		process.off("unhandledRejection", on);
	}
});

test("OSR-F006: the keys are zeroed at every end: close, silence, rekey, a peer's close, an accept that fails to derive nothing is left", () => {
	for (const how of ["close", "silence", "rekey", "peer-close"] as const) {
		const p = pair(), keys = inside_(p.box).keys!, opKeys = inside_(p.op).keys!;
		assert.ok(!zero(keys) && !zero(opKeys), "live keys are not zero");
		if (how === "close") p.box.close("page-left");
		else if (how === "silence") { p.clock.advance(OPERATE_LIMITS.silenceMs); p.box.tick(); }
		else if (how === "rekey") { p.clock.advance(OPERATE_LIMITS.rekeyMs + OPERATE_LIMITS.rekeyGraceMs); p.box.tick(); }
		else p.box.receive({ session: p.opening.session, type: "close", reason: "x" }, alice.id);
		assert.equal(p.box.state, "closed", how);
		assert.ok(zero(keys), `the box's keys are zero after ${how}`);
		assert.equal(inside_(p.box).keys, undefined);
		p.op.close("done");
		assert.ok(zero(opKeys), "and the operator's");
	}
});

test("OSR-F006: joinKeys zeroes the derivation's own two copies and returns both keys in one buffer", () => {
	const x = Buffer.alloc(32, 1), y = Buffer.alloc(32, 2), both = joinKeys({ toBox: x, toOperator: y });
	assert.deepEqual(both, Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]));
	assert.ok(zero(x) && zero(y));
});

test("OSR-F006: the bytes of a finished multi-part message are given back, so a long session takes message after message", () => {
	const p = pair();
	const noise = Buffer.alloc(3_000_000);
	for (let i = 0; i < noise.length; i += 32) sha256(Buffer.from(String(i))).copy(noise, i);
	const body = noise.toString("base64");
	for (let k = 1; k <= 3; k++) {
		assert.equal(p.op.send({ t: "ev", id: `m:${k}`, d: body }), true);
		p.deliver();
		assert.equal(p.b.inner.length, k, `message ${k} arrived whole`);
		assert.equal(inside_(p.box).pendingBytes, 0);
	}
	assert.equal(p.b.drops.filter((d) => d.reason === "part-limit").length, 0);
});

test("OSR-F006: the reassembly of a message half-received is dropped at the end of the session", () => {
	const p = pair();
	const noise = Buffer.alloc(400_000);
	for (let i = 0; i < noise.length; i += 32) sha256(Buffer.from(String(i))).copy(noise, i);
	p.op.send({ t: "ev", id: "m:1", d: noise.toString("base64") });
	const fs = frames(p.a.sent);
	assert.ok(fs.length > 2);
	p.box.receive(fs[0]!, alice.id);
	assert.equal(inside_(p.box).pending.size, 1);
	assert.ok(inside_(p.box).pendingBytes > 0);
	p.box.close("page-left");
	assert.equal(inside_(p.box).pending.size, 0);
	assert.equal(inside_(p.box).pendingBytes, 0);
});

test("OSR-F007: the test hooks are no part of OperateDeps, and no file of src/ outside operate.ts names the seam", async () => {
	const { readdirSync, readFileSync: read, statSync } = await import("node:fs");
	const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
	const src = join(import.meta.dirname, "..", "src");
	const users = walk(src).filter((f) => f.endsWith(".ts") && read(f, "utf8").includes("TEST_ENTROPY")).map((f) => f.slice(src.length + 1));
	assert.deepEqual(users, [join("link", "operate.ts")]);
	const source = read(join(src, "link", "operate.ts"), "utf8");
	const deps = /export interface OperateDeps \{[\s\S]*?\n\}/.exec(source)![0];
	assert.ok(!/ephemeral|sessionId/.test(deps));
	// Without the seam every session is random: two boxes given one open make different keys.
	const clock = fakeClock(), a = end(clock), registry = new OperateRegistry(clock.now);
	OperateSession.open(a.deps, { team: TEAM, self: alice.id, peer: dave.id, want: "team" });
	const open = a.sent[0] as Opening, b1 = end(clock), b2 = end(clock);
	OperateSession.accept(b1.deps, { team: TEAM, self: dave.id, from: alice.id, open, scope: SCOPE, limits: LIMITS, registry: new OperateRegistry(clock.now) });
	OperateSession.accept(b2.deps, { team: TEAM, self: dave.id, from: alice.id, open, scope: SCOPE, limits: LIMITS, registry });
	assert.notDeepEqual((b1.sent[0] as Accepted).eph, (b2.sent[0] as Accepted).eph);
});
