import type { Pending } from "../src/ask.ts";
import type { Mark } from "../src/netdata.ts";
import type { AllyBase, LinkAlert, LinkSummary } from "../src/link/holder.ts";
import { m } from "./paraglide/messages.js";

// What the page says about Straw Link, as plain functions of the holder's reading (src/link/holder.ts `LinkSummary`, `LinkView`): the notice texts,
// the countdown of an invite, a teammate's last presence, and how an ally base's states map onto the map's marks. No DOM here, so tests drive it.

const text = (v: string | number | undefined) => String(v ?? "");

/** A notice in words. `data` is the holder's: label, short id, tool, reason are a teammate's or the relay's text, so they only ever become text nodes. */
export function alertLine(a: LinkAlert): string {
	const d = a.data, team = a.teamName;
	switch (a.kind) {
		case "join-request": return d.unattended ? m.link_a_join_unattended({ label: text(d.label), short: text(d.short), team }) : m.link_a_join({ label: text(d.label), short: text(d.short), team });
		case "confirm": return d.tower ? m.link_a_confirm({ label: text(d.label), short: text(d.short), tool: text(d.tool), tower: text(d.tower) }) : m.link_a_confirm_plain({ label: text(d.label), short: text(d.short), tool: text(d.tool) });
		case "dialog": return m.link_a_dialog({ label: text(d.label), short: text(d.short), team, owner: text(d.owner) });
		case "fork": return m.link_a_fork({ team, reason: text(d.reason) });
		case "mismatch": return m.link_a_mismatch({ label: text(d.label), short: text(d.short), team });
		case "unreachable": return m.link_a_unreachable({ team, minutes: text(d.minutes) });
		case "inbox": return m.link_a_inbox({ count: Number(d.count) || 0, team });
		case "held": return m.link_a_held({ count: Number(d.count) || 0, team });
		case "served": return m.link_a_served({ count: Number(d.count) || 0, team });
	}
}

/** The alerts that want the boss to act or look now (everything but a quiet inbox note), most urgent first. */
export const urgentFirst = (alerts: LinkAlert[]): LinkAlert[] => {
	const rank = { error: 0, warning: 1, info: 2 } as const;
	return [...alerts].sort((a, b) => rank[a.level] - rank[b.level]);
};

/** `m:ss` for what is left of an invite, `h:mm:ss` from an hour on (an unattended device's invite lasts longer); `0:00` once it has lapsed. */
export function countdown(msLeft: number): string {
	const s = Math.max(0, Math.ceil(msLeft / 1000)), two = (n: number) => String(n).padStart(2, "0");
	return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** A teammate's last presence: online, or how long ago, or never seen since this computer started. */
export function lastSeen(ageMs: number | null, online: boolean): string {
	if (ageMs === null) return m.link_never_seen();
	if (online) return m.link_online();
	const n = Math.floor(ageMs / 1000);
	return m.link_seen_ago({ ago: n < 3600 ? m.age_m({ n: String(Math.max(1, Math.floor(n / 60))) }) : n < 86_400 ? m.age_h({ n: String(Math.floor(n / 3600)) }) : m.age_d({ n: String(Math.floor(n / 86_400)) }) });
}

/** An ally base's mark: offline is unknown (dim), a blocked tower waits on a question, working works, anything else idles. */
export function allyMark(a: Pick<AllyBase, "online" | "tower">): Mark {
	if (!a.online) return "unknown";
	return a.tower === "blocked" ? "waiting" : a.tower === "working" ? "working" : a.tower === "unknown" ? "unknown" : "idle";
}

/** What a tower state a teammate's presence reported reads as; one the page does not know is shown as it is (cut to the label character set by the sender's holder). */
export function stateName(state: string): string {
	switch (state) {
		case "working": return m.mark_working();
		case "blocked": return m.mark_waiting();
		case "idle": return m.mark_idle();
		case "done": return m.mark_done();
		case "unknown": return m.mark_unknown();
		default: return state;
	}
}

/** Whether the summary has anything to show in the HUD's Link button: a notice or a confirm. A quiet inbox note counts too, but a held message does not shout. */
export const hasLinkNews = (s: LinkSummary | undefined): boolean => Boolean(s && (s.alerts.length || s.confirms.length));

/** Where a forwarded dialog stands: asking, answered from here and not yet closed, or closed (how: by a controller, at the device, cancelled there, or ended with no answer). */
export type DialogState = "open" | "sent" | "done-here" | "done-other" | "done-local" | "cancelled" | "expired";
export function dialogState(a: Pick<LinkAlert, "data">): DialogState {
	const { closed, answered } = a.data;
	if (closed === undefined) return answered ? "sent" : "open";
	if (closed === "remote") return answered ? "done-here" : "done-other";
	return closed === "local" ? "done-local" : closed === "cancel" ? "cancelled" : "expired";
}
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
