import { type Answer, type BlockSegment, encodeAnswer, type InvalidSegment, parse } from "pi-better-show";
import { configure, type PbsElement, TAGS } from "pi-better-show/elements";
import type { Delivery } from "./blockanswer.ts";
import { type BlockLock, lockFor } from "./blocklock.ts";
import { h } from "./dom.ts";
import { mount, parse as markdown } from "./markdown.ts";
import { m } from "./paraglide/messages.js";

// The page's drawing of pi-better-show's blocks (docs/specs/2026-11-07-better-show-host.md), a lazy chunk (blockschunk.ts): the text is split by the package's parser, prose is the page's own Markdown (markdown.ts), each block is the
// element of its kind fed with the block's data (never markup: the elements build text nodes), and a block that does not parse shows its source in code. An element's answer is handed to the host, which delivers it and only then locks the
// element with the fields that went (`answered`); a refusal leaves it open with the reason under it. What a block can name is the host's to resolve: an image only through `image`, and a page, a diagram, or a link target never.

export interface BlockHost {
	density: "compact" | "comfortable";
	/** The document the blocks are in, as an answer's `ref` names it. */
	doc?: string;
	/** What keeps an answer locked across a reload (blocklock.ts): a chat message's session and entry, a document's capability and revision. Without it nothing is kept. */
	scope?: string[];
	/** The URL the page may load for a review item's `image`, or none: only the host's own route (a document's capability), never what the author wrote. */
	image?(ref: string): string | undefined;
	/** Delivers an answer: `text` is what the agent reads (`encodeAnswer`). */
	send(answer: Answer, text: string): Promise<Delivery>;
}

// The URLs the host resolved are the only ones an element may load: the package's default admits any http(s) or data image.
const resolved = new Set<string>();
configure({ imageUrl: (ref) => (resolved.has(ref) ? ref : undefined) });

/** The block's data as the element gets it: a review item's `image` goes through the host, or goes. */
function dataOf(seg: BlockSegment, host: BlockHost): unknown {
	if (seg.kind !== "review") return seg.data;
	return { ...seg.data, items: seg.data.items.map(({ image, ...item }) => {
		const url = image === undefined ? undefined : host.image?.(image);
		if (url !== undefined) resolved.add(url);
		return url === undefined ? item : { ...item, image: url };
	}) };
}

function block(seg: BlockSegment, host: BlockHost): HTMLElement {
	const el = document.createElement(TAGS[seg.kind]) as PbsElement, lock: BlockLock | undefined = host.scope && lockFor(...host.scope);
	const note = h("p", { class: "pbs-note", role: "status", "aria-live": "polite" });
	el.setAttribute("density", host.density);
	el.ref = host.doc === undefined ? { block: seg.index } : { doc: host.doc, block: seg.index };
	el.data = dataOf(seg, host);
	const kept = lock?.get(seg.index);
	if (kept) el.answered = kept;
	let sending = false;
	el.addEventListener("pbs-answer", (event) => {
		const answer = (event as CustomEvent<Answer>).detail;
		event.preventDefault(); // the host takes the answer: the element stays open until the owner has it
		if (sending) return;
		sending = true;
		note.textContent = m.block_sending();
		delete note.dataset.tone;
		void host.send(answer, encodeAnswer(answer)).catch((): Delivery => ({ ok: false, reason: m.unsure() })).then((r) => {
			sending = false;
			note.textContent = r.ok ? "" : r.reason;
			if (r.ok) delete note.dataset.tone; else note.dataset.tone = "error";
			if (!r.ok) return;
			lock?.set(seg.index, answer.fields);
			el.answered = answer.fields;
		});
	});
	return h("div", { class: "pbs-block", "data-kind": seg.kind }, el, note);
}

const invalid = (seg: InvalidSegment) => h("pre", { class: "pbs-invalid", title: `${seg.kind}: ${seg.error}` }, h("code", { "data-lang": seg.kind }, seg.source));

/** Replaces the children of `into` with `text` drawn: prose, blocks, and the source of what is not a block. */
export function drawBlocks(into: HTMLElement, text: string, host: BlockHost) {
	into.replaceChildren(...parse(text).map((seg) => (seg.type === "markdown" ? mount(markdown(seg.text)) : seg.type === "invalid" ? invalid(seg) : block(seg, host))));
}
