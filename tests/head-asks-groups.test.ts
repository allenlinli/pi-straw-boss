import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerAsk, ASK_OPEN_MS, GROUP_MS, openAsk, readAsks } from "../src/server/headasks.ts";
import { buildHeadBrief, type HeadBriefInput } from "../src/server/headbrief.ts";
import { headSeam } from "../src/server/headnet.ts";
import type { Slot } from "../src/server/record.ts";
import { addText, addWait, emptyMemory, lapsed, memorySection, memorySummary } from "../src/server/towermemory.ts";
import { HEAD_KEY, towerDir } from "../src/server/towerstore.ts";

// The head page, minimal (docs/specs/2026-11-06-head-page-minimal.md): an ask joins the group of a broadcast, the net's ask rows carry the group and a state that never says answered without an answer, an old asks.json
// still reads, the head's summary leaves lapsed boss waits out, and the head's brief tells the head to close them.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-hag-")) }) as Slot;
const T0 = Date.parse("2026-11-06T08:00:00Z"), MIN = 60_000, HOUR = 3_600_000;
const send = (slot: Slot, at: number, workspace: string, first: string) => openAsk(slot, at, { workspace, label: workspace.toUpperCase(), first });

test("a broadcast is one group: asks with the same first line within 60 s of the newest member share the id of the first; other text, or a later start, is a group of its own", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "I am up");
	const b = send(slot, T0 + 20_000, "wB", "I am up");
	const c = send(slot, T0 + 70_000, "wC", "I am up\nsecond line"); // 50 s after b: the chain holds
	const d = send(slot, T0 + 80_000, "wD", "something else");
	const e = send(slot, T0 + 80_000 + GROUP_MS, "wE", "I am up"); // c was 130 s ago
	assert.deepEqual([a, b, c, d, e].map((x) => x.group), ["H1", "H1", "H1", "H4", "H5"]);
	assert.deepEqual(readAsks(slot, T0).map((x) => x.group), ["H1", "H1", "H1", "H4", "H5"], "the group is in the file");
});

test("an asks.json from before the field reads: asks without a group are grouped by the same rule, and a new ask joins an old group", () => {
	const slot = slotIn();
	mkdirSync(towerDir(slot, HEAD_KEY), { recursive: true });
	const old = (n: number, ws: string, at: number, first: string) => ({ id: `H${n}`, workspace: ws, label: ws, at, last: at, first, answers: [] });
	writeFileSync(join(towerDir(slot, HEAD_KEY), "asks.json"), JSON.stringify({ next: 6, asks: [old(1, "wA", T0, "going out"), old(2, "wB", T0 + 5_000, "going out"), old(3, "wA", T0 + 5 * MIN, "going out"), old(4, "wB", T0 + 5 * MIN + 1000, "back")] }));
	const rows = headSeam(slot, () => T0 + HOUR).asks();
	assert.deepEqual(rows.map((r) => [r.id, r.group]), [["H1", "H1"], ["H2", "H1"], ["H3", "H3"], ["H4", "H4"]]);
	const next = send(slot, T0 + 5 * MIN + 2000, "wC", "back");
	assert.equal(next.group, "H4", "an ask that matches an old, ungrouped one joins its derived group");
});

test("a row's state: answered when it has an answer, waiting while open, silent once 24 h pass (or the cap closed it) with none; its text is the newest answer's first line", () => {
	const slot = slotIn();
	const a = send(slot, T0, "wA", "ping");
	send(slot, T0, "wB", "ping");
	send(slot, T0, "wC", "ping");
	answerAsk(slot, T0 + HOUR, { id: a.id, workspace: "wA", text: "[straw net kind=x] first\nsecond" });
	answerAsk(slot, T0 + 2 * HOUR, { id: a.id, workspace: "wA", text: "newer" });
	const at = (now: number) => headSeam(slot, () => now).asks().map((r) => [r.id, r.state, r.answers, r.last, r.group]);
	assert.deepEqual(at(T0 + 3 * HOUR), [["H1", "answered", 2, "newer", "H1"], ["H2", "waiting", 0, undefined, "H1"], ["H3", "waiting", 0, undefined, "H1"]]);
	assert.deepEqual(at(T0 + ASK_OPEN_MS + HOUR).map((r) => r[1]), ["answered", "silent", "silent"], "24 h without an answer is silent, never answered");
});

test("the rows carry when the broadcast began and when anything last happened, and the snapshot cuts between groups, never inside one", () => {
	const slot = slotIn();
	for (let g = 0; g < 20; g++) for (const ws of ["wA", "wB", "wC", "wD"]) send(slot, T0 + g * 5 * MIN, ws, `broadcast ${g}`);
	const rows = headSeam(slot, () => T0 + 10 * HOUR).asks();
	assert.ok(rows.length <= 60 && rows.length % 4 === 0, `${rows.length} rows: whole groups of four`);
	assert.equal(rows.at(-1)!.group, "H77", "the newest group is in");
	assert.deepEqual([rows[0]!.since, rows[0]!.at, rows[0]!.first], [T0 + 5 * 5 * MIN, T0 + 5 * 5 * MIN, "broadcast 5"]);
});

test("the head's summary leaves out a boss wait past its due, or with no due one a day old; the file keeps it and a workspace tower's summary is unchanged", () => {
	const m = emptyMemory();
	addWait(m, T0 - 2 * HOUR, "r1", { text: "due", for: "boss", dueMin: 60 });
	addWait(m, T0 - 2 * HOUR, "r1", { text: "not yet due", for: "boss", dueMin: 600 });
	addWait(m, T0 - 30 * HOUR, "r1", { text: "no due, a day old", for: "boss" });
	addWait(m, T0 - 2 * HOUR, "r1", { text: "no due, fresh", for: "boss" });
	addWait(m, T0 - 2 * HOUR, "r1", { text: "for an agent", for: "agent", on: { id: "s1", name: "main" }, dueMin: 60 });
	const ids = (s: ReturnType<typeof memorySummary>) => s.bossWaits.map((w) => w.text);
	assert.deepEqual(ids(memorySummary(m)), ["due", "not yet due", "no due, a day old", "no due, fresh"], "a workspace tower shows what it showed");
	assert.deepEqual(ids(memorySummary(m, T0)), ["not yet due", "no due, fresh"]);
	assert.equal(memorySummary(m, T0).waits, 5, "the count of open waits is as it was");
	assert.deepEqual(m.entries.filter((e) => lapsed(e, T0)).map((e) => e.text), ["due", "no due, a day old", "for an agent"]);
	assert.equal(m.entries.length, 5, "nothing is dropped: the server keeps it 7 days");
	const brief = memorySection(m, T0).text;
	assert.match(brief, /\[W1\] for boss: due \(overdue 1h/, "the brief's own source is not filtered: it lists the lapsed wait, marked overdue");
	assert.match(brief, /\[W3\] for boss: no due, a day old/);
	addText(m, T0, "gui", "standing", "x");
	assert.equal(m.entries.filter((e) => e.kind === "standing" && lapsed(e, T0)).length, 0, "only a wait lapses");
});

const input = (over: Partial<HeadBriefInput> = {}): HeadBriefInput => ({ identity: "sb-head", woken: "09:00", boss: false, chapter: { n: 1, since: "2026-11-01T00:00:00Z", turns: 1, resumed: true }, workspaces: [], asks: [], tools: ["- tower_list"], flags: [], ...over });

test("the head's brief names the lapsed waits and tells the head to resolve them or ask the boss again; with none it says nothing of it", () => {
	const text = buildHeadBrief(input({ lapsed: ["W1", "W3"] }));
	assert.match(text, /Lapsed waits \(the boss no longer sees them on the page\): W1, W3\. Resolve each with tower_memory resolve, or ask the boss again with a new due\./);
	assert.doesNotMatch(buildHeadBrief(input()), /Lapsed waits/);
	assert.doesNotMatch(buildHeadBrief(input({ lapsed: [] })), /Lapsed waits/);
});
