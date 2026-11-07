import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { DocCard } from "../src/documents.ts";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// A document card's Markdown document draws its blocks with pi-better-show's elements in the page itself (no frame), at the comfortable density; an HTML document keeps its sandboxed frame. An answer from a block goes to the
// document's answer route (the v1 form path behind it), and the element locks once the owner took it. A review's image resolves only through the document's own capability route.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { docHooks, docTile } = await import("../gui/doc.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");
const { DEMO_BLOCKS_DOC } = await import("../gui/demo-blocks.ts");
type Posted = { ok: boolean; status: number; body: Record<string, unknown> };
type Locked = El & { answered?: unknown; data?: { items?: { image?: string }[] } };

const card = (display: string, extra: Partial<DocCard> = {}): DocCard => ({ cap: "c".repeat(32), display, kind: display.endsWith(".html") ? "html" : "text", reason: "Plan ready", revision: 1, onScreen: true, ...extra });
const posts: [string, Record<string, unknown>][] = [];
let reply: Posted = { ok: true, status: 200, body: { accepted: true } };
beforeEach(() => {
	stored.clear();
	posts.length = 0;
	reply = { ok: true, status: 200, body: { accepted: true } };
	docHooks.load = async () => ({ text: DEMO_BLOCKS_DOC });
	docHooks.post = async (path, body) => (posts.push([path, body]), reply);
});
const tiles: { closed?(): void }[] = [];
afterEach(() => tiles.splice(0).forEach((t) => t.closed?.())); // a tile stays open by its capability until it is closed
const open = async (c: DocCard) => {
	const tile = docTile("billing-main", c), root = tile.body() as unknown as El;
	tiles.push(tile);
	await whenDrawn();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await whenDrawn();
	return root;
};
const fire = (el: El, answer: unknown) => {
	for (const on of el.handlers["pbs-answer"] ?? []) on({ type: "pbs-answer", detail: answer, preventDefault() {} });
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await whenDrawn(); };

test("a Markdown document draws every block kind with its element, in the page, at the comfortable density, and with no frame", async () => {
	const root = await open(card("docs/plan.md"));
	assert.deepEqual(root.find((el) => el.tagName.startsWith("pbs-")).map((el) => el.tagName), ["pbs-callout", "pbs-callout", "pbs-cards", "pbs-options", "pbs-form", "pbs-review", "pbs-mindmap", "pbs-suggest", "pbs-checklist", "pbs-table", "pbs-steps", "pbs-stats", "pbs-diff", "pbs-diagram"]);
	for (const el of root.find((el) => el.tagName.startsWith("pbs-"))) assert.equal(el.getAttribute("density"), "comfortable", el.tagName);
	assert.equal(root.find((el) => el.tagName === "iframe").length, 0);
});

test("a document with no block is the page's own Markdown as before, and a plain-text document stays text", async () => {
	docHooks.load = async () => ({ text: "# Notes\n\nplain **text**" });
	const md = await open(card("docs/notes.md"));
	assert.equal(md.find((el) => el.tagName.startsWith("pbs-")).length, 0);
	assert.equal(md.find((el) => el.tagName === "h1")[0]?.textContent, "Notes");
	docHooks.load = async () => ({ text: "```form\nquestions: []\n```" });
	const txt = await open(card("docs/notes.txt", { cap: "d".repeat(32) }));
	assert.equal(txt.find((el) => el.tagName.startsWith("pbs-")).length, 0, "a .txt document is not Markdown");
	assert.equal(txt.find((el) => el.className === "doc-pre").length, 1);
});

test("an HTML document keeps its sandboxed frame", async () => {
	const root = await open(card("docs/review.html"));
	const frame = root.find((el) => el.tagName === "iframe")[0]!;
	assert.match(frame.getAttribute("sandbox") ?? "", /allow-forms/);
	assert.ok(!/allow-scripts/.test(frame.getAttribute("sandbox") ?? ""));
	assert.equal(root.find((el) => el.tagName.startsWith("pbs-")).length, 0);
});

test("an answer from a block goes to the document's answer route as v1 fields, and the element locks once the owner took it", async () => {
	const root = await open(card("docs/plan.md"));
	const form = root.find((el) => el.tagName === "pbs-form")[0] as Locked;
	fire(form, { kind: "form", title: "Decide the store", fields: [["store", "SQLite"], ["why", "simple"]], ref: { block: 4 } });
	await settle();
	assert.equal(posts.length, 1);
	assert.equal(posts[0]![0], `doc/${"c".repeat(32)}/answer`);
	assert.deepEqual((posts[0]![1] as { fields: unknown }).fields, [["store", "SQLite"], ["why", "simple"]]);
	assert.match(String(posts[0]![1].answerId), /^[A-Za-z0-9_-]{16,64}$/);
	assert.deepEqual(form.answered, [["store", "SQLite"], ["why", "simple"]]);
	const review = root.find((el) => el.tagName === "pbs-review")[0] as Locked;
	fire(review, { kind: "review", fields: [["title", "Landing page"], ["picked", "A"], ["item", "A"], ["comment", "ok"]] });
	await settle();
	assert.deepEqual((posts[1]![1] as { fields: unknown[] }).fields[0], ["pi-kind", "review"], "a review goes out under its kind");
});

test("a document the session no longer shows refuses the answer, the element stays open, and the reason is under it", async () => {
	reply = { ok: false, status: 409, body: { error: "closed", reason: "The document is no longer open in its session." } };
	const root = await open(card("docs/plan.md"));
	const chips = root.find((el) => el.tagName === "pbs-suggest")[0] as Locked;
	fire(chips, { kind: "suggest", fields: [["text", "Go ahead"]] });
	await settle();
	assert.equal(chips.answered, undefined);
	assert.ok(root.find((el) => el.className === "pbs-note").some((el) => /no longer open/.test(el.textContent)));
});

test("a review item's image resolves only through the document's own capability route, never as a URL the author wrote", async () => {
	const root = await open(card("docs/plan.md"));
	const review = root.find((el) => el.tagName === "pbs-review")[0] as Locked;
	assert.deepEqual(review.data!.items!.map((i) => i.image), [`doc/${"c".repeat(32)}/a.svg`, `doc/${"c".repeat(32)}/b.svg`, undefined]);
	docHooks.load = async () => ({ text: "```review\nitems:\n  - {name: A, image: 'https://evil.example/x.png'}\n  - {name: B, image: '../secret.png'}\n  - {name: C, image: 'data:image/svg+xml;base64,AAAA'}\n  - {name: D, image: 'sub/dir/ok.png'}\n```" });
	const other = await open(card("docs/other.md", { cap: "e".repeat(32) }));
	assert.deepEqual((other.find((el) => el.tagName === "pbs-review")[0] as Locked).data!.items!.map((i) => i.image), [undefined, undefined, undefined, `doc/${"e".repeat(32)}/sub/dir/ok.png`]);
});
