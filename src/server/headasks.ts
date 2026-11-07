import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fieldsOf } from "../header.ts";
import { headId, type Slot } from "./record.ts";
import { ensureDir, HEAD_KEY, towerDir, writeDurable } from "./towerstore.ts";

// The head tower's asks (docs/specs/2026-11-04-head-tower.md, Forwarding, and the answers): each forward to a workspace tower opens an ask `H<n>` in `head/asks.json`. An ask stays open for 24 hours after its last forward or
// answer, at most 40 are open (opening one more closes the oldest), and the head's gate takes an answer only for an open ask to the workspace its sender is the tower of. The file is the boss's: it survives a close of the head.

/** How long an ask stays open after its last forward or answer, and how many may be open at once. */
export const ASK_OPEN_MS = 24 * 3_600_000;
export const ASK_CAP = 40;
/** Closed and expired asks stay in the file for the brief and the page; the oldest beyond this go. */
const ASK_KEEP = 100;
const FIRST = 120;
/** The most of the head's message, and of the boss's words, an ask keeps whole for the card that unfolds (docs/specs/2026-11-07-head-log-cards.md): the page draws every kept ask of a snapshot, so the text is cut here, not at the page. */
const TEXT_KEEP = 1500;
/** The head has no broadcast tool, so one boss instruction is several `tower_send` calls: asks with one `relay` are one broadcast; asks with none (before the relay existed, the head's own notes) are one when they have the same first line, each within this long of the newest member before it. */
export const GROUP_MS = 60_000;

export interface HeadAnswer { at: number; first: string }
export interface HeadAsk {
	id: string;
	workspace: string;
	label: string;
	/** When it was opened, and when it last saw a forward or an answer (the 24 hours count from there). */
	at: number;
	last: number;
	first: string;
	/** The message the head sent, whole (cut at `TEXT_KEEP`); a file from before it has none, and the page shows `first`. */
	sent?: string;
	/** The boss's own words of the event `relay` names, kept on the first ask of the broadcast only (every ask of one instruction has the same); never the model's text. */
	boss?: string;
	/** The earlier ask (`H<n>`) the head named as the one this correction replaces; the page folds that broadcast under this one. */
	supersedes?: string;
	/** When the tower of the workspace took the message into a run (`read`), and when it first sent something in a turn that message started (`acted`): what the server saw of the tower, whatever the tower answered. */
	read?: number;
	acted?: number;
	/** `boss:<event id>`: the forward was the boss's instruction relayed. */
	relay?: string;
	/** The id of the first ask of the broadcast this one belongs to (docs/specs/2026-11-06-head-page-minimal.md); a file from before it has none, and `groupsOf` derives it. */
	group?: string;
	/** The head's cap closed it before its time. */
	closed?: true;
	answers: HeadAnswer[];
}
interface File { next: number; asks: HeadAsk[] }

const fileOf = (slot: Slot) => join(towerDir(slot, HEAD_KEY), "asks.json");
const cut = (text: string | undefined) => { const t = (text ?? "").trim(); return t ? Array.from(t).slice(0, TEXT_KEEP).join("") : undefined; };
const line = (text: string) => Array.from(text.split("\n").find((l) => l.trim()) ?? "").join("").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, FIRST);
const valid = (a: unknown): a is HeadAsk => {
	const v = a as Partial<HeadAsk> | null;
	return typeof v === "object" && v !== null && typeof v.id === "string" && /^H\d+$/.test(v.id) && typeof v.workspace === "string" && typeof v.label === "string" && Number.isFinite(v.at) && Number.isFinite(v.last) && typeof v.first === "string" && Array.isArray(v.answers);
};
function load(slot: Slot): File {
	try {
		const f = JSON.parse(readFileSync(fileOf(slot), "utf8")) as Partial<File>;
		const asks = Array.isArray(f.asks) ? f.asks.filter(valid).map((a) => (typeof a.group === "string" ? a : (({ group: _g, ...rest }) => rest)(a))) : [];
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

/**
 * The group of each ask by id, oldest first: the recorded one, else (an ask from before the field) by the broadcast it belongs to. An ask with a `relay` joins the newest earlier ask of the same relay (one boss instruction is one `relay`, however the head tailored its text per tower);
 * an ask without one (a file from before the relay, the head's own notes) joins the newest earlier unrelayed ask with the same first line that is 0 to `GROUP_MS` before it (a prior `at` in the future, from clock skew, is no member); otherwise it is its own group.
 */
export function groupsOf(asks: HeadAsk[]): Map<string, string> {
	const out = new Map<string, string>(), byRelay = new Map<string, string>(), byFirst = new Map<string, { group: string; at: number }>();
	for (const a of asks) {
		const near = byFirst.get(a.first), group = a.group ?? (a.relay ? byRelay.get(a.relay) : near && a.at - near.at >= 0 && a.at - near.at < GROUP_MS ? near.group : undefined) ?? a.id;
		out.set(a.id, group);
		if (a.relay) byRelay.set(a.relay, group);
		else byFirst.set(a.first, { group, at: a.at });
	}
	return out;
}

/** Every ask in the file, oldest first, open or not. */
export const readAsks = (slot: Slot, _now: number): HeadAsk[] => load(slot).asks;
/** The asks that are open now, oldest first. */
export const openAsks = (slot: Slot, now: number): HeadAsk[] => load(slot).asks.filter((a) => isOpen(a, now));

/**
 * Opens an ask for a forward; the 41st open ask closes the oldest open one. `first` is the message: its first line and the whole of it (`sent`) are kept. `boss` is the boss's words (the first ask of a relayed broadcast keeps them),
 * `supersedes` the earlier ask this one corrects: it has to be an `H<n>` of the file and older than this ask, or the call throws and opens nothing.
 */
export function openAsk(slot: Slot, now: number, d: { workspace: string; label: string; first: string; relay?: string; boss?: string; supersedes?: string }): HeadAsk {
	const file = load(slot), id = `H${file.next}`;
	if (d.supersedes !== undefined && !(/^H\d+$/.test(d.supersedes) && Number(d.supersedes.slice(1)) < file.next && file.asks.some((a) => a.id === d.supersedes))) throw new Error(`supersedes has to be the id (H12) of an earlier ask you sent; ${JSON.stringify(d.supersedes)} is not one`);
	const sent = cut(d.first), ask: HeadAsk = { id, workspace: d.workspace, label: d.label, at: now, last: now, first: line(d.first), ...(sent ? { sent } : {}), ...(d.relay ? { relay: d.relay } : {}), ...(d.supersedes ? { supersedes: d.supersedes } : {}), answers: [] };
	ask.group = groupsOf([...file.asks, ask]).get(id)!;
	const boss = ask.group === id ? cut(d.boss) : undefined;
	if (boss) ask.boss = boss;
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
/**
 * Records what the server saw the tower of `workspace` do with the ask: it `read` it (a run took the message) or `acted` (it sent something in the turn the message started; acting is reading). The ask's 24 hours do not move.
 * False for an ask that is not there or is another workspace's.
 */
export function noteAsk(slot: Slot, now: number, d: { id: string; workspace: string; what: "read" | "acted" }): boolean {
	const file = load(slot), ask = file.asks.find((a) => a.id === d.id);
	if (!ask || ask.workspace !== d.workspace) return false;
	if (ask.read !== undefined && (d.what === "read" || ask.acted !== undefined)) return true;
	ask.read ??= now;
	if (d.what === "acted") ask.acted ??= now;
	save(slot, file);
	return true;
}
/**
 * What a workspace tower did with an event in its queue, noted on the head's ask the event carries: only an event the head identity sent (`from`), whose header names an `ask=H<n>` of this workspace, counts; the header of anyone else's
 * message is its sender's own word. Nothing happens for any other event, and nothing throws: a note must not break the run it is about.
 */
export function noteEvent(slot: Slot, now: number, workspace: string, event: { from?: { id: string }; text: string } | undefined, what: "read" | "acted"): void {
	try {
		const id = event?.from?.id === headId(slot) ? fieldsOf(event.text)?.ask : undefined;
		if (id && /^H\d+$/.test(id)) noteAsk(slot, now, { id, workspace, what });
	} catch { /* the ask is a convenience of the page */ }
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
