import type { Answer } from "pi-better-show";
import { m } from "./paraglide/messages.js";
import type { Answer as Posted } from "./post.ts";
import { towerWhy } from "./towerturns.ts";

// How a block's answer leaves the page (docs/specs/2026-11-07-better-show-host.md): a chat block's text goes to the unit through the composer's input route and the guards behind it; a document block's fields go to the
// document's answer route (src/docs.ts), which hands them to the owner as a v1 form answer. Both say what went wrong in the words the composer uses; neither retries.

export type Delivery = { ok: true } | { ok: false; reason: string };
const refused = (r: Posted): Delivery => ({ ok: false, reason: r.status === 504 ? m.unsure() : (towerWhy(r) ?? r.body.reason ?? m.refused({ status: r.status })) });
const sent = (r: Posted): Delivery => (r.ok ? { ok: true } : refused(r));

/** A text that pi would run as a shell line (`!`) or a command (`/`): the label of a chip says nothing of it, so a block never sends one. */
export const commandLine = (text: string) => /^\s*[!/]/.test(text);

/** A chat block's delivery: `post` is the session's input route with the composer's own failure words. The message is held to a paired device's guards (`guarded`: no /boss command that changes who may command this computer, even from this page). */
export const deliverToUnit = (post: (body: Record<string, unknown>) => Promise<Posted>) => async (text: string): Promise<Delivery> => {
	if (commandLine(text)) return { ok: false, reason: m.block_command() };
	return post({ text, as: "send", guarded: true }).then(sent, () => ({ ok: false, reason: m.unsure() }));
};

/** The fields a document's answer goes out with. The owner reads a form's fields as they are, and a review or page feedback under `pi-kind`; v1 has no pick, chip, or checklist, which go as a form that names the block. */
export function docFields({ kind, title, fields }: Pick<Answer, "kind" | "title" | "fields">): [string, string][] {
	const own = fields.filter(([name]) => name !== "pi-kind"); // the kind is the block's, never a field's
	if (kind === "form") return own;
	if (kind === "review" || kind === "feedback") return [["pi-kind", kind], ...own];
	return [["block", title ? `${kind} "${title}"` : kind], ...own];
}

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""); // randomUUID needs a secure context, and a phone may reach this page over plain http
/** A document block's delivery: each answer has an id of its own, which the server spends once. */
export const deliverToDoc = (post: (path: string, body: Record<string, unknown>) => Promise<Posted>, cap: string) => async (answer: Answer): Promise<Delivery> =>
	post(`doc/${encodeURIComponent(cap)}/answer`, { answerId: newId(), fields: docFields(answer) }).then(sent, () => ({ ok: false, reason: m.unsure() }));
