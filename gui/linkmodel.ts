import type { Mark } from "../src/netdata.ts";
import type { AllyBase, ConfirmView, DeviceUnits, LinkAlert, LinkSummary } from "../src/link/holder.ts";
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
		case "notice": return m.link_a_notice({ label: text(d.label), short: text(d.short), team, what: text(d.what), unit: text(d.unit), text: text(d.text) });
	}
}

/** The line of a confirm a teammate's tower asked of this computer (the header's Link notices and Zen's card say it the same way). */
export const confirmLine = (c: ConfirmView): string => alertLine({ id: "", kind: "confirm", level: "warning", team: c.team, teamName: "", data: { label: c.fromLabel, short: c.fromShort, tool: c.tool, tower: c.tower } });

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

/** Where a forwarded dialog stands: asking, answered from here and not yet closed, or closed (how: by a controller, at the device, cancelled there, withdrawn from this controller because it lost `dispatch`, or ended with no answer). */
export type DialogState = "open" | "sent" | "done-here" | "done-other" | "done-local" | "cancelled" | "expired" | "withdrawn";
export function dialogState(a: Pick<LinkAlert, "data">): DialogState {
	const { closed, answered } = a.data;
	if (closed === undefined) return answered ? "sent" : "open";
	if (closed === "remote") return answered ? "done-here" : "done-other";
	return closed === "local" ? "done-local" : closed === "cancel" ? "cancelled" : closed === "withdrawn" ? "withdrawn" : "expired";
}

/** The units an unattended device reported that belong to an ally base: those of its workspace, or all of them for a device whose presence names no workspace yet. */
export function unitsFor(units: DeviceUnits[] | undefined, a: Pick<AllyBase, "team" | "device" | "workspace">) {
	const mine = (units ?? []).find((u) => u.team === a.team && u.device === a.device);
	return mine ? mine.units.filter((u) => a.workspace === null || u.unit === a.workspace).map((u) => ({ ...u, stale: mine.stale === true })) : [];
}
/** One unit's line under an ally base: its state, how many monitors run. The report is shown apart, as text. */
export const unitLine = (u: { state: string; monitors: string[]; stale?: boolean }): string => [stateName(u.state), ...(u.monitors.length ? [m.link_unit_monitors({ count: String(u.monitors.length) })] : []), ...(u.stale ? [m.link_unit_stale()] : [])].join(" · ");
