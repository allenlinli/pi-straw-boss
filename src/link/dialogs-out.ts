import { randomBytes } from "node:crypto";
import { ANSWER_ID, checkAnswer, type Hub } from "../dialogs.ts";
import type { Answer } from "../owners.ts";
import { LIMITS, type DialogClose, type DialogOpen, type Notice } from "./kinds.ts";
import { EVERYONE, reaches, type Scope } from "./scope.ts";

// Dialogs across devices (docs/specs/2026-10-25-straw-link.md, Unattended devices: Asking back; Message kinds: dialog-open, dialog-answer, dialog-close).
// An unattended device has no one at its screen, so a question one of its sessions asks is forwarded to the controllers its policy trusts at `dispatch`
// (`DialogForwarder`); a controller shows it (`DialogViews`) and answers it with `dialog-answer`. The unattended device takes an answer only from an attended
// sender that is at `dispatch` now, for an open dialog, with the dialog's digest, under an answer id it has not seen; the first valid answer wins. What is
// forwarded is the dialog the hub already lets a page answer (dialogs.ts `merge`): never a secret_drop, never one that waits in the terminal. The log carries
// ids and outcomes, never a dialog's text.
// On a box shared by several devs a question is for the controller that dispatched the unit that asked, and the team's admins (scope.ts, docs/specs/2026-11-05-link-shared-box.md): `dispatcher` says whose unit asked,
// the others are not sent the question, and the box refuses an answer from one of them.

/** The `dialog` field of a `dialog-open`: what a controller needs to draw the question, as JSON. */
export interface RemoteDialog { select?: unknown; questions?: unknown; cancel?: true }
/** The `answer` field of a `dialog-answer`, as JSON: `{ choice }`, `{ answers }`, or `{ cancel: true }` (dialogs.ts `checkAnswer`). */
export type RemoteAnswer = { choice: number } | { answers: unknown[] } | { cancel: true };

/** The most dialogs one device keeps open for forwarding, and the answer ids it remembers. */
export const MAX_OPEN = 32;
const MAX_SEEN = 1024;

export interface DialogsOutDeps {
	hub: Pick<Hub, "onChange" | "answerable" | "outcome" | "send">;
	/** One net reading, which binds the hub's relayed dialogs to their units (so `answerable` is current). */
	read(): Promise<void>;
	/** The attended devices at `dispatch` that are members of a running team now (empty on an attended computer). */
	controllers(): { team: string; device: string }[];
	post(team: string, device: string, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose): Promise<void>;
	log(entry: Record<string, unknown>): void;
	/** Whether the controller's device has sent a presence lately. Absent: always online. An offline controller gets the open once (queued) and no refresh until it is back. */
	online?(team: string, device: string): boolean;
	/** False while `controllers()` may be short for a reason other than lost trust (the holder is stopped, a roster unreadable): nothing is withdrawn then. Absent: true. */
	controllersKnown?(): boolean;
	/** The clock (default `Date.now`), for the unanswered-dialog notice. */
	now?(): number;
	/** Tells the controllers `scope` covers (src/link/unitstatus.ts `UnitReporter.notify`); once per key. Absent: no notices. */
	notice?(key: string, notice: Notice, scope: Scope): void | boolean | Promise<void | boolean>;
	/**
	 * The device (and its team, when known) that dispatched the unit `key` asked from, or nothing when none did; read from Herdr, so it is asked again while it is unknown. Absent: every controller is a recipient,
	 * as on a box with one controller.
	 */
	dispatcher?(key: string): Promise<{ device: string; team?: string } | undefined>;
	/** Whether `device` is an admin of `team`'s roster now: an admin is a recipient of every question. Absent: nobody is. */
	admin?(team: string, device: string): boolean;
	/**
	 * What a controller is told asks the question in the unit `key`: the unit's name, scrubbed for leaving the box (known after a `read`). Nothing: the dialog's owner, the package that opened it (`rpiv`), is told instead, which names
	 * no unit. Absent: the owner.
	 */
	unit?(key: string): string | undefined;
}
/** A dialog nobody has answered this long is told to the controllers, once. */
export const UNANSWERED_MS = 30 * 60_000;
/** An open dialog is sent again to each controller this often, so a controller that lost it (a restart, a missed post) has it back, and one that expires views not refreshed (`OPEN_STALE_MS`) keeps it. */
export const REFRESH_MS = 10 * 60_000;
/** How long an answer that no session confirmed (`unknown`) is trusted to have landed before a dialog that is still open is taken as unanswered. */
export const UNKNOWN_RECHECK_MS = 15_000;
/** A pass that has not finished this long is stuck: the next look logs where it waits (`dialog-pass-stuck`), lets it go, and starts a pass of its own, so one call that never returns cannot end forwarding for good. */
export const PASS_STUCK_MS = 60_000;
/** A close that failed to post is tried at this many passes, then given up (the card expires at the controller anyway). */
export const CLOSE_TRIES = 5;
/** The most closes held to be posted; the oldest is given up when more come. */
const MAX_CLOSES = 256;
/** A `dialog-close` (an end, or a withdrawal) not yet posted to a controller: it is kept apart from the open dialog, which is gone from `open` once it ends, so a pass let go as stuck leaves it for the next to post. */
interface PendingClose { k: string; dialogId: string; by: string; at: number; tries: number }
export interface DialogAnswerInput { team: string; from: string; dialogId: string; digest: string; answer: string; answerId: string }
/** `sent` is where the dialog was last sent, per controller, and when; `claimed` is set while an answer is on its way or has been accepted; `unknownAt` is when an answer no session confirmed was sent. */
interface Open { key: string; target: Parameters<Hub["send"]>[1]; /** The package that owns the dialog (`rpiv`). */ owner: string; /** What the controllers are told asks: the unit's name when the box can say it, else `owner`. */ label: string; text: string; sent: Map<string, number>; away: Set<string>; claimed: boolean; unknownAt?: number; since: number; told: boolean; /** The log line that nobody can be told of this question was written. */ unrouted?: boolean; /** Whose unit asked, once it is known (`dispatcher`). */ who?: { device: string; team?: string } }

export class DialogForwarder {
	private readonly d: DialogsOutDeps;
	private open = new Map<string, Open>();
	private skipped = new Set<string>();
	private seen = new Set<string>();
	private off: (() => void) | undefined;
	private polling: Promise<void> | undefined;
	/** The closes not posted yet, per controller and dialog, drained by every pass until each is posted. */
	private closes = new Map<string, PendingClose>();
	/** The passes let go as stuck that have not returned; at most one is outstanding, so a call that never returns costs one pending pass and not one a minute. */
	private released = new Set<Promise<void>>();
	/** The line that a second stuck pass is not let go was written for this stretch. */
	private hung = false;
	private again = false;
	/** The pass that counts: a pass let go as stuck has an older number and stops at its next turn. */
	private gen = 0;
	/** When the pass in flight began, and the call it waits at (`dialog-pass-stuck` names it). */
	private passAt = 0;
	private step = "idle";
	/** What the last `dialog-controllers` line said, so a line is written when it changes and not at every pass. */
	private counted: string | undefined;
	/** The room for open questions was used up, and the line that says so was written. */
	private full = false;
	constructor(d: DialogsOutDeps) {
		this.d = d;
	}
	start(): void {
		if (this.off) return;
		this.off = this.d.hub.onChange(() => void this.poll());
		this.d.log({ event: "dialog-forwarder", state: "started" });
	}
	stop(): void {
		this.off?.();
		this.off = undefined;
	}
	/** The periodic look: a controller that gained `dispatch` while a dialog was open gets it now, and a dialog unanswered for 30 minutes is told once. */
	tick(): Promise<void> {
		return this.poll();
	}
	/** Looks at the hub now; calls that overlap run once more after the one in flight, and a pass in flight for `PASS_STUCK_MS` is let go (its next look is a new pass). */
	poll(): Promise<void> {
		if (this.polling) {
			if (this.now() - this.passAt < PASS_STUCK_MS) return ((this.again = true), this.polling);
			if (this.released.size) {
				// A pass let go has not returned: its call may never, and another release would leave one more pending pass behind. The pass in flight is waited on until that one ends.
				if (!this.hung) this.d.log({ event: "dialog-pass-hung", step: this.step, ms: this.now() - this.passAt });
				this.hung = true;
				return ((this.again = true), this.polling);
			}
			this.d.log({ event: "dialog-pass-stuck", step: this.step, ms: this.now() - this.passAt });
			this.gen++;
			this.released.add(this.polling);
			this.polling = undefined;
			// What the pass let go marked as sent may never have left (it waited at the post): the controllers get every open question again.
			for (const d of this.open.values()) d.sent.clear();
		}
		const gen = this.gen;
		const run: Promise<void> = (async () => {
			do {
				this.again = false;
				this.passAt = this.now();
				try {
					await this.pass(gen);
				} catch (error) {
					this.d.log({ event: "dialog-forward-failed", step: this.step, error: String((error as Error).message).slice(0, 200) });
				}
			} while (this.again && gen === this.gen);
		})().finally(() => {
			if (this.polling === run) this.polling = undefined;
			this.released.delete(run);
			if (!this.released.size) this.hung = false;
		});
		return (this.polling = run);
	}
	/** Whose unit asked: looked up until it is known, then kept. A lookup that fails leaves it unknown, which is the admins' alone. */
	private async whose(d: Open): Promise<void> {
		if (!this.d.dispatcher || d.who) return;
		d.who = await this.d.dispatcher(d.key).catch(() => undefined);
	}
	/** What the question's controllers are: every controller when the box cannot tell whose units are whose, else the dispatcher and the admins. */
	private scopeOf(d: Open): Scope {
		return this.d.dispatcher ? (d.who ? { device: d.who.device, ...(d.who.team !== undefined ? { team: d.who.team } : {}) } : {}) : EVERYONE;
	}
	/** Records where the pass in flight waits (`dialog-pass-stuck` names it); a pass let go as stuck no longer writes it. */
	private at(gen: number, step: string): void {
		if (gen === this.gen) this.step = step;
	}
	/** One line when the controllers the forwarder sees change in number or in whether the list is complete, so a box with nobody to tell says so once (and the first pass says how it starts). */
	private count(controllers: number, known: boolean): void {
		const line = `${controllers}/${known}`;
		if (line === this.counted) return;
		this.counted = line;
		this.d.log({ event: "dialog-controllers", count: controllers, known, open: this.open.size });
	}
	private async pass(gen: number): Promise<void> {
		const to = this.d.controllers();
		this.count(to.length, this.d.controllersKnown?.() ?? true);
		if (this.closes.size && !(await this.drain(gen))) return;
		if (!to.length && !this.open.size) return;
		if (to.length) {
			this.at(gen, "read");
			await this.d.read();
			if (gen !== this.gen) return;
		}
		for (const o of to.length ? this.d.hub.answerable() : []) {
			const id = o.target.answer.dialog;
			if (this.open.has(id) || this.skipped.has(id)) continue;
			const { select, questions, cancel } = o.target.answer, text = JSON.stringify({ ...(select ? { select } : {}), ...(questions ? { questions } : {}), ...(cancel ? { cancel } : {}) } satisfies RemoteDialog);
			if (Buffer.byteLength(text) > LIMITS.dialog) {
				this.skipped.add(id);
				this.d.log({ event: "dialog-oversize", dialog: id, bytes: Buffer.byteLength(text) });
				const unit = { key: o.key } as Open;
				this.at(gen, "dispatcher");
				await this.whose(unit);
				this.at(gen, "notice");
				await this.d.notice?.(`oversize/${id}`, { kind: "dialog-oversize", unit: o.key, text: `A question of ${this.labelOf(o.key, o.owner)} was not forwarded: it is ${Buffer.byteLength(text)} bytes, over the ${LIMITS.dialog} the link carries. It waits at the device.` }, this.scopeOf(unit));
				if (gen !== this.gen) return;
				continue;
			}
			if (this.open.size >= MAX_OPEN) {
				// The one case where a question is left unforwarded with no line of its own: the line says the room is used up, once until it frees.
				if (!this.full) this.d.log({ event: "dialog-full", open: this.open.size });
				this.full = true;
				continue;
			}
			this.open.set(id, { key: o.key, target: o.target, owner: o.owner, label: this.labelOf(o.key, o.owner), text, sent: new Map(), away: new Set(), claimed: false, since: this.now(), told: false });
			this.d.log({ event: "dialog-seen", dialog: id, unit: o.key, owner: o.owner });
		}
		for (const [id, d] of [...this.open]) {
			this.at(gen, "dispatcher");
			await this.whose(d);
			if (gen !== this.gen) return;
			const state = this.d.hub.outcome(id);
			if (!state.open) {
				this.open.delete(id);
				this.full = false;
				this.d.log({ event: "dialog-ended", dialog: id, by: state.by, sent: d.sent.size });
				for (const k of d.sent.keys()) this.hold(k, id, state.by);
				if (!(await this.drain(gen))) return;
				continue;
			}
			// An answer no session confirmed, and the dialog is still open a while after: it did not land, so the next valid answer may win and the controllers get the question open again.
			if (d.claimed && d.unknownAt !== undefined && this.now() - d.unknownAt >= UNKNOWN_RECHECK_MS) {
				d.claimed = false;
				d.unknownAt = undefined;
				d.sent.clear();
			}
			// The controllers this question is for: its dispatcher and the admins, among those at `dispatch`.
			const mine = to.filter((c) => reaches(this.scopeOf(d), c, this.d.admin ?? (() => false)));
			// A controller that lost `dispatch`, or is no longer one this question is for, is told it is withdrawn; one that has it again gets it open again below.
			for (const k of this.d.controllersKnown?.() === false ? [] : [...d.sent.keys()]) {
				if (mine.some((c) => `${c.team}\n${c.device}` === k)) continue;
				d.sent.delete(k);
				this.hold(k, id, "withdrawn");
				if (!(await this.drain(gen))) return;
			}
			if (!d.told && !d.claimed && to.length && this.now() - d.since >= UNANSWERED_MS) {
				// Marked told only once the notice reached somebody: with no admin at `dispatch` it is tried again at the next pass (g346-F005).
				this.at(gen, "notice");
				const sent = await this.d.notice?.(`unanswered/${id}`, { kind: "dialog-unanswered", unit: d.key, text: `A question of ${d.label} has waited ${Math.round((this.now() - d.since) / 60_000)} minutes for an answer.` }, this.scopeOf(d));
				if (gen !== this.gen) return;
				d.told = sent !== false;
			}
			// A question no controller can be told of (an unattributed unit, and no admin at `dispatch`) stays open and is never widened to the others; the box's own log says it waits.
			if (!mine.length && !d.unrouted) {
				d.unrouted = true;
				this.d.log({ event: "dialog-unrouted", dialog: id, unit: d.key, owner: d.owner });
			}
			for (const c of mine) {
				const k = `${c.team}\n${c.device}`;
				const at = d.sent.get(k), up = this.d.online?.(c.team, c.device) ?? true;
				if (!up) {
					d.away.add(k);
					if (at !== undefined) continue;
				} else if (at !== undefined && !d.away.delete(k) && this.now() - at < REFRESH_MS) continue;
				d.sent.set(k, this.now());
				this.at(gen, "post");
				const posted = await this.send(k, "dialog-open", { dialogId: id, digest: d.target.answer.digest, owner: d.label, dialog: d.text });
				// A pass let go no longer owns `sent`: the pass that replaced it has marked what it posted.
				if (gen !== this.gen) return;
				if (!posted) d.sent.delete(k);
			}
		}
		for (const id of [...this.skipped]) if (!this.d.hub.outcome(id).open) this.skipped.delete(id);
	}
	/** Keeps a close to post: the oldest is given up when the room is used up. */
	private hold(k: string, dialogId: string, by: string): void {
		this.closes.set(`${k}\n${dialogId}`, { k, dialogId, by, at: this.now(), tries: 0 });
		for (const [key, c] of this.closes) {
			if (this.closes.size <= MAX_CLOSES) break;
			this.closes.delete(key);
			this.d.log({ event: "dialog-close-dropped", dialog: c.dialogId, reason: "full" });
		}
	}
	/** Posts the held closes, each removed once posted. One that failed `CLOSE_TRIES` times, or whose card has expired at the controller (`OPEN_STALE_MS`), is given up with a line. False when this pass was let go meanwhile. */
	private async drain(gen: number): Promise<boolean> {
		for (const [key, c] of [...this.closes]) {
			if (this.now() - c.at > OPEN_STALE_MS) {
				this.closes.delete(key);
				this.d.log({ event: "dialog-close-dropped", dialog: c.dialogId, reason: "stale" });
				continue;
			}
			this.at(gen, "post");
			const posted = await this.send(c.k, "dialog-close", { dialogId: c.dialogId, by: c.by });
			if (posted) this.closes.delete(key);
			else if (++c.tries >= CLOSE_TRIES) {
				this.closes.delete(key);
				this.d.log({ event: "dialog-close-dropped", dialog: c.dialogId, reason: "failed" });
			}
			if (gen !== this.gen) return false;
		}
		return true;
	}
	private now = () => this.d.now?.() ?? Date.now();
	/** What the controllers are told asks: the unit's name when it is known, else the owner of the dialog. */
	private labelOf(key: string, owner: string): string {
		return this.d.unit?.(key) || owner;
	}
	private async send(k: string, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose): Promise<boolean> {
		const [team, device] = k.split("\n") as [string, string];
		try {
			await this.d.post(team, device, kind, payload);
			this.d.log({ event: "dialog-sent", kind, dialog: payload.dialogId, team, to: device });
			return true;
		} catch (error) {
			this.d.log({ event: "dialog-post-failed", kind, dialog: payload.dialogId, error: String((error as Error).message).slice(0, 200) });
			return false;
		}
	}
	/** Has the next pass send the dialog open again to one controller, so its card can be answered again. */
	private reopen(d: Open, team: string, device: string): void {
		d.sent.delete(`${team}\n${device}`);
		void this.poll();
	}
	/**
	 * An answer the holder has checked came from an attended member at `dispatch`. It counts only for an open dialog with the same digest, under an answer id not seen
	 * before, and only the first such answer is carried to the session; the rest are dropped with a log line.
	 */
	async answer(a: DialogAnswerInput): Promise<void> {
		const drop = (reason: string) => this.d.log({ event: "drop", reason, kind: "dialog-answer", from: a.from, dialog: a.dialogId });
		const d = this.open.get(a.dialogId);
		if (!d) return drop("dialog-answer-unknown");
		// Only a controller the question was sent to may answer it (the dispatcher and the admins): the holder checked that the sender is at `dispatch`, this checks that it is the one this question is for.
		await this.whose(d);
		if (!reaches(this.scopeOf(d), { team: a.team, device: a.from }, this.d.admin ?? (() => false))) return drop("dialog-answer-not-recipient");
		if (d.target.answer.digest !== a.digest) return drop("dialog-answer-digest");
		if (!ANSWER_ID.test(a.answerId) || this.seen.has(a.answerId)) return drop("dialog-answer-id");
		this.seen.add(a.answerId);
		while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
		if (d.claimed) return drop("dialog-answer-late");
		let json: unknown;
		try {
			json = JSON.parse(a.answer);
		} catch {
			return drop("dialog-answer-malformed");
		}
		if (typeof json !== "object" || json === null || Array.isArray(json)) return drop("dialog-answer-malformed");
		const checked = checkAnswer(d.target.answer, json as Record<string, unknown>);
		if (typeof checked === "string") return drop("dialog-answer-invalid");
		// A choice only this computer may pick, and a cancel where every choice is, as control.ts holds a paired device to: the controller is one, whatever it sent.
		const choices = d.target.answer.select?.choices;
		if (("choice" in checked && choices?.[checked.choice]?.hereOnly) || ("cancel" in checked && choices?.every((c) => c.hereOnly))) {
			this.reopen(d, a.team, a.from);
			return drop("dialog-answer-here-only");
		}
		d.claimed = true;
		const answer: Answer = { id: a.dialogId, answerId: a.answerId, digest: a.digest, ...checked };
		const sent = await this.d.hub.send(d.key, d.target, answer);
		const outcome = sent.body.outcome;
		// Only an accepted answer keeps the dialog claimed. One the session turned down or could not take (`rejected`, `busy`, `unsent`) leaves it open for the next valid answer, and the
		// controller that gave it gets the question open again; one no session confirmed (`unknown`) may have landed, so it is looked at again on a later pass (`UNKNOWN_RECHECK_MS`).
		if (outcome === "unknown") d.unknownAt = this.now();
		else if (outcome !== "accepted") {
			d.claimed = false;
			if (outcome !== "stale") this.reopen(d, a.team, a.from);
		}
		this.d.log({ event: "dialog-answered", dialog: a.dialogId, from: a.from, outcome });
	}
}

/** A dialog an unattended device forwarded to this device, as the controller keeps it in memory. */
export interface DialogView { team: string; device: string; dialogId: string; digest: string; owner: string; dialog: string; at: number; answered: boolean; /** The `by` of the `dialog-close` that ended it, and when it came: the card says how it ended for a while. */ closed?: { by: string; at: number } }
const MAX_VIEWS = 50;
/** How long a card of an ended dialog stays, to say how it ended. */
export const CLOSED_MS = 2 * 60_000;
/** How long an open dialog stays without its device sending it again (it does every `REFRESH_MS`): a device that went away does not leave a question nobody can answer. */
export const OPEN_STALE_MS = 25 * 60_000;

/** The forwarded dialogs waiting here, the latest per device and dialog id. */
export class DialogViews {
	private views = new Map<string, DialogView>();
	private key = (device: string, dialogId: string) => `${device}\n${dialogId}`;
	/** Returns whether the dialog is new (not a replacement of one held). */
	put(v: Omit<DialogView, "answered">): boolean {
		const k = this.key(v.device, v.dialogId), held = this.views.get(k);
		this.views.delete(k);
		// A dialog-open for a dialog held opens it for answering again, answered before or not: the device sends it again after it turned an answer down or lost it (`DialogForwarder`).
		this.views.set(k, { ...v, answered: false });
		while (this.views.size > MAX_VIEWS) this.views.delete(this.views.keys().next().value!);
		return !held;
	}
	drop(device: string, dialogId: string): void {
		this.views.delete(this.key(device, dialogId));
	}
	/** The dialog ended (the device's `dialog-close`): it stays as a card that says how, until `CLOSED_MS` has passed. */
	close(device: string, dialogId: string, by: string, at: number): void {
		const v = this.views.get(this.key(device, dialogId));
		if (v) v.closed = { by, at };
	}
	get(device: string, dialogId: string): DialogView | undefined {
		return this.views.get(this.key(device, dialogId));
	}
	/** Those of devices `keep` still counts as members; an ended one only until `CLOSED_MS` after it ended, and an open one only until `OPEN_STALE_MS` after the device last sent it. */
	list(keep: (v: DialogView) => boolean, now: number): DialogView[] {
		for (const [k, v] of this.views) if (!keep(v) || (v.closed ? now - v.closed.at > CLOSED_MS : now - v.at > OPEN_STALE_MS)) this.views.delete(k);
		return [...this.views.values()];
	}
}

/** A fresh answer id (32 hex characters, which `ANSWER_ID` takes). */
export const newAnswerId = () => randomBytes(16).toString("hex");
