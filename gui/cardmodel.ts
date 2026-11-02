import { rowSpans } from "./mirror.ts";
import type { Phase } from "./mirrorconn.ts";

// The terminal card's rules, with no DOM (docs/specs/2026-11-02-terminal-card.md §5 to §7): what the card shows of a pane's rows, whether the
// last row asks for a password, whether the field is masked, which state the card is in, and when its step is over. termcard.ts draws and sends; it asks here.

export type Kind = "prompt" | "pane";
export type CardState = "connecting" | "live" | "secret" | "sending" | "confirm" | "running" | "stale" | "paused" | "hidden" | "held" | "refused" | "ended" | "gone";
const SECRET = /(password|passphrase|passcode|\bpin\b|密碼|口令).{0,80}[:：]$/i;
/** A row as plain text: every escape stripped (the tile's own `rowSpans`, without its classes), right-trimmed. */
const plain = (row: string) => rowSpans(row).map((s) => s.text).join("").trimEnd();

/** The last 4 non-blank rows of the mirror, as plain text. */
export const tail = (rows: string[]): string[] => rows.map(plain).filter(Boolean).slice(-4);
/** The last non-blank row ends in a colon after password, passphrase, passcode, PIN, 密碼, or 口令: only that row, because the mirror carries no cursor and the prompt is where it waits. */
export const secretPrompt = (rows: string[]): boolean => SECRET.test(rows.map(plain).findLast(Boolean) ?? "");

/** `on`: the field hides what is typed. `hand`: the boss pressed 遮住, so the prompt no longer decides. */
export interface Mask { on: boolean; hand: boolean }
export const NO_MASK: Mask = { on: false, hand: false };
/** A password prompt turns the mask on; it goes off by itself only when the prompt is gone and the field is empty, never unmasking typed text; a hand mask is left as it is. */
export const maskStep = (mask: Mask, { secret, empty }: { secret: boolean; empty: boolean }): Mask => (mask.hand ? mask : secret ? (mask.on ? mask : { on: true, hand: false }) : mask.on && empty ? NO_MASK : mask);
export const maskToggle = (mask: Mask): Mask => ({ on: !mask.on, hand: true });

/** What the card knows: `phase` and `stale` are the connection's (mirrorconn.ts); `held` is a tower's sentence when no run is live; `ended` is the connection's end or, for a pane, a write refused as gone; `confirm` is the token the server named for an Enter ("" if none); `after` is the tail when this card's Enter was taken. */
export interface CardFacts { kind: Kind; phase: Phase; stale: boolean; rows: string[]; held?: string; ended?: boolean; sending?: boolean; refused?: boolean; confirm?: string; after?: string[] }
export function cardState(f: CardFacts): CardState {
	const pane = f.kind === "pane";
	if (f.held) return "held";
	if (f.ended) return pane ? "gone" : "ended";
	if (f.sending) return "sending";
	if (f.confirm !== undefined) return "confirm";
	if (f.refused || f.phase === "refused") return "refused";
	if (f.phase !== "live") return f.phase;
	if (f.stale) return "stale";
	if (pane && secretPrompt(f.rows)) return "secret";
	return pane && f.after && f.after.join("\n") !== tail(f.rows).join("\n") ? "running" : "live";
}

export type StepKind = Kind | "armed";
/** `taken`: an Enter this card (or its expansion) sent got a 200; `going`: one is on its way; `end`: the `ended` frame; `refused`: an attach or a write the server refused; `mark`: the unit's mark in a snapshot. */
export type StepEvent = { type: "taken" | "going" | "cancel" | "stale" | "paused" | "network" | "end" } | { type: "refused"; status: number; error?: string } | { type: "mark"; mark: string };
/** When a card's step is over, and only by what it sent or what happened to its own pane, never by a mark (except an armed terminal's first work). */
export function stepRule(kind: StepKind, e: StepEvent): "stay" | "close" {
	const gone = e.type === "end" || (e.type === "refused" && (e.status === 404 || e.error === "pane_closed"));
	return (kind === "prompt" ? e.type === "taken" : kind === "armed" ? e.type === "mark" && e.mark === "working" : gone) ? "close" : "stay";
}
