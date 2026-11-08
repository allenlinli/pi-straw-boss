import type { Answer } from "pi-better-show";
import { m } from "./sentences.ts";
import type { Answer as Posted } from "./post.ts";
import { towerWhy } from "./towerturns.ts";

// How a block's answer leaves the page (docs/specs/2026-11-07-better-show-host.md): a chat block's text goes to the unit through the composer's input route and the guards behind it; a document block's Answer goes to the document's answer route
// (src/docs.ts), which hands it to the owner (a v2 owner the Answer, a v1 owner the form it reads). Both say what went wrong in the words the composer uses; neither retries.

export type Delivery = { ok: true } | { ok: false; reason: string; /** The block was answered already, from another device: the fields that went. */ answered?: Fields };
type Fields = readonly (readonly [string, string])[];
const refused = (r: Posted): Delivery => ({ ok: false, reason: r.status === 504 ? m.unsure() : (towerWhy(r) ?? r.body.reason ?? m.refused({ status: r.status })), ...(r.status === 409 && r.body.error === "answered" && Array.isArray(r.body.fields) ? { answered: r.body.fields as Fields } : {}) });
const sent = (r: Posted): Delivery => (r.ok ? { ok: true } : refused(r));

/** A text that pi would run as a shell line (`!`) or a command (`/`): the label of a chip says nothing of it, so a block never sends one. */
export const commandLine = (text: string) => /^\s*[!/]/.test(text);

/** A chat block's delivery: `post` is the session's input route with the composer's own failure words. The message is held to a paired device's guards (`guarded`: no /boss command that changes who may command this computer, even from this page). The block names itself (its message's entry id, its index, the fields that go), so the server records it as answered in the same request. */
export const deliverToUnit = (post: (body: Record<string, unknown>) => Promise<Posted>, block: { entry: string; index: number; fields: Fields }) => async (text: string): Promise<Delivery> => {
	if (commandLine(text)) return { ok: false, reason: m.block_command() };
	return post({ text, as: "send", guarded: true, block }).then(sent, () => ({ ok: false, reason: m.unsure() }));
};

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); // randomUUID needs a secure context, and a phone may reach this page over plain http
/** A document block's delivery: the Answer (its `ref.block` is the block) and the hash of the text the page drew it from, each answer with an id of its own, which the server spends once. */
export const deliverToDoc = (post: (path: string, body: Record<string, unknown>) => Promise<Posted>, cap: string, rev: string) => async (answer: Answer): Promise<Delivery> =>
	post(`doc/${encodeURIComponent(cap)}/answer`, { answerId: newId(), answer, rev }).then(sent, () => ({ ok: false, reason: m.unsure() }));
