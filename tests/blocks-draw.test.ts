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
const { parse, inline, inlinePlain, BLOCK_KINDS, DISPLAY_KINDS, INTERACTIVE_KINDS } = await import("pi-better-show"), { TAGS } = await import("pi-better-show/elements");
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
	assert.equal(kinds.size, 14, "the sample has every kind of the vocabulary");
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

// The `tree` block (pi-better-show 0.4.0): an indented directory snapshot the agent wrote. It is a display kind, drawn by `pbs-tree` from the block's data, and its text is text: sb makes no name a link or a route, and a note's links are shown as their text.
const TREE = "```tree\nrepo/\n  src/ {focus} # the **core**\n    parse.ts {new}\n    old.ts {removed}\n  README.md {changed, risk}\n  … 12 more\n```";

test("a tree block is the pbs-tree element fed with the block's data, at the host's density, addressed by its index; the wrapper names its kind", () => {
	const into = drawn(`Before.\n\n\`\`\`suggest\n- Go\n\`\`\`\n\n${TREE}`);
	const el = elementsOf(into).find((e) => e.tagName === "pbs-tree") as unknown as El & { data: { root: { name: string; children: { name: string; dir: boolean; tags: string[]; note?: string; children: { name: string; tags: string[] }[] }[] } }; ref: unknown };
	assert.ok(el, "a tree is drawn with pbs-tree");
	assert.equal(TAGS.tree, "pbs-tree");
	assert.equal(el.getAttribute("density"), "compact");
	assert.deepEqual(el.ref, { block: 1 }, "the block's address is its index among the document's blocks");
	assert.equal(el.data.root.name, "repo");
	assert.deepEqual(el.data.root.children.map((c) => [c.name, c.dir, c.tags]), [["src", true, ["focus"]], ["README.md", false, ["changed", "risk"]], ["… 12 more", false, []]]);
	assert.deepEqual(el.data.root.children[0]!.children.map((c) => [c.name, c.tags]), [["parse.ts", ["new"]], ["old.ts", ["removed"]]]);
	const wrap = into.find((e) => e.getAttribute("class") === "pbs-block" && e.getAttribute("data-kind") === "tree");
	assert.equal(wrap.length, 1);
});

test("a tree takes no answer: it is not among the kinds a reader answers, so a pbs-answer from its element delivers nothing and locks nothing", async () => {
	assert.deepEqual([...BLOCK_KINDS].sort(), [...DISPLAY_KINDS, ...INTERACTIVE_KINDS].sort(), "every kind of the package is a display kind or a kind a reader answers: a new kind makes this fail until sb decides which");
	assert.ok(DISPLAY_KINDS.includes("tree" as never) && !INTERACTIVE_KINDS.includes("tree" as never));
	const sent: string[] = [];
	const into = drawn(TREE, host(async (_a, t) => (sent.push(t), { ok: true }), { scope: ["S1", "tree"] }));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	assert.equal(fire(el!, { kind: "form", fields: [["q", "x"]], ref: { block: 0 } }), false, "the host does not even take it: the event is left alone");
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(el!.answered, undefined);
	assert.equal(lockFor("S1", "tree").get(0).state, "open");
});

test("a tree is a display block: a unit whose box is away does not switch it off, and it carries no note", () => {
	const away = { why: () => "The box is unreachable.", watch() {} };
	const into = drawn(`${TREE}\n\n\`\`\`suggest\n- Go\n\`\`\``, host(undefined, { away }));
	const wraps = into.find((e) => e.getAttribute("class") === "pbs-block");
	assert.deepEqual(wraps.map((w) => [w.getAttribute("data-kind"), w.hasAttribute("data-away"), elementsOf(w)[0]!.hasAttribute("inert")]), [["tree", false, false], ["suggest", true, true]], "the chips are off with the box, the tree is not");
	assert.deepEqual(into.find((e) => e.getAttribute("class") === "pbs-note").map((n) => n.textContent), ["", "The box is unreachable."]);
});

test("a tree's names are text and its notes show their links as text: no name or note reaches the element as a link, a route, or markup", () => {
	const note = "see [the runbook](https://example.com/run), https://example.com/x, **bold [inside](https://example.com/in)**, `a_b`, *soft*, and \\[kept\\]";
	const into = drawn(`\`\`\`tree\nhttps://example.com/\n  [a](https://example.com/b)/ # ${note}\n    ../../etc/passwd # file:///etc/passwd\n    nested.ts # *__[only here](https://example.com/in)__*\n\`\`\``);
	const root = (elementsOf(into)[0] as unknown as { data: { root: { name: string; children: { name: string; note?: string; children: { name: string; note?: string }[] }[] } } }).data.root;
	assert.equal(root.name, "https://example.com", "a name is the parser's, untouched: the element builds a text node of it");
	assert.equal(root.children[0]!.name, "[a](https://example.com/b)");
	assert.equal(root.children[0]!.children[0]!.name, "../../etc/passwd");
	const tokens = (text: string) => inline(text);
	const flat = (list: ReturnType<typeof inline>): string[] => list.flatMap((t) => (t.type === "link" ? ["LINK"] : "children" in t ? [t.type, ...flat(t.children)] : [t.type]));
	const original = flat(tokens(note)), shown = root.children[0]!.note!;
	assert.ok(original.includes("LINK"), "the note as written has links (the test is not vacuous)");
	assert.ok(!flat(tokens(shown)).includes("LINK"), `no link survives in: ${shown}`);
	assert.equal(inlinePlain(shown), "see the runbook, https://example.com/x, bold inside, a_b, soft, and [kept]", "the words are the same; a link is its label, and a bare address is text");
	assert.deepEqual(flat(tokens(shown)).filter((t) => t !== "text"), ["strong", "code", "em"], "bold, code, and italic stay as they were");
	assert.equal(root.children[0]!.children[0]!.note, "file:///etc/passwd", "a note without a link is the block's, untouched");
	assert.ok(!flat(tokens(root.children[0]!.children[1]!.note!)).includes("LINK"), "a link inside emphasis is found too");
	assert.equal(inlinePlain(root.children[0]!.children[1]!.note!), "only here");
});

test("a tree that does not parse shows its source in code with the reason, like any block: an unknown tag, a tab, a second root, a file holding entries, over the limits", () => {
	const bad = ["root/\n  a.ts {oops}", "root/\n\ta.ts", "root/\nother/", "root/\n  a.ts\n    b.ts", `root/\n${Array.from({ length: 2001 }, (_, i) => `  f${i}`).join("\n")}`];
	for (const source of bad) {
		const into = drawn(`\`\`\`tree\n${source}\n\`\`\``);
		assert.equal(elementsOf(into).length, 0, source.slice(0, 30));
		const pre = into.find((e) => e.tagName === "pre")[0]!;
		assert.equal(pre.find((e) => e.tagName === "code")[0]!.getAttribute("data-lang"), "tree");
		assert.ok(pre.getAttribute("title")!.startsWith("tree: "), "the reason is the tooltip");
	}
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
	lockFor("S9", "seeded").seed({ done: [], pending: [0] });
	assert.deepEqual(els[0]!.answered, [["text", "Go"]], "a seed that says a finished block is on its way does not take its answer back");
	assert.equal(wraps[0]!.hasAttribute("inert"), false);
});

test("BS-F004: a block that is answered, or on its way, sends nothing when its element fires again (another drawing of it, a double click)", async () => {
	const text = "```suggest\n- Go\n```\n\n```suggest\n- Stop\n```";
	const sent: string[] = [];
	const h = host(async (_a, t) => (sent.push(t), { ok: true }), { scope: ["S9", "locked"] });
	lockFor("S9", "locked").seed({ done: [[0, [["text", "Go"]]]], pending: [1] });
	const els = elementsOf(drawn(text, h)) as unknown as El[];
	for (const [i, el] of els.entries()) fire(el, { kind: "suggest", fields: [["text", "Later"]], ref: { block: i } });
	await settle();
	assert.deepEqual(sent, [], "neither the finished nor the pending block sends");
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
		const into = drawn(`> [!NOTE] ${evil}\n> <script>alert(1)</script>\n\n\`\`\`cards\n- {title: "${evil}", body: "<b>x</b>"}\n\`\`\`\n\n\`\`\`form\nquestions:\n  - {name: q, label: "${evil}"}\n\`\`\`\n\n\`\`\`tree\nroot/\n  ${evil} {focus} # ${evil}\n\`\`\`\n\n\`\`\`bogus-not-a-kind\n${evil}\n\`\`\`\n\n\`\`\`form\n${evil}\n\`\`\``);
		assert.ok(elementsOf(into).length >= 4);
		assert.deepEqual(writes, []);
	} finally {
		for (const name of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) delete (El.prototype as unknown as Record<string, unknown>)[name];
	}
	for (const file of ["gui/blocks.ts", "gui/mdbody.ts", "gui/blockanswer.ts", "gui/blocklock.ts"]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")), file);
});

// BSR-F001: a form's choice, a form's question, and a checklist's item each have a name that goes out and a label that is shown; when they differ the boss is shown the exact text before it goes (one confirm step), the way a chip shows its text.
const FORM_SPLIT = "```form\ntitle: Ship\nquestions:\n  - name: when\n    label: When?\n    choices:\n      - {value: approve the production deploy, label: Today}\n      - Later\n```";
const confirmOf = (into: El) => into.find((e) => e.getAttribute("class") === "pbs-confirm")[0];
const pressed = (el: El | undefined, which: string) => {
	const button = el!.find((e) => e.tagName === "button" && e.getAttribute("class") === which)[0]!;
	for (const on of button.handlers.click ?? []) on({ type: "click", target: button, preventDefault() {} });
};

test("BSR-F001: a form choice whose value is not its label asks for a confirm before it sends: the exact outgoing text, then Send sends that very text", async () => {
	const sent: [Answer, string][] = [];
	const into = drawn(FORM_SPLIT, host(async (a, text) => (sent.push([a, text]), { ok: true })));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const answer: Answer = { kind: "form", title: "Ship", fields: [["form", "Ship"], ["when", "approve the production deploy"]], ref: { block: 0 } };
	assert.equal(fire(el!, answer), true);
	await settle();
	assert.equal(sent.length, 0, "nothing goes before the boss says so");
	const panel = confirmOf(into);
	assert.ok(panel, "the confirm step is shown");
	const shown = panel!.find((e) => e.tagName === "pre")[0]!.textContent;
	assert.equal(shown, "User submitted a form in the HTML review pane:\n- form: Ship\n- when: approve the production deploy", "the text the agent will read, as it is");
	assert.equal(el!.answered, undefined, "the element stays open under it");
	pressed(panel, "pbs-confirm-send");
	await settle();
	assert.deepEqual(sent.map(([a, t]) => [a.fields, t]), [[answer.fields, shown]], "what was shown is what was sent");
	assert.equal(confirmOf(into), undefined, "the step goes once it is answered");
	assert.deepEqual(el!.answered, answer.fields);
});

test("BSR-F001: Back closes the step and sends nothing; the block can be answered again, and the confirm is of the new answer", async () => {
	const sent: string[] = [];
	const into = drawn(FORM_SPLIT, host(async (_a, t) => (sent.push(t), { ok: true })));
	const [el] = elementsOf(into) as unknown as El[];
	fire(el!, { kind: "form", fields: [["when", "approve the production deploy"]], ref: { block: 0 } });
	pressed(confirmOf(into), "pbs-confirm-back");
	await settle();
	assert.equal(confirmOf(into), undefined);
	assert.deepEqual(sent, []);
	fire(el!, { kind: "form", fields: [["when", "approve the production deploy, Later"]], ref: { block: 0 } });
	fire(el!, { kind: "form", fields: [["when", "approve the production deploy"]], ref: { block: 0 } });
	assert.equal(into.find((e) => e.getAttribute("class") === "pbs-confirm").length, 1, "one step at a time: the later answer replaces the earlier");
	assert.match(confirmOf(into)!.find((e) => e.tagName === "pre")[0]!.textContent, /- when: approve the production deploy$/);
});

test("BSR-F001: Escape in the step closes it like Back", () => {
	const into = drawn(FORM_SPLIT, host());
	fire(elementsOf(into)[0]!, { kind: "form", fields: [["when", "approve the production deploy"]], ref: { block: 0 } });
	for (const on of confirmOf(into)!.handlers.keydown ?? []) on({ type: "keydown", key: "Enter" });
	assert.ok(confirmOf(into), "another key leaves it");
	for (const on of confirmOf(into)!.handlers.keydown ?? []) on({ type: "keydown", key: "Escape" });
	assert.equal(confirmOf(into), undefined);
});

test("BSR-F001: a form answer whose values the boss saw goes at once: a choice whose value is its label, even in a form where another choice differs", async () => {
	const sent: string[] = [];
	const into = drawn(FORM_SPLIT, host(async (_a, t) => (sent.push(t), { ok: true })));
	const [el] = elementsOf(into) as unknown as El[];
	fire(el!, { kind: "form", fields: [["when", "Later"]], ref: { block: 0 } });
	await settle();
	assert.equal(confirmOf(into), undefined);
	assert.equal(sent.length, 1);
});

test("BSR-F001 (tower's key rule): a question key that is a plain identifier (/^[A-Za-z0-9_.-]{1,40}$/) is the agent's handle and asks for nothing by itself; a key that is prose, has other punctuation, or is longer asks for the confirm unless it is the label as drawn", () => {
	const ask = (name: string, label: string | undefined) => {
		const sent: string[] = [];
		const into = drawn(`\`\`\`form\nquestions:\n  - ${JSON.stringify({ name, ...(label === undefined ? {} : { label }) })}\n\`\`\``, host(async (_a, t) => (sent.push(t), { ok: true })));
		fire(elementsOf(into)[0]!, { kind: "form", fields: [[name, "yes"]], ref: { block: 0 } });
		return confirmOf(into) ? "confirm" : sent.length ? "sent" : "nothing";
	};
	assert.equal(ask("store", "Which store?"), "sent", "a handle with another label");
	assert.equal(ask("a.b_c-9", "Q"), "sent");
	assert.equal(ask("x".repeat(40), "Q"), "sent", "40 characters is the limit");
	assert.equal(ask("x".repeat(41), "Q"), "confirm", "41 is prose");
	assert.equal(ask("approve the production deploy", "Run the tests?"), "confirm", "prose, not the label");
	assert.equal(ask("run:tests", "Run"), "confirm", "punctuation beyond _.-");
	assert.equal(ask("déploy", "Q"), "confirm", "not ASCII letters");
	assert.equal(ask("**Ready**", "**Ready**"), "confirm", "the label's markup is not what was drawn");
	assert.equal(ask("Which store?", "Which store?"), "sent", "a key that is its label as drawn was seen");
	assert.equal(ask("Which store?", undefined), "sent", "no label: the key is what is drawn");
});

test("BSR-F001: a checklist whose item name is not its label asks for the confirm (every item goes out); one whose names are the labels does not", async () => {
	const sent: string[] = [];
	const into = drawn("```checklist\ntitle: Release\nitems:\n  - {name: deploy to production, label: Run tests}\n  - Write notes\n```", host(async (_a, t) => (sent.push(t), { ok: true })));
	const [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const fields: [string, string][] = [["deploy to production", "checked"], ["Write notes", "unchecked"]];
	fire(el!, { kind: "checklist", title: "Release", fields, ref: { block: 0 } });
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(confirmOf(into)!.find((e) => e.tagName === "pre")[0]!.textContent, 'User updated the checklist "Release":\n☑ deploy to production\n☐ Write notes');
	pressed(confirmOf(into), "pbs-confirm-send");
	await settle();
	assert.equal(sent.length, 1);
	const plain = drawn("```checklist\nitems:\n  - Run tests\n  - Write notes\n```", host(async () => ({ ok: true })));
	fire(elementsOf(plain)[0]!, { kind: "checklist", fields: [["Run tests", "checked"], ["Write notes", "unchecked"]], ref: { block: 0 } });
	assert.equal(confirmOf(plain), undefined);
});

test("BSR-F001: the step goes away when another device answers the block meanwhile, and it takes no second tap on Send once the block is locked", async () => {
	const sent: string[] = [];
	const h = host(async (_a, t) => (sent.push(t), { ok: true }), { scope: ["S1", "confirm"] });
	const into = drawn(FORM_SPLIT, h);
	const [el] = elementsOf(into) as unknown as El[];
	fire(el!, { kind: "form", fields: [["when", "approve the production deploy"]], ref: { block: 0 } });
	const panel = confirmOf(into);
	lockFor("S1", "confirm").done(0, [["when", "Later"]]);
	assert.equal(confirmOf(into), undefined, "the answered block shows no step");
	pressed(panel, "pbs-confirm-send");
	await settle();
	assert.deepEqual(sent, [], "a stale Send sends nothing");
});

test("BSR-F001: a chip keeps its own rule (its label is the text it sends) and asks for no step", () => {
	const into = drawn("```suggest\n- {label: OK, text: approve the deploy}\n```", host());
	fire(elementsOf(into)[0]!, { kind: "suggest", fields: [["text", "approve the deploy"]], ref: { block: 0 } });
	assert.equal(confirmOf(into), undefined);
});

test("BSR-F001: the step's controls are 44 px tall on touch, in the block's own sheet", () => {
	const css = readFileSync(new URL("../gui/pbs.css", import.meta.url), "utf8");
	assert.match(css, /@media \(pointer: coarse\), \(max-width: 640px\) \{[^@]*\.pbs-confirm button \{ min-height: 44px; min-width: 44px; \}/);
});

test("a tree's rows and its two buttons are 44 px tall on touch, in the block's own sheet, and every part the sheet names is a part pbs-tree has", () => {
	const css = readFileSync(new URL("../gui/pbs.css", import.meta.url), "utf8"), element = readFileSync(new URL("../node_modules/pi-better-show/src/elements/tree.ts", import.meta.url), "utf8");
	const touch = /@media \(pointer: coarse\), \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
	const named = [...touch.matchAll(/pbs-tree::part\(([\w-]+)\)/g)].map((x) => x[1]!), has = new Set([...element.matchAll(/(?:part: "|button\(")([\w-]+)"/g)].map((x) => x[1]!)); // `part: "node"`, and the bar's `button("expand-all", ...)`
	assert.deepEqual([...new Set(named)].sort(), ["collapse-all", "expand-all", "node"]);
	for (const part of named) assert.ok(has.has(part), `${part} is a part of pbs-tree`);
	for (const part of named) assert.match(touch, new RegExp(`pbs-tree::part\\(${part}\\)[^{]*\\{[^}]*min-height: 44px`), `${part} is 44 px tall`);
});

// A block of a unit on a remote base whose box takes no input (unreachable or ended): the host says so (`away`), and the block cannot be submitted (todo #121 task 7 fix round 4, R-F001).
const away = (reason?: string) => {
	const views = new Set<{ refresh(): void }>();
	const a = { reason, why: () => a.reason, watch: (v: { refresh(): void }) => void views.add(v), set(next?: string) { a.reason = next; views.forEach((v) => v.refresh()); } };
	return a;
};
const noteOf = (into: El) => into.find((e) => e.getAttribute("class") === "pbs-note")[0]!.textContent;

test("R-F001: an open block of a unit whose box takes no input is off with the reason under it, posts nothing when its answer arrives, and follows the box back", async () => {
	const sent: string[] = [];
	const gate = away("This machine cannot be reached right now; answers wait until it can.");
	const h = host(async (_a, t) => (sent.push(t), { ok: true }), { scope: ["S1", "away"], away: gate });
	const into = drawn("```suggest\n- Go\n```", h), [el] = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	assert.equal(el!.hasAttribute("inert"), true, "its controls are off");
	assert.equal(noteOf(into), gate.reason, "with the reason");
	assert.equal(fire(el!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } }), true, "the host still takes the event");
	await settle();
	assert.deepEqual(sent, [], "nothing is posted");
	assert.equal(el!.answered, undefined);
	gate.set(undefined);
	assert.equal(el!.hasAttribute("inert"), false, "back on a live box: on");
	assert.equal(noteOf(into), "", "the reason goes");
	fire(el!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	await settle();
	assert.equal(sent.length, 1, "and it sends again");
	assert.deepEqual(el!.answered, [["text", "Go"]]);
});

test("R-F001: a box going away turns a drawn open block off at once, and a confirm step that was open goes with it, taking no late Send", async () => {
	const sent: string[] = [];
	const gate = away();
	const into = drawn(FORM_SPLIT, host(async (_a, t) => (sent.push(t), { ok: true }), { scope: ["S1", "away2"], away: gate }));
	const [el] = elementsOf(into) as unknown as El[];
	fire(el!, { kind: "form", fields: [["when", "approve the production deploy"]], ref: { block: 0 } });
	const panel = confirmOf(into);
	assert.ok(panel, "the step is open");
	gate.set("gone");
	assert.equal(confirmOf(into), undefined, "the step is withdrawn");
	assert.equal(el!.hasAttribute("inert"), true);
	assert.equal(noteOf(into), "gone");
	pressed(panel, "pbs-confirm-send");
	await settle();
	assert.deepEqual(sent, [], "a stale Send sends nothing");
});

test("R-F001: an answered block stays as it is on a box that is away (locked with its fields, no reason), and one on its way keeps Sending…", () => {
	const gate = away("gone");
	lockFor("S1", "away3").seed({ done: [[0, [["text", "Go"]]]], pending: [1] });
	const into = drawn("```suggest\n- Go\n```\n\n```suggest\n- Stop\n```\n\n```suggest\n- Wait\n```", host(undefined, { scope: ["S1", "away3"], away: gate }));
	const els = elementsOf(into) as unknown as (El & { answered?: unknown })[];
	const notes = () => into.find((e) => e.getAttribute("class") === "pbs-note").map((e) => e.textContent);
	assert.deepEqual(els[0]!.answered, [["text", "Go"]]);
	assert.equal(els[0]!.hasAttribute("inert"), false, "answered: as it was");
	assert.deepEqual(notes(), ["", "Sending…", "gone"], "answered and pending as they were; open: off with the reason");
	assert.equal(els[2]!.hasAttribute("inert"), true);
	gate.set(undefined);
	assert.deepEqual(notes(), ["", "Sending…", ""], "back: only the open one changed");
});

test("R-F001: a host with no away (a document's, a local base's) draws and sends as before", async () => {
	const sent: string[] = [];
	const into = drawn("```suggest\n- Go\n```", host(async (_a, t) => (sent.push(t), { ok: true })));
	assert.equal(elementsOf(into)[0]!.hasAttribute("inert"), false);
	fire(elementsOf(into)[0]!, { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } });
	await settle();
	assert.equal(sent.length, 1);
});

test("R-F001: only a block that can be answered is off on a box that is away: a table, a diagram or a card stays as it is, with no reason under it", () => {
	const gate = away("gone");
	const text = "```table\ncolumns: [a, b]\nrows:\n  - [1, 2]\n```\n\n```form\nquestions:\n  - {name: q, label: Q}\n```\n\n```options\n- title: A\n- title: B\n```\n\n```checklist\nitems:\n  - One\n```\n\n```suggest\n- Go\n```\n\n```review\nitems:\n  - {name: r, label: R}\n```\n\n```cards\n- {title: T, body: B}\n```";
	const into = drawn(text, host(undefined, { scope: ["S1", "away4"], away: gate }));
	const kinds = into.find((e) => e.getAttribute("class") === "pbs-block").map((w) => w.getAttribute("data-kind"));
	const els = elementsOf(into);
	assert.deepEqual(kinds, ["table", "form", "options", "checklist", "suggest", "review", "cards"]);
	assert.deepEqual(els.map((e) => e.hasAttribute("inert")), [false, true, true, true, true, true, false]);
	assert.deepEqual(into.find((e) => e.getAttribute("class") === "pbs-note").map((e) => e.textContent), ["", "gone", "gone", "gone", "gone", "gone", ""]);
});
