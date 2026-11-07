import { type Pane, type HerdrRun, panes } from "../herdr.ts";
import { watchPolicy } from "../link/policy.ts";
import type { LinkService } from "../link/service.ts";
import type { Found, Ref } from "../net.ts";
import type { Operate } from "../operateseam.ts";
import { createOperateBox } from "./operatebox.ts";
import { ownerOf, storeOwnerWorld } from "./operatescope.ts";
import type { Slot } from "./record.ts";

// The operate bridge of an unattended box, wired to the server's own parts (docs/specs/2026-11-07-link-operate.md §6.1): the holder's `operate` sink and `onRoster` hook reach it through the link service (main.ts), and it reaches the GUI's
// in-process operate entry through the GUI host. A unit's owner is read from the box's records (operatescope.ts) over facts `refresh` reads before each check (Herdr's listing), with the live ally panes and the registry read at the
// moment of the request.
export interface OperateWireDeps {
	slot: Slot;
	now(): number;
	run: HerdrRun;
	/** The GUI host's way in while a GUI runs (guihost.ts `operate`). */
	gui(): { api: Operate; refs(): Ref[]; lookup(key: string): Found | undefined } | undefined;
	allyPanes(): { pane: string; device: string; team?: string }[];
	link(): LinkService | undefined;
}

/**
 * The facts a unit's owner is read from, and the refresh that reads Herdr's listing for them. A listing that cannot be read is no listing: it is dropped rather than kept or emptied, and until a read succeeds a main, member
 * or subagent is nobody's, for the box part as well as for a team's (a failed read must not hand a team's units to a `box` session). Never rejects.
 */
export function operateFacts(o: Pick<OperateWireDeps, "slot" | "now" | "run" | "gui" | "allyPanes">) {
	let listing: Pane[] | undefined;
	return {
		owner: (key: string) => ownerOf(storeOwnerWorld({ slot: o.slot, now: o.now, refs: () => o.gui()?.refs() ?? [], panes: () => listing, allyPanes: o.allyPanes }), key),
		refresh: async (): Promise<void> => void (listing = await panes(o.run).catch(() => undefined)),
	};
}

export function operateWire(o: OperateWireDeps) {
	const facts = operateFacts(o);
	return createOperateBox({
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
		every: (ms, fn) => { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); },
		watch: (onChange) => watchPolicy(onChange, { ...(o.link()?.policyPath ? { path: o.link()!.policyPath! } : {}) }),
	});
}
