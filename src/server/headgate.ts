import { fieldsOf } from "../header.ts";

// What may reach the head identity before anything is queued (docs/specs/2026-11-04-head-tower.md, Who reaches it). The boss's events come in through the run hub, not through intercom, and the server's own notices likewise; what
// arrives through intercom is accepted for one reason only: it is a tower's answer to an ask the head opened. The rule is pure: the caller reads the facts (who the sender is the tower of, which asks are open).

export type HeadVerdict = { ok: true; ask: string; workspace: string } | { ok: false; why: string };
const ASK = /^H\d{1,6}$/;

/**
 * `text` is the message as the broker delivered it, `senderWorkspace` the workspace the sender is the tower of (undefined for a main, a member, or anyone else), `isOpen` whether an ask is open for a workspace. The header is read
 * at the very start of the text only, so text under it can claim nothing; the sender's own claim of `in-reply-to` is believed only together with the facts the server holds.
 */
export function headGate({ text, senderWorkspace, isOpen }: { text: string; senderWorkspace: string | undefined; isOpen(workspace: string, id: string): boolean }): HeadVerdict {
	const fields = fieldsOf(text);
	if (!fields) return { ok: false, why: "no header" };
	if (fields.kind !== "tower_send") return { ok: false, why: `a ${fields.kind ?? "message"} is not an answer` };
	const ask = fields["in-reply-to"];
	if (!ask || !ASK.test(ask)) return { ok: false, why: "no ask is named" };
	if (!senderWorkspace) return { ok: false, why: "the sender is the tower of no workspace" };
	if (!isOpen(senderWorkspace, ask)) return { ok: false, why: "no open ask to that workspace" };
	return { ok: true, ask, workspace: senderWorkspace };
}
