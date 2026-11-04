import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readers } from "../src/history.ts";
import type { Found } from "../src/net.ts";
import { api, image, type Hub, watchSession } from "../src/watch.ts";
import { assistant, header, lines, message, text, user } from "./sessions.ts";

// The head tower's history reads every chapter (docs/specs/2026-11-04-head-tower.md, The GUI channel, Reading; H3): paging older crosses from the newest chapter into the one before it, with a divider item where a chapter
// begins; the first page of a chapter is the page of its file; an entry id is looked up in the chapter that holds it.

const dir = mkdtempSync(join(tmpdir(), "psb-head-history-"));
const pool = readers();
after(() => rmSync(dir, { recursive: true, force: true }));

const PNG = "iVBORw0KGgo=";
/** A chapter file of `n` talk turns: the boss's line `u<tag>1..` and the head's reply `a<tag>1..`, so every entry id names its chapter; the boss's first line of chapter `b` carries a picture. */
function chapter(tag: string, turns: number): string {
	const file = join(dir, `2026_${tag}.jsonl`), entries: unknown[] = [header(`sess-${tag}`)];
	let parent: string | null = null;
	for (let i = 1; i <= turns; i++) {
		entries.push(tag === "b" && i === 1 ? message("ub1", null, { role: "user", content: [text("boss b1"), { type: "image", mimeType: "image/png", data: PNG }], timestamp: 1 }) : user(`u${tag}${i}`, parent, `boss ${tag}${i}`), assistant(`a${tag}${i}`, `u${tag}${i}`, [text(`head ${tag}${i}`)]));
		parent = `a${tag}${i}`;
	}
	writeFileSync(file, lines(entries));
	return file;
}
const ONE = chapter("a", 3), TWO = chapter("b", 2), THREE = chapter("c", 4);
const CHAPTERS = [
	{ n: 1, file: ONE, from: "2026-11-01T08:00:00.000Z", to: "2026-11-02T08:00:00.000Z", why: "the first conversation" },
	{ n: 2, file: TWO, from: "2026-11-02T08:00:00.000Z", to: "2026-11-03T08:00:00.000Z", why: "the boss asked for a new conversation" },
	{ n: 3, file: THREE, from: "2026-11-03T08:00:00.000Z", why: "the last one grew past 8 MB" },
];
const found = (over: Partial<Found> = {}): Found => ({ key: "sb-head", base: "wH", name: "head tower", role: "head", file: THREE, live: true, chapters: CHAPTERS, ...over });
const hub = (f: Found): Hub => ({ lookup: () => f, workspace: () => [], readers: pool });
const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id);
const body = async (h: Hub, kind: string, id: string | undefined, query = "") => (await api(h, [kind, "sb-head", ...(id ? [id] : [])], new URLSearchParams(query))).body as { items: { id: string; kind: string; type?: string; text?: string; at?: string }[]; before?: string };

test("the newest chapter pages as a file does; when it is exhausted a divider opens it and the cursor names the chapter before", async () => {
	const h = hub(found());
	const first = await body(h, "history", undefined, "limit=4");
	assert.deepEqual([ids(first), first.before], [["uc3", "ac3", "uc4", "ac4"], "uc3"]);
	const rest = await body(h, "history", undefined, "before=uc3&limit=4");
	assert.deepEqual([ids(rest), rest.before], [["chapter-3", "uc1", "ac1", "uc2", "ac2"], "chapter:2"], "the divider is the oldest item, and the cursor leaves the file");
	const divider = rest.items[0]!;
	assert.deepEqual([divider.kind, divider.type, divider.text, divider.at], ["divider", "chapter", "the last one grew past 8 MB", "2026-11-03T08:00:00.000Z"]);
});

test("a chapter cursor pages the chapter it names, newest first, and the first chapter has no divider and no cursor", async () => {
	const h = hub(found());
	const two = await body(h, "history", undefined, "before=chapter:2&limit=4");
	assert.deepEqual([ids(two), two.before], [["chapter-2", "ub1", "ab1", "ub2", "ab2"], "chapter:1"]);
	assert.equal(two.items[0]!.text, "the boss asked for a new conversation");
	const one = await body(h, "history", undefined, "before=chapter:1");
	assert.deepEqual([ids(one), one.before], [["ua1", "aa1", "ua2", "aa2", "ua3", "aa3"], undefined]);
});

test("an entry id from an older chapter pages that chapter: the id is looked up newest chapter first", async () => {
	const h = hub(found());
	const page = await body(h, "history", undefined, "before=ab2&limit=1");
	assert.deepEqual([ids(page), page.before], [["ub2"], "ub2"], "one item of chapter 2, more behind it in the same file");
	const rest = await body(h, "history", undefined, "before=ab1&limit=5");
	assert.deepEqual([ids(rest), rest.before], [["chapter-2", "ub1"], "chapter:1"]);
});

test("a cursor that names nothing is an empty page, not an error and not the newest chapter again", async () => {
	const h = hub(found());
	for (const before of ["chapter:9", "chapter:x", "no-such-entry"]) assert.deepEqual(await body(h, "history", undefined, `before=${before}`), { items: [] }, before);
});

test("an entry and its picture are fetched from the chapter that holds them", async () => {
	const h = hub(found());
	assert.deepEqual([(await api(h, ["entry", "sb-head", "ub2"], new URLSearchParams())).status, ((await api(h, ["entry", "sb-head", "ub2"], new URLSearchParams())).body as { id: string }).id], [200, "ub2"]);
	assert.equal((await api(h, ["entry", "sb-head", "nope"], new URLSearchParams())).status, 404);
	const pic = await image(h, ["sb-head", "ub1", "0"]);
	assert.deepEqual([pic?.type, pic?.bytes.toString("base64")], ["image/png", PNG]);
});

test("a key without chapters is read as before: one file, its own ids, no divider", async () => {
	const h = hub(found({ role: "tower", chapters: undefined }));
	const page = await body(h, "history", undefined, "limit=4");
	assert.deepEqual([ids(page), page.before], [["uc3", "ac3", "uc4", "ac4"], "uc3"]);
	const rest = await body(h, "history", undefined, "before=uc3");
	assert.deepEqual([ids(rest), rest.before], [["uc1", "ac1", "uc2", "ac2"], undefined]);
});

test("the stream's first page is the newest chapter with its divider and the cursor to the one before; a new chapter resets the stream to itself", async () => {
	const f = found({ chapters: [CHAPTERS[1]!, CHAPTERS[2]!], file: THREE });
	const sent: { reset?: boolean; items?: { id: string }[]; before?: string }[] = [];
	const w = watchSession(hub(f), "sb-head", (_, data) => void sent.push(data as never));
	await w.refresh();
	assert.deepEqual([sent[0]!.reset, sent[0]!.items!.map((i) => i.id), sent[0]!.before], [true, ["chapter-3", "uc1", "ac1", "uc2", "ac2", "uc3", "ac3", "uc4", "ac4"], "chapter:2"]);
	const FOUR = chapter("d", 1);
	f.chapters = [...f.chapters!, { n: 4, file: FOUR, from: "2026-11-04T08:00:00.000Z", why: "the boss asked for a new conversation" }];
	f.file = FOUR;
	await w.refresh();
	assert.deepEqual([sent[1]!.reset, sent[1]!.items!.map((i) => i.id), sent[1]!.before], [true, ["chapter-4", "ud1", "ad1"], "chapter:3"]);
	w.stop();
});
