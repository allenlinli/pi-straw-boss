import type { Bus } from "./owners.ts";

// The session's background monitors, from pi-loop-monitor's events on the session's bus (monitor:started, monitor:output,
// monitor:finished), for the GUI: the bridge relays the list with its dialogs (bridge.ts). pi-loop-monitor offers other extensions no
// way to stop one, so the list is read-only. An ended monitor stays 15 minutes, as long as pi-loop-monitor keeps its record.
// A line that is JSON of the form {"progress":{"message":"…","load":{"max":30,"now":42}}} (the format a train's gate wrapper prints, docs/specs/2026-11-07-train-workers.md §8.2, and the one pi-loop-monitor counts as progress) shows its message as the
// monitor's last line instead of the raw JSON, and its load is kept on the monitor while it runs; the newest line wins, so a line without a load clears it.

/** The load a step waits for or runs under, as its newest progress line said: the limit it needs and the 1-minute load average then. */
export interface MonitorLoad { max: number; now: number }
/** `stale`: stopped for inactivity (pi-loop-monitor's timeout). `last`: its newest output line, or the `message` of its newest progress line. `load`: the `progress.load` of that line, while the monitor runs. */
export interface Monitor { id: string; what: string; status: "running" | "done" | "error" | "stale" | "stopped"; exit?: number; last?: string; load?: MonitorLoad; lines: number; at: number; ended?: number }
export const MAX_MONITORS = 6, MONITOR_TEXT = 160;
const KEEP_MS = 15 * 60_000, STATUSES = new Set(["running", "done", "error", "stale", "stopped"]);
// Terminal escapes go, then any other control character; what is left is cut to MONITOR_TEXT.
const clean = (v: unknown) => {
	const s = String(v ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
	return s.length > MONITOR_TEXT ? `${s.slice(0, MONITOR_TEXT - 1)}…` : s;
};
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const text = (v: unknown, empty = false): v is string => typeof v === "string" && v.length <= MONITOR_TEXT && (empty || v.length > 0) && !CONTROL.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const MAX_LOAD = 1e6, MAX_PROGRESS_LINE = 8192;
const loadNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_LOAD;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const loadOk = (v: unknown): v is MonitorLoad => record(v) && Object.keys(v).length === 2 && loadNumber(v.max) && loadNumber(v.now);

/**
 * The progress a line carries, or undefined when it is not a progress line: JSON with a string `progress.message` (what pi-loop-monitor takes as progress too). The message is cleaned and cut like any monitor text; `load` is kept only
 * when it is exactly `{max, now}` of two plain numbers, and a malformed one is dropped without spoiling the message. A line is never trusted: a monitor's command can print anything.
 */
export function progressOf(line: unknown): { message: string; load?: MonitorLoad } | undefined {
	if (typeof line !== "string" || line.length > MAX_PROGRESS_LINE || !line.trimStart().startsWith("{")) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	const progress = record(value) ? value.progress : undefined;
	if (!record(progress) || typeof progress.message !== "string") return undefined;
	const message = clean(progress.message);
	if (!message) return undefined;
	const load = record(progress.load) && loadNumber(progress.load.max) && loadNumber(progress.load.now) ? { max: progress.load.max, now: progress.load.now } : undefined;
	return { message, ...(load ? { load } : {}) };
}

/** What the hub accepts from a bridge. */
export function monitorsOk(list: unknown): list is Monitor[] {
	return Array.isArray(list) && list.length <= MAX_MONITORS && list.every((m: Partial<Monitor> | null) => m !== null && typeof m === "object" && text(m.id) && text(m.what) && STATUSES.has(m.status as string) && count(m.lines) && count(m.at) && (m.ended === undefined || count(m.ended)) && (m.exit === undefined || Number.isSafeInteger(m.exit)) && (m.last === undefined || text(m.last, true)) && (m.load === undefined || loadOk(m.load)));
}

/** `changed` runs on every change; output lines, which pi-loop-monitor sends at most once a second per monitor, at most once per `throttleMs`. */
export function trackMonitors(bus: Bus, changed: () => void, { now = Date.now, throttleMs = 2000 } = {}) {
	const all = new Map<string, Monitor>();
	let timer: ReturnType<typeof setTimeout> | undefined, prune: ReturnType<typeof setTimeout> | undefined;
	const soon = () => timer ?? ((timer = setTimeout(() => ((timer = undefined), changed()), throttleMs)), timer.unref?.());
	// One timer for the next ended monitor to leave, so its leaving is told too; it sets the one after.
	const schedule = () => {
		if (prune) clearTimeout(prune);
		const next = Math.min(...[...all.values()].map((m) => (m.ended === undefined ? Infinity : m.ended + KEEP_MS + 1000)));
		prune = Number.isFinite(next) ? setTimeout(() => ((prune = undefined), changed(), schedule()), Math.max(0, next - now())) : undefined;
		prune?.unref?.();
	};
	const id = (d: unknown) => ((x) => (typeof x === "string" && x.length > 0 && x.length <= 64 ? x : undefined))((d as { monitorId?: unknown } | null)?.monitorId);
	const offs = [
		bus.on("monitor:started", (d) => {
			const k = id(d), e = d as { command?: unknown; description?: unknown };
			if (!k) return;
			all.set(k, { id: k, what: clean(e.description) || clean(e.command) || `#${k}`, status: "running", lines: 0, at: now() });
			changed();
		}),
		bus.on("monitor:output", (d) => {
			const m = all.get(id(d) ?? ""), e = d as { line?: unknown; outputLines?: unknown };
			if (!m || m.status !== "running") return;
			const progress = progressOf(e.line);
			[m.last, m.lines] = [progress?.message ?? clean(e.line), count(e.outputLines) ? (e.outputLines as number) : m.lines];
			if (progress?.load) m.load = progress.load;
			else delete m.load;
			if (throttleMs) soon();
			else changed();
		}),
		bus.on("monitor:finished", (d) => {
			const m = all.get(id(d) ?? ""), e = d as { status?: unknown; reason?: unknown; exitCode?: unknown; outputLines?: unknown };
			if (!m || m.status !== "running") return;
			m.status = e.status === "completed" ? "done" : e.status === "error" ? "error" : e.reason === "timeout" ? "stale" : "stopped";
			if (Number.isSafeInteger(e.exitCode)) m.exit = e.exitCode as number;
			if (count(e.outputLines)) m.lines = e.outputLines as number;
			m.ended = now();
			delete m.load; // a step that ended waits for nothing
			schedule();
			changed();
		}),
	];
	return {
		/** Running ones first, then the newest; at most MAX_MONITORS. */
		list(): Monitor[] {
			for (const [k, m] of all) if (m.ended !== undefined && now() - m.ended > KEEP_MS) all.delete(k);
			return [...all.values()].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.at - a.at || Number(b.id) - Number(a.id)).slice(0, MAX_MONITORS).map((m) => ({ ...m }));
		},
		clear: () => all.clear(),
		off() {
			offs.forEach((off) => off());
			[timer, prune].forEach((t) => t && clearTimeout(t));
		},
	};
}
