import type { BlockHost } from "./blocks.ts";
import { h } from "./dom.ts";
import { mount, parse } from "./markdown.ts";

// The body of a message or document that may carry pi-better-show blocks (docs/specs/2026-11-07-better-show-host.md). Prose is always the page's own Markdown (markdown.ts). A text that holds a block (a fence of a block kind, or a
// GitHub alert) is first drawn as that Markdown, so it reads at once and still reads if the block code never loads, and then drawn again with the blocks by their lazy chunk (blocks.ts, with its elements and stylesheet);
// a text without one never imports it.

/** The block kinds of pi-better-show's `BLOCK_KINDS` but `alert` (a test holds this list to the package's). */
const KINDS = "mermaid|diff|cards|options|form|review|mindmap|suggest|checklist|table|steps|stats|tree";
const FENCE = new RegExp(`^ {0,3}(?:\`{3,}|~{3,})[ \\t]*(?:${KINDS})(?=\\s|$)`, "im"), ALERT = /^ {0,3}> ?\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im;
/** Whether the block parser could find a block in `text`: a hint that may say yes for a text with none, never no for one with. */
export const hasBlocks = (text: string) => FENCE.test(text) || ALERT.test(text);

const drawing = new Set<Promise<unknown>>();
/** How many texts wait for the block code to draw them. */
const count = () => drawing.size;
/** Resolves when every text asked for so far is drawn (or failed to be): for tests and for a screenshot to wait on. */
const whenDrawn = async () => {
	while (drawing.size) await Promise.allSettled([...drawing]);
};
export { count as drawing, whenDrawn };

/** The `class` element holding `text`; with a `host` that says where its blocks' answers go, a text with blocks is redrawn with them once the block code is loaded. */
export function mdBody(text: string, cls: string, host?: BlockHost): HTMLElement {
	const body = h("div", { class: cls }, mount(parse(text)));
	if (host && hasBlocks(text)) {
		const job = import("./blockschunk.ts").then(async ({ drawBlocks }) => drawBlocks(body, text, host, host.ready ? await host.ready() : true)).catch(() => {}); // the Markdown above stays
		drawing.add(job);
		void job.finally(() => drawing.delete(job));
	}
	return body;
}
