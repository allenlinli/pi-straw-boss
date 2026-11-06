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

/**
 * One ally card as the map draws it: a device (and one workspace of it), however many teams it is in. A device is the same machine in each team, so the card is one, with `teams` naming them (in the order the teams came) and the
 * state of the device: online when any team hears it, the most urgent tower state of the online ones (a question that waits, then work), and the tabs of the state that was taken. The team-scoped parts of the card (a forwarded question,
 * the notice behind a crash) keep their team in their own words.
 */
export interface AllyCard extends Omit<AllyBase, "team" | "teamName"> { teams: { team: string; teamName: string }[] }
const URGENCY: Record<string, number> = { blocked: 3, working: 2, idle: 1 };
/** A team that shows no workspace of a device gives its team to the device's cards and has none of its own; with no workspace anywhere, the device has the one card. */
export function mergeAllies(allies: AllyBase[]): AllyCard[] {
	const devices = new Map<string, AllyBase[]>();
	for (const a of allies) devices.set(a.device, [...(devices.get(a.device) ?? []), a]);
	return [...devices].flatMap(([device, bases]) => {
		const teams: AllyCard["teams"] = [];
		for (const b of bases) if (!teams.some((t) => t.team === b.team)) teams.push({ team: b.team, teamName: b.teamName });
		const named = bases.filter((b) => b.workspace !== null), workspaces = named.length ? [...new Set(named.map((b) => b.workspace))] : [null];
		return workspaces.map((workspace): AllyCard => {
			const mine = bases.filter((b) => b.workspace === workspace);
			const best = [...mine].sort((p, q) => Number(q.online) - Number(p.online) || (q.online ? (URGENCY[q.tower] ?? 0) - (URGENCY[p.tower] ?? 0) : 0))[0]!;
			return { id: workspace === null ? device : `${device}/${workspace}`, device, short: best.short, label: best.label, online: bases.some((b) => b.online), ...(bases.some((b) => b.unattended) ? { unattended: true as const } : {}), workspace, tower: best.tower, tabs: best.tabs, teams };
		});
	});
}

/** The units an unattended device reported that belong to an ally card: those of its workspace, or all of them for a device whose presence names no workspace yet. The device reports to each of its teams alike, so the status is the freshest of the card's teams'. */
export function unitsFor(units: DeviceUnits[] | undefined, a: Pick<AllyCard, "device" | "workspace"> & { teams: string[] }) {
	const mine = (units ?? []).filter((u) => u.device === a.device && a.teams.includes(u.team)).sort((p, q) => q.at - p.at)[0];
	return mine ? mine.units.filter((u) => a.workspace === null || u.unit === a.workspace).map((u) => ({ ...u, at: mine.at, stale: mine.stale === true })) : [];
}

/** How long a crash notice still makes a unit that is not running read as crashed: the wire carries no outcome, so an old crash says nothing of the unit now. */
export const CRASH_FRESH_MS = 30 * 60_000;
/** The notices that say a run ended without its work (src/link/unitstatus.ts): a crash, or a trust question nobody answered. */
const CRASH_KINDS = ["run-crashed", "trust-unanswered"];
export type UnitTone = "working" | "idle" | "waiting" | "crashed" | "other";
/** One unit of an ally base as its card draws it. `word` is the state in words, `crash` the notice that says why it stopped (`trust`: a trust question nobody answered, which the box's settings fix, not its code). */
export interface UnitCard { unit: string; state: string; tone: UnitTone; word: string; at: number; stale: boolean; monitors: string[]; report: string; crash?: { at: number; text: string; trust?: true } }

/** A unit's state word: the tower service's states (standing, waking, running, closing, held) and the marks a plain unit has; one the page does not know is shown as it is. A held unit was paused after repeated crashes: trouble. */
export function unitWord(state: string): { tone: UnitTone; word: string } {
	switch (state) {
		case "standing": case "idle": case "done": return { tone: "idle", word: m.mark_standing() };
		case "running": case "working": case "waking": case "commanding": return { tone: "working", word: m.link_unit_running() };
		case "blocked": return { tone: "waiting", word: m.mark_waiting() };
		case "held": return { tone: "crashed", word: m.link_unit_held() };
		case "closing": return { tone: "other", word: m.tower_state_closing() };
		default: return { tone: "other", word: stateName(state) };
	}
}

/**
 * The cards of an ally base's units: its state word and when it was heard, the monitors, the last report, and why it stopped when a notice told of it lately and the unit is not running.
 * `seen` is the page's memory of when each unit was last seen running (`device/unit` to the time of that status): a run after the notice ends it, so a unit that was re-run and stands by again is not told as crashed again.
 * A page without that memory (just loaded) has the 30-minute rule alone.
 */
export function unitCards(units: DeviceUnits[] | undefined, alerts: LinkAlert[] | undefined, a: Parameters<typeof unitsFor>[1], now: number, seen: Map<string, number> = new Map()): UnitCard[] {
	return unitsFor(units, a).map((u) => {
		const base = unitWord(u.state), key = `${a.device}/${u.unit}`;
		if (base.tone === "working") seen.set(key, Math.max(seen.get(key) ?? 0, u.at));
		const crash = alerts?.filter((x) => x.kind === "notice" && CRASH_KINDS.includes(String(x.data.what)) && a.teams.includes(x.team) && x.data.device === a.device && x.data.unit === u.unit && Number(x.data.at) > 0).map((x) => ({ at: Number(x.data.at), text: String(x.data.text ?? ""), trust: x.data.what === "trust-unanswered" })).sort((p, q) => q.at - p.at)[0];
		const told = crash !== undefined && base.tone !== "working" && now - crash.at < CRASH_FRESH_MS && crash.at > (seen.get(key) ?? 0) ? { at: crash.at, text: crash.text, ...(crash.trust ? { trust: true as const } : {}) } : undefined;
		const state = !told ? base : base.tone === "crashed" ? base : told.trust ? { tone: "waiting" as const, word: m.link_unit_trust() } : { tone: "crashed" as const, word: m.link_unit_crashed() };
		return { unit: u.unit, state: u.state, ...state, ...(told ? { crash: told } : {}), at: u.at, stale: u.stale, monitors: u.monitors, report: u.report };
	});
}

/** Markdown marks that are markup: a pair that opens after a space, a bracket or a quote (or at the start) with a non-space after it, and closes before a space, closing punctuation, or a sentence's end; so `rounding_mode`, `a*b`, `__init__.py`, `2 * 3` keep their characters. */
const PAIR = /(^|[\s(["'])(\*\*|__|~~|\*|_)(?=\S)(.+?)(?<=\S)\2(?=$|[\s,;:!?)\]"']|\.(?:$|\s))/g;

/** The first line of a report with its Markdown marks (heading, list and quote bullets, paired emphasis, code ticks) taken off, for the folded row; characters that are the text's own (identifiers, paths, a multiplication) stay. */
export function reportPeek(report: string): string {
	const line = report.split("\n").map((l) => l.trim()).find((l) => l && !/^(`{3,}|~{3,}|[-*_]{3,}$)/.test(l)) ?? "";
	let out = line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "").replace(/(`+)(.+?)\1/g, "$2");
	for (let i = 0; i < 4; i++) {
		const next = out.replace(PAIR, "$1$3");
		if (next === out) break;
		out = next;
	}
	return out.trim();
}
