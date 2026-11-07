import { randomBytes } from "node:crypto";
import type { Bus } from "./owners.ts";

// Document contract v1 (pi-herdr-doc-review ≥ 0.4.0, its README's "Browser viewers") and v2 (pi-better-show 0.1.0, its README's "Event bus, contract version 2"): the package that shows a session's documents (its
// owner) publishes the full list on pi's event bus at every change and delivers answers itself. The bridge (bridge.ts) relays the list with its dialogs; the hub (dialogs.ts) binds it to the unit with the dialog binding rule and gives each
// document a capability, 128 random bits per server; the page gets the capability and never a path; the server serves by it (docs.ts). A v1 document has a path on this computer's disk, which the server reads. A v2 document has none:
// its entry carries the URL of the owner's own page server (loopback only), from which the server fetches its text or page, and the directory URL its relative references resolve against.
// The v1 listener stays until pi-herdr-doc-review is archived.

export const LIST = "doc-review:documents", REQUEST = "doc-review:documents-request", FORM = "doc-review:form", RESULT = "doc-review:form-result";
export const LIST2 = "better-show:documents", REQUEST2 = "better-show:documents-request", ANSWER2 = "better-show:answer", RESULT2 = "better-show:answer-result";
const MAX_DOCS = 32, FORM_MS = 4000;
export const MAX_FIELDS = 64, MAX_ANSWER = 12 * 1024;
export type DocKind = "html" | "text" | "blocks";
/** `v: 2` marks a document of contract v2 (no path; `capability` and `assets` while its owner's page server runs); without it the document is v1 and has its `path`. */
export interface Doc { id: string; path?: string; kind: DocKind; display: string; reason: string; revision: number; onScreen: boolean; v?: 2; capability?: string; assets?: string }
/** A document as the page sees it: its capability instead of its path and owner id. `blocks` is a Markdown document the page draws with blocks (a v2 `blocks` document, or a v1 text document whose name is Markdown), `text` shows as text, `html` in a frame. */
export interface DocCard { cap: string; display: string; kind: DocKind; reason: string; revision: number; onScreen: boolean }
/** A unit's documents in the snapshot; `docsCut` when its list was too long to relay (they stay in the terminal). */
export interface Shelf { docs?: DocCard[]; docsCut?: true }
export interface FormResult { accepted: boolean; reason?: string }
export type Fields = [string, string][];
export type AnswerKind = "form" | "review" | "feedback" | "pick" | "suggest" | "checklist";
/** pi-better-show's `Answer`: what a block sends back, with the block's address. */
export interface BlockAnswer { kind: AnswerKind; title?: string; fields: Fields; ref?: { doc?: string; block: number } }

const MARKDOWN = /\.(md|markdown)$/i, KINDS: readonly AnswerKind[] = ["form", "review", "feedback", "pick", "suggest", "checklist"];
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/; // tab, newline, and CR (a textarea's line break) stay
/** What the page draws for a document. */
export const cardKind = (d: Doc): DocKind => (d.v === 2 ? d.kind : d.kind === "text" && MARKDOWN.test(d.display) ? "blocks" : d.kind);
/** Whether a document's blocks answer: a v2 `blocks` document (the package refuses a `text` one), or a v1 text document that is Markdown. */
export const isBlocksDoc = (d: Doc) => cardKind(d) === "blocks";

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
export const MAX_BLOCK = 4095;
/** The URL of a page server on this computer, or undefined: http, a loopback name with its port, a plain path with no empty, `.`, `..`, or encoded-slash segment, no credentials, query, or fragment. Returned as the URL parses. */
export function loopbackUrl(url: unknown): string | undefined {
	if (typeof url !== "string" || url.length > 512 || /[\\\s]|%2f|%5c/i.test(url) || /\/\.\.?(\/|$)/.test(url)) return;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return;
	}
	const parts = u.pathname.split("/").slice(1, -1);
	if (u.protocol !== "http:" || u.username || u.password || !u.port || u.search || u.hash || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || parts.some((part) => !part)) return;
	return u.href;
}
/** The owner's capability for document `id`, `<base>/doc/<id>/<name>`, and its assets directory, `<base>/doc/<id>/`: loopback URLs of one page server (one origin, one token). */
const pathOf = (url: string, id: string, file: boolean) => {
	const parts = new URL(url).pathname.split("/");
	return parts.length === 5 && parts[2] === "doc" && parts[3] === encodeURIComponent(id) && (file ? parts[4] !== "" : parts[4] === "") ? parts[1] : undefined;
};
const capabilityOf = (url: unknown, id: string) => { const ok = loopbackUrl(url); return ok && pathOf(ok, id, true) ? ok : undefined; };
const assetsOf = (url: unknown, id: string, capability?: string) => { const ok = loopbackUrl(url); return ok && pathOf(ok, id, false) && (!capability || (new URL(ok).origin === new URL(capability).origin && pathOf(ok, id, false) === pathOf(capability, id, true))) ? ok : undefined; };

type Raw = Record<string, unknown> | undefined;
/** The fields every entry has; its display and reason are cut to 1024 and 2048 characters (show_doc's reason has no limit), anything else out of shape refuses it. */
const headOf = (d: Raw, kinds: readonly string[]) => {
	if (!str(d?.id, 64) || !kinds.includes(d.kind as string) || typeof d.display !== "string" || typeof d.reason !== "string" || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1 || typeof d.onScreen !== "boolean") return;
	return { id: d.id, kind: d.kind as DocKind, display: d.display.slice(0, 1024), reason: d.reason.slice(0, 2048), revision: d.revision as number, onScreen: d.onScreen };
};
/** A v1 entry: a path on this computer's disk. */
const docOf1 = (d: Raw): Doc | undefined => {
	const head = headOf(d, ["html", "text"]);
	if (!head || !str(d?.path, 4096) || !d.path.startsWith("/")) return;
	return { id: head.id, path: d.path, kind: head.kind, display: head.display, reason: head.reason, revision: head.revision, onScreen: head.onScreen };
};
/** A v2 entry has no path. `strict` (the hub, reading a bridge's relay): a path, or a capability or assets that is not the owner's loopback server, refuses the entry. Otherwise (the bridge, reading the owner) a path is ignored and a capability or assets that is not it is dropped, and the document stays, unreachable. */
const docOf2 = (d: Raw, strict: boolean): Doc | undefined => {
	const head = headOf(d, ["blocks", "html", "text"]);
	if (!head || (strict && d?.path !== undefined)) return;
	const capability = d?.capability === undefined ? undefined : capabilityOf(d.capability, head.id);
	const assets = d?.assets === undefined ? undefined : assetsOf(d.assets, head.id, capability);
	if (strict && ((d?.capability !== undefined && !capability) || (d?.assets !== undefined && !assets))) return;
	return { ...head, v: 2, ...(capability ? { capability } : {}), ...(assets ? { assets } : {}) };
};
const listOf = (raw: unknown, version: number, entry: (d: Raw) => Doc | undefined): Doc[] | undefined => {
	const p = raw as { version?: unknown; documents?: unknown };
	if (p?.version !== version || !Array.isArray(p.documents) || p.documents.length > MAX_DOCS) return;
	const docs = p.documents.map((d) => entry(d as Raw));
	return docs.every(Boolean) && new Set(docs.map((d) => d!.id)).size === docs.length ? (docs as Doc[]) : undefined;
};
/** A list as the hub takes it from a bridge, `{version: 1, documents}` with v1 entries and v2 ones (marked `v: 2`), or undefined (another version or shape: a relay never guesses at one). Ids are unique. */
export const docsOf = (raw: unknown): Doc[] | undefined => listOf(raw, 1, (d) => (d?.v === undefined ? docOf1(d) : d.v === 2 ? docOf2(d, true) : undefined));
export const fieldsOk = (f: unknown): f is Fields => Array.isArray(f) && f.length <= MAX_FIELDS && f.every((x) => Array.isArray(x) && x.length === 2 && x.every((s) => typeof s === "string"));

/** An answer as the owner takes it: one of the six kinds, a title, at most 64 text fields under 12 KB with no control character but a line break and a tab, and the block's address. */
export function answerOk(a: unknown): a is BlockAnswer {
	if (typeof a !== "object" || a === null) return false;
	const { kind, title, fields, ref } = a as Record<string, unknown>;
	if (!KINDS.includes(kind as AnswerKind) || (title !== undefined && !str(title, 1024)) || !fieldsOk(fields) || fields.some(([name, value]) => CONTROL.test(name) || CONTROL.test(value)) || Buffer.byteLength(JSON.stringify(fields)) > MAX_ANSWER) return false;
	if (ref === undefined) return true;
	const { doc, block } = (ref ?? {}) as Record<string, unknown>;
	return typeof ref === "object" && ref !== null && Number.isInteger(block) && (block as number) >= 0 && (block as number) <= MAX_BLOCK && (doc === undefined || str(doc, 1024));
}
/** The Answer of an HTML document's form: its `pi-kind` field, when it says review or page feedback, is the kind, and is not a field. */
export function answerOfFields(fields: Fields): BlockAnswer {
	const kind = fields.find(([name]) => name === "pi-kind")?.[1];
	return { kind: kind === "review" || kind === "feedback" ? kind : "form", fields: fields.filter(([name]) => name !== "pi-kind") };
}

/** The owners' lists as they change: v1 (`doc-review:documents`) and v2 (`better-show:documents`) are held apart and relayed together, v1 first, the newest 32 when together they pass the hub's limit (each owner lists oldest first; a hub that takes none of an over-long list would hide them all). A list out of shape counts as none for its own version, so an older list never stays; a list on the wrong channel for its version is not heard. A viewer that starts late asks each owner for its list once. */
export function listenDocs(bus: Bus, list: (docs: Doc[]) => void): () => void {
	let one: Doc[] = [], two: Doc[] = [];
	const relay = () => {
		const seen = new Set<string>();
		list([...one, ...two].filter((d) => !seen.has(d.id) && seen.add(d.id)).slice(-MAX_DOCS));
	};
	const off1 = bus.on(LIST, (raw) => (raw as { version?: unknown })?.version === 1 && ((one = listOf(raw, 1, docOf1) ?? []), relay()));
	const off2 = bus.on(LIST2, (raw) => (raw as { version?: unknown })?.version === 2 && ((two = listOf(raw, 2, (d) => docOf2(d, false)) ?? []), relay()));
	bus.emit(REQUEST, { version: 1 });
	bus.emit(REQUEST2, { version: 2 });
	return () => (off1(), off2());
}
/** Hands one form answer to the owner and reports its result once (nothing when the owner stays silent for 4 s). */
export function submitForm(bus: Bus, id: string, answerId: string, fields: Fields, done: (r: FormResult) => void) {
	let finished = false;
	const finish = (r?: FormResult) => (finished || ((finished = true), off(), clearTimeout(timer), r && done(r)));
	const off = bus.on(RESULT, (raw) => {
		const r = raw as { version?: unknown; id?: unknown; answerId?: unknown; accepted?: unknown; reason?: unknown };
		if (r?.version === 1 && r.id === id && r.answerId === answerId && typeof r.accepted === "boolean") finish({ accepted: r.accepted, ...(str(r.reason, 512) ? { reason: r.reason } : {}) });
	});
	const timer = setTimeout(finish, FORM_MS);
	timer.unref?.();
	bus.emit(FORM, { version: 1, id, answerId, fields });
}

/** Hands one answer to a v2 owner (`better-show:answer`) and reports its result once (nothing when the owner stays silent for 4 s). */
export function submitAnswer(bus: Bus, id: string, answerId: string, answer: BlockAnswer, done: (r: FormResult) => void) {
	let finished = false;
	const finish = (r?: FormResult) => (finished || ((finished = true), off(), clearTimeout(timer), r && done(r)));
	const off = bus.on(RESULT2, (raw) => {
		const r = raw as { version?: unknown; id?: unknown; answerId?: unknown; accepted?: unknown; reason?: unknown };
		if (r?.version === 2 && r.id === id && r.answerId === answerId && typeof r.accepted === "boolean") finish({ accepted: r.accepted, ...(str(r.reason, 512) ? { reason: r.reason } : {}) });
	});
	const timer = setTimeout(finish, FORM_MS);
	timer.unref?.();
	bus.emit(ANSWER2, { version: 2, id, answerId, answer });
}

/** The hub's capabilities: one per (session, bridge, document) while its bridge lists that document, new for every server (`clear`). A list cut
 *  for size lists nothing meanwhile, so its documents get new capabilities when they fit again. */
export function createCaps() {
	let caps = new Map<string, string>(), held = new Map<string, { key: string; from: string; bridgeId: string; id: string }>();
	return {
		/** One reading: each bound unit's lists by key; `listed` holds `from\nbridgeId\nid` of every relayed document, and a capability not in it goes. */
		bind(units: { key: string; from: string; bridgeId: string; docs: Doc[] }[], listed: Set<string>): Map<string, DocCard[]> {
			const cards = new Map<string, DocCard[]>();
			for (const k of caps.keys()) if (!listed.has(k)) caps.delete(k);
			held = new Map();
			for (const { key, from, bridgeId, docs } of units)
				cards.set(key, docs.map((d) => {
					const { id, display, reason, revision, onScreen } = d, k = `${from}\n${bridgeId}\n${id}`, cap = caps.get(k) ?? randomBytes(16).toString("hex");
					caps.set(k, cap);
					held.set(cap, { key, from, bridgeId, id });
					return { cap, display, kind: cardKind(d), reason, revision, onScreen };
				}));
			return cards;
		},
		find: (cap: string) => held.get(cap),
		clear: () => ((caps = new Map()), (held = new Map())),
	};
}
