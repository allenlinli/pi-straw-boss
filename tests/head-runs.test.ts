import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HEAD_RUN_TOOLS } from "../src/runallow.ts";
import { type BossPointer, readPointer, writePointer } from "../src/server/bossconv.ts";
import { HEAD_CHAPTER_MAX, readChapters } from "../src/server/headchapters.ts";
import { openAsk } from "../src/server/headasks.ts";
import { readNotes, readRun } from "../src/server/towerrunstore.ts";
import { callControl } from "../src/server/socket.ts";
import { HEAD_KEY, headDir } from "../src/server/towerstore.ts";
import { addWait, updateMemory } from "../src/server/towermemory.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The head tower's runs (docs/specs/2026-11-04-head-tower.md, Runs; H2): every run resumes the one conversation, a chapter replaces the 4 MB and 7 day reset, the boss's and an answer's limits, one run at a time.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	world.runTimers = { hold: 120 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const head = await world.expose!.head.ensure();
	return { s, head, ws: head.workspace };
};
const nthRun = async (ws: string, n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the run's pid to be recorded");
	return id;
};
const claimRun = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { token: String(got.token), brief: String(got.brief), reply: got };
};
const poll = (s: Running, token: string, idle = true) => ask(s, { cmd: "run-poll", token, idle });
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await poll(s, token)).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const argsOf = (id: string) => world.pis.get(id)!.args.slice(world.pis.get(id)!.args.indexOf("--") + 1);
const sessions = () => join(world.env.PI_CODING_AGENT_DIR!, "sessions", "--head--");
const sessionFile = (name: string, bytes = 200, body?: string) => {
	mkdirSync(sessions(), { recursive: true });
	const file = join(sessions(), name);
	writeFileSync(file, body ?? "x".repeat(bytes));
	return file;
};
/** The boss writes to the head (present) and the run it wakes is claimed, drained, and reports `file`. */
const talk = async (s: Running, ws: string, n: number, file: string, text = "hello") => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: ws, text, present: true })).ok, true);
	const id = await nthRun(ws, n);
	const c = await claimRun(s, id);
	await ask(s, { cmd: "run-file", token: c.token, file });
	await drain(s, c.token);
	return { id, ...c };
};
const quit = async (s: Running, ws: string, run: { id: string; token: string }) => {
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "ignored", left: true })).ok, true);
	exit(run.id);
	await until(() => readRun(world.slot, ws, run.id)?.outcome === "done", "the conversation to end as done");
};

test("the first run: no session to resume, the head's tools and role, a boss-named run; its brief says who it is and which chapter; its file becomes the pointer and the first chapter", async () => {
	const { s, ws } = await setup();
	const file = sessionFile("2026-11-04_aaa.jsonl");
	const c = await talk(s, ws, 1, file);
	const args = argsOf(c.id);
	assert.deepEqual(args.slice(0, 4), ["--name", "head · boss", "--sb-run", c.id]);
	assert.ok(!args.includes("--session"));
	assert.equal(args[args.indexOf("--tools") + 1], HEAD_RUN_TOOLS.join(","));
	for (const t of ["bash", "write", "edit", "subagent", "boss_open_main", "boss_close_main", "call_tower", "boss_status", "tower_reply", "link_request"]) assert.ok(!HEAD_RUN_TOOLS.includes(t), `${t} is not a head tool`);
	assert.match(world.herdr.commands("agent", "start")[0]![2]!, /^head-[a-z0-9]+-[0-9a-f]{8}$/);
	assert.equal(c.reply.kind, "head");
	assert.equal(c.reply.identity, "sb-head");
	assert.match(c.brief, /^You are the head tower: the boss's own tower, in no workspace\. This session is your one conversation with the boss \(chapter 1, since \d{4}-\d\d-\d\d, 0 boss turns\)\./);
	assert.match(c.brief, /The boss is at this pane now/);
	assert.equal(readPointer(world.slot, ws)!.file.endsWith("2026-11-04_aaa.jsonl"), true);
	const chapters = readChapters(world.slot);
	assert.equal(chapters.length, 1);
	assert.deepEqual({ n: chapters[0]!.n, why: chapters[0]!.why, to: chapters[0]!.to }, { n: 1, why: "the first conversation", to: undefined });
	assert.equal((await ask(s, { cmd: "run-done", token: c.token, note: "n" })).stay, true, "the boss is in the run: tower_done stays");
});

test("every run resumes the one conversation: the next boss message, and a run woken by a tower's answer while the boss is away, both start with --session; the answer's run is an event run (no boss in it)", async () => {
	const { s, ws } = await setup();
	const file = sessionFile("2026-11-04_aaa.jsonl");
	await quit(s, ws, await talk(s, ws, 1, file));
	// A tower's answer wakes a run.
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const wa = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it" });
	world.client("sb-head")!.incoming({ id: "sb-tower-wa", name: "tower · Alpha" }, { id: "a1", content: { text: `[straw net from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=tower to="head tower (head tower of head)" reply=none in-reply-to=${wa.id}] landed` } } as never);
	const id = await nthRun(ws, 2);
	const args = argsOf(id);
	assert.equal(args[args.indexOf("--session") + 1].endsWith("2026-11-04_aaa.jsonl"), true, "an answer's run resumes the conversation too");
	assert.equal(args[args.indexOf("--tools") + 1], HEAD_RUN_TOOLS.join(","));
	assert.match(args[1]!, /^head run · [0-9a-f]{8}$/);
	assert.equal(readRun(world.slot, ws, id)?.conversation, undefined, "no boss in it");
	const c = await claimRun(s, id);
	assert.doesNotMatch(c.brief, /The boss is at this pane now/);
	assert.match(c.brief, /chapter 1/);
	const events = [] as string[];
	for (;;) {
		const e = (await poll(s, c.token)).event as { id: string; text: string } | undefined;
		if (!e) break;
		events.push(e.text);
		await ask(s, { cmd: "run-taken", token: c.token, id: e.id });
	}
	assert.equal(events.length, 1);
	assert.equal((await ask(s, { cmd: "run-done", token: c.token, note: "told the boss Alpha landed it" })).ok, true, "an event run ends with its note");
	assert.equal(readPointer(world.slot, ws)!.file.endsWith("2026-11-04_aaa.jsonl"), true, "and the pointer stays");
	assert.equal(readNotes(world.slot, ws).at(-1)!.note, "told the boss Alpha landed it");
});

test("HM-F004: the head's real brief names the waits for the boss that lapsed, not a wait for an agent and not a fresh one; with none it has no such line", async () => {
	const { s, ws } = await setup();
	const now = Date.now();
	updateMemory(world.slot, HEAD_KEY, now, (m) => {
		addWait(m, now - 30 * 3_600_000, "r1", { text: "a day old, no due", for: "boss" });
		addWait(m, now - 2 * 3_600_000, "r1", { text: "for an agent, past its due", for: "agent", on: { id: "s1", name: "main" }, dueMin: 60 });
		addWait(m, now, "r1", { text: "fresh", for: "boss" });
	});
	const first = await talk(s, ws, 1, sessionFile("2026-11-06_lapsed.jsonl"));
	assert.match(first.brief, /Lapsed waits \(the boss no longer sees them on the page\): W1\. Resolve each/);
	assert.doesNotMatch(first.brief, /Lapsed waits[^\n]*W2/, "an agent's wait is not the boss's");
	assert.doesNotMatch(first.brief, /Lapsed waits[^\n]*W3/);
	updateMemory(world.slot, HEAD_KEY, now, (m) => void (m.entries.find((e) => e.id === "W1")!.state = "resolved"));
	await ask(s, { cmd: "run-done", token: first.token, note: "x", left: true });
	exit(first.id);
	await until(() => readRun(world.slot, ws, first.id)?.outcome === "done", "the conversation to end");
	const second = await talk(s, ws, 2, sessionFile("2026-11-06_lapsed.jsonl"));
	assert.doesNotMatch(second.brief, /Lapsed waits/);
});

test("a session over 8 MB is not resumed: a new chapter starts, its brief says why with the last note and the last lines between the boss and the head, and the chapter list gets the new file", async () => {
	const { s, ws } = await setup();
	const lines = [
		{ type: "custom_message", id: "1", display: true, customType: "straw-tower", details: { kind: "boss" }, content: "[the boss writes to you from the GUI or /boss tower; this is an instruction]\nplease start MP-4129", timestamp: "2026-11-04T01:00:00Z" },
		{ type: "message", id: "2", message: { role: "assistant", content: [{ type: "text", text: "Forwarded to the MP Center tower as H1." }] }, timestamp: "2026-11-04T01:00:05Z" },
	].map((x) => JSON.stringify(x)).join("\n") + "\n";
	const big = sessionFile("2026-11-04_big.jsonl", 0, "x".repeat(HEAD_CHAPTER_MAX) + "\n" + lines);
	const first = await talk(s, ws, 1, big);
	assert.equal(HEAD_CHAPTER_MAX, 8 * 1024 * 1024);
	await ask(s, { cmd: "run-done", token: first.token, note: "(ignored)", left: true });
	exit(first.id);
	await until(() => readRun(world.slot, ws, first.id)?.outcome === "done", "the first conversation to end");
	const second = await talk(s, ws, 2, sessionFile("2026-11-04_next.jsonl"), "again");
	assert.ok(!argsOf(second.id).includes("--session"), "over the limit: a new session");
	assert.match(second.brief, /New chapter 2: the last one grew past 8 MB/);
	assert.match(second.brief, /boss: please start MP-4129/);
	assert.match(second.brief, /head: Forwarded to the MP Center tower as H1\./);
	assert.match(second.brief, /chapter 2/);
	const chapters = readChapters(world.slot);
	assert.deepEqual(chapters.map((c) => [c.n, c.file.endsWith("big.jsonl") ? "big" : "next"]), [[1, "big"], [2, "next"]]);
	assert.equal(typeof chapters[0]!.to, "string", "the old chapter has an end");
	assert.match(chapters[1]!.why, /grew past 8 MB/);
	assert.equal(readPointer(world.slot, ws)!.file.endsWith("next.jsonl"), true);
});

test("there is no age limit: a conversation whose last boss turn was 40 days ago is resumed", async () => {
	const { s, ws } = await setup();
	const file = sessionFile("2026-10-01_old.jsonl");
	await quit(s, ws, await talk(s, ws, 1, file));
	const was = readPointer(world.slot, ws) as BossPointer;
	writePointer(world.slot, ws, { ...was, lastAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
	const second = await talk(s, ws, 2, file, "still here");
	assert.equal(argsOf(second.id)[argsOf(second.id).indexOf("--session") + 1].endsWith("old.jsonl"), true);
	assert.doesNotMatch(second.brief, /New chapter/);
});

test("/new starts a chapter, not a fresh start of the list: the next run has no session and says the boss asked; a missing file starts a chapter with that reason", async () => {
	const { s, ws } = await setup();
	await quit(s, ws, await talk(s, ws, 1, sessionFile("2026-11-04_aaa.jsonl")));
	assert.equal((await ask(s, { cmd: "tower-new", workspace: ws })).ok, true);
	assert.equal(readPointer(world.slot, ws)!.fresh, true);
	const second = await talk(s, ws, 2, sessionFile("2026-11-04_bbb.jsonl"));
	assert.ok(!argsOf(second.id).includes("--session"));
	assert.match(second.brief, /New chapter 2: the boss asked for a new conversation/);
	assert.equal(readChapters(world.slot).length, 2);
	assert.equal(readPointer(world.slot, ws)!.fresh, undefined, "the new chapter's file replaces the pointer and the mark");
	await quit(s, ws, second);
	// The file is gone.
	const was = readPointer(world.slot, ws) as BossPointer;
	writePointer(world.slot, ws, { ...was, file: join(sessions(), "gone.jsonl") });
	const third = await talk(s, ws, 3, sessionFile("2026-11-04_ccc.jsonl"));
	assert.ok(!argsOf(third.id).includes("--session"));
	assert.match(third.brief, /New chapter 3: the last session file is gone/);
	assert.deepEqual(readChapters(world.slot).map((c) => c.n), [1, 2, 3]);
});

test("one head run at a time: a message that arrives while a run is live goes into it, and the model comes from headModel, else towerModel", async () => {
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true }, towerModel: "tower/model", headModel: "head/model" }));
	const { s, ws } = await setup();
	const c = await talk(s, ws, 1, sessionFile("2026-11-04_aaa.jsonl"));
	const args = argsOf(c.id);
	assert.equal(args[args.indexOf("--model") + 1], "head/model");
	assert.equal((await ask(s, { cmd: "tower-event", workspace: ws, text: "one more thing", present: true })).ok, true);
	const e = (await poll(s, c.token)).event as { text: string };
	assert.equal(e.text, "one more thing");
	assert.equal(world.pis.size, 1);
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	// Without headModel the tower model is used.
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true }, towerModel: "tower/model" }));
	await quit(s, ws, c);
	const next = await talk(s, ws, 2, sessionFile("2026-11-04_aaa.jsonl"));
	assert.equal(argsOf(next.id)[argsOf(next.id).indexOf("--model") + 1], "tower/model");
});

test("the brief: the workspaces now (label, id, folder, tower state), the open asks, the head's memory, and the last handoff note; at most 8,000 characters", async () => {
	const { s, ws } = await setup();
	openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "start MP-4129" });
	writeFileSync(join(headDir(world.slot), "memory.json"), JSON.stringify({ v: 1, rev: 1, next: { S: 2, D: 1, W: 1, P: 1 }, entries: [{ id: "S1", kind: "standing", text: "Always forward MP work to MP Center", by: "boss", via: "gui", at: "2026-11-04T00:00:00Z" }], proposals: [] }));
	const first = await talk(s, ws, 1, sessionFile("2026-11-04_aaa.jsonl"));
	assert.match(first.brief, /Workspaces now:\n- Alpha \(wA\), \/w\/alpha: tower standing by/);
	assert.match(first.brief, /- Beta \(wB\)[^\n]*: no tower/);
	assert.doesNotMatch(first.brief, /Head tower \(/, "the head workspace is never a row");
	assert.match(first.brief, /Open asks:\n- H1 Alpha, \d+m: start MP-4129/);
	assert.match(first.brief, /Always forward MP work to MP Center/);
	assert.ok(first.brief.length <= 8000);
	assert.match(first.brief, /tower_send/);
	assert.match(first.brief, /Call tower_done with a handoff note/);
	await ask(s, { cmd: "run-done", token: first.token, note: "x", left: true });
	exit(first.id);
	await until(() => readRun(world.slot, ws, first.id)?.outcome === "done", "the conversation to end");
	const second = await talk(s, ws, 2, sessionFile("2026-11-04_aaa.jsonl"));
	assert.match(second.brief, /Handoff note from the last run \(\d+m ago\):\n\(boss quit\)/);
	assert.match(readFileSync(join(headDir(world.slot), "boss-session.json"), "utf8"), /aaa\.jsonl/);
});
