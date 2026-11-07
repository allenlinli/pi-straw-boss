import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet, netSource, type Ref, type TowerView } from "../src/net.ts";
import type { HeadSeam } from "../src/nethead.ts";
import { answerAsk, openAsk } from "../src/server/headasks.ts";
import { appendChapter } from "../src/server/headchapters.ts";
import { headSeam } from "../src/server/headnet.ts";
import { slotOf } from "../src/server/record.ts";
import { assistant, call, custom, header, lines, text, user } from "./sessions.ts";

// The head tower in the snapshot (docs/specs/2026-11-04-head-tower.md, The GUI channel; H3): `Net.head` is the head unit with its state, its asks, and `said`; the session key `sb-head` is always in the registry (role `head`)
// with a file only when a conversation file exists, so the page can write to the head before it exists; no base carries a crown any more (`Base.head` is gone).

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-head-net-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const SESSIONS = join(scratch, "sessions");
mkdirSync(SESSIONS);
const file = (name: string) => (writeFileSync(join(SESSIONS, name), ""), join(SESSIONS, name));
const ONE = file("2026_one.jsonl"), TWO = file("2026_two.jsonl");
const OUTSIDE = join(scratch, "elsewhere.jsonl");
writeFileSync(OUTSIDE, "");

const ws = (id: string, label: string, tokens: Record<string, string> = {}): Workspace => ({ workspace_id: id, label, tokens });
const pane = (id: string, tab: string, tokens: Record<string, string> = {}): Pane => ({ pane_id: id, tab_id: tab, tokens });
const session = (id: string, name: string, p: string, w: string, tab: string): Session => ({ id, name, status: "idle", herdrLocation: { status: "current", paneId: p, workspace: { id: w }, tab: { id: tab } } } as Session);
const view = (over: Partial<TowerView> = {}): TowerView => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], queue: [], ...over });
const seam = (over: Partial<HeadSeam> = {}): HeadSeam => ({ key: "sb-head", asks: () => [], chapters: () => [], said: () => undefined, line: () => undefined, ...over });

const headWorld = (services?: (workspace: string) => TowerView | undefined, head: HeadSeam = seam()) => {
	const refs = new Map<string, Ref>();
	const net = buildNet({
		sessions: [session("sb-head", "head tower", "wH:p1", "wH", "wH:t1"), session("tower-a", "tower · Alpha", "wA:p1", "wA", "wA:t1")],
		panes: [pane("wH:p1", "wH:t1", { sb_role: "head" }), pane("wA:p1", "wA:t1", { sb_role: "tower" })],
		workspaces: [ws("wH", "Head tower", { sb_head: "sb-head" }), ws("wA", "Alpha", { tower: "tower-a" })],
		children: () => [], sessionDir: SESSIONS, head, ...(services ? { services } : {}),
	}, refs);
	return { net, refs };
};

test("no head seam, no head: the snapshot has no `head`, no key `sb-head`, and no base carries a crown", () => {
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions: [session("tower-a", "tower · Alpha", "wA:p1", "wA", "wA:t1")], panes: [pane("wA:p1", "wA:t1", { sb_role: "tower" })], workspaces: [ws("wA", "Alpha", { tower: "tower-a" })], children: () => [], sessionDir: SESSIONS }, refs);
	assert.equal("head" in net, false);
	assert.equal(refs.has("sb-head"), false);
	assert.equal(net.bases.length, 1);
	assert.ok(net.bases.every((b) => !("head" in b)));
});

test("before the head exists the unit is absent, and its key is in the registry with no file, no pane, and the head key as its base, so the page can write to it", () => {
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions: [], panes: [], workspaces: [ws("wA", "Alpha", { tower: "tower-a" })], children: () => [], sessionDir: SESSIONS, head: seam() }, refs);
	assert.deepEqual(net.head, { key: "sb-head", name: "head tower", mark: "idle", state: "absent", asks: [] });
	assert.deepEqual(refs.get("sb-head"), { key: "sb-head", base: "@head", name: "head tower", role: "head", file: undefined, pane: undefined, chapters: [] });
});

test("a secondary slot's key is the seam's: the registry and the unit carry it", () => {
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions: [], panes: [], workspaces: [], children: () => [], sessionDir: SESSIONS, head: seam({ key: "sb-head-ab12cd34" }) }, refs);
	assert.equal(net.head?.key, "sb-head-ab12cd34");
	assert.equal(refs.get("sb-head-ab12cd34")?.role, "head");
});

test("the head service is the unit's: state, queue rows, the asks and `said` from the seam; the head workspace is no base and the registry holds its pane and the newest chapter's file", () => {
	const asks = [{ id: "H1", group: "H1", workspace: "wA", label: "Alpha", since: 900, at: 1000, first: "go", state: "answered" as const, answers: 1, last: "landed" }];
	const { net, refs } = headWorld(
		(w) => (w === "wH" ? view({ state: "waking", queued: 1, queue: [{ text: "boss: ship it", as: "followUp" }], file: TWO }) : undefined),
		seam({ asks: () => asks, said: (f) => (f === ONE || f === TWO ? 4242 : undefined), line: (f) => (f === TWO ? "Lighthouse Web is green." : undefined), chapters: () => [{ n: 1, file: ONE, from: "2026-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z", why: "the first conversation" }, { n: 2, file: TWO, from: "2026-11-03T00:00:00Z", why: "the last one grew past 8 MB" }] }),
	);
	assert.deepEqual(net.bases.map((b) => b.id), ["wA"], "the head workspace is no base");
	assert.deepEqual({ ...net.head, service: undefined }, { key: "sb-head", name: "head tower", mark: "idle", state: "waking", service: undefined, queued: [{ text: "boss: ship it", as: "followUp" }], asks, said: 4242, line: "Lighthouse Web is green." });
	assert.equal(net.head?.service?.queued, 1);
	assert.ok(!("queue" in net.head!.service!) && !("file" in net.head!.service!), "the queue and the file are the unit's, not the service's");
	const ref = refs.get("sb-head")!;
	assert.deepEqual([ref.role, ref.base, ref.name, ref.file, ref.pane], ["head", "wH", "head tower", TWO, "wH:p1"]);
	assert.deepEqual(ref.chapters?.map((c) => [c.n, c.file]), [[1, ONE], [2, TWO]]);
});

test("the seam's newest line: the first line of the newest assistant text, by the head log's filter (tool-only and non-assistant entries skipped), cut to 160, none for a missing file; read again only when the file changed", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-head-line-")), slot = slotOf(dir, { HOME: dir }), conversation = join(SESSIONS, "2026_line.jsonl");
	try {
		const seam = headSeam(slot, () => 0);
		assert.equal(seam.line(undefined), undefined, "no file named");
		assert.equal(seam.line(conversation), undefined, "no file yet");
		writeFileSync(conversation, lines([header("s"), user("u1", null, "go"), assistant("a1", "u1", [text("\n  First thing   \nsecond line")])]));
		assert.equal(seam.line(conversation), "First thing", "the first non-empty line, trimmed");
		writeFileSync(conversation, lines([header("s"), user("u1", null, "go"), assistant("a1", "u1", [text("Older text")]), assistant("a2", "a1", [call("t1", "bash", { command: "ls" })]), custom("c1", "a2", "straw-tower", "Tower note", true), user("u2", "c1", "newer user text")]));
		assert.equal(seam.line(conversation), "Older text", "a tool-only assistant entry, a notice, and a user entry are not the head's words");
		writeFileSync(conversation, lines([header("s"), assistant("a1", null, [text("x".repeat(400))])]));
		assert.equal(seam.line(conversation), `${"x".repeat(159)}…`, "cut to 160 with an ellipsis");
		writeFileSync(conversation, lines([header("s"), user("u1", null, "go")]));
		assert.equal(seam.line(conversation), undefined, "a file with no assistant text has no line");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the head's session is the server's own id, never the one the workspace token names: a stale or forged sb_head token moves neither its pane nor its name (review HH3-F004)", () => {
	const refs = new Map<string, Ref>();
	const net = buildNet({
		sessions: [session("sb-head", "head tower", "wH:p1", "wH", "wH:t1"), session("tower-a", "tower · Alpha", "wA:p1", "wA", "wA:t1")],
		panes: [pane("wH:p1", "wH:t1", { sb_role: "head" }), pane("wA:p1", "wA:t1", { sb_role: "tower" })],
		workspaces: [ws("wH", "Head tower", { sb_head: "tower-a" }), ws("wA", "Alpha", { tower: "tower-a" })],
		children: () => [], sessionDir: SESSIONS, head: seam(),
	}, refs);
	assert.equal(net.head?.name, "head tower");
	assert.equal(refs.get("sb-head")?.pane, "wH:p1");
});

test("the mark is the tower unit's rule: an idle conversation is idle, a live run with the boss away is working, and the head is never waiting for a reason of its own", () => {
	const idleConversation = headWorld(() => view({ state: "running", run: { id: "r1", kind: "local", startedAt: "2026-11-04T10:00:00Z" }, conversation: { since: "2026-11-04T10:00:00Z", resumed: true, turns: 2, idle: true, idleMs: 600_000, capAt: 1 } })).net.head!;
	assert.equal(idleConversation.mark, "idle");
	const working = headWorld(() => view({ state: "running", run: { id: "r1", kind: "local", startedAt: "2026-11-04T10:00:00Z" } })).net.head!;
	assert.equal(working.mark, "working");
	assert.equal(headWorld(() => view()).net.head!.mark, "idle");
});

test("a chapter file outside pi's sessions folder is dropped from the registry; with no chapter the service's own file is the unit's", () => {
	const { refs } = headWorld(() => view({ file: ONE }), seam({ chapters: () => [{ n: 1, file: OUTSIDE, from: "2026-11-01T00:00:00Z", why: "x" }] }));
	assert.deepEqual([refs.get("sb-head")?.file, refs.get("sb-head")?.chapters], [ONE, []]);
	const none = headWorld(undefined, seam());
	assert.equal(none.refs.get("sb-head")?.file, undefined);
	assert.equal(none.net.head?.state, "absent", "a head workspace with no service view is not running");
});

test("netSource reads the head seam with the net: the key is findable, and Base.head is nowhere", async () => {
	const source = netSource({
		run: (async () => ({})) as never, world: async () => ({ panes: [pane("wA:p1", "wA:t1", { sb_role: "tower" })], workspaces: [ws("wA", "Alpha", { tower: "tower-a" })], tabs: [] }),
		sessions: async () => [session("tower-a", "tower · Alpha", "wA:p1", "wA", "wA:t1")], sessionDir: SESSIONS, head: seam(),
	});
	const net = await source.read();
	assert.equal(net.head?.state, "absent");
	assert.equal(source.lookup("sb-head")?.role, "head");
	assert.equal(source.lookup("sb-head")?.live, true);
	assert.ok(net.bases.every((b) => !("head" in b)));
});

test("the server's seam: the head's key by slot, its newest asks with their state, its chapters, and the time of the newest assistant text, read again only when the file changed", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-head-seam-")), slot = slotOf(dir, { HOME: dir }), T0 = Date.parse("2026-11-04T08:00:00Z");
	try {
		const seam = headSeam(slot, () => T0 + 60_000);
		assert.deepEqual([seam.key, seam.asks(), seam.chapters(), seam.said(undefined)], [slot.primary ? "sb-head" : `sb-head-${slot.slot8}`, [], [], undefined]);
		const a = openAsk(slot, T0, { workspace: "wA", label: "Alpha", first: "do it" });
		openAsk(slot, T0 + 1, { workspace: "wB", label: "Beta", first: "and this" });
		answerAsk(slot, T0 + 30_000, { id: a.id, workspace: "wA", text: "landed\nmore" });
		assert.deepEqual(seam.asks().map((r) => [r.id, r.workspace, r.state, r.last]), [["H1", "wA", "answered", "landed"], ["H2", "wB", "waiting", undefined]]);
		assert.equal(seam.asks()[0]!.at, T0 + 30_000, "the time of its last forward or answer");
		const conversation = join(SESSIONS, "2026_head.jsonl");
		appendChapter(slot, T0, conversation, "the first conversation");
		assert.deepEqual(seam.chapters().map((c) => [c.n, c.file, c.why]), [[1, conversation, "the first conversation"]]);
		assert.equal(seam.said(conversation), undefined, "no file yet");
		writeFileSync(conversation, lines([header("s"), user("u1", null, "go"), assistant("a1", "u1", [text("on it")])]));
		assert.equal(seam.said(conversation), Date.parse("2026-10-17T08:00:01.000Z"), "the assistant entry's own time, not the file's");
		writeFileSync(conversation, lines([header("s"), user("u1", null, "go")]));
		assert.equal(seam.said(conversation), undefined, "a file with no assistant text has said nothing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
