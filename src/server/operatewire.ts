import { homedir } from "node:os";
import { join } from "node:path";
import { type Pane, type HerdrRun, panes } from "../herdr.ts";
import { watchPolicy } from "../link/policy.ts";
import type { LinkService } from "../link/service.ts";
import type { Found, Net, Ref } from "../net.ts";
import type { Operate } from "../operateseam.ts";
import { dispatcherOf } from "./dispatcher.ts";
import { createOperateBox } from "./operatebox.ts";
import { openLedger, seenFrom } from "./operateledger.ts";
import { ownerOf, type Scope, storeOwnerWorld } from "./operatescope.ts";
import type { Slot } from "./record.ts";

// The operate bridge of an unattended box, wired to the server's own parts (docs/specs/2026-11-07-link-operate.md §6.1): the holder's `operate` sink and `onRoster` hook reach it through the link service (main.ts), and it reaches the GUI's
// in-process operate entry through the GUI host. A unit's owner is read from the box's records (operatescope.ts) over facts `refresh` reads before each check (Herdr's listing), with the live ally panes and the registry read at the
// moment of the request.
export interface OperateWireDeps {
	/** Told after a session of the bridge has ended. */
	ended?(): void;
	slot: Slot;
	now(): number;
	run: HerdrRun;
	/** The GUI host's way in while a GUI runs (guihost.ts `operate`). */
	gui(): { api: Operate; refs(): Ref[]; lookup(key: string): Found | undefined } | undefined;
	allyPanes(): { pane: string; device: string; team?: string }[];
	link(): LinkService | undefined;
	/** pi's session folder, where a transcript may be read from (default: the one the net reads session files from, net.ts). */
	sessionDir?: string;
	/** How often the box reads its own net for the ledger while its policy has an `operate` grant, with no session or page to cause a reading (default 30 s). */
	netMs?: number;
	/** A repeating timer; returns the way to stop it (default `setInterval`, unref'd). */
	every?(ms: number, fn: () => void): () => void;
}
const NET_MS = 30_000;
const timerOf = (ms: number, fn: () => void): (() => void) => { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); };

/**
 * The facts a unit's owner is read from, and the refresh that reads Herdr's listing for them. A listing that cannot be read is no listing: it is dropped rather than kept or emptied, and until a read succeeds a main, member
 * or subagent is nobody's, for the box part as well as for a team's (a failed read must not hand a team's units to a `box` session). Never rejects.
 */
export function operateFacts(o: Pick<OperateWireDeps, "slot" | "now" | "run" | "gui" | "allyPanes">) {
	let listing: Pane[] | undefined;
	const world = () => storeOwnerWorld({ slot: o.slot, now: o.now, refs: () => o.gui()?.refs() ?? [], panes: () => listing, allyPanes: o.allyPanes });
	return {
		owner: (key: string) => ownerOf(world(), key),
		/** The owner for a reading that is kept (the ledger): none while the listing, the pane's token and the `opened` row do not yet agree on whose it is (operatescope.ts `ownerOf`, `settled`). */
		settled: (key: string) => ownerOf(world(), key, true),
		/** The device that dispatched a unit, from the same listing (dispatcher.ts); nobody's when no listing has been read or the unit has no pane. */
		device: (key: string): string | undefined => {
			const pane = o.gui()?.lookup(key)?.pane;
			return pane && listing ? dispatcherOf(pane, listing, o.allyPanes())?.device : undefined;
		},
		refresh: async (): Promise<void> => void (listing = await panes(o.run).catch(() => undefined)),
	};
}

/** A scope that holds every unit: the ledger is given the box's whole reading, not a session's slice (operateledger.ts `observe`). */
const EVERYTHING = { box: true, has: () => true };
/** The workspace labels of a reading, and the keys of the finished subagents in it. */
function readingOf(net: Net): { labels: Map<string, string>; finished: Set<string> } {
	const labels = new Map<string, string>(), finished = new Set<string>();
	const walk = (u: { key: string; ended?: boolean; subs?: unknown[] }) => { if (u.ended) finished.add(u.key); for (const c of (u.subs ?? []) as (typeof u)[]) walk(c); };
	for (const b of net.bases) {
		labels.set(b.id, b.label);
		if (b.tower) walk(b.tower);
		for (const t of b.tabs) t.units.forEach(walk);
		b.outside.forEach(walk);
	}
	return { labels, finished };
}

/**
 * The box's ledger of finished runs (operateledger.ts) with the two seams of the bridge it plugs into: `observe` after each session's snapshot, `transcripts` for each session's hub. The ledger learns from the whole registry, never a session's
 * slice (the dispatcher and the owner of each unit come from the facts the owner is read from), one reading at a time.
 */
export function operateRecord(o: Pick<OperateWireDeps, "slot" | "now" | "gui" | "link" | "sessionDir">, facts: Pick<ReturnType<typeof operateFacts>, "settled" | "device" | "refresh">) {
	const sessionDir = o.sessionDir ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
	const ledger = openLedger({
		file: join(o.slot.stateDir, "link", "operate-ledger.jsonl"), root: sessionDir, now: o.now,
		label: (device) => o.link()?.holder?.list().flatMap((t) => t.devices).find((x) => x.id === device)?.label,
		failed: (error) => o.link()?.store.log({ event: "operate-ledger-failed", error: (error as Error)?.name ?? "Error" }),
	});
	let observing: Promise<void> | undefined;
	return {
		ledger,
		/**
		 * Reads the box's whole net once (the last reading, or a fresh one with `fresh`: no session listens then, so none is kept current) and hands the ledger every unit with a session file; a call while one runs is covered by it. Resolves
		 * when the reading is in. Herdr's listing is read after the net, so a pane the net shows is in it: an owner is never fixed from a listing that predates the pane (review OW-F004).
		 */
		observe(fresh = false): Promise<void> {
			const gui = o.gui();
			if (observing || !gui) return observing ?? Promise.resolve();
			return (observing = gui.api.snapshot(EVERYTHING, fresh).then(async (net) => {
				await facts.refresh();
				const { labels, finished } = readingOf(net);
				ledger.observe(seenFrom({ refs: gui.refs(), workspace: (base) => labels.get(base) ?? base, owner: facts.settled, device: facts.device, live: (key) => !finished.has(key) }));
			}).catch(() => undefined).finally(() => void (observing = undefined)));
		},
		transcripts: (scope: () => Scope) => ledger.within(scope),
	};
}

/**
 * The box's bridge with the ledger's slow reading: `net.start()` reads the box's own net now and every `netMs` after, so a run that starts and ends while no session or page watches still gets its row (§9); the caller starts it only while
 * the policy has an `operate` grant, and stops it when the grant goes (`net.stop()`, and `stop()` of the bridge).
 */
export function operateWire(o: OperateWireDeps) {
	const facts = operateFacts(o), record = operateRecord(o, facts), every = o.every ?? timerOf;
	let stopTimer: (() => void) | undefined;
	const net = {
		start(): void {
			if (stopTimer) return;
			stopTimer = every(o.netMs ?? NET_MS, () => void record.observe(true));
			void record.observe(true);
		},
		stop(): void { stopTimer?.(); stopTimer = undefined; },
		running: (): boolean => stopTimer !== undefined,
	};
	const box = createOperateBox({
		observe: () => void record.observe(),
		transcripts: record.transcripts,
		gui: () => o.gui()?.api,
		send: (team, device, message) => { const holder = o.link()?.holder; return holder ? holder.sendLive(team, device, message) : Promise.reject(new Error("The link holder is not running")); },
		device: () => o.link()?.holder?.deviceId,
		policy: () => o.link()!.policyNow(),
		member: (team, device) => o.link()?.holder?.member(team, device),
		owner: facts.owner,
		refresh: facts.refresh,
		pane: (key) => o.gui()?.lookup(key)?.pane,
		log: (entry) => o.link()?.store.log(entry),
		now: o.now,
		every,
		...(o.ended ? { ended: o.ended } : {}),
		watch: (onChange) => watchPolicy(onChange, { ...(o.link()?.policyPath ? { path: o.link()!.policyPath! } : {}) }),
	});
	return { ...box, stop: () => { net.stop(); box.stop(); }, net };
}
export type OperateWire = ReturnType<typeof operateWire>;
