import { OperateRegistry, OperateSession, refuseOpen, type OperateInner } from "../src/link/operate.ts";
import type { OperateMessage } from "../src/link/kinds.ts";
import type { Base, Net, Unit } from "../src/net.ts";
import { type BoxOffer, createOperateHost } from "../src/server/operatehost.ts";
import { fakeClock } from "./fake-clock.ts";
import { DEVICES } from "./link/scenario.ts";

// The controller's host (src/server/operatehost.ts) against fake boxes that run the real session core (`OperateSession.accept`) over a hand-pumped transport: what the host sends reaches the box on `pump`, and what the box sends
// reaches the host's `receive` the same way, so nothing is delivered inside the call that sent it (the real relay never does). Every inner message the host sent is kept on the box for the test to read, and the box's own are made by
// `snap`, `rep` and `ev`.

export const { alice, dave } = DEVICES;
export const A = "0f".repeat(16), B = "1e".repeat(16);
export const offer = (team = A, over: Partial<BoxOffer> = {}): BoxOffer => ({ team, teamName: team === A ? "Alpha" : "Beta", device: dave.id, short: dave.shortId, label: "ci-box", ...over });

export const unit = (key: string, over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle", subs: [], ...over });
export const baseOf = (id: string, tabs: [string, Unit[]][], over: Partial<Base> = {}): Base => ({ id, label: `ws ${id}`, mark: "idle", tower: null, outposts: [], outside: [], tabs: tabs.map(([tab, units]) => ({ id: tab, label: `tab ${tab}`, units })), ...over });
export const netOf = (...bases: Base[]): Net => ({ bases });

export interface FakeBox { team: string; device: string; session?: OperateSession; inner: OperateInner[]; policy: "accept" | string; scope: { teams: Buffer[]; box: boolean }; limits: { mirrors: number; watches: number; budget: number }; opens: number; snap(net: unknown): void; rep(id: string, status: unknown, body: unknown): void; ev(id: string, e: string, d: unknown): void; send(inner: OperateInner): void; close(reason: string): void; reqs(): OperateInner[]; watches(): OperateInner[] }

/** `devices` adds boxes of other devices to each team (one box per team and device). */
export function hostWorld(o: { teams?: string[]; box?: boolean; devices?: string[] } = {}) {
	const clock = fakeClock(1_800_000_000_000), registry = new OperateRegistry(clock.now), logs: Record<string, unknown>[] = [], offers: BoxOffer[] = (o.teams ?? [A]).flatMap((t) => [offer(t), ...(o.devices ?? []).map((d) => offer(t, { device: d, short: d.slice(0, 6) }))]);
	const toBox: { team: string; device: string; message: OperateMessage }[] = [], boxes = new Map<string, FakeBox>(), changes = { n: 0 };
	let down = false, failing = false;
	const stats = { opens: 0 }, paused = { on: false };
	const host = createOperateHost({
		now: clock.now, device: () => alice.id, boxes: () => offers, paused: () => paused.on, log: (e) => void logs.push(e), interval: false,
		send: async (team, device, message) => { if (failing) throw new Error("relay down"); if (message.type === "open") stats.opens++; if (!down) toBox.push({ team, device, message }); return { delivered: 1 }; },
	});
	host.onChange(() => void changes.n++);
	const box = (team = A, device = dave.id): FakeBox => {
		let b = boxes.get(`${team}\0${device}`);
		if (!b) {
			b = { team, device, inner: [], policy: "accept", scope: { teams: [Buffer.from(team, "hex")], box: o.box ?? true }, limits: { mirrors: 2, watches: 8, budget: 900 }, opens: 0 } as unknown as FakeBox;
			const self = b;
			self.send = (i) => void self.session?.send(i);
			self.snap = (net) => self.send({ t: "snap", net });
			self.rep = (id, status, body) => self.send({ t: "rep", id, status, body });
			self.ev = (id, e, d) => self.send({ t: "ev", id, e, d });
			self.close = (reason) => self.session?.close(reason);
			self.reqs = () => self.inner.filter((i) => i.t === "req");
			self.watches = () => self.inner.filter((i) => i.t === "watch");
			boxes.set(`${team}\0${device}`, self);
		}
		return b;
	};
	const takeAt = (team: string, device: string, message: OperateMessage) => {
		const b = box(team, device);
		if (message.type === "open") {
			const deps = { now: clock.now, send: (m: OperateMessage) => void out.push({ team, device, message: m }), onInner: (i: OperateInner) => void b.inner.push(i), onEnd: () => undefined, onTransportError: () => undefined };
			if (b.policy !== "accept") return refuseOpen(deps, message.session, b.policy);
			b.opens++;
			b.session = OperateSession.accept(deps, { team: Buffer.from(team, "hex"), self: device, from: alice.id, open: message, scope: b.scope, limits: b.limits, registry }) ?? b.session;
		} else b.session?.receive(message, alice.id);
	};
	const out: { team: string; device: string; message: OperateMessage }[] = [];
	/** What the host sent reaches the boxes and what the boxes sent reaches the host, until nothing is left. */
	const pump = async () => {
		for (let round = 0; round < 10; round++) {
			let moved = false;
			for (const m of toBox.splice(0)) (moved = true, takeAt(m.team, m.device, m.message));
			await new Promise((r) => setImmediate(r));
			for (const m of out.splice(0)) (moved = true, !down && host.receive({ team: m.team, from: m.device, fromAttended: false, message: m.message, ts: clock.now(), dropped: 0 }));
			if (!moved) break;
		}
	};
	/** Time passes in `ms` steps of 1 s: the host's tick, then the transport. */
	const run = async (ms: number, step = 1000) => {
		for (let t = 0; t < ms; t += step) {
			clock.advance(step);
			host.tick();
			for (const b of boxes.values()) b.session?.tick();
			await pump();
		}
	};
	/** A page connects: the session opens at the next tick and the box answers. */
	const page = async () => {
		const left = host.page();
		await new Promise<void>((r) => queueMicrotask(r));
		await pump();
		await pump();
		return left;
	};
	return { paused, clock, host, box, logs, offers, pump, run, page, changes, stats, registry, partition: (v: boolean) => (down = v), /** The relay refuses every send (the holder's `sendLive` rejects). */ fail: (v: boolean) => (failing = v), sent: () => toBox };
}
