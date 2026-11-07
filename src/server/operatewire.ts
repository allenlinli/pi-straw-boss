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

export function operateWire(o: OperateWireDeps) {
	let listing: Pane[] = [];
	return createOperateBox({
		gui: () => o.gui()?.api,
		send: (team, device, message) => { const holder = o.link()?.holder; return holder ? holder.sendLive(team, device, message) : Promise.reject(new Error("The link holder is not running")); },
		device: () => o.link()?.holder?.deviceId,
		policy: () => o.link()!.policyNow(),
		member: (team, device) => o.link()?.holder?.member(team, device),
		owner: (key) => ownerOf(storeOwnerWorld({ slot: o.slot, now: o.now, refs: () => o.gui()?.refs() ?? [], panes: () => listing, allyPanes: o.allyPanes }), key),
		// A listing that cannot be read is no listing: a unit whose tab is unknown belongs to the box alone, so a team's session loses it (fail closed).
		refresh: async () => void (listing = await panes(o.run).catch(() => [])),
		pane: (key) => o.gui()?.lookup(key)?.pane,
		log: (entry) => o.link()?.store.log(entry),
		now: o.now,
		every: (ms, fn) => { const timer = setInterval(fn, ms); timer.unref(); return () => clearInterval(timer); },
		watch: (onChange) => watchPolicy(onChange, { ...(o.link()?.policyPath ? { path: o.link()!.policyPath! } : {}) }),
	});
}
