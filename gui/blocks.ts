import { type Answer, type BlockSegment, encodeAnswer, type InvalidSegment, inlinePlain, parse } from "pi-better-show";
import { configure, type PbsElement, TAGS } from "pi-better-show/elements";
import type { Delivery } from "./blockanswer.ts";
import { type Cell, lockFor } from "./blocklock.ts";
import { h } from "./dom.ts";
import { mount, parse as markdown } from "./markdown.ts";
import { m } from "./paraglide/messages.js";

// The page's drawing of pi-better-show's blocks (docs/specs/2026-11-07-better-show-host.md), a lazy chunk (blockschunk.ts): the text is split by the package's parser, prose is the page's own Markdown (markdown.ts), each block is the
// element of its kind fed with the block's data (never markup: the elements build text nodes), and a block that does not parse shows its source in code. An element's answer is handed to the host, which delivers it and only then locks the
// element with the fields that went (`answered`); a refusal leaves it open with the reason under it. While an answer is on its way every drawing of the block is locked (inert, "Sending…"): a redraw does not find it open. What a block can name is the host's to
// resolve: an image only through `image`, and a page, a diagram, or a link target never.

export interface BlockHost {
	density: "compact" | "comfortable";
	/** The document the blocks are in, as an answer's `ref` names it. */
	doc?: string;
	/** What the page's lock for these blocks is keyed by (blocklock.ts): a chat message's session and entry, a document's capability and the hash of its text. Without it nothing is kept across drawings. */
	scope?: string[];
	/** The URL the page may load for a review item's `image`, or none: only the host's own route (a document's capability), never what the author wrote. */
	image?(ref: string): string | undefined;
	/** Resolves once the server's record of answered blocks has been put into the page's locks (false: it could not be read). A host without one has nothing to read. */
	ready?(): Promise<boolean>;
	/** Delivers an answer: `text` is what the agent reads (`encodeAnswer`). */
	send(answer: Answer, text: string): Promise<Delivery>;
}

// The URLs the host resolved are the only ones an element may load: the package's default admits any http(s) or data image.
const resolved = new Set<string>();
configure({ imageUrl: (ref) => (resolved.has(ref) ? ref : undefined) });

/** Markdown's punctuation made literal, so that a chip shows a text as it is. */
const literal = (text: string) => text.replace(/[!-/:-@[-`{-~]/g, "\\$&");

/** The block's data as the element gets it: a review item's `image` goes through the host, or goes; a chip shows the text it sends, since what goes out under the boss's name must be what the boss saw (a label that reads as the text keeps its formatting). */
function dataOf(seg: BlockSegment, host: BlockHost): unknown {
	if (seg.kind === "suggest") return { ...seg.data, items: seg.data.items.map((item) => (inlinePlain(item.label) === item.text ? item : { ...item, label: literal(item.text) })) };
	if (seg.kind !== "review") return seg.data;
	return { ...seg.data, items: seg.data.items.map(({ image, ...item }) => {
		const url = image === undefined ? undefined : host.image?.(image);
		if (url !== undefined) resolved.add(url);
		return url === undefined ? item : { ...item, image: url };
	}) };
}

function block(seg: BlockSegment, host: BlockHost, known: boolean): HTMLElement {
	const el = document.createElement(TAGS[seg.kind]) as PbsElement, lock = lockFor(...(host.scope ?? [])), index = seg.index;
	const note = h("p", { class: "pbs-note", role: "status", "aria-live": "polite" }), wrap = h("div", { class: "pbs-block", "data-kind": seg.kind }, el, note);
	el.setAttribute("density", host.density);
	el.ref = host.doc === undefined ? { block: index } : { doc: host.doc, block: index };
	el.data = dataOf(seg, host);
	let sending = false;
	/** The note a state brings, unless the delivery that ended it has put its own words there. */
	const say = (text: string, tone?: string) => ((note.textContent = text), tone ? (note.dataset.tone = tone) : delete note.dataset.tone);
	const view = {
		show(cell: Cell) {
			wrap.toggleAttribute("inert", cell.state === "pending");
			if (cell.state === "done") el.answered = cell.fields;
			if (cell.state === "pending") say(m.block_sending());
			else if (!sending && (cell.state === "done" || note.textContent === m.block_sending())) say(cell.state === "open" && !known ? m.block_unsure_state() : "");
		},
	};
	lock.watch(index, view);
	say(known ? "" : m.block_unsure_state());
	view.show(lock.get(index));
	el.addEventListener("pbs-answer", (event) => {
		const sent = (event as CustomEvent<Answer>).detail, answer: Answer = { ...sent, ref: { ...sent.ref, block: index } }; // the block's address is the block's own, whatever the element says
		event.preventDefault(); // the host takes the answer: the element stays open until the owner has it
		if (sending || lock.get(index).state !== "open") return;
		sending = true;
		lock.pend(index);
		void host.send(answer, encodeAnswer(answer)).catch((): Delivery => ({ ok: false, reason: m.unsure() })).then((r) => {
			sending = false;
			if (r.ok) return lock.done(index, answer.fields);
			if (r.answered) lock.done(index, r.answered);
			else lock.cancel(index);
			say(r.reason, r.answered ? undefined : "error");
		});
	});
	return wrap;
}

const invalid = (seg: InvalidSegment) => h("pre", { class: "pbs-invalid", title: `${seg.kind}: ${seg.error}` }, h("code", { "data-lang": seg.kind }, seg.source));

/** Replaces the children of `into` with `text` drawn: prose, blocks, and the source of what is not a block. `known` is false when the server's record of answered blocks could not be read: the blocks are open, with a note that says so. */
export function drawBlocks(into: HTMLElement, text: string, host: BlockHost, known = true) {
	into.replaceChildren(...parse(text).map((seg) => (seg.type === "markdown" ? mount(markdown(seg.text)) : seg.type === "invalid" ? invalid(seg) : block(seg, host, known))));
}
