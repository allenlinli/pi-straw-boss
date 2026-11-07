import { allyLabel } from "../boardauto.ts";
import { wireId } from "../board.ts";
import type { UnitStopInput } from "../link/holder.ts";
import type { MainStatus, Notice } from "../link/kinds.ts";
import type { Stop } from "./allyroute.ts";
import type { OpenedMain } from "./revoke.ts";
import type { RunSignal } from "./runs.ts";

// The box's half of a remote stop (docs/specs/2026-11-07-link-remote-stop.md, section 4). The holder has checked what the bytes can show (this device is unattended, the sender is an attended member at `dispatch` now, the request is fresh, the
// mode is known); here the box decides which main and whose, from its own record. A stop is accepted when:
//   1. its handle (the first 8 bytes of sha256(this device's id ‖ the main's session id)) names exactly one `opened` row among the live services' routes, and that row's team is the team the envelope came on: a row of another team does not match;
//   2. the sender is the row's device (the dispatcher) or an admin of the row's team in the roster now: an admin of another team is no recipient (g346-F001);
//   3. the main's pane token, the second witness, does not name another device (`refuseTarget`'s two-witness rule).
// An accepted stop is written on the route row and the box asks the revoker for a sweep at once; the revoker carries it out (revoke.ts). A refusal writes and spends nothing. The requester's `reason` is kept on the route row and told in the `main-stop-*` notices; no log line and no key carries it.

export type { Stop };
export interface UnitStopDeps {
	/** This device's id (the handle's key); none until the holder runs. */
	box(): string | undefined;
	/** The `opened` rows of every live service, as the revoker reads them. */
	opened(): OpenedMain[];
	/** Whether `device` is an admin of `team`'s roster now. */
	admin(team: string, device: string): boolean;
	/** What the main's pane says: the device its `sb_opened_by` token names (the `link:` prefix cut), if any, and the main's own name from the broker. Rejects when the net cannot be read. */
	witness(row: OpenedMain): Promise<{ device?: string; name?: string } | undefined>;
	/** Writes the stop on the row, once: `set: false` with the stop already there for a second request. Throws when the row is gone. */
	record(row: OpenedMain, stop: Stop, name?: string): { set: true } | { set: false; stop: Stop };
	/** Asks the revoker for a sweep now. */
	sweep(): void;
	/** Tells the scope of the requester (the requester and its team's admins) or the dispatcher's. */
	signal(s: RunSignal): void | boolean | Promise<boolean | undefined | void>;
	/** Tells one device alone (the sender of a stop the box could not act on). */
	tell(team: string, device: string, notice: Notice): Promise<void>;
	label(team: string, device: string): string;
	/** The holder's link.log, where `unit-stop-in` already is: `unit-stop-pending`, `unit-stop-refused` (with its verdict word), `unit-stop-noop` and `unit-stop-failed`, all with ids, never the reason. */
	audit(entry: Record<string, unknown>): void;
	now(): number;
}

/** A main's handle: the board's wire id, so no session id leaves the box. */
export const handleOf = (box: string, main: string): string => wireId(box, main);

/** One opened main as the box knows it right now: its row, its own name and its pane's state. */
export interface MainFact { row: OpenedMain; name: string; state: string }
const MAINS_MAX = 20;
/**
 * The mains `controller` may stop, for the `mains` field of its `unit-status` (docs/specs/2026-11-07-link-remote-stop.md, 3.2): its own, or every main of the team when it is an admin of that team. Mains with a pending stop come first, so the cut
 * to 20 never hides one. The name is the main's own, scrubbed and cut to 40; the state is the pane's `agent_status`, or `unknown`.
 */
export function mainsFor(facts: MainFact[], controller: { team: string; device: string }, d: { box: string; admin(team: string, device: string): boolean }): MainStatus[] {
	const all = d.admin(controller.team, controller.device);
	return facts
		.filter((f) => f.row.team === controller.team && (all || f.row.device === controller.device))
		.sort((a, b) => Number(b.row.stop !== undefined) - Number(a.row.stop !== undefined))
		.slice(0, MAINS_MAX)
		.map((f): MainStatus => ({ handle: handleOf(d.box, f.row.main), unit: allyLabel(f.row.label), name: allyLabel(f.name, 40), state: f.state || "unknown", by: f.row.device, stopping: f.row.stop !== undefined }));
}

/** What `controller` is told in `mains`: nothing until the holder runs and the tower service stands, and nothing where the team's units are not shared as `status`. */
export async function mainsOf(controller: { team: string; device: string }, d: { box: string | undefined; share: string | undefined; admin(team: string, device: string): boolean; facts?: () => Promise<MainFact[]> }): Promise<MainStatus[]> {
	if (!d.box || !d.facts || d.share !== "status") return [];
	return mainsFor(await d.facts(), controller, { box: d.box, admin: d.admin });
}

export function createUnitStop(d: UnitStopDeps) {
	/** A refusal that only the sender is told (there is no main or no row of a team to scope it by). */
	const tell = (a: UnitStopInput, word: string) => d.tell(a.team, a.from, { kind: "unit-stop-refused", unit: "", text: `Stop ${a.stopId.slice(0, 6)} was refused: ${word}.` }).catch((error: Error) => d.audit({ event: "unit-stop-notice-failed", stopId: a.stopId, error: error.message }));
	const refuse = async (a: UnitStopInput, word: string, row?: OpenedMain) => {
		d.audit({ event: "unit-stop-refused", team: a.team, from: a.from, stopId: a.stopId, verdict: word });
		if (row && word === "not-recipient") await d.signal({ kind: "main-stop", outcome: "refused", workspace: row.workspace, label: row.label, ally: true, device: a.from, team: a.team, main: row.main, stopId: a.stopId, text: `${d.label(a.team, a.from)} asked to stop the main "${row.name}" of ${row.deviceLabel}; the box refused: ${word}.` });
		else await tell(a, word);
	};
	return {
		/** The holder's sink: decides one stop; it never throws (a failure is told to the sender). */
		async handle(a: UnitStopInput): Promise<void> {
			try {
				const box = d.box();
				if (!box) throw new Error("this device's id is not known yet");
				const rows = d.opened().filter((r) => handleOf(box, r.main) === a.handle), row = rows[0];
				if (rows.length !== 1 || !row || row.team !== a.team) return await refuse(a, "gone");
				if (a.from !== row.device && !d.admin(row.team, a.from)) return await refuse(a, "not-recipient", row);
				const seen = await d.witness(row);
				if (seen?.device !== undefined && seen.device !== row.device) return await refuse(a, "gone");
				const stop: Stop = { by: a.from, at: d.now(), stopId: a.stopId, mode: a.mode, ...(a.reason ? { reason: a.reason } : {}) }, set = d.record(row, stop, seen?.name ? allyLabel(seen.name, 40) : undefined);
				if (!set.set) return d.audit({ event: "unit-stop-noop", team: a.team, from: a.from, stopId: a.stopId, first: set.stop.stopId });
				d.audit({ event: "unit-stop-pending", team: a.team, from: a.from, stopId: a.stopId, workspace: row.workspace, main: row.main });
				d.sweep();
			} catch (error) {
				d.audit({ event: "unit-stop-failed", team: a.team, stopId: a.stopId, error: (error as Error).message.slice(0, 200) });
				await tell(a, "failed");
			}
		},
	};
}
