import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// pi-better-show's blocks as the page draws them (gui/blocks.ts, the lazy chunk): one element per block kind fed with the block's data, prose through the page's own Markdown, a block that does not parse as its source in code,
// the answer from an element handed to the host (which locks the element once the answer is delivered), and nothing from a block ever becoming markup.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { drawBlocks } = await import("../gui/blocks.ts");
const { DEMO_BLOCKS_DOC } = await import("../gui/demo-blocks.ts");
const { parse } = await import("pi-better-show"), { TAGS } = await import("pi-better-show/elements");
type Delivery = { ok: true } | { ok: false; reason: string };
type Answer = { kind: string; title?: string; fields: [string, string][]; ref?: { doc?: string; block: number } };

const host = (send: (answer: Answer, text: string) => Promise<Delivery> = async () => ({ ok: true }), extra: object = {}) => ({ density: "compact" as const, send, ...extra });
const drawn = (text: string, h = host()) => {
	const into = new El("div");
	drawBlocks(into as unknown as HTMLElement, text, h);
	return into;
};
const elementsOf = (into: El) => into.find((el) => el.tagName.startsWith("pbs-"));
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const fire = (el: El, answer: Answer) => {
	let refused = false;
	for (const on of el.handlers["pbs-answer"] ?? []) on({ type: "pbs-answer", detail: answer, preventDefault: () => (refused = true) });
	return refused;
};

test("a document with every block kind draws one element per block, in order, fed with the block's data, at the host's density", () => {
	const segments = parse(DEMO_BLOCKS_DOC).filter((s) => s.type === "block");
	const kinds = new Set(segments.map((s) => s.kind));
	assert.equal(kinds.size, 13, "the sample has every kind of the vocabulary");
	const els = elementsOf(drawn(DEMO_BLOCKS_DOC));
	assert.deepEqual(els.map((e) => e.tagName), segments.map((s) => TAGS[s.kind as keyof typeof TAGS]));
	els.forEach((el, i) => {
		const seg = segments[i]! as unknown as { kind: string; data: { items?: object[] }; index: number };
		// A review's images are the host's to resolve (below): with none, the data is the block's but for them.
		const want = seg.kind === "review" ? { ...seg.data, items: seg.data.items!.map(({ image: _, ...item }: { image?: string }) => item) } : seg.data;
		assert.deepEqual((el as unknown as { data: unknown }).data, want, `${el.tagName} gets the block's data`);
		assert.equal(el.getAttribute("density"), "compact");
		assert.deepEqual((el as unknown as { ref: unknown }).ref, { block: seg.index }, "the block's address is its index");
	});
});

test("prose between blocks goes through the page's own Markdown, and a document without blocks is only that", () => {
	const into = drawn("Intro with **bold**.\n\n```table\ncolumns: [a]\nrows: [[1]]\n```\n\nAfter.");
	assert.deepEqual(into.children.filter((k) => k.tagName === "#fragment").length, 2, "two prose pieces");
	assert.equal(into.find((el) => el.tagName === "strong")[0]?.textContent, "bold");
	assert.equal(elementsOf(into).length, 1);
	assert.equal(elementsOf(drawn("just text\n\n```js\nlet a = 1\n```")).length, 0, "an ordinary code fence is not a block");
});

test("a block that does not fit its schema shows its source in code, and nothing throws", () => {
	const into = drawn("```form\nquestions: not-a-list\n```\n\n```table\ncolumns: [: bad\n```");
	assert.equal(elementsOf(into).length, 0);
	const pre = into.find((el) => el.tagName === "pre");
	assert.equal(pre.length, 2);
	assert.equal(pre[0]!.find((el) => el.tagName === "code")[0]!.textContent, "questions: not-a-list");
	assert.ok(pre[0]!.getAttribute("title"), "the reason is the tooltip");
});

test("an answer is delivered by the host: the element is told to stay open until it is, then locked with the fields that went", async () => {
	const sent: [Answer, string][] = [];
	const into = drawn("```options\n- {title: A}\n- {title: B}\n```", host(async (a, text) => (sent.push([a, text]), { ok: true })));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const refused = fire(el!, { kind: "pick", title: "t", fields: [["picked", "A"]], ref: { block: 0 } });
	assert.equal(refused, true, "preventDefault: the host takes the answer, the element does not lock itself");
	assert.equal(el!.answered, undefined, "not locked while the answer is on its way");
	await settle();
	assert.deepEqual(sent.map(([a, text]) => [a.kind, text]), [["pick", 'User picked "A" for "t".']], "the host gets the answer and the text the agent reads");
	assert.deepEqual(el!.answered, [["picked", "A"]]);
});

test("a refused answer leaves the element open and says why under it; a second answer while one is on its way is ignored", async () => {
	let release!: (d: Delivery) => void, calls = 0;
	const into = drawn("```suggest\n- Go\n```", host(() => (calls++, new Promise<Delivery>((r) => (release = r)))));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	fire(el!, { kind: "suggest", fields: [["text", "Go"]] });
	fire(el!, { kind: "suggest", fields: [["text", "Go"]] });
	assert.equal(calls, 1);
	release({ ok: false, reason: "The session is not live." });
	await settle();
	assert.equal(el!.answered, undefined);
	const note = into.find((e) => e.getAttribute("class") === "pbs-note")[0]!;
	assert.equal(note.textContent, "The session is not live.");
	assert.equal(note.getAttribute("role"), "status");
	fire(el!, { kind: "suggest", fields: [["text", "Go"]] });
	assert.equal(calls, 2, "after a refusal the user can try again");
});

test("a delivered answer is kept per scope: the same text drawn again (a reload) comes back locked, another scope's does not", async () => {
	const text = "```form\nquestions:\n  - {name: q, label: Q}\n```";
	const h = host(async () => ({ ok: true }), { scope: ["S1", "e7"] });
	const first = elementsOf(drawn(text, h)) as unknown as (El & { answered?: unknown })[];
	fire(first[0]!, { kind: "form", fields: [["q", "yes"]] });
	await settle();
	assert.ok([...stored.keys()].some((k) => k.startsWith("sb-")), "the lock is in the page's storage");
	const again = elementsOf(drawn(text, h)) as unknown as (El & { answered?: unknown })[];
	assert.deepEqual(again[0]!.answered, [["q", "yes"]], "locked after a reload");
	const other = elementsOf(drawn(text, host(async () => ({ ok: true }), { scope: ["S1", "e8"] }))) as unknown as (El & { answered?: unknown })[];
	assert.equal(other[0]!.answered, undefined, "keyed by the session, the entry, and the block");
	const unscoped = elementsOf(drawn(text)) as unknown as (El & { answered?: unknown })[];
	assert.equal(unscoped[0]!.answered, undefined, "a host with no scope keeps nothing");
});

test("a review item's image is the host's to resolve: only what the host maps is shown, and nothing from the block is a URL the page loads", () => {
	const text = "```review\nitems:\n  - {name: A, image: a.svg}\n  - {name: B, image: 'https://evil.example/x.png'}\n  - {name: C, image: '../../etc/passwd.png'}\n```";
	const items = (into: El) => ((elementsOf(into)[0] as unknown as { data: { items: { image?: string }[] } }).data.items);
	assert.deepEqual(items(drawn(text)).map((i) => i.image), [undefined, undefined, undefined], "no host mapping: no image");
	const mapped = items(drawn(text, host(undefined, { image: (ref: string) => (/^[\w.-]+\.svg$/.test(ref) ? `doc/cap/${ref}` : undefined) })));
	assert.deepEqual(mapped.map((i) => i.image), ["doc/cap/a.svg", undefined, undefined]);
});

test("nothing a block holds becomes markup: hostile text stays data, and the block code never writes HTML", () => {
	const writes: string[] = [];
	for (const name of ["innerHTML", "outerHTML"]) Object.defineProperty(El.prototype, name, { configurable: true, set: (v: string) => void writes.push(`${name}=${v}`) });
	(El.prototype as unknown as Record<string, unknown>).insertAdjacentHTML = (_: string, v: string) => void writes.push(`adjacent=${v}`);
	try {
		const evil = "<img src=x onerror=alert(1)>";
		const into = drawn(`> [!NOTE] ${evil}\n> <script>alert(1)</script>\n\n\`\`\`cards\n- {title: "${evil}", body: "<b>x</b>"}\n\`\`\`\n\n\`\`\`form\nquestions:\n  - {name: q, label: "${evil}"}\n\`\`\`\n\n\`\`\`bogus-not-a-kind\n${evil}\n\`\`\`\n\n\`\`\`form\n${evil}\n\`\`\``);
		assert.ok(elementsOf(into).length >= 3);
		assert.deepEqual(writes, []);
	} finally {
		for (const name of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) delete (El.prototype as unknown as Record<string, unknown>)[name];
	}
	for (const file of ["gui/blocks.ts", "gui/mdbody.ts", "gui/blockanswer.ts", "gui/blocklock.ts"]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")), file);
});
