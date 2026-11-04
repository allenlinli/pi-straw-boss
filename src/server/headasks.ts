import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ensureDir, HEAD_KEY, towerDir, writeDurable } from "./towerstore.ts";

// The head tower's asks (docs/specs/2026-11-04-head-tower.md, Forwarding, and the answers): each forward to a workspace tower opens an ask `H<n>` in `head/asks.json`. An ask stays open for 24 hours after its last forward or
// answer, at most 40 are open (opening one more closes the oldest), and the head's gate takes an answer only for an open ask to the workspace its sender is the tower of. The file is the boss's: it survives a close of the head.

/** How long an ask stays open after its last forward or answer, and how many may be open at once. */
export const ASK_OPEN_MS = 24 * 3_600_000;
export const ASK_CAP = 40;
/** Closed and expired asks stay in the file for the brief and the page; the oldest beyond this go. */
const ASK_KEEP = 100;
const FIRST = 120;

export interface HeadAnswer { at: number; first: string }
export interface HeadAsk {
	id: string;
	workspace: string;
	label: string;
	/** When it was opened, and when it last saw a forward or an answer (the 24 hours count from there). */
	at: number;
	last: number;
	first: string;
	/** `boss:<event id>`: the forward was the boss's instruction relayed. */
	relay?: string;
	/** The head's cap closed it before its time. */
	closed?: true;
	answers: HeadAnswer[];
}
interface File { next: number; asks: HeadAsk[] }

const fileOf = (slot: Slot) => join(towerDir(slot, HEAD_KEY), "asks.json");
const line = (text: string) => Array.from(text.split("\n").find((l) => l.trim()) ?? "").join("").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, FIRST);
const valid = (a: unknown): a is HeadAsk => {
	const v = a as Partial<HeadAsk> | null;
	return typeof v === "object" && v !== null && typeof v.id === "string" && /^H\d+$/.test(v.id) && typeof v.workspace === "string" && typeof v.label === "string" && Number.isFinite(v.at) && Number.isFinite(v.last) && typeof v.first === "string" && Array.isArray(v.answers);
};
function load(slot: Slot): File {
	try {
		const f = JSON.parse(readFileSync(fileOf(slot), "utf8")) as Partial<File>;
		const asks = Array.isArray(f.asks) ? f.asks.filter(valid) : [];
		return { next: Number.isInteger(f.next) && f.next! >= 1 ? f.next! : 1 + Math.max(0, ...asks.map((a) => Number(a.id.slice(1)))), asks };
	} catch {
		return { next: 1, asks: [] };
	}
}
function save(slot: Slot, file: File): void {
	ensureDir(towerDir(slot, HEAD_KEY));
	writeDurable(fileOf(slot), { next: file.next, asks: file.asks.slice(-ASK_KEEP) });
}
const isOpen = (a: HeadAsk, now: number) => !a.closed && now - a.last < ASK_OPEN_MS;

/** Every ask in the file, oldest first, open or not. */
export const readAsks = (slot: Slot, _now: number): HeadAsk[] => load(slot).asks;
/** The asks that are open now, oldest first. */
export const openAsks = (slot: Slot, now: number): HeadAsk[] => load(slot).asks.filter((a) => isOpen(a, now));

/** Opens an ask for a forward; the 41st open ask closes the oldest open one. */
export function openAsk(slot: Slot, now: number, d: { workspace: string; label: string; first: string; relay?: string }): HeadAsk {
	const file = load(slot), ask: HeadAsk = { id: `H${file.next}`, workspace: d.workspace, label: d.label, at: now, last: now, first: line(d.first), ...(d.relay ? { relay: d.relay } : {}), answers: [] };
	file.next++;
	file.asks.push(ask);
	const open = file.asks.filter((a) => isOpen(a, now));
	for (const old of open.slice(0, Math.max(0, open.length - ASK_CAP))) old.closed = true;
	save(slot, file);
	return ask;
}
/** Records an answer on an open ask of `workspace`; undefined when there is no such open ask (another workspace's, expired, closed, or unknown). */
export function answerAsk(slot: Slot, now: number, d: { id: string; workspace: string; text: string }): HeadAsk | undefined {
	const file = load(slot), ask = file.asks.find((a) => a.id === d.id);
	if (!ask || ask.workspace !== d.workspace || !isOpen(ask, now)) return undefined;
	ask.answers.push({ at: now, first: line(d.text) });
	ask.last = now;
	save(slot, file);
	return ask;
}
/** Closes an ask: the forward it was opened for was not delivered. */
export function closeAsk(slot: Slot, id: string): void {
	const file = load(slot), ask = file.asks.find((a) => a.id === id);
	if (!ask) return;
	ask.closed = true;
	save(slot, file);
}
/** Whether `id` is an open ask to `workspace`. */
export const asked = (slot: Slot, now: number, workspace: string, id: string): boolean => openAsks(slot, now).some((a) => a.id === id && a.workspace === workspace);
