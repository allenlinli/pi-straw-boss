import type { DocCard } from "../src/documents.ts";
import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { iconRef } from "./icons.ts";
import type { Tile } from "./layer.ts";
import { deliverToDoc } from "./blockanswer.ts";
import { type Fields, lockFor } from "./blocklock.ts";
import { mdBody } from "./mdbody.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";
import { unitsOf } from "./units.ts";

// The documents a session shows (show_doc, or a Mini SDD folder opening on its own), served by capability (src/docs.ts). An HTML document is a
// tile with a frame sandboxed twice, by its attribute here and by the server's policy: no scripts and an opaque origin, its CSS, images, and
// fonts from its own directory, links in a new tab, and its pi-answer form answered through the owner. A text document renders read only, as
// markdown for .md and as plain text otherwise. A new revision reloads a tile that shows and marks a hidden one until it shows. The page never
// sees a path: show_doc cards and the dossier find a document by its display name. `docHooks` is the dev fixture's stand-in for the server.

export const SANDBOX = "allow-forms allow-popups allow-popups-to-escape-sandbox";
export interface Loaded { text: string; /** The hash of the text, which an answer names (src/docs.ts). */ rev?: string; /** What the server's record says of the document's blocks. */ answered?: { done: [number, Fields][]; pending: number[]; unreadable?: boolean } }
export const docHooks: { src?(cap: string): string; load?(cap: string): Promise<Loaded | undefined>; post?(path: string, body: Record<string, unknown>): ReturnType<typeof post>; image?(cap: string, ref: string): string | undefined } = {};
type Open = { card: DocCard; tile: Tile; loaded: number; seq: number; failed?: boolean; shown: boolean; gone: boolean; body: HTMLElement; state: HTMLElement; off: HTMLElement; frame?: HTMLIFrameElement };
const open = new Map<string, Open>();

/** A path folded the way show_doc resolves it against the session's directory, so a call's path and a document's display compare. */
export function resolvePath(path: string, cwd = "") {
	const out: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) if (part === "..") out.pop(); else if (part && part !== ".") out.push(part);
	return `/${out.join("/")}`;
}
/** The listed document a show_doc path names. */
export const docFor = (cards: DocCard[] | undefined, cwd: string | undefined, path: string) => cards?.find((c) => resolvePath(c.display, cwd) === resolvePath(path, cwd));
/** What arrived since the unit's last snapshot (none the first time a unit is seen); `seen` keeps each unit's display names, which outlive
 *  a capability a restarted server or bridge mints afresh. */
export function arrivals(seen: Map<string, Set<string>>, key: string, cards: DocCard[] = []) {
	const known = seen.get(key);
	seen.set(key, new Set(cards.map((c) => c.display)));
	return known ? cards.filter((c) => !known.has(c.display)) : [];
}

/** A Markdown document's blocks (docs/specs/2026-11-07-better-show-host.md): comfortable, answered on the document's own route, locked for this text (its hash: an edit opens the blocks again), and a review's images only from the document's capability route (src/docs.ts serves a Markdown document's images). A name is any letters, digits, and `_ .@+-`, as the server serves; no separator but `/` between folders, and `.` and `..` never. */
const SAFE_IMAGE = /^(?!\/)(?:[\p{L}\p{N}_ .@+-]+\/)*[\p{L}\p{N}_ .@+-]+\.(?:png|jpe?g|gif|webp|svg)$/iu;
const docHost = (cap: string, rev: string, known: boolean) => ({
	density: "comfortable" as const,
	doc: cap,
	scope: ["doc", cap, rev],
	ready: async () => known,
	image: (ref: string) => (SAFE_IMAGE.test(ref) && !ref.split("/").some((part) => part === ".." || part === ".") ? (docHooks.image?.(cap, ref) ?? `doc/${encodeURIComponent(cap)}/${ref.split("/").map(encodeURIComponent).join("/")}`) : undefined),
	send: (answer: Parameters<ReturnType<typeof deliverToDoc>>[0]) => deliverToDoc((path, body) => (docHooks.post ?? post)(path, body), cap, rev)(answer),
});

/** The document's Markdown with its blocks, locked as the server's record says (it comes with the text) for this text. */
function drawn(cap: string, { text, rev = "", answered }: Loaded) {
	if (answered) lockFor("doc", cap, rev).seed({ done: answered.done, pending: answered.pending });
	return mdBody(text, "md", docHost(cap, rev, !answered?.unreadable));
}
const say = (o: Open, text: string, tone = "") => ((o.state.dataset.tone = tone), (o.state.textContent = text));
const fail = (o: Open, text: string) => ((o.failed = true), say(o, text, "error")); // it loads again when it next shows
const src = (cap: string) => docHooks.src?.(cap) ?? `doc/${encodeURIComponent(cap)}/`;
function load(o: Open) {
	[o.loaded, o.failed] = [o.card.revision, false];
	say(o, "");
	if (o.frame) return void (o.frame.src = src(o.card.cap));
	const cap = o.card.cap, blocks = o.card.kind === "blocks", seq = ++o.seq; // only the latest load lands
	void (docHooks.load?.(cap) ?? fetch(`api/doc/${encodeURIComponent(cap)}`, { cache: "no-store" }).then((r) => (r.ok ? (r.json() as Promise<Loaded>) : undefined))).then(
		(d) => o.seq !== seq || (d ? o.body.replaceChildren(blocks ? drawn(cap, d) : h("pre", { class: "doc-pre" }, d.text)) : fail(o, m.doc_gone())),
		() => o.seq !== seq || fail(o, m.unreachable()),
	);
}

/** The tile of a document (the open one when it is open already); `unit` names its session in the title. */
export function docTile(unit: string, card: DocCard): Tile {
	const had = open.get(card.cap);
	if (had) return had.tile;
	const name = card.display.split("/").pop() || card.display, frame = card.kind === "html" ? h("iframe", { class: "doc-frame", sandbox: SANDBOX, referrerpolicy: "no-referrer", title: m.shown_by({ display: card.display, unit }) }) : undefined;
	const reload = h("button", { type: "button", class: "cmp-link" }, m.reload()), tab = frame && h("a", { class: "cmp-link", href: src(card.cap), target: "_blank", rel: "noopener noreferrer" }, m.open_new_tab());
	const body = frame ?? h("div", { class: "doc-text" }, h("p", { class: "chat-empty" }, m.loading())), state = h("span", { class: "term-state", role: "status" }), off = h("em", { class: "doc-off" }, m.off_screen());
	const wrap = h("div", { class: "doc-tile" }, h("div", { class: "term-bar doc-bar" }, h("span", { class: "doc-why" }, card.reason), off, state, h("span", { class: "doc-acts" }, reload, tab)), body);
	const io = new IntersectionObserver(([e]) => ((o.shown = Boolean(e?.isIntersecting)), o.shown && !o.gone && (o.failed || o.loaded !== o.card.revision) && load(o)));
	const tile: Tile = { id: `doc:${card.cap}`, title: `${name} · ${unit}`, path: card.display, body: () => wrap, closed: () => (open.delete(card.cap), io.disconnect()) };
	const o: Open = { card, tile, loaded: 0, seq: 0, shown: false, gone: false, body, state, off, ...(frame && { frame }) };
	reload.onclick = () => !o.gone && load(o);
	off.hidden = card.onScreen;
	// A revision that came while the tile was hidden (another tab of tiles, a narrow window) loads when it shows.
	io.observe(wrap);
	load(o);
	open.set(card.cap, o);
	return tile;
}

/** Every snapshot: a document that arrives for the unit whose comms are open (`at`) opens beside them without focus; elsewhere it only shows on the unit. */
export function shelve(net: Net, seen: Map<string, Set<string>>, at: string | undefined, arrive: (unit: string, card: DocCard) => void) {
	const cards = new Map<string, DocCard>(), keys = new Set<string>();
	for (const { unit: u } of unitsOf(net)) {
		for (const c of u.docs ?? []) cards.set(c.cap, c);
		for (const c of arrivals(seen, u.key, u.docs)) if (u.key === at) arrive(u.name, c);
		keys.add(u.key);
	}
	for (const k of seen.keys()) if (!keys.has(k)) seen.delete(k); // a unit that left: seen afresh when it comes back
	refreshDocs(cards);
}

/** Every listed document by capability: open tiles follow revisions and the terminal pane, and say when their document is gone. */
export function refreshDocs(cards: Map<string, DocCard>) {
	for (const o of open.values()) {
		const c = cards.get(o.card.cap);
		if (!c) {
			if (!o.gone) say(o, m.doc_unlisted(), "error");
			o.gone = true;
			continue;
		}
		const back = o.gone && (say(o, ""), o.failed); // listed again after a failed load: it loads again
		[o.card, o.gone, o.off.hidden] = [c, false, c.onScreen];
		if (c.revision === o.loaded && !back) continue;
		if (o.shown) load(o);
		else if (c.revision !== o.loaded) say(o, m.doc_updated());
	}
}

/** The list row's role icon (iconRef `doc`), drawn by a view that has art for it (raven.css); Standard draws its paper sheet in the row's background and hides this. */
function docIcon(): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
	svg.setAttribute("class", "d-doc-ico"), svg.setAttribute("aria-hidden", "true");
	use.dataset.icon = "doc", use.setAttribute("href", iconRef("doc"));
	svg.append(use);
	return svg;
}
/** The dossier's list of a unit's documents; a click opens one beside the comms. */
export function docList(root: HTMLElement, cards: DocCard[] | undefined, cut: boolean | undefined, show: (card: DocCard) => void) {
	root.hidden = !cards?.length && !cut;
	root.querySelector(".d-doc-list")!.replaceChildren(...(cards ?? []).map((c) => {
		const b = h("button", { type: "button", class: "d-doc", title: c.reason }, docIcon(), h("b", null, c.display), h("small", null, c.onScreen ? c.reason : m.off_screen_short({ reason: c.reason })));
		b.onclick = () => show(c);
		return b;
	}));
	root.querySelector<HTMLElement>(".d-docs-cut")!.hidden = !cut;
}
