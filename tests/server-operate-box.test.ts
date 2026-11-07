import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Level, TeamPolicy } from "../src/link/config.ts";
import type { OperateIn } from "../src/link/holder.ts";
import type { OperateMessage } from "../src/link/kinds.ts";
import { OperateSession, type OperateInner } from "../src/link/operate.ts";
import type { OperateGrant, Policy } from "../src/link/policy.ts";
import type { Reply } from "../src/control.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { Operate, OperateSession as Seam, Sink } from "../src/operateseam.ts";
import { type OperateScope } from "../src/operateroutes.ts";
import { sliceNet } from "../src/operateslice.ts";
import { createOperateBox, type BoxDeps } from "../src/server/operatebox.ts";
import type { MemberOf, Owner } from "../src/server/operatescope.ts";
import { fakeClock } from "./fake-clock.ts";
import { DEVICES } from "./link/scenario.ts";

// The box's bridge (docs/specs/2026-11-07-link-operate.md §11 row 5, §5.4, §5.5, §10): the holder's operate sink, a session per operator whose grant the guard checks on every request, the sliced net, the mirror at most twice a second as whole
// screens, a budget that stretches the mirror first, and link.log lines that never carry what was typed. Both ends are real `OperateSession`s over a transport the test pumps, so the frames are really sealed; Herdr's GUI is a fake of
// the seam, and the clock is the test's.

const { alice, bob, dave } = DEVICES;
const A = "a".repeat(32), B = "b".repeat(32);
const MARKER = "zq7-marker-should-never-be-logged";
const tp = (name: string): TeamPolicy => ({ project: "/srv/work", share: "status", name });
const unit = (key: string): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle", subs: [] });
/** Base wA: a team A main, a team B main, a box-own main in a tab, and the box's tower. */
const NET = (): Net => ({
	bases: [{
		id: "wA", label: "work", mark: "idle", outposts: [], outside: [],
		tower: { name: "tower", mark: "idle", key: "tower", control: true, subs: [] },
		tabs: [{ id: "t1", label: "one", units: [unit("a-main")] }, { id: "t2", label: "two", units: [unit("b-main")] }, { id: "t3", label: "three", units: [unit("box-main")] }],
	} as Base],
});
const OWNERS: Record<string, Owner> = { "a-main": { team: A }, "b-main": { team: B }, "box-main": { box: true }, tower: { box: true } };
const keysOf = (net: Net): string[] => net.bases.flatMap((b) => [...(b.tower ? [b.tower.key] : []), ...b.tabs.flatMap((t) => t.units.map((u) => u.key))]).sort();
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

interface Recorded { watches: [string, string, boolean][]; mirrors: [string, boolean][]; requests: { method: string; parts: string[]; body: unknown; scope: OperateScope }[]; rescoped: OperateScope[]; stopped: boolean; sink: Sink }
function fakeOperate(replies: { request?: (parts: string[]) => Reply } = {}) {
	const sessions: (Recorded & Seam)[] = [], listeners = new Set<() => void>();
	let snapshots = 0, net = NET();
	const api: Operate = {
		async snapshot(scope) { snapshots++; return sliceNet(JSON.parse(JSON.stringify(net)) as Net, scope); },
		changed: (l) => (listeners.add(l), () => void listeners.delete(l)),
		open(sink) {
			const s: Recorded & Seam = {
				watches: [], mirrors: [], requests: [], rescoped: [], stopped: false, sink,
				async watch(id, target, on) { s.watches.push([id, target, on]); return { status: 200, body: { watching: on } }; },
				async mirror(key, on) { s.mirrors.push([key, on]); return { status: 200, body: { attached: on } }; },
				async request(method, parts, _q, body, scope) { s.requests.push({ method, parts, body, scope }); return replies.request?.(parts) ?? { status: 200, body: { ok: true } }; },
				async rescope(scope) { s.rescoped.push(scope); },
				stop() { s.stopped = true; },
			};
			sessions.push(s);
			return s;
		},
	};
	return { api, sessions, snapshots: () => snapshots, changed: () => listeners.forEach((l) => l()), set: (fn: (n: Net) => void) => fn(net) };
}

interface State { policy: Policy; roster: Record<string, { role: "admin" | "member" }>; gui: boolean; membersGone: boolean; /** The relay does not answer: a send never settles. */ stall: boolean }
function world(o: { budget?: number } = {}) {
	const clock = fakeClock(1_800_000_000_000);
	const fo = fakeOperate();
	const state: State = {
		policy: {
			mode: "unattended", teams: new Map([[A, tp("alpha")], [B, tp("beta")]]),
			trust: new Map<string, Level>([[alice.id, "dispatch"], [bob.id, "dispatch"]]),
			operate: new Map<string, OperateGrant>([[alice.id, "box"], [bob.id, "team"]]),
		},
		roster: { [`${A}:${alice.id}`]: { role: "admin" }, [`${A}:${bob.id}`]: { role: "member" }, [`${B}:${bob.id}`]: { role: "admin" } },
		gui: true, membersGone: false, stall: false,
	};
	const logs: Record<string, unknown>[] = [], out: { team: string; device: string; message: OperateMessage; at: number }[] = [], order: string[] = [];
	const member: MemberOf = (team, device) => { const m = state.membersGone ? undefined : state.roster[`${team}:${device}`]; return m && { role: m.role, attended: true }; };
	const every = (ms: number, fn: () => void) => { let live = true; const arm = () => clock.at(clock.elapsed() + ms, () => { if (!live) return; fn(); arm(); }); arm(); return () => void (live = false); };
	let policyWatch: (() => void) | undefined, watchStopped = false, gui: Operate = fo.api;
	/** How often the facts an owner is read from were read again. */
	const facts = { reads: 0 };
	const deps: BoxDeps = {
		gui: () => (state.gui ? gui : undefined),
		send: async (team, device, message) => { out.push({ team, device, message, at: clock.elapsed() }); return state.stall ? new Promise(() => undefined) : { delivered: 1 }; },
		device: () => dave.id,
		policy: () => (order.push("policy"), state.policy),
		member, owner: (key) => OWNERS[key], refresh: async () => void facts.reads++, pane: (key) => `pane-${key}`,
		log: (entry) => void logs.push(entry), now: clock.now, every,
		watch: (onChange) => (order.push("watch"), (policyWatch = onChange), { stop: () => void (watchStopped = true) }),
		...(o.budget !== undefined ? { budget: o.budget } : {}),
	};
	const box = createOperateBox(deps);
	const ctls: Ctl[] = [], sent: { team: string; device: string; message: OperateMessage; at: number }[] = [];
	interface Ctl { who: typeof alice; team: string; sess: OperateSession; inner: OperateInner[]; at: number[]; ended: { reason: string; peer?: string }[]; toBox: OperateMessage[]; opened: unknown[] }
	const w = {
		clock, fo, state, logs, out, sent, order, box, ctls, facts,
		edit: (fn: (p: Extract<Policy, { mode: "unattended" }>) => void) => { fn(state.policy as Extract<Policy, { mode: "unattended" }>); policyWatch?.(); },
		watchStopped: () => watchStopped,
		/** The GUI restarts under the sessions: a new entry object answers `gui()` from now on, and the old one is still around. */
		swapGui: () => void (gui = fakeOperate().api),
		/** An operator's session on `team`: its open goes to the box on the next `pump`. */
		controller(who = alice, team = A, want: "team" | "box" = "team"): Ctl {
			const c = { who, team, inner: [], at: [], ended: [], toBox: [], opened: [] } as unknown as Ctl;
			c.sess = OperateSession.open({ now: clock.now, send: (m) => void c.toBox.push(m), onInner: (i) => void (c.inner.push(i), c.at.push(clock.elapsed())), onEnd: (e) => void c.ended.push(e), onOpen: (a) => void c.opened.push(a), onTransportError: () => undefined }, { team: Buffer.from(team, "hex"), self: who.id, peer: dave.id, want });
			ctls.push(c);
			return c;
		},
		/** Hands what each end sent to the other, until nothing is left. */
		async pump() {
			for (let round = 0; round < 8; round++) {
				let moved = false;
				for (const c of ctls) for (const message of c.toBox.splice(0)) (moved = true, box.take({ team: c.team, from: c.who.id, fromAttended: true, message, ts: clock.now(), dropped: 0 } satisfies OperateIn));
				await settle();
				for (const m of out.splice(0)) {
					moved = true;
					sent.push(m);
					for (const c of ctls) if (m.device === c.who.id && m.team === c.team && m.message.session.equals(c.sess.id)) c.sess.receive(m.message, dave.id);
				}
				if (!moved) break;
			}
		},
		/** Time passes in 250 ms steps (the box's pulse), the controllers tick, and the transport is pumped. */
		async run(ms: number) {
			for (let t = 0; t < ms; t += 250) {
				clock.advance(250);
				for (const c of ctls) c.sess.tick();
				await w.pump();
			}
		},
		async open(who = alice, team = A, want: "team" | "box" = "team") {
			const c = w.controller(who, team, want);
			await w.pump();
			return c;
		},
		req: (c: Ctl, id: string, m: "GET" | "POST", parts: string[], body: unknown = {}, q: unknown = {}) => c.sess.send({ t: "req", id, m, parts, q, body }),
		rep: (c: Ctl, id: string) => c.inner.find((i) => i.t === "rep" && i.id === id) as { status: number; body: Record<string, unknown> } | undefined,
	};
	return w;
}
type W = ReturnType<typeof world>;
const snaps = (c: { inner: OperateInner[] }) => c.inner.filter((i) => i.t === "snap").map((i) => i.net as Net);
const mirrorFrames = (c: { inner: OperateInner[] }, key = "a-main") => c.inner.filter((i) => i.t === "ev" && i.id === `m:${key}` && i.e === "mirror").map((i) => i.d as { key: string; seq: number; rows: number; cols: number; whole?: true; set: [number, string][] });
const pushScreen = (w: W, n: number, rows = 3) => w.fo.sessions[0]!.sink("m:a-main", "mirror", { key: "a-main", seq: n, rows, cols: 80, set: Array.from({ length: rows }, (_, i): [number, string] => [i, `row ${i} frame ${n}`]), whole: true });
const pushDiff = (w: W, n: number) => w.fo.sessions[0]!.sink("m:a-main", "mirror", { key: "a-main", seq: n, rows: 3, cols: 80, set: [[1, `row 1 frame ${n}`]] });
const logsOf = (w: W, event: string) => w.logs.filter((l) => l.event === event);

// ---- Admission and the sliced snapshot ------------------------------------------------------------------------------------------------------------------

test("an open from a granted admin is accepted, and its first snapshot holds its team's units only: no other team's, no box tower", async () => {
	const w = world();
	const c = await w.open(alice, A, "team");
	assert.equal(c.opened.length, 1, "the session opened at the controller");
	assert.deepEqual(c.opened[0], { scope: { teams: [Buffer.from(A, "hex")], box: false }, limits: { mirrors: 2, watches: 8, budget: 900 } });
	assert.equal(w.fo.sessions.length, 1);
	assert.deepEqual(snaps(c).map(keysOf), [["a-main"]], "a team scope sees its own team's unit and nothing else");
	assert.deepEqual(snaps(c)[0]!.bases[0]!.tower, null);
	assert.equal(logsOf(w, "operate-open").length, 1);
	assert.deepEqual({ ...logsOf(w, "operate-open")[0]!, session: "x" }, { event: "operate-open", team: A, from: alice.id, session: "x", want: "team", verdict: "accepted" });
});

test("a box grant that asked for the box part also sees the box's own units and its tower, never another team's", async () => {
	const w = world();
	const c = await w.open(alice, A, "box");
	assert.deepEqual(snaps(c).map(keysOf), [["a-main", "box-main", "tower"]]);
	assert.equal((c.opened[0] as { scope: { box: boolean } }).scope.box, true);
});

test("a device the policy does not grant is refused with a word before any data, and nothing opens on the GUI", async () => {
	const w = world();
	w.edit((p) => p.operate.delete(alice.id));
	const c = await w.open(alice, A);
	assert.deepEqual(c.ended.map((e) => [e.reason, e.peer]), [["refused", "not-granted"]]);
	assert.equal(w.fo.sessions.length, 0);
	assert.equal(logsOf(w, "operate-open")[0]!.verdict, "not-granted");
	assert.equal(snaps(c).length, 0);
});

test("a member who is not an admin of the team gets not-admin, and an admin of team B has no session on team A", async () => {
	const w = world();
	const c = await w.open(bob, A);
	assert.deepEqual(c.ended.map((e) => e.peer), ["not-admin"]);
	const d = await w.open(bob, B);
	assert.deepEqual(snaps(d).map(keysOf), [["b-main"]], "bob's own team");
});

test("no GUI to serve it: the open is refused as unavailable", async () => {
	const w = world();
	w.state.gui = false;
	const c = await w.open(alice, A);
	assert.deepEqual(c.ended.map((e) => e.peer), ["unavailable"]);
	assert.equal(logsOf(w, "operate-open")[0]!.verdict, "unavailable");
});

test("a replayed open of a session id already in use is refused without throwing, and the live session is untouched", async () => {
	const w = world();
	const c = await w.open(alice, A);
	const again = { team: A, from: alice.id, fromAttended: true, message: { session: c.sess.id, type: "open", eph: Buffer.alloc(32, 9), caps: ["operate/1"], want: "team" }, ts: w.clock.now(), dropped: 0 } as OperateIn;
	assert.doesNotThrow(() => w.box.take(again));
	await settle();
	assert.deepEqual(w.out.filter((m) => m.message.type === "refuse").map((m) => [m.device, (m.message as { reason: string }).reason]), [[alice.id, "seen"]]);
	assert.equal(c.sess.state, "open");
	assert.equal(w.fo.sessions.length, 1);
	assert.equal(w.fo.sessions[0]!.stopped, false);
	assert.deepEqual(logsOf(w, "operate-open").map((l) => l.verdict), ["accepted", "seen"]);
});

test("the policy watch starts before the first admission reads the policy", async () => {
	const w = world();
	await w.open(alice, A);
	assert.equal(w.order[0], "watch", "watchPolicy first, then the first admit's read");
	assert.ok(w.order.includes("policy"));
});

// ---- Requests: the check on every one, bound to the sender and the team ----------------------------------------------------------------------------

test("a request on an in-scope unit reaches the seam under the session's scope and is answered; the log line has the action and class but never the text", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "r1", "POST", ["sessions", "a-main", "input"], { text: `hello ${MARKER}` });
	w.req(c, "r2", "POST", ["sessions", "a-main", "keys"], { text: `typed ${MARKER}`, stream: "x" });
	w.req(c, "r3", "POST", ["sessions", "a-main", "keys"], { paste: `pasted ${MARKER}`, stream: "x" });
	w.req(c, "r4", "POST", ["sessions", "a-main", "keys"], { key: "enter", stream: "x" });
	w.req(c, "r5", "POST", ["sessions", "a-main", "keys"], { key: "ctrl+u", stream: "x" });
	w.req(c, "r6", "POST", ["sessions", "a-main", "keys"], { key: "up", stream: "x" });
	w.req(c, "r7", "POST", ["sessions", "a-main", "keys"], { keys: ["esc"] });
	w.req(c, "r8", "GET", ["history", "a-main"]);
	await w.pump();
	const seam = w.fo.sessions[0]!;
	assert.deepEqual(seam.requests.map((r) => r.parts.slice(0, 3).join("/")), ["sessions/a-main/input", "sessions/a-main/keys", "sessions/a-main/keys", "sessions/a-main/keys", "sessions/a-main/keys", "sessions/a-main/keys", "sessions/a-main/keys", "history/a-main"]);
	assert.ok(seam.requests[0]!.scope.has("a-main") && !seam.requests[0]!.scope.has("b-main") && !seam.requests[0]!.scope.box, "the scope the seam gets is the session's");
	for (const id of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) assert.equal(w.rep(c, id)?.status, 200, id);
	const inputs = logsOf(w, "operate-input").map((l) => [l.action, l.class, l.unit, l.pane, l.status]);
	assert.deepEqual(inputs, [["input", "text", "a-main", "pane-a-main", 200], ["keys", "text", "a-main", "pane-a-main", 200], ["keys", "paste", "a-main", "pane-a-main", 200], ["keys", "enter", "a-main", "pane-a-main", 200], ["keys", "chord", "a-main", "pane-a-main", 200], ["keys", "pad", "a-main", "pane-a-main", 200], ["keys", "esc", "a-main", "pane-a-main", 200]]);
	assert.deepEqual(logsOf(w, "operate-read").map((l) => [l.unit, l.what]), [["a-main", "history"]]);
	for (const l of logsOf(w, "operate-input")) assert.deepEqual(Object.keys(l).sort(), ["action", "class", "event", "from", "pane", "session", "status", "team", "unit"].sort());
	assert.ok(!JSON.stringify(w.logs).includes(MARKER), "what was typed is in no log line");
});

test("a request on another team's unit is refused out-of-scope: no seam call, a logged operate-refused, the session stays", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "r1", "POST", ["sessions", "b-main", "input"], { text: "hi" });
	w.req(c, "r2", "POST", ["sessions", "box-main", "input"], { text: "hi" });
	w.req(c, "r3", "POST", ["close", "unit"], { key: "b-main" });
	await w.pump();
	assert.equal(w.fo.sessions[0]!.requests.length, 0);
	for (const id of ["r1", "r2", "r3"]) assert.deepEqual([w.rep(c, id)?.status, w.rep(c, id)?.body.why], [403, "out-of-scope"], id);
	assert.deepEqual(logsOf(w, "operate-refused").map((l) => [l.route, l.reason]), [["sessions/*/input", "out-of-scope"], ["sessions/*/input", "out-of-scope"], ["close/unit", "out-of-scope"]]);
	assert.equal(c.sess.state, "open");
});

test("a route that stays on the box's console is refused local-only and logged; `open/*` and a bare pane's keys never reach the seam", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "r1", "POST", ["open", "main"], { dir: "/x" });
	w.req(c, "r2", "POST", ["panes", "g1", "keys"], { key: "enter" });
	await w.pump();
	assert.equal(w.fo.sessions[0]!.requests.length, 0);
	assert.deepEqual([w.rep(c, "r1")?.status, w.rep(c, "r1")?.body.why], [403, "local-only"]);
	assert.deepEqual([w.rep(c, "r2")?.status, w.rep(c, "r2")?.body.why], [403, "local-only"]);
	assert.deepEqual(logsOf(w, "operate-refused").map((l) => l.reason), ["local-only", "local-only"]);
});

test("a request whose grant is gone ends the session with the guard's reason: close goes out, the seam session stops, operate-close is logged once", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.state.policy = { ...(w.state.policy as Extract<Policy, { mode: "unattended" }>), operate: new Map() };
	w.req(c, "r1", "POST", ["sessions", "a-main", "input"], { text: "hi" });
	await w.pump();
	assert.equal(w.fo.sessions[0]!.requests.length, 0);
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "policy" }]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason, l.team, l.from]), [["box", "policy", A, alice.id]]);
});

test("a frame under another device's name, or on another team, is not the session's request: nothing reaches the seam", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "r1", "POST", ["sessions", "a-main", "input"], { text: "hi" });
	const [message] = c.toBox.splice(0);
	w.box.take({ team: A, from: bob.id, fromAttended: true, message: message!, ts: w.clock.now(), dropped: 0 });
	w.box.take({ team: B, from: alice.id, fromAttended: true, message: message!, ts: w.clock.now(), dropped: 0 });
	await settle();
	assert.equal(w.fo.sessions[0]!.requests.length, 0, "neither the stranger's nor the other team's copy was taken");
	assert.deepEqual(logsOf(w, "operate-drop").map((l) => l.reason), ["wrong-sender", "wrong-sender"]);
	w.box.take({ team: A, from: alice.id, fromAttended: true, message: message!, ts: w.clock.now(), dropped: 0 });
	await settle();
	assert.equal(w.fo.sessions[0]!.requests.length, 1, "the real sender's is");
});

test("a watch is checked and handed to the seam; a unit out of scope is refused with a rep under the watch's id", async () => {
	const w = world();
	const c = await w.open(alice, A);
	c.sess.send({ t: "watch", id: "w1", target: "a-main", on: true });
	c.sess.send({ t: "watch", id: "w2", target: "b-main", on: true });
	await w.pump();
	assert.deepEqual(w.fo.sessions[0]!.watches, [["w1", "a-main", true]]);
	assert.deepEqual([w.rep(c, "w2")?.status, w.rep(c, "w2")?.body.why], [403, "out-of-scope"]);
	assert.deepEqual(logsOf(w, "operate-watch").map((l) => [l.unit, l.on]), [["a-main", true]]);
	w.fo.sessions[0]!.sink("w1", "history", { key: "a-main", items: [] });
	await w.run(500);
	assert.ok(c.inner.some((i) => i.t === "ev" && i.id === "w1" && i.e === "history"));
});

test("a mirror request goes to the seam's own mirror entry and is logged as operate-mirror", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	assert.deepEqual(w.fo.sessions[0]!.mirrors, [["a-main", true]]);
	assert.equal(w.rep(c, "m1")?.status, 200);
	assert.deepEqual(logsOf(w, "operate-mirror").map((l) => [l.unit, l.pane, l.on]), [["a-main", "pane-a-main", true]]);
});

// ---- Pacing and budget -------------------------------------------------------------------------------------------------------------------------------

test("the mirror sends whole screens at most twice a second while the screen moves, then an empty current frame every 2 s", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	pushScreen(w, 1);
	for (let n = 2; n <= 41; n++) {
		await w.run(250);
		pushDiff(w, n); // Herdr's reader sends only the changed row: the bridge folds it into the whole screen
	}
	const moving = mirrorFrames(c);
	for (const f of moving) {
		assert.equal(f.whole, true, "whole screens, never row diffs");
		assert.equal(f.rows, 3);
		assert.equal(f.set.length, 3, "every row is in it");
	}
	assert.ok(moving.length <= 21, `${moving.length} frames in 10 s: at most 2 a second`);
	assert.ok(moving.length >= 18, `${moving.length} frames in 10 s: it keeps up at the cap`);
	assert.match(moving.at(-1)!.set[1]![1], /^row 1 frame (3[5-9]|4[01])$/, "the latest diff landed in the whole screen");
	assert.match(moving.at(-1)!.set[0]![1], /^row 0 frame 1$/, "the rows the diffs did not touch are kept");
	await w.run(1000);
	const before = mirrorFrames(c).length;
	await w.run(10_000);
	const calm = mirrorFrames(c).slice(before);
	assert.ok(calm.length >= 4 && calm.length <= 6, `${calm.length} calm frames in 10 s`);
	for (const f of calm) assert.deepEqual([f.set.length, f.whole], [0, undefined], "an empty current frame");
});

test("a mirror that ends or is hidden reaches the controller without waiting for a cadence", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	pushScreen(w, 1);
	await w.run(500);
	w.fo.sessions[0]!.sink("m:a-main", "mirror", { key: "a-main", ended: "The pane closed." });
	await w.run(250);
	const last = c.inner.filter((i) => i.t === "ev" && i.id === "m:a-main").at(-1)!;
	assert.deepEqual(last.d, { key: "a-main", ended: "The pane closed." });
});

test("when the budget runs short the mirror is stretched to 1 s and then 2 s, bulk stops at the budget, and a rep is never held back", async () => {
	const w = world({ budget: 40 });
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	pushScreen(w, 1);
	for (let n = 2; n <= 201; n++) {
		await w.run(250);
		pushDiff(w, n);
	}
	const times = c.inner.flatMap((i, k) => (i.t === "ev" && i.id === "m:a-main" && i.e === "mirror" ? [c.at[k]!] : []));
	const gaps = times.slice(1).map((t, i) => t - times[i]!);
	assert.equal(gaps[0], 500, "twice a second while the budget is calm");
	const slow = gaps.findIndex((g) => g >= 1000);
	assert.ok(slow > 0, `the mirror was stretched: ${gaps}`);
	assert.ok(gaps.slice(slow).every((g) => g >= 1000), `and stayed stretched: ${gaps}`);
	assert.ok(gaps.some((g) => g >= 2000), `to 2 s: ${gaps}`);
	assert.ok(w.sent.length <= 40 + 4, `bulk never passes the budget (50 s of a moving screen), a few control frames aside: ${w.sent.length}`);
	w.req(c, "r1", "GET", ["history", "a-main"]);
	await w.run(500);
	assert.equal(w.rep(c, "r1")?.status, 200, "an answer goes whatever the budget says");
});

test("the snapshot keeps its 2 s cadence while the budget is a half spent and the mirror is already stretched", async () => {
	const w = world({ budget: 100 });
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	pushScreen(w, 1);
	for (let n = 2; n <= 121; n++) {
		await w.run(250);
		pushDiff(w, n);
	}
	assert.ok(w.sent.length >= 50 && w.sent.length < 90, `the budget is half spent: ${w.sent.length} of 100`);
	const before = snaps(c).length;
	w.fo.set((n) => void (n.bases[0]!.tabs[0]!.units[0]!.mark = "working"));
	w.fo.changed();
	await w.run(2250);
	assert.equal(snaps(c).length, before + 1, "the changed net went within 2 s");
});

test("the snapshot goes at once after accept and then at most one per 2 s, and only when the sliced net moved", async () => {
	const w = world();
	const c = await w.open(alice, A);
	assert.equal(snaps(c).length, 1);
	await w.run(6000);
	assert.equal(snaps(c).length, 1, "a calm net sends nothing more");
	w.fo.changed();
	await w.run(2500);
	assert.equal(snaps(c).length, 1, "a change the slice does not show is not sent");
	w.fo.set((n) => void (n.bases[0]!.tabs[0]!.units[0]!.mark = "working"));
	w.fo.changed();
	await w.run(250);
	w.fo.set((n) => void (n.bases[0]!.tabs[0]!.units[0]!.mark = "waiting"));
	w.fo.changed();
	await w.run(250);
	assert.equal(snaps(c).length, 2, "the first change went at once, the second waits for the 2 s");
	await w.run(2000);
	assert.equal(snaps(c).length, 3);
	assert.equal(snaps(c).at(-1)!.bases[0]!.tabs[0]!.units[0]!.mark, "waiting");
});

test("the facts a unit's owner is read from are read again before every request's check, and every 2 s while a session lives", async () => {
	const w = world();
	const c = await w.open(alice, A);
	await w.run(1000);
	const before = w.facts.reads;
	w.req(c, "r1", "GET", ["history", "a-main"]);
	await w.pump();
	assert.equal(w.facts.reads, before + 1, "one read for the request's check");
	const idle = w.facts.reads;
	await w.run(6000);
	assert.ok(w.facts.reads >= idle + 3, `the periodic read: ${w.facts.reads - idle} in 6 s`);
});

test("a relay that does not answer holds bulk at 32 sends in flight, and a rep still goes", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	w.state.stall = true;
	pushScreen(w, 1);
	for (let n = 2; n <= 121; n++) {
		w.clock.advance(250);
		pushDiff(w, n);
		await settle();
	}
	const count = w.out.length;
	assert.ok(count <= 32 + 2, `at most 32 sends were handed on while none was answered: ${count}`);
	w.req(c, "r1", "GET", ["history", "a-main"]);
	for (const m of c.toBox.splice(0)) w.box.take({ team: A, from: alice.id, fromAttended: true, message: m, ts: w.clock.now(), dropped: 0 });
	await settle();
	assert.equal(w.out.length, count + 1, "the rep went all the same");
});

test("watch events piling up behind a relay that does not answer end the session as overloaded instead of growing without a bound", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.state.stall = true;
	for (let n = 0; n < 600; n++) w.fo.sessions[0]!.sink("w1", "history", { key: "a-main", n });
	await settle();
	assert.equal(logsOf(w, "operate-overload").length, 1);
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason]), [["box", "overload"]]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
	assert.ok(w.out.some((m) => m.message.type === "close"), "and the close went out");
	void c;
});

// ---- Teardown ----------------------------------------------------------------------------------------------------------------------------------------

test("a policy edit that withdraws the grant ends the session at the watch: close with the reason, seam stopped, operate-close logged once", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.edit((p) => p.operate.delete(alice.id));
	await w.pump();
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "policy" }]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason]), [["box", "policy"]]);
	assert.equal(typeof logsOf(w, "operate-close")[0]!.seconds, "number");
	w.edit((p) => p.operate.delete(alice.id));
	await w.pump();
	assert.equal(logsOf(w, "operate-close").length, 1, "nothing ends twice");
});

test("a lowered grant narrows the scope: the seam is told to rescope, and the next snapshot has no box units", async () => {
	const w = world();
	const c = await w.open(alice, A, "box");
	assert.deepEqual(keysOf(snaps(c)[0]!), ["a-main", "box-main", "tower"]);
	w.edit((p) => p.operate.set(alice.id, "team"));
	await w.run(2500);
	const seam = w.fo.sessions[0]!;
	assert.equal(seam.rescoped.length, 1);
	assert.equal(seam.rescoped[0]!.box, false);
	assert.equal(c.sess.state, "open", "the session goes on with what is left");
	assert.deepEqual(keysOf(snaps(c).at(-1)!), ["a-main"]);
});

test("a roster change that demotes the operator ends the session, synchronously and without waiting for anything", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.state.roster[`${A}:${alice.id}`] = { role: "member" };
	w.box.onRoster(A);
	assert.equal(w.fo.sessions[0]!.stopped, true, "the seam session stopped inside the call");
	assert.ok(w.out.some((m) => m.message.type === "close" && m.device === alice.id), "the close was handed to the transport inside the call");
	await w.pump();
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "roster" }]);
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason]), [["box", "roster"]]);
});

test("the team stopping (the box left it, or the holder stopped) ends the session: the roster no longer knows the operator", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.state.membersGone = true;
	w.box.onRoster(A);
	await w.pump();
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "roster" }]);
});

test("the operator's own close, and its silence, end the session by the operator and by the box", async () => {
	const w = world();
	const c = await w.open(alice, A);
	c.sess.close("leave");
	await w.pump();
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason]), [["operator", "leave"]]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
	await w.open(alice, A);
	for (let t = 0; t < 50_000; t += 250) (w.clock.advance(250), await settle()); // the operator goes silent: no ping, no frame
	assert.deepEqual(logsOf(w, "operate-close").map((l) => [l.by, l.reason]).at(-1), ["box", "silence"]);
});

test("a GUI that stopped under a session ends it as unavailable", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.state.gui = false;
	await w.run(500);
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "unavailable" }]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
});

test("stopping the box ends every session and the policy watch", async () => {
	const w = world();
	await w.open(alice, A);
	await w.open(bob, B);
	w.box.stop();
	assert.equal(w.fo.sessions.every((s) => s.stopped), true);
	assert.equal(w.watchStopped(), true);
	assert.deepEqual(logsOf(w, "operate-close").map((l) => l.by), ["box", "box"]);
});

// ---- Review of task 5 (OBX-F001 to F005) --------------------------------------------------------------------------------------------------------------

/** An `open` envelope as the holder hands it over: a fresh session id each time unless one is given. */
const openFrom = (w: W, who: typeof alice, team: string, id = randomBytes(16)) => w.box.take({ team, from: who.id, fromAttended: true, message: { session: id, type: "open", eph: randomBytes(32), caps: ["operate/1"], want: "team" }, ts: w.clock.now(), dropped: 0 } as OperateIn);
const refusals = (w: W) => [...w.sent, ...w.out].filter((m) => m.message.type === "refuse");

test("OBX-F001: refusals of a member who is not granted are throttled per (team, sender) and do not spend the box's budget, so a granted session's mirror goes on and link.log keeps its audit", async () => {
	const w = world({ budget: 40 });
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.run(2500);
	pushScreen(w, 1);
	await w.run(750);
	const before = mirrorFrames(c).length;
	assert.ok(before >= 1, "the mirror flows while the budget is calm");
	w.edit((p) => p.operate.delete(bob.id));
	w.logs.length = 0;
	for (let i = 0; i < 60; i++) openFrom(w, bob, A);
	await settle();
	assert.equal(refusals(w).length, 1, "one refuse in the window; the controller remembers it for 10 minutes anyway");
	assert.equal(logsOf(w, "operate-open").length, 1, "one operate-open line, not sixty");
	for (let n = 2; n < 10; n++) { pushScreen(w, n); await w.run(500); }
	assert.ok(mirrorFrames(c).length - before >= 4, "the granted session's mirror still flows after the flood");
});

test("OBX-F001: the window closes after 10 s, the next refusal goes out, and one operate-open-throttled line counts what was dropped", async () => {
	const w = world();
	w.edit((p) => p.operate.delete(bob.id));
	for (let i = 0; i < 5; i++) openFrom(w, bob, A);
	await settle();
	assert.equal(refusals(w).length, 1);
	w.clock.advance(9_000);
	openFrom(w, bob, A);
	await settle();
	assert.equal(refusals(w).length, 1, "still inside the window");
	w.clock.advance(1_500);
	openFrom(w, bob, A);
	await settle();
	assert.equal(refusals(w).length, 2, "the window passed: refused again");
	assert.deepEqual(logsOf(w, "operate-open-throttled").map((l) => [l.team, l.from, l.dropped]), [[A, bob.id, 5]]);
	assert.equal(logsOf(w, "operate-open").length, 2);
});

test("OBX-F001: a window still open when the box stops logs what it dropped", async () => {
	const w = world();
	w.edit((p) => p.operate.delete(bob.id));
	for (let i = 0; i < 4; i++) openFrom(w, bob, A);
	await settle();
	assert.deepEqual(logsOf(w, "operate-open-throttled"), []);
	w.box.stop();
	assert.deepEqual(logsOf(w, "operate-open-throttled").map((l) => [l.team, l.from, l.dropped]), [[A, bob.id, 3]]);
});

test("OBX-F001: a refusal that comes from the registry (a third open session of one operator on one team) opens the window as well", async () => {
	const w = world();
	await w.open(alice, A);
	await w.open(alice, A);
	for (let i = 0; i < 6; i++) openFrom(w, alice, A);
	await settle();
	assert.equal(refusals(w).length, 1, "the third open is refused by the registry once; the five after it are dropped in the window");
	assert.equal(logsOf(w, "operate-open").filter((l) => l.verdict !== "accepted").length, 1);
});

test("OBX-F001: another team's open from the same sender, and another sender's, are not held by a window", async () => {
	const w = world();
	w.edit((p) => p.operate.delete(alice.id));
	for (let i = 0; i < 3; i++) openFrom(w, alice, A);
	for (let i = 0; i < 3; i++) openFrom(w, bob, A); // bob is no admin on A (not-admin): refused, in a window of its own
	await settle();
	assert.deepEqual(refusals(w).map((m) => m.device).sort(), [alice.id, bob.id].sort(), "one refuse for each (team, sender)");
	const c = await w.open(bob, B);
	assert.equal(c.opened.length, 1, "bob's open on team B, which he admins and is granted, is not held by the window on A");
});

test("OBX-F001: a refuse is not counted against the budget (the budget keeps room for the granted session's frames)", async () => {
	const w = world({ budget: 6 });
	const c = await w.open(alice, A);
	w.req(c, "m1", "POST", ["sessions", "a-main", "mirror"], { on: true });
	await w.pump();
	w.edit((p) => p.operate.delete(bob.id));
	for (let k = 0; k < 4; k++) { openFrom(w, bob, A); await w.run(10_500); }
	assert.equal(refusals(w).length, 4, "four refusals went out, a window apart");
	const before = mirrorFrames(c).length;
	pushScreen(w, 1);
	await w.run(1_000);
	assert.ok(mirrorFrames(c).length > before, "a mirror frame still goes: the refusals took none of the budget");
});

test("OBX-F003: after stop(), an open is refused and nothing arms again; another frame of a session is dropped", async () => {
	const w = world();
	const c0 = await w.open(alice, A);
	w.box.stop();
	const orderAfterStop = [...w.order], logsAfterStop = w.logs.length;
	const c = await w.open(alice, A);
	assert.equal(c.opened.length, 0, "no session after stop");
	assert.deepEqual(c.ended, [{ reason: "refused", peer: "unavailable" }]);
	assert.deepEqual(w.box.sessions(), []);
	assert.deepEqual(w.order, orderAfterStop, "no policy read and no policy watch began after stop");
	assert.equal(w.fo.sessions.length, 1, "the GUI opened no second seam session");
	assert.ok(w.logs.length >= logsAfterStop, "the refusal is logged as an operate-open line");
	assert.deepEqual(c0.ended, [{ reason: "peer-closed", peer: "stopped" }]);
});

test("OBX-F004: a tower memory request is logged as the action memory, any other tower route as tower", async () => {
	const w = world();
	const c = await w.open(alice, A, "box");
	w.req(c, "t1", "POST", ["tower", "wA", "memory"], { text: MARKER });
	w.req(c, "t2", "POST", ["tower", "wA", "leave"], {});
	await w.pump();
	assert.deepEqual(logsOf(w, "operate-input").map((l) => l.action), ["memory", "tower"]);
	assert.equal(JSON.stringify(w.logs).includes(MARKER), false);
});

test("OBX-F005 (M12): a GUI that restarted under a session, a new entry while the old one is still there, ends it as unavailable", async () => {
	const w = world();
	const c = await w.open(alice, A);
	w.swapGui();
	await w.run(500);
	assert.deepEqual(c.ended, [{ reason: "peer-closed", peer: "unavailable" }]);
	assert.equal(w.fo.sessions[0]!.stopped, true);
	assert.deepEqual(w.box.sessions(), []);
});

test("OBX-F005: a request that names no unit (close/tab), right after a demotion and before any pulse, reaches the seam under the narrowed scope", async () => {
	const w = world();
	const c = await w.open(alice, A, "box");
	w.state.roster[`${A}:${alice.id}`] = { role: "member" }; // the roster moved; neither onRoster nor a pulse has run
	w.req(c, "q1", "POST", ["close", "tab"], { tab: "t1" });
	await w.pump();
	const seen = w.fo.sessions[0]!.requests.filter((r) => r.parts[0] === "close");
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.scope.has("a-main"), false, "team A's part is gone from the scope the seam runs under");
	assert.equal(seen[0]!.scope.has("box-main"), true, "a box grant keeps the box part");
});
