import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// pi-better-show's blocks as the page draws them (gui/blocks.ts, the lazy chunk): one element per block kind fed with the block's data, prose through the page's own Markdown, a block that does not parse as its source in code,
// the answer from an element handed to the host (which locks the element once the answer is delivered), and nothing from a block ever becoming markup.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { drawBlocks } = await import("../gui/blocks.ts");
const { lockFor } = await import("../gui/blocklock.ts");
const { DEMO_BLOCKS_DOC } = await import("../gui/demo-blocks.ts");
const { parse, inlinePlain } = await import("pi-better-show"), { TAGS } = await import("pi-better-show/elements");
type Delivery = { ok: true } | { ok: false; reason: string; answered?: [string, string][] };
type Answer = { kind: string; title?: string; fields: [string, string][]; ref?: { doc?: string; block: number } };

const host = (send: (answer: Answer, text: string) => Promise<Delivery> = async () => ({ ok: true }), extra: object = {}) => ({ density: "compact" as const, send, ...extra });
const drawn = (text: string, h = host()) => {
	const into = new El("div");
	drawBlocks(into as unknown as HTMLElement, text, h, true);
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
		// A chip shows the text it sends (BS-F001): the label of one whose text differs is that text, the rest of the block is the block's.
		if (seg.kind === "suggest") {
			const got = (el as unknown as { data: { items: { label: string; text: string }[] } }).data.items;
			assert.deepEqual(got.map((i) => i.text), (seg.data as unknown as { items: { text: string }[] }).items.map((i) => i.text));
			for (const item of got) assert.equal(inlinePlain(item.label), item.text);
			return;
		}
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

test("a delivered answer locks its block for as long as the page lives, per scope and block, and the page writes nothing to its storage (the record is the server's)", async () => {
	const text = "```form\nquestions:\n  - {name: q, label: Q}\n```";
	stored.clear();
	const h = host(async () => ({ ok: true }), { scope: ["S1", "e7"] });
	const first = elementsOf(drawn(text, h)) as unknown as (El & { answered?: unknown })[];
	fire(first[0]!, { kind: "form", fields: [["q", "yes"]], ref: { block: 0 } });
	await settle();
	assert.equal(stored.size, 0, "no localStorage");
	const again = elementsOf(drawn(text, h)) as unknown as (El & { answered?: unknown })[];
	assert.deepEqual(again[0]!.answered, [["q", "yes"]], "drawn again (a redraw): locked");
	const other = elementsOf(drawn(text, host(async () => ({ ok: true }), { scope: ["S1", "e8"] }))) as unknown as (El & { answered?: unknown })[];
	assert.equal(other[0]!.answered, undefined, "keyed by the session, the entry, and the block");
	const unscoped = elementsOf(drawn(text)) as unknown as (El & { answered?: unknown })[];
	assert.equal(unscoped[0]!.answered, undefined, "a host with no scope keeps nothing");
});

test("BS-F004: a block redrawn while its answer is on its way comes up locked and pending, and both drawings lock (or both reopen) when the delivery ends", async () => {
	const text = "```suggest\n- Go\n```";
	let release!: (d: Delivery) => void;
	const h = host(() => new Promise<Delivery>((r) => (release = r)), { scope: ["S1", "flight"] });
	const old = drawn(text, h), [oldEl] = elementsOf(old) as unknown as (El & { answered?: unknown })[];
	fire(oldEl!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	const wrap = (into: El) => into.find((e) => e.getAttribute("class") === "pbs-block")[0]!;
	const fresh = drawn(text, h), [freshEl] = elementsOf(fresh) as unknown as (El & { answered?: unknown })[];
	assert.equal(wrap(fresh).hasAttribute("inert"), true, "locked while pending");
	assert.equal(wrap(old).hasAttribute("inert"), true);
	assert.equal(fresh.find((e) => e.getAttribute("class") === "pbs-note")[0]!.textContent, "Sending…");
	assert.equal(freshEl!.answered, undefined, "pending is not yet an answer: no fields to show");
	release({ ok: true });
	await settle();
	assert.deepEqual([oldEl!.answered, freshEl!.answered], [[["text", "Go"]], [["text", "Go"]]], "the redrawn element locks with the fields that went");
	assert.equal(wrap(fresh).hasAttribute("inert"), false);
	// A refusal reopens every drawing.
	let refuse!: (d: Delivery) => void;
	const h2 = host(() => new Promise<Delivery>((r) => (refuse = r)), { scope: ["S1", "flight2"] });
	const a = drawn(text, h2), [aEl] = elementsOf(a) as unknown as (El & { answered?: unknown })[];
	fire(aEl!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	const b = drawn(text, h2);
	assert.equal(wrap(b).hasAttribute("inert"), true);
	refuse({ ok: false, reason: "The session is not live." });
	await settle();
	assert.equal(wrap(b).hasAttribute("inert"), false, "open again");
	assert.equal(wrap(a).hasAttribute("inert"), false);
});

test("BS-F004: the server's record seeds the lock: a block it says was answered comes locked with the fields that went, one it says is on its way comes locked and pending, and the rest stay open", () => {
	const text = "```suggest\n- Go\n```\n\n```form\nquestions:\n  - {name: q, label: Q}\n```\n\n```suggest\n- Stop\n```";
	lockFor("S9", "seeded").seed({ done: [[0, [["text", "Go"]]]], pending: [1] });
	const into = drawn(text, host(undefined, { scope: ["S9", "seeded"] }));
	const els = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const wraps = into.find((e) => e.getAttribute("class") === "pbs-block");
	assert.deepEqual(els[0]!.answered, [["text", "Go"]]);
	assert.equal(els[1]!.answered, undefined);
	assert.deepEqual(wraps.map((w) => w.hasAttribute("inert")), [false, true, false]);
	lockFor("S9", "seeded").seed({ done: [], pending: [] });
	assert.deepEqual(els.map((e) => e.answered === undefined), [false, true, true], "a seed that says nothing about a block never reopens one");
});

test("BS-F004: when the record could not be read the blocks show their source state with a note saying so, and can still be answered (the server refuses a block it knows is answered)", async () => {
	const into = new El("div");
	drawBlocks(into as unknown as HTMLElement, "```suggest\n- Go\n```", host(async () => ({ ok: true }), { scope: ["S1", "unsure"] }), false);
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const note = into.find((e) => e.getAttribute("class") === "pbs-note")[0]!;
	assert.match(note.textContent, /could not be read|answered/i);
	assert.equal(into.find((e) => e.getAttribute("class") === "pbs-block")[0]!.hasAttribute("inert"), false);
	fire(el!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	await settle();
	assert.deepEqual(el!.answered, [["text", "Go"]]);
	assert.equal(note.textContent, "", "the note goes once it is answered");
});

test("BS-F004: an answer the server says was given already (from another device) locks the block with the fields that went and says so", async () => {
	const into = drawn("```suggest\n- Go\n- Stop\n```", host(async () => ({ ok: false, reason: "This block was answered already.", answered: [["text", "Stop"]] }), { scope: ["S1", "elsewhere"] }));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	fire(el!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	await settle();
	assert.deepEqual(el!.answered, [["text", "Stop"]]);
	assert.equal(into.find((e) => e.getAttribute("class") === "pbs-note")[0]!.textContent, "This block was answered already.");
});

test("BS-F001: a chip shows the text it sends: when its text is not what its label reads as, the chip is the text itself, markup and all, so the boss sees it before sending", () => {
	const into = drawn("```suggest\n- {label: OK, text: approve the deploy}\n- {label: '**Yes**', text: Yes}\n- plain\n- {label: Look, text: '[Look](https://x.example)'}\n- {label: Quiet, text: '*go*'}\n```");
	const items = (elementsOf(into)[0] as unknown as { data: { items: { label: string; text: string }[] } }).data.items;
	assert.deepEqual(items.map((i) => i.text), ["approve the deploy", "Yes", "plain", "[Look](https://x.example)", "*go*"], "what is sent does not change");
	assert.equal(items[1]!.label, "**Yes**", "a label that reads as the text keeps its formatting");
	assert.equal(items[2]!.label, "plain");
	for (const [i, item] of items.entries()) assert.equal(inlinePlain(item.label), item.text, `chip ${i} reads as what it sends`);
	assert.notEqual(items[0]!.label, "OK");
});

test("BS-F007: the package's own image rule (any http or data image) is replaced: nothing but a URL the host resolved passes", async () => {
	const { configuration } = (await import(pathToFileURL(fileURLToPath(new URL("../node_modules/pi-better-show/src/elements/config.ts", import.meta.url))).href)) as { configuration(): { imageUrl(ref: string): string | undefined } };
	const text = "```review\nitems:\n  - {name: A, image: a.svg}\n```";
	drawn(text, host(undefined, { image: (ref: string) => `doc/cap/${ref}` }));
	assert.equal(configuration().imageUrl("doc/cap/a.svg"), "doc/cap/a.svg", "what the host resolved");
	for (const ref of ["https://evil.example/x.png", "http://evil.example/x.png", "data:image/png;base64,AAAA", "../x.png", "a.svg"]) assert.equal(configuration().imageUrl(ref), undefined, ref);
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
