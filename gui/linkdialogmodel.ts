import type { Pending } from "../src/ask.ts";
import type { LinkAlert } from "../src/link/holder.ts";
import type { DialogState } from "./linkmodel.ts";
import { m } from "./paraglide/messages.js";

// The pure half of a forwarded dialog's card (gui/linkdialogs.ts draws it; both load when the first such dialog shows): its state in words, the check of the
// question's shape a sender's device wrote, and the answer's body. Where a dialog stands (`dialogState`) is in linkmodel.ts, which the page's start needs.

/** What the card says of a dialog that is not asking. */
export function dialogStateLine(state: Exclude<DialogState, "open">): string {
	switch (state) {
		case "sent": return m.link_dialog_sent();
		case "done-here": return m.link_dialog_done_here();
		case "done-other": return m.link_dialog_done_other();
		case "done-local": return m.link_dialog_done_local();
		case "cancelled": return m.link_dialog_cancelled();
		case "expired": return m.link_dialog_expired();
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const goodOptions = (v: unknown) => Array.isArray(v) && v.every((o) => isRecord(o) && isText(o.title));
/**
 * The question of a forwarded dialog as the shared question panel takes it (gui/ask.ts), or undefined when the sender's JSON is not one a panel can draw:
 * a select with a title and labelled choices, or questions with text and options. The sender is another computer, so its shape is checked before it is drawn.
 */
export function remoteDialog(a: Pick<LinkAlert, "data">): Pending | undefined {
	const { dialog, dialogId, digest } = a.data;
	if (!isText(dialog) || !isText(dialogId) || !isText(digest)) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(dialog);
	} catch {
		return undefined;
	}
	if (!isRecord(json)) return undefined;
	const { select, questions, cancel } = json, answer = { dialog: dialogId, digest, ...(cancel === true ? { cancel: true as const } : {}) };
	if (isRecord(select) && isText(select.title) && Array.isArray(select.choices) && select.choices.every((c) => isRecord(c) && isText(c.label))) return { callId: dialogId, tool: "dialog", answer: { ...answer, select: select as never } };
	if (Array.isArray(questions) && questions.length > 0 && questions.every((q) => isRecord(q) && isText(q.question) && goodOptions(q.options))) return { callId: dialogId, tool: "dialog", answer: { ...answer, questions: questions as never } };
	return undefined;
}
/** The body the holder takes as `answer` for what the panel sent (src/link/dialogs-out.ts `RemoteAnswer`). */
export const remoteAnswer = (body: Record<string, unknown>): Record<string, unknown> => (body.cancel === true ? { cancel: true } : body.choice !== undefined ? { choice: body.choice } : { answers: body.answers });
