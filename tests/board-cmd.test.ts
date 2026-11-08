import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import { boardCommand } from "../src/boardcmd.ts";
import type { Pane, Session } from "../src/herdr.ts";

// `/boss board` (docs/specs/2026-11-09-board-view.md): the head page's rows as text, local only.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const dir = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-boardcmd-"))), dirs.at(-1)!);
const MIN = 60_000, HOUR = 60 * MIN, NOW = Date.parse("2026-11-09T10:00:00Z");
const session = (id: string, name: string, p: string, tab: string, status = "idle"): Session => ({ id, name, status, herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "Alpha" }, tab: { id: tab, label: `${name}-tab` } } } as Session);
const pane = (id: string, role: string): Pane => ({ pane_id: id, tab_id: "t", workspace_id: "wA", tokens: { sb_role: role } });
const net = (status = "idle") => ({ sessions: [session("m1", "billing", "wA:p1", "t1", status), session("m2", "reports", "wA:p2", "t2"), session("tw", "tower", "wA:p3", "t3")], ps: [pane("wA:p1", "main"), pane("wA:p2", "main"), pane("wA:p3", "tower")] });

test("it prints one line per live main and per ended line of this computer, with stale and ended told in words", () => {
	const d = dir();
	writeEntry(d, "m1", { now: "MP-1 export", items: [{ t: "a", done: true }, { t: "b", done: false }] }, NOW - 12 * MIN);
	writeEntry(d, "m2", { now: "was busy", items: [] }, NOW - 3 * HOUR);
	writeEntry(d, "old-1", { now: "left behind", items: [{ t: "x", done: true }] }, NOW - 9 * HOUR);
	const text = boardCommand({ dir: d, now: NOW, net: net() });
	assert.match(text, /^Work board: 3 lines \(1 idle over 2 h, 1 ended\)$/m);
	assert.match(text, /^Alpha › billing-tab · billing · idle · MP-1 export · 1\/2 · 12 min ago$/m);
	assert.match(text, /^Alpha › reports-tab · reports · idle · was busy · 3 h ago · stale$/m);
	assert.match(text, /^old-1 · ended · left behind · 1\/1 · 9 h ago$/m);
	assert.ok(!text.includes("tower"), "a tower is no main");
});

test("a working main is not stale however old its line; with nothing at all it says the board is empty", () => {
	const d = dir();
	writeEntry(d, "m1", { now: "long job", items: [] }, NOW - 5 * HOUR);
	assert.match(boardCommand({ dir: d, now: NOW, net: net("working") }), /^Alpha › billing-tab · billing · working · long job · 5 h ago$/m);
	assert.equal(boardCommand({ dir: dir(), now: NOW, net: { sessions: [], ps: [] } }), "The work board is empty: no main has joined and no line is left.");
});
