import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MARK } from "../src/herdr.ts";
import { type Board, writeBoard, writeYard, type Yard } from "../src/train/board.ts";
import { stepOf } from "../src/trainsign.ts";
import { until, World } from "./fakes.ts";

// Task 6 (docs/specs/2026-11-07-train-workers.md §12): the integrator and the train find themselves in the trainboard files, and their panes carry the keys, marks and `sb_step` from them.

let world = new World();
const dirs: string[] = [];
afterEach(async () => {
	await world.stopAll();
	world = new World();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const M = "2026-11-06-m";
const GLYPH = { run: "\uF04B", wait: "\uF254", fail: "\uF00D" };
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-tokens-"))), dirs.at(-1)!);
const writer = (session: string) => ({ session, pid: 4300, started: "2026-11-07T06:00:00Z" });
// A yard written by a session whose process runs (this test process stands for it): its pid answers and it started before the file was written.
const live = (session: string) => ({ session, pid: process.pid, started: new Date().toISOString() });
const yard = (session: string, by = writer(session), project = "acme"): Yard => ({ v: 1, project, writer: by, updated: "2026-11-07T08:00:00Z", trains: [] });
const board = (steps: Board["steps"]): Board => ({ v: 1, project: "acme", app: "web", code: M, writer: writer("train-1"), updated: "2026-11-07T08:00:00Z", round: 1, cars: [], steps });
const step = (id: number, status: Board["steps"][number]["status"], kind: Board["steps"][number]["kind"] = "full-check", extra: object = {}): Board["steps"][number] => ({ id, kind, name: "n", status, round: 1, ...extra });

test("a train's step is its own board's: the lowest step in progress, else the newest completed; none for a missing board", () => {
	const root = state(), train = { project: "acme", code: M };
	assert.equal(stepOf(root, train), undefined);
	writeBoard(root, board([step(1, "completed", "assemble", { outcome: "passed" }), step(2, "in_progress", "full-check")]));
	assert.equal(stepOf(root, train), "\uF04B full-check");
	writeBoard(root, board([step(1, "completed", "assemble", { outcome: "passed" }), step(2, "in_progress", "deploy", { waits: [{ load: { max: 30, now: 42 } }] })]));
	assert.equal(stepOf(root, train), "\uF254 deploy");
	writeBoard(root, board([step(1, "completed", "assemble", { outcome: "passed" }), step(2, "completed", "land", { outcome: "failed" })]));
	assert.equal(stepOf(root, train), "\uF00D land");
});

test("a main of the integrator kind carries the integrator's key and mark, its member follows into the same place, and a main that is none keeps its tab's place", async () => {
		const main = world.agent({ id: "integ-1", name: "integ acme", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	await main.run(); // the name migrates the main to the integrator kind before its prompt is built (docs/specs/2026-11-09-agent-kinds.md §2)
	await until(() => world.herdr.pane("wA:p1").tokens.sb_mark === MARK.integrator, "the integrator's mark");
	assert.match(world.herdr.pane("wA:p1").tokens.sb_order!, /^000\.05\.\d{3}\.0\.000$/);
	const other = world.agent({ id: "main-2", name: "Docs", pane: "wA:p3", tab: "wA:t2" });
	await other.start();
	await other.promote();
	await until(() => world.herdr.pane("wA:p3").tokens.sb_mark === MARK.main, "an ordinary main");
	assert.match(world.herdr.pane("wA:p3").tokens.sb_order!, /^000\.1\.\d{3}\.0\.000$/);
	assert.equal(world.herdr.pane("wA:p3").tokens.sb_mark, MARK.main);
	const member = world.agent({ id: "mem-1", name: "Helper", pane: "wA:p2", tab: "wA:t1" });
	await member.start();
	await until(() => /^000\.05\.\d{3}\.1\.001$/.test(world.herdr.pane("wA:p2").tokens.sb_order ?? ""), "the integrator's member");
	assert.equal(world.herdr.pane("wA:p2").tokens.sb_mark, MARK.member);
	assert.equal(world.herdr.pane("wA:p2").tokens.sb_order, world.herdr.pane("wA:p1").tokens.sb_order!.replace(".0.000", ".1.001"), "right beside its main, in the same tab place");
});

test("TT-F002: a pane's tokens move no member: a main's role and mark written by anyone leave its tab's members where they were", async () => {
	const main = world.agent({ id: "main-1", name: "Docs", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	await until(() => world.herdr.pane("wA:p1").tokens.sb_mark === MARK.main, "an ordinary main");
	world.herdr.pane("wA:p1").tokens.sb_mark = MARK.integrator; // what any session can write with pane.report
	const member = world.agent({ id: "mem-1", name: "Helper", pane: "wA:p2", tab: "wA:t1" });
	await member.start();
	await until(() => world.herdr.pane("wA:p2").tokens.sb_order !== undefined, "the member's key");
	assert.match(world.herdr.pane("wA:p2").tokens.sb_order!, /^000\.1\.\d{3}\.1\.001$/, "no yard names the main: the member keeps its tab's place");
	assert.equal(world.herdr.pane("wA:p1").tokens.sb_mark, MARK.integrator, "the forged mark is still on the main's pane, and counts for nothing");
});

test("TT-F003: a yard of a writer that is gone gives its main no mark and its members no place", async () => {
	const root = world.stateDir, ended = spawnSync(process.execPath, ["-e", ""]).pid!;
	writeYard(root, yard("integ-1", { session: "integ-1", pid: ended, started: new Date().toISOString() }));
	const main = world.agent({ id: "integ-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	const member = world.agent({ id: "mem-1", name: "Helper", pane: "wA:p2", tab: "wA:t1" });
	await member.start();
	await until(() => world.herdr.pane("wA:p1").tokens.sb_mark !== undefined && world.herdr.pane("wA:p2").tokens.sb_order !== undefined, "both published");
	assert.equal(world.herdr.pane("wA:p1").tokens.sb_mark, MARK.main);
	assert.match(world.herdr.pane("wA:p1").tokens.sb_order!, /^000\.1\./);
	assert.match(world.herdr.pane("wA:p2").tokens.sb_order!, /^000\.1\./);
});

test("a train's pane carries its key, its mark with the short code and its step, and the step follows the board within the debounce", async () => {
	const root = world.stateDir;
	world.herdr.onAgentStart = (pane) => {
		const agent = world.agent({ id: "train-1", name: "train 1106m", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, deps: { detectMs: 10 } });
		agent.file = "/s/train.jsonl";
		void agent.start();
	};
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	writeYard(root, yard("sender-1", live("sender-1"))); // the integrator's yard is the folder the train watches
	const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	await tower.tool("boss_open_main", { role: "train", request: `train:\n  project: acme\n  app: web\n  code: ${M}\n`, sender: "integ-acme" });
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	await until(() => world.herdr.pane(pane.pane_id).tokens.sb_order?.startsWith("000.06."), "the train's key");
	const tokens = () => world.herdr.pane(pane.pane_id).tokens;
	assert.equal(tokens().sb_order, "000.06.2611060m.822b33ad", "the code, then the project's tie");
	assert.equal(tokens().sb_mark, `${MARK.train} 1106m`);
	assert.equal(tokens().sb_step, undefined, "no board yet, no step");
	writeBoard(root, board([step(1, "in_progress", "assemble")]));
	await until(() => tokens().sb_step === "\uF04B assemble", "the first step");
	writeBoard(root, board([step(1, "completed", "assemble", { outcome: "passed" }), step(2, "in_progress", "full-check")]));
	await until(() => tokens().sb_step === "\uF04B full-check", "the new step, written by the debounce and not by the 4 minute refresh");
	assert.equal(tokens().sb_name, undefined);
});
