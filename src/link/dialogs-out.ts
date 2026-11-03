import { randomBytes } from "node:crypto";
import { ANSWER_ID, checkAnswer, type Hub } from "../dialogs.ts";
import type { Answer } from "../owners.ts";
import { LIMITS, type DialogClose, type DialogOpen } from "./kinds.ts";

// Dialogs across devices (docs/specs/2026-10-25-straw-link.md, Unattended devices: Asking back; Message kinds: dialog-open, dialog-answer, dialog-close).
// An unattended device has no one at its screen, so a question one of its sessions asks is forwarded to the controllers its policy trusts at `dispatch`
// (`DialogForwarder`); a controller shows it (`DialogViews`) and answers it with `dialog-answer`. The unattended device takes an answer only from an attended
// sender that is at `dispatch` now, for an open dialog, with the dialog's digest, under an answer id it has not seen; the first valid answer wins. What is
// forwarded is the dialog the hub already lets a page answer (dialogs.ts `merge`): never a secret_drop, never one that waits in the terminal. The log carries
// ids and outcomes, never a dialog's text.

/** The `dialog` field of a `dialog-open`: what a controller needs to draw the question, as JSON. */
export interface RemoteDialog { select?: unknown; questions?: unknown; cancel?: true }
/** The `answer` field of a `dialog-answer`, as JSON: `{ choice }`, `{ answers }`, or `{ cancel: true }` (dialogs.ts `checkAnswer`). */
export type RemoteAnswer = { choice: number } | { answers: unknown[] } | { cancel: true };

/** The most dialogs one device keeps open for forwarding, and the answer ids it remembers. */
const MAX_OPEN = 32, MAX_SEEN = 1024;

export interface DialogsOutDeps {
	hub: Pick<Hub, "onChange" | "answerable" | "outcome" | "send">;
	/** One net reading, which binds the hub's relayed dialogs to their units (so `answerable` is current). */
	read(): Promise<void>;
	/** The attended devices at `dispatch` that are members of a running team now (empty on an attended computer). */
	controllers(): { team: string; device: string }[];
	post(team: string, device: string, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose): Promise<void>;
	log(entry: Record<string, unknown>): void;
}
export interface DialogAnswerInput { team: string; from: string; dialogId: string; digest: string; answer: string; answerId: string }
interface Open { key: string; target: Parameters<Hub["send"]>[1]; owner: string; text: string; sent: Set<string>; claimed: boolean }

export class DialogForwarder {
	private readonly d: DialogsOutDeps;
	private open = new Map<string, Open>();
	private skipped = new Set<string>();
	private seen = new Set<string>();
	private off: (() => void) | undefined;
	private polling: Promise<void> | undefined;
	private again = false;
	constructor(d: DialogsOutDeps) {
		this.d = d;
	}
	start(): void {
		this.off ??= this.d.hub.onChange(() => void this.poll());
	}
	stop(): void {
		this.off?.();
		this.off = undefined;
	}
	/** Looks at the hub now; calls that overlap run once more after the one in flight. */
	poll(): Promise<void> {
		if (this.polling) return ((this.again = true), this.polling);
		const run = (async () => {
			do {
				this.again = false;
				try {
					await this.pass();
				} catch (error) {
					this.d.log({ event: "dialog-forward-failed", error: String((error as Error).message).slice(0, 200) });
				}
			} while (this.again);
		})().finally(() => (this.polling = undefined));
		return (this.polling = run);
	}
	private async pass(): Promise<void> {
		const to = this.d.controllers();
		if (!to.length && !this.open.size) return;
		if (to.length) await this.d.read();
		for (const o of to.length ? this.d.hub.answerable() : []) {
			const id = o.target.answer.dialog;
			if (this.open.has(id) || this.skipped.has(id)) continue;
			const { select, questions, cancel } = o.target.answer, text = JSON.stringify({ ...(select ? { select } : {}), ...(questions ? { questions } : {}), ...(cancel ? { cancel } : {}) } satisfies RemoteDialog);
			if (Buffer.byteLength(text) > LIMITS.dialog) {
				this.skipped.add(id);
				this.d.log({ event: "dialog-oversize", dialog: id, bytes: Buffer.byteLength(text) });
				continue;
			}
			if (this.open.size >= MAX_OPEN) continue;
			this.open.set(id, { key: o.key, target: o.target, owner: o.owner, text, sent: new Set(), claimed: false });
		}
		for (const [id, d] of [...this.open]) {
			const state = this.d.hub.outcome(id);
			if (!state.open) {
				this.open.delete(id);
				for (const k of d.sent) await this.send(k, "dialog-close", { dialogId: id, by: state.by });
				continue;
			}
			for (const c of to) {
				const k = `${c.team}\n${c.device}`;
				if (d.sent.has(k)) continue;
				d.sent.add(k);
				if (!(await this.send(k, "dialog-open", { dialogId: id, digest: d.target.answer.digest, owner: d.owner, dialog: d.text }))) d.sent.delete(k);
			}
		}
		for (const id of [...this.skipped]) if (!this.d.hub.outcome(id).open) this.skipped.delete(id);
	}
	private async send(k: string, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose): Promise<boolean> {
		const [team, device] = k.split("\n") as [string, string];
		try {
			await this.d.post(team, device, kind, payload);
			return true;
		} catch (error) {
			this.d.log({ event: "dialog-post-failed", kind, dialog: payload.dialogId, error: String((error as Error).message).slice(0, 200) });
			return false;
		}
	}
	/**
	 * An answer the holder has checked came from an attended member at `dispatch`. It counts only for an open dialog with the same digest, under an answer id not seen
	 * before, and only the first such answer is carried to the session; the rest are dropped with a log line.
	 */
	async answer(a: DialogAnswerInput): Promise<void> {
		const drop = (reason: string) => this.d.log({ event: "drop", reason, kind: "dialog-answer", from: a.from, dialog: a.dialogId });
		const d = this.open.get(a.dialogId);
		if (!d) return drop("dialog-answer-unknown");
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
		d.claimed = true;
		const answer: Answer = { id: a.dialogId, answerId: a.answerId, digest: a.digest, ...checked };
		const sent = await this.d.hub.send(d.key, d.target, answer);
		// A session that could not be reached took nothing: the next valid answer may still win.
		if (sent.body.outcome === "unsent") d.claimed = false;
		this.d.log({ event: "dialog-answered", dialog: a.dialogId, from: a.from, outcome: sent.body.outcome });
	}
}

/** A dialog an unattended device forwarded to this device, as the controller keeps it in memory. */
export interface DialogView { team: string; device: string; dialogId: string; digest: string; owner: string; dialog: string; at: number; answered: boolean; /** The `by` of the `dialog-close` that ended it, and when it came: the card says how it ended for a while. */ closed?: { by: string; at: number } }
const MAX_VIEWS = 50;
/** How long a card of an ended dialog stays, to say how it ended. */
export const CLOSED_MS = 2 * 60_000;

/** The forwarded dialogs waiting here, the latest per device and dialog id. */
export class DialogViews {
	private views = new Map<string, DialogView>();
	private key = (device: string, dialogId: string) => `${device}\n${dialogId}`;
	/** Returns whether the dialog is new (not a replacement of one held). */
	put(v: Omit<DialogView, "answered">): boolean {
		const k = this.key(v.device, v.dialogId), held = this.views.get(k);
		this.views.delete(k);
		this.views.set(k, { ...v, answered: held?.answered === true && held.digest === v.digest });
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
	/** Those of devices `keep` still counts as members; an ended one only until `CLOSED_MS` after it ended. */
	list(keep: (v: DialogView) => boolean, now: number): DialogView[] {
		for (const [k, v] of this.views) if (!keep(v) || (v.closed && now - v.closed.at > CLOSED_MS)) this.views.delete(k);
		return [...this.views.values()];
	}
}

/** A fresh answer id (32 hex characters, which `ANSWER_ID` takes). */
export const newAnswerId = () => randomBytes(16).toString("hex");
