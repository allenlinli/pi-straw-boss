import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a main that commands work prints its real mark, commanding, not idle (the head page says so)", () => {
	const d = dir(), sessions = join(d, "sessions");
	// m1 is idle itself and has a subagent that works: its parent file names the artifacts the child's activity lives in.
	const parent = join(sessions, "2026-10-17T00-00-00-000Z_m1.jsonl");
	mkdirSync(join(sessions, "artifacts", "m1", "subagent-activity"), { recursive: true });
	writeFileSync(join(sessions, "artifacts", "m1", "subagent-activity", "kid-1.json"), JSON.stringify({ phase: "active" }));
	const kid: Pane = { pane_id: "wA:p9", tab_id: "t1", workspace_id: "wA", agent: "pi", agent_status: "working", agent_session: { value: join(sessions, "2026_kid-1-1a2b3c4d-5e6f7a8b-9c0d.jsonl") } } as Pane;
	const n = net();
	const ps = [...n.ps.map((p) => (p.pane_id === "wA:p1" ? ({ ...p, agent: "pi", agent_session: { value: parent } } as Pane) : p)), kid];
	writeEntry(d, "m1", { now: "waits on its helper", items: [] }, NOW - 5 * HOUR);
	const text = boardCommand({ dir: d, now: NOW, net: { sessions: n.sessions, ps } });
	assert.match(text, /^Alpha › billing-tab · billing · commanding · waits on its helper · 5 h ago$/m);
	assert.doesNotMatch(text, /billing · idle/);
});

test("a line whose session is open but is no longer a main prints 'not a main', not 'ended'", () => {
	const d = dir();
	writeEntry(d, "tw", { now: "was a main", items: [] }, NOW - 40 * MIN);
	writeEntry(d, "old-1", { now: "closed", items: [] }, NOW - 40 * MIN);
	const text = boardCommand({ dir: d, now: NOW, net: net() });
	assert.match(text, /^tw · not a main · was a main · 40 min ago$/m);
	assert.match(text, /^old-1 · ended · closed · 40 min ago$/m);
});
