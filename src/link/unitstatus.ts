import { createHash } from "node:crypto";
import { allyLabel } from "../boardauto.ts";
import { cutBytes } from "./canon.ts";
import type { RunSignal } from "../server/runs.ts";
import { LIMITS, type Notice, type UnitStatus } from "./kinds.ts";

// What an unattended device tells its dispatch controllers beside the dialogs (docs/specs/2026-10-25-straw-link.md, Unattended devices): a `unit-status` (ephemeral) with each unit's
// state, its running monitors and its last report, every minute and when it changes, and a `notice` (1 KB) when something went wrong that nobody at the device will see. The
// reporter holds no timer: the server calls `tick()` on its own interval and `notify()` from the places that know, so a test moves a clock and nothing else. An attended computer
// has no controllers (`controllers()` is empty), so it sends nothing.

/** A unit as the server knows it, without the report (that depends on the controller it goes to). */
export type UnitFacts = Omit<UnitStatus, "report">;
export interface UnitReporterDeps {
	/** The attended devices at `dispatch` that are members of a running team now (the holder's `dialogControllers`). */
	controllers(): { team: string; device: string }[];
	/** The units to tell the controllers of `team`: those inside that team's project, and none when its policy shares presence only. */
	units(team: string): Promise<UnitFacts[]>;
	/** The last `tower_done` summary of the unit, or the last `tower_send` text to this controller, whichever came later. */
	report(unit: string, device: string, team: string): string;
	status(team: string, device: string, units: UnitStatus[]): Promise<void>;
	notice(team: string, device: string, notice: Notice): Promise<void>;
	now(): number;
	log(entry: Record<string, unknown>): void;
}
export const STATUS_EVERY_MS = 60_000;
/** The most notice keys remembered, so one trigger tells once however long the server runs. */
const TOLD_MAX = 512;

export class UnitReporter {
	private readonly d: UnitReporterDeps;
	private sent = new Map<string, { at: number; sig: string }>();
	private told = new Set<string>();
	private running: Promise<void> | undefined;
	constructor(d: UnitReporterDeps) {
		this.d = d;
	}
	/** Sends each controller its `unit-status` when it differs from the last one sent or the last one is a minute old. Overlapping calls share the pass in flight. */
	tick(): Promise<void> {
		return (this.running ??= this.pass().catch((error: Error) => this.d.log({ event: "unit-status-failed", error: String(error.message).slice(0, 200) })).finally(() => (this.running = undefined)));
	}
	private async pass(): Promise<void> {
		const to = this.d.controllers(), keys = new Set(to.map((c) => `${c.team}\n${c.device}`));
		for (const k of this.sent.keys()) if (!keys.has(k)) this.sent.delete(k);
		if (!to.length) return;
		const now = this.d.now(), facts = new Map<string, UnitFacts[]>();
		for (const c of to) {
			// One reading per team in a pass, however many controllers it has.
			let mine = facts.get(c.team);
			if (!mine) facts.set(c.team, (mine = await this.d.units(c.team)));
			const k = `${c.team}\n${c.device}`, units = mine.map((u) => ({ ...u, report: cutBytes(this.d.report(u.unit, c.device, c.team), LIMITS.report) })), sig = JSON.stringify(units), before = this.sent.get(k);
			if (before && before.sig === sig && now - before.at < STATUS_EVERY_MS) continue;
			try {
				await this.d.status(c.team, c.device, units);
				this.sent.set(k, { at: now, sig });
			} catch (error) {
				this.d.log({ event: "unit-status-post-failed", device: c.device, error: String((error as Error).message).slice(0, 200) });
			}
		}
	}
	/** Tells every controller, once per `key`; nothing is remembered when there was nobody to tell, so the next trigger with the same key still goes out. */
	async notify(key: string, notice: Notice): Promise<void> {
		if (this.told.has(key)) return;
		const to = this.d.controllers();
		if (!to.length) return;
		this.told.add(key);
		while (this.told.size > TOLD_MAX) this.told.delete(this.told.values().next().value!);
		this.d.log({ event: "notice", key, kind: notice.kind, unit: notice.unit });
		for (const c of to) {
			try {
				await this.d.notice(c.team, c.device, notice);
			} catch (error) {
				this.d.log({ event: "notice-post-failed", device: c.device, kind: notice.kind, error: String((error as Error).message).slice(0, 200) });
			}
		}
	}
}

/** The notice a run's end or refusal makes, with the key that tells it once (the run id, or the workspace and the reason for a refusal). */
export function runNotice(s: RunSignal): { key: string; notice: Notice } {
	const who = s.ally ? "An ally run" : "A run";
	// The key goes into the log, and a refusal's text can carry a path or a line of the project's settings: the key holds a hash of it.
	if (s.kind === "refused") return { key: `refused/${s.workspace}/${createHash("sha256").update(s.text).digest("hex").slice(0, 16)}`, notice: { kind: "run-refused", unit: allyLabel(s.label), text: s.text } };
	const trust = s.detail?.startsWith("No trust decision");
	const kind = trust ? "trust-unanswered" : s.outcome === "quit" ? "run-quit" : s.outcome === "timeout" ? "run-timeout" : "run-crashed";
	return { key: `run/${s.run}`, notice: { kind, unit: allyLabel(s.label), text: `${who} ${s.outcome === "quit" ? "was quit" : s.outcome === "timeout" ? "timed out" : "crashed"}${s.detail ? `: ${s.detail}` : ""}` } };
}
