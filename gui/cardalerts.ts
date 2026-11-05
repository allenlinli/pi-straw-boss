import type { ConfirmView } from "../src/link/holder.ts";
import type { MemoryProposal, Net } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { remoteDialog } from "./linkdialogmodel.ts";
import { alertLine, dialogState } from "./linkmodel.ts";
import { labelOf, type PairRequest } from "./pairs.ts";

// The questions Zen shows as cards beyond a unit's dialog (docs/specs/2026-11-01-zen-view.md, Link cards), read from what the server holds: the snapshot's Link confirms and notices and its towers' memory proposals, and the pending list of pair requests. Nothing
// here is kept: a request the server stopped listing (answered at the computer, timed out) is gone from the next reading, and the item goes with it. Standard does not use these (alerts.ts `alertsOf` is its set).

/**
 * What waits on the boss apart from a unit's own dialog, a trust question and a tower's wait: a confirm a teammate's tower asked (`confirm`), a dialog an unattended device forwarded (`dialog`, whose question is the alert's `pending`),
 * a pair request, and a memory proposal of a tower run. Standard has them in the Link button, the Wi-Fi notice and the tower's notices; Zen draws each as a card.
 */
export type BossCard =
	| { kind: "confirm"; confirm: ConfirmView }
	| { kind: "dialog"; device: string; dialogId: string; digest: string; line: string }
	| { kind: "pair"; request: PairRequest }
	| { kind: "proposal"; ws: string; tower: string; proposal: MemoryProposal; rev: number };
export interface CardSources {
	/** The pair requests `lan/pending` lists; none on a paired device's page (the server refuses it Wi-Fi access: `local_only`). */
	pairs?: PairRequest[];
	/** When the list was read (the ages are as of then); the snapshot's time when it is not given. */
	pairsAt?: number;
}
const card = (key: string, name: string, at: number, extra: Partial<Alert>): Alert => ({ key, ws: "", name, role: "none", mark: "waiting", at, ...extra });

export function cardAlerts(net: Net, at: number, { pairs = [], pairsAt = at }: CardSources): Alert[] {
	const out: Alert[] = [];
	for (const c of net.link?.confirms ?? []) out.push(card(`link-confirm\u001f${c.dialogId}`, c.fromLabel, at, { note: c.tool, since: c.at, card: { kind: "confirm", confirm: c } }));
	for (const a of net.link?.alerts ?? []) {
		// Only a forwarded dialog that still asks and that a panel can draw; the other notices (a join request's words are checked in Standard) stay in the Link button.
		if (a.kind !== "dialog" || dialogState(a) !== "open") continue;
		const pending = remoteDialog(a);
		if (pending) out.push(card(`link-dialog\u001f${a.id}`, String(a.data.label), at, { pending, card: { kind: "dialog", device: String(a.data.device), dialogId: String(a.data.dialogId), digest: String(a.data.digest), line: alertLine(a) } }));
	}
	for (const p of pairs) out.push(card(`pair\u001f${p.id}`, labelOf(p), at, { ...(p.ageMs !== undefined ? { since: pairsAt - p.ageMs } : {}), card: { kind: "pair", request: p } }));
	for (const b of net.bases) {
		const tower = b.tower, memory = tower?.service?.memory;
		for (const p of memory?.proposals ?? []) out.push({ key: `proposal\u001f${b.id}\u001f${p.id}`, unit: tower!.key, ws: b.id, name: tower!.name, role: "tower", mark: "waiting", at, closed: !tower!.control, card: { kind: "proposal", ws: b.id, tower: tower!.key, proposal: p, rev: memory!.rev } });
	}
	return out;
}
