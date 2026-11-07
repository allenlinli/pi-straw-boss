import { randomBytes } from "node:crypto";
import type { Level, TeamPolicy } from "../src/link/config.ts";
import type { OperateIn } from "../src/link/holder.ts";
import type { OperateMessage } from "../src/link/kinds.ts";
import { OperateSession, type OperateInner } from "../src/link/operate.ts";
import type { OperateGrant, Policy } from "../src/link/policy.ts";
import type { Reply } from "../src/control.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import type { Operate, OperateSession as Seam, Sink } from "../src/operateseam.ts";
import type { Transcripts } from "../src/watch.ts";
import { type OperateScope } from "../src/operateroutes.ts";
import { sliceNet } from "../src/operateslice.ts";
import { createOperateBox, type BoxDeps } from "../src/server/operatebox.ts";
import type { MemberOf, Owner } from "../src/server/operatescope.ts";
import { fakeClock } from "./fake-clock.ts";
import { DEVICES } from "./link/scenario.ts";

// The box test world (task 5), shared by tests/server-operate-box.test.ts and the controller host's wire test (tests/server-operate-host-wire.test.ts), so both run against the same one.
// The box's bridge (docs/specs/2026-11-07-link-operate.md §11 row 5, §5.4, §5.5, §10): the holder's operate sink, a session per operator whose grant the guard checks on every request, the sliced net, the mirror at most twice a second as whole
// screens, a budget that stretches the mirror first, and link.log lines that never carry what was typed. Both ends are real `OperateSession`s over a transport the test pumps, so the frames are really sealed; Herdr's GUI is a fake of
// the seam, and the clock is the test's.

export const { alice, bob, dave } = DEVICES;
export const A = "a".repeat(32), B = "b".repeat(32);
export const MARKER = "zq7-marker-should-never-be-logged";
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
export const keysOf = (net: Net): string[] => net.bases.flatMap((b) => [...(b.tower ? [b.tower.key] : []), ...b.tabs.flatMap((t) => t.units.map((u) => u.key))]).sort();
export const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

interface Recorded { /** What the box gave this session as its transcripts (undefined when it gave none). */ transcripts: Transcripts | undefined; watches: [string, string, boolean][]; mirrors: [string, boolean][]; requests: { method: string; parts: string[]; body: unknown; scope: OperateScope }[]; rescoped: OperateScope[]; stopped: boolean; sink: Sink }
function fakeOperate(replies: { request?: (parts: string[]) => Reply } = {}) {
	const sessions: (Recorded & Seam)[] = [], listeners = new Set<() => void>();
	let snapshots = 0, net = NET();
	const api: Operate = {
		async snapshot(scope) { snapshots++; return sliceNet(JSON.parse(JSON.stringify(net)) as Net, scope); },
		changed: (l) => (listeners.add(l), () => void listeners.delete(l)),
		open(sink, transcripts) {
			const s: Recorded & Seam = {
				transcripts, watches: [], mirrors: [], requests: [], rescoped: [], stopped: false, sink,
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
export function world(o: { budget?: number; transcripts?: BoxDeps["transcripts"]; observe?: BoxDeps["observe"] } = {}) {
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
		...(o.transcripts ? { transcripts: o.transcripts } : {}),
		...(o.observe ? { observe: o.observe } : {}),
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
export type W = ReturnType<typeof world>;
const snaps = (c: { inner: OperateInner[] }) => c.inner.filter((i) => i.t === "snap").map((i) => i.net as Net);
const mirrorFrames = (c: { inner: OperateInner[] }, key = "a-main") => c.inner.filter((i) => i.t === "ev" && i.id === `m:${key}` && i.e === "mirror").map((i) => i.d as { key: string; seq: number; rows: number; cols: number; whole?: true; set: [number, string][] });
export const pushScreen = (w: W, n: number, rows = 3) => w.fo.sessions[0]!.sink("m:a-main", "mirror", { key: "a-main", seq: n, rows, cols: 80, set: Array.from({ length: rows }, (_, i): [number, string] => [i, `row ${i} frame ${n}`]), whole: true });
const pushDiff = (w: W, n: number) => w.fo.sessions[0]!.sink("m:a-main", "mirror", { key: "a-main", seq: n, rows: 3, cols: 80, set: [[1, `row 1 frame ${n}`]] });
