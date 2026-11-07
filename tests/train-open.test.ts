import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DEFAULT_MAX_TRAINS, maxTrainsOf, readMaxTrains, trainFromRequest, trainFromToken, trainLabel, trainToken } from "../src/trainrole.ts";
import { opener } from "../src/opener.ts";
import { type Board, writeBoard } from "../src/train/board.ts";
import { World } from "./fakes.ts";

// The tower opens a train with boss_open_main and role "train" (docs/specs/2026-11-07-train-workers.md §3.3, task 3): a tab of its own, counted per project against maxTrains and not
// among the tower's two opened mains, no limit per sender, once per code, and only while the merge train is on.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");
const manifest = (code: string, project = "acme", extra = "") => ["train:", `  project: ${project}`, "  app: web", `  code: ${code}`, "  base: develop", "  stages: [merge]", extra].filter(Boolean).join("\n");
const M = "2026-11-06-m", N = "2026-11-06-n", O = "2026-11-06-o", P = "2026-11-06-p";

async function net() {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	for (const [n, pane] of [["2", "wA:p2"], ["3", "wA:p3"], ["4", "wA:p4"]] as const) await world.agent({ id: `sender-${n}`, name: `other-${n}`, pane, tab: "wA:t1" }).start();
	return { tower, sender };
}
async function restart(old: { stop(reason?: string): Promise<void> }) {
	await old.stop("new");
	const fresh = world.agent({ id: "tower-wA-2", name: "tower · wA-2", pane: "wA:p7", env: { STRAW_BOSS_ROLE: "tower" } });
	await fresh.start();
	return fresh;
}
const trains = () => world.herdr.panes.filter((p) => p.tokens.sb_role === "train" || p.tokens.sb_train);

test("a train opens in a tab of its own, named train 1106m, with the role in its environment and its tokens, and gets the manifest verbatim", async () => {
	world.autoMains();
	const { tower } = await net();
	const result = await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "integ-acme", label: "train 1106m" });
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "train 1106m", "--cwd", "/w/alpha", "--no-focus", "--env", "STRAW_BOSS_ROLE=train"]]);
	const [start] = world.herdr.commands("agent", "start");
	assert.match(start![2]!, /^train-[0-9a-f]{8}$/);
	assert.deepEqual(start?.slice(-2), ["--name", "train 1106m"]);
	const [pane] = trains();
	assert.ok(pane, "the train has a pane");
	assert.equal(pane!.tokens.sb_role, "train");
	assert.equal(pane!.tokens.sb_train, "acme/2026-11-06-m");
	assert.equal(pane!.tokens.sb_opened_by, "sender-1");
	assert.equal(pane!.tokens.sb_open_main, undefined, "the one-time token was consumed");
	const delivered = world.broker.delivered.filter((d) => d.to.startsWith("opened-"));
	assert.equal(delivered.length, 1);
	assert.match(delivered[0]!.message, /you are the train 1106m of project acme/);
	assert.ok(delivered[0]!.message.endsWith(`Request, verbatim:\n${manifest(M)}`));
	assert.deepEqual(result.details, { tab: pane!.tab_id, pane: pane!.pane_id, main: `opened-${pane!.pane_id}`, sender: "sender-1", train: { project: "acme", code: M } });
	assert.match(textOf(result), /train 1106m/);
});

test("the tab is named by the code whatever label the caller sends", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "integ-acme", label: "something else" });
	assert.equal(world.herdr.commands("tab", "create")[0]![5], "train 1106m");
});

test("a train opens beside two opened mains and does not use up their places; the mains' limit and per-sender limit do not count trains", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: "one", sender: "sender-1" });
	await tower.tool("boss_open_main", { request: "two", sender: "sender-2" });
	await assert.rejects(tower.tool("boss_open_main", { request: "three", sender: "sender-3" }), /already has 2 mains opened by its tower \(the limit is 2\)/);
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-3" });
	await tower.tool("boss_open_main", { role: "train", request: manifest(N), sender: "sender-3" });
	await assert.rejects(tower.tool("boss_open_main", { request: "four", sender: "sender-4" }), /limit is 2/, "two live trains took no place of the mains");
	assert.equal(trains().length, 2);
	assert.equal(world.herdr.commands("tab", "create").length, 4);
});

test("trains take none of the places of the mains: with two trains live a sender still opens its own main, and one train sender opens a main as well", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	await tower.tool("boss_open_main", { role: "train", request: manifest(N), sender: "sender-1" });
	await tower.tool("boss_open_main", { request: "one", sender: "sender-1" });
	await tower.tool("boss_open_main", { request: "two", sender: "sender-2" });
	assert.equal(world.herdr.commands("tab", "create").length, 4);
});

test("a sender that has an opened main still opens a train, and a main still opens beside the sender's trains", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: "one", sender: "sender-1" });
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	await assert.rejects(tower.tool("boss_open_main", { request: "again", sender: "sender-1" }), /already has an opened main running/, "the main's own limit per sender still holds");
	assert.equal(trains().length, 1);
});

test("a pane that carries sb_train but is a main's still counts toward the two mains: only the role train leaves the count", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: "one", sender: "sender-1" });
	await tower.tool("boss_open_main", { request: "two", sender: "sender-2" });
	for (const pane of world.herdr.panes.filter((p) => p.tokens.sb_opened_by)) pane.tokens.sb_train = "acme/2026-11-06-z"; // left behind by a crashed train, or written by a process of the same user
	await assert.rejects(tower.tool("boss_open_main", { request: "three", sender: "sender-3" }), /already has 2 mains opened by its tower \(the limit is 2\)/);
	await assert.rejects(tower.tool("boss_open_main", { request: "again", sender: "sender-1" }), /already has an opened main running/);
});

test("one integrator opens as many trains as the project allows: the per-sender limit of one does not apply to the role", async () => {
	world.autoMains();
	const { tower } = await net();
	for (const code of [M, N, O]) await tower.tool("boss_open_main", { role: "train", request: manifest(code), sender: "sender-1" });
	assert.equal(trains().length, 3);
});

test("the fourth live train of a project is refused, counted from live panes so a restarted tower keeps counting; another project has its own count; a train that ended frees a place", async () => {
	world.autoMains();
	const { tower } = await net();
	for (const code of [M, N, O]) await tower.tool("boss_open_main", { role: "train", request: manifest(code), sender: "sender-1" });
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" }), /Project acme already has 3 live trains \(maxTrains is 3\)/);
	const fresh = await restart(tower);
	await assert.rejects(fresh.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-2" }), /maxTrains is 3/);
	assert.equal(world.herdr.commands("tab", "create").length, 3);
	await fresh.tool("boss_open_main", { role: "train", request: manifest(P, "beta"), sender: "sender-2" });
	const m = world.herdr.panes.find((p) => p.tokens.sb_train === `acme/${M}`)!;
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== m.pane_id);
	await fresh.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-2" });
	assert.equal(trains().length, 4);
});

test("a refused train created nothing and may be asked again", async () => {
	world.autoMains();
	const { tower } = await net();
	for (const code of [M, N, O]) await tower.tool("boss_open_main", { role: "train", request: manifest(code), sender: "sender-1" });
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" }), /maxTrains/);
	world.herdr.panes = world.herdr.panes.filter((p) => p.tokens.sb_train !== `acme/${M}`);
	await tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" });
	assert.equal(trains().length, 3);
});

test("maxTrains comes from the project's apps.json (integration.maxTrains); a value that is no whole number from 1 to 32 opens nothing and names the field", async () => {
	world.autoMains();
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-trains-")));
	try {
		mkdirSync(join(dir, ".straw-boss"));
		writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ integration: { maxTrains: 1 } }));
		world.herdr.workspace("wA").worktree = { checkout_path: dir };
		const { tower } = await net();
		await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
		await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(N), sender: "sender-1" }), /Project acme already has 1 live train \(maxTrains is 1\)/);
		writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ integration: { maxTrains: "many" } }));
		await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(N), sender: "sender-1" }), /apps\.json: integration\.maxTrains must be a whole number from 1 to 32/);
		assert.equal(trains().length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the same code twice is refused whatever the request, in the same project only", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(M, "acme", "cars: T-1"), sender: "sender-2" }), /train 1106m of project acme is already open/);
	assert.equal(trains().length, 1);
	await tower.tool("boss_open_main", { role: "train", request: manifest(M, "beta"), sender: "sender-2" });
	assert.equal(trains().length, 2);
});

// D4 and D3 are per project across the whole computer (§19): the count and the code check read every workspace's panes and the trainboards, not one workspace's live panes.
async function secondTower() {
	const tower = world.tower("tower-wB", "wB:t7", "wB:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-b", name: "integ-acme-b", pane: "wB:p1", tab: "wB:t1" });
	await sender.start();
	await sender.promote();
	return tower;
}
/** A board a train wrote: its writer is this very process (alive), updated just now, no land step. */
const writtenBoard = (code: string, over: Partial<Board> = {}) => writeBoard(world.stateDir, { v: 1, project: "acme", app: "web", code, writer: { session: "gone-train", pid: process.pid, started: new Date().toISOString() }, updated: new Date().toISOString(), round: 1, cars: [], steps: [{ id: 1, kind: "assemble", name: "assemble", status: "in_progress", round: 1 }], ...over });

test("maxTrains counts the project's trains across every workspace of the computer: three in one workspace refuse a fourth from the tower of another, and another project is still free", async () => {
	world.autoMains();
	const { tower } = await net();
	for (const code of [M, N, O]) await tower.tool("boss_open_main", { role: "train", request: manifest(code), sender: "sender-1" });
	const other = await secondTower();
	await assert.rejects(other.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-b" }), /Project acme already has 3 live trains \(maxTrains is 3\)/);
	await other.tool("boss_open_main", { role: "train", request: manifest(P, "beta"), sender: "sender-b" });
	assert.equal(trains().length, 4);
});

test("a code is used once on the whole computer: the other workspace's live train blocks it, and so does the trainboard folder of a train that has ended", async () => {
	world.autoMains();
	const { tower } = await net();
	await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	const other = await secondTower();
	await assert.rejects(other.tool("boss_open_main", { role: "train", request: manifest(M, "acme", "cars: T-9"), sender: "sender-b" }), /train 1106m of project acme is already open/);
	world.herdr.panes = world.herdr.panes.filter((p) => p.tokens.sb_train !== `acme/${M}`); // the train ended and its tab is gone
	writtenBoard(M, { steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] });
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(M, "acme", "round: 2"), sender: "sender-1" }), /train 1106m of project acme was already used/);
	assert.equal(trains().length, 0);
	await tower.tool("boss_open_main", { role: "train", request: manifest(M, "beta"), sender: "sender-1" }); // the same code of another project is another train
	assert.equal(trains().length, 1);
});

test("a live trainboard counts toward maxTrains when its pane is gone; an ended one does not", async () => {
	world.autoMains();
	const { tower } = await net();
	writtenBoard(M);
	writtenBoard(N);
	writtenBoard(O);
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" }), /Project acme already has 3 live trains \(maxTrains is 3\)/);
	writtenBoard(O, { steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] });
	await tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" });
	assert.equal(trains().length, 1);
});

test("a board whose writer is gone and that nobody updated for ten minutes is stale and counts for nothing, while a live writer keeps an old board counted", async () => {
	world.autoMains();
	const { tower } = await net();
	const gone = spawnSync(process.execPath, ["-e", ""]).pid!; // a pid that has ended
	const old = new Date(Date.now() - 20 * 60_000).toISOString();
	writtenBoard(M, { writer: { session: "dead-train", pid: gone, started: old }, updated: old });
	writtenBoard(N, { writer: { session: "dead-train", pid: gone, started: old }, updated: old });
	writtenBoard(O, { updated: old }); // the writer is this process: alive
	await tower.tool("boss_open_main", { role: "train", request: manifest(P), sender: "sender-1" }); // M and N are stale: only O counts, and 2 of 3 places are free
	await tower.tool("boss_open_main", { role: "train", request: manifest("2026-11-06-q"), sender: "sender-1" });
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest("2026-11-06-r"), sender: "sender-1" }), /Project acme already has 3 live trains \(maxTrains is 3\)/);
});

test("a train with a live pane and a live board counts once", async () => {
	world.autoMains();
	const { tower } = await net();
	for (const code of [M, N]) await tower.tool("boss_open_main", { role: "train", request: manifest(code), sender: "sender-1" });
	writtenBoard(M);
	writtenBoard(N);
	await tower.tool("boss_open_main", { role: "train", request: manifest(O), sender: "sender-1" });
	assert.equal(trains().length, 3);
});

test("the same manifest from the same sender opens once and says so", async () => {
	world.autoMains();
	const { tower } = await net();
	const first = await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	const again = await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.equal((first.details as { repeated?: boolean }).repeated, undefined);
	assert.equal((again.details as { repeated?: boolean }).repeated, true);
	assert.match(textOf(again), /A train was already opened for this request/);
});

test("a manifest without a project or a code, with an unsafe name, or with a bad code opens nothing and says what is missing", async () => {
	world.autoMains();
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: "merge the cars", sender: "sender-1" }), /missing project and code/);
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: "project: acme", sender: "sender-1" }), /missing code/);
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest("1106m"), sender: "sender-1" }), /is not a train code/);
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(M, "../up"), sender: "sender-1" }), /not a path-safe name/);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("a train is opened for a session of this computer: a request for a teammate's device is refused before anything is read", async () => {
	const open = opener({} as never);
	await assert.rejects(open({ role: "train", request: manifest(M), sender: "d1", peer: { id: "d1", label: "Ann's laptop", short: "ab12" } }), /A train is opened for a session of this computer, not for a teammate's device/);
});

test("a main and a train of the same sender and the same text are two requests: the train is opened, not given the main's open back", async () => {
	world.autoMains();
	const { tower } = await net();
	const main = await tower.tool("boss_open_main", { request: manifest(M), sender: "sender-1" });
	const train = await tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" });
	assert.equal((main.details as { train?: unknown }).train, undefined);
	assert.deepEqual((train.details as { train?: unknown }).train, { project: "acme", code: M });
	assert.equal((train.details as { repeated?: boolean }).repeated, undefined);
	assert.equal(trains().length, 1);
});

test("a role other than train is refused before anything opens", async () => {
	world.autoMains();
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { role: "main", request: "x", sender: "sender-1" }), /role must be "train"/);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("with the merge train off on this computer a train is refused with the reason, and a main still opens", async () => {
	world.autoMains();
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, integration: "off" }));
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" }), /integration is off on this computer/);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	await tower.tool("boss_open_main", { request: "one", sender: "sender-1" });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
});

test("a pi that joins the tab as anything but the train fails the open, closes the tab, and hands over nothing", async () => {
	world.herdr.onAgentStart = (pane) => void world.agent({ id: `plain-${pane.pane_id}`, pane: pane.pane_id }).start(); // no STRAW_BOSS_ROLE: it joins as a member
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { role: "train", request: manifest(M), sender: "sender-1" }), /did not become the train of its tab within 60 s/);
	assert.equal(world.herdr.closed.length, 1);
	assert.deepEqual(world.broker.delivered.filter((d) => d.to.startsWith("plain-")), []);
});

test("the manifest's words: project and code from key lines or JSON, the first of each, in a path-safe name and a real code", () => {
	assert.deepEqual(trainFromRequest(manifest(M)), { project: "acme", code: M });
	assert.deepEqual(trainFromRequest('{"train": {"project": "acme", "code": "2026-11-06-m"}}'), { project: "acme", code: M });
	assert.deepEqual(trainFromRequest(`project: first\ncode: ${M}\ncars:\n  - project: second\n    code: ${N}`), { project: "first", code: M });
	assert.match((trainFromRequest("code: 2026-11-06-m") as { refusal: string }).refusal, /missing project/);
	assert.match((trainFromRequest(`project: a\ncode: 2026-02-30-m`) as { refusal: string }).refusal, /not a train code/);
	assert.match((trainFromRequest(`project: ..\ncode: ${M}`) as { refusal: string }).refusal, /not a path-safe name/);
});

test("a train token is <project>/<code> and reads back only as exactly that; the label is the short code", () => {
	assert.equal(trainToken({ project: "acme", code: M }), "acme/2026-11-06-m");
	assert.deepEqual(trainFromToken("acme/2026-11-06-m"), { project: "acme", code: M });
	for (const bad of [undefined, "", "acme", "/2026-11-06-m", "a/b/2026-11-06-m", "acme/1106m", "..//2026-11-06-m", 5]) assert.equal(trainFromToken(bad), undefined, String(bad));
	assert.equal(trainLabel(M), "train 1106m");
	assert.equal(trainLabel("2026-11-06-ab"), "train 1106ab");
});

test("maxTrains: 3 when nothing says; a whole number from 1 to 32 when apps.json does; a file that cannot be read is a refusal, not a guess", () => {
	assert.equal(DEFAULT_MAX_TRAINS, 3);
	assert.equal(maxTrainsOf(undefined), 3);
	assert.equal(maxTrainsOf(5), 5);
	for (const bad of [0, 33, 1.5, "3", null, [], {}]) assert.match((maxTrainsOf(bad) as { refusal: string }).refusal, /whole number from 1 to 32/, JSON.stringify(bad));
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-maxtrains-")));
	try {
		assert.equal(readMaxTrains(dir), 3, "no file: the default");
		mkdirSync(join(dir, ".straw-boss"));
		const file = join(dir, ".straw-boss", "apps.json");
		writeFileSync(file, JSON.stringify({ apps: {} }));
		assert.equal(readMaxTrains(dir), 3, "no integration: the default");
		writeFileSync(file, JSON.stringify({ integration: { maxTrains: 2 } }));
		assert.equal(readMaxTrains(dir), 2);
		writeFileSync(file, "{ not json");
		assert.match((readMaxTrains(dir) as { refusal: string }).refusal, /cannot be parsed/);
		writeFileSync(file, JSON.stringify({ integration: 7 }));
		assert.match((readMaxTrains(dir) as { refusal: string }).refusal, /integration must be an object/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
