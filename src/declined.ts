import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Esc before a decline (docs/specs/2026-11-09-auto-mode.md, §9; AM-W3). A question the boss cancelled with no words may be a slipped Esc: the first cancel gets a note that tells the agent to ask once more, and
// only a second cancel of the session's next question, with no answer between and within ten minutes, reads as a decline. A cancel sb made itself (auto mode, auto.ts) is never the boss's and gets neither line.

/** The note on a first cancel. */
export const SLIPPED = "The boss cancelled with no answer; it may be a slipped Esc. Ask once more, saying it is the second time; a second cancel is a decline.";
/** The line on a second cancel. */
export const DECLINED = "Cancelled again: the boss declines; do not ask a third time.";
/** How long after a first cancel the next question's cancel is a decline. */
export const WINDOW_MS = 10 * 60_000;
const TOOLS = new Set(["ask_user_question", "robot_hand", "secret_drop"]);
const HAND = "robot-hand";

export interface Declined {
	/** A cancel sb made for this call: it is no Esc of the boss's, so the result gets no line. */
	sbCancelled(toolCallId: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function registerDeclined(pi: ExtensionAPI, { now = Date.now }: { now?: () => number } = {}): Declined {
	// robot_hand's result does not say how its selector ended; its `closed` event on the bus does (`by: "cancel"` is Escape, `local` any pick including "No, thanks"), keyed by the dialog id of its `pending`.
	const dialogs = new Map<string, string>(), cancelled = new Set<string>(), ours = new Set<string>();
	let first: number | undefined;
	const hold = <T>(set: Set<T>, value: T) => (set.add(value), set.size > 64 && set.delete(set.values().next().value as T));
	pi.events.on(`${HAND}:pending`, (raw) => {
		if (isRecord(raw) && typeof raw.id === "string" && typeof raw.toolCallId === "string") (dialogs.set(raw.id, raw.toolCallId), dialogs.size > 64 && dialogs.delete(dialogs.keys().next().value as string));
	});
	pi.events.on(`${HAND}:closed`, (raw) => {
		const call = isRecord(raw) && typeof raw.id === "string" ? dialogs.get(raw.id) : undefined;
		if (call && isRecord(raw) && raw.by === "cancel") hold(cancelled, call);
	});
	pi.on("session_start", () => void (first = undefined));
	pi.on("tool_result", (event) => {
		if (!TOOLS.has(event.toolName) || event.isError) return;
		const details = isRecord(event.details) ? event.details : {};
		let cancel: boolean;
		if (event.toolName === "ask_user_question") {
			// A validation error is neither a cancel nor an answer.
			if (details.error !== undefined) return;
			cancel = details.cancelled === true;
		} else if (event.toolName === "robot_hand") cancel = cancelled.has(event.toolCallId);
		else cancel = details.status === "cancelled";
		if (!cancel) return void (first = undefined); // an answer, "No, thanks", or the secret reply: any answer resets the rule
		if (ours.has(event.toolCallId)) return;
		const at = now(), decline = first !== undefined && at - first <= WINDOW_MS;
		first = at;
		return { content: [...event.content, { type: "text" as const, text: decline ? DECLINED : SLIPPED }] };
	});
	return { sbCancelled: (toolCallId) => void hold(ours, toolCallId) };
}
