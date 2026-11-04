import assert from "node:assert/strict";
import { test } from "node:test";
import { BOSS_MARK } from "../src/eventmarks.ts";
import type { Item } from "../src/items.ts";
import { CLEAR, CLEAR_MS, createFade, FADE_MS, headLines, levelOf, REST, SHOWN, SHOWN_SMALL } from "../gui/headlines.ts";

// The lines under Zen's circle (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle): which history items become lines, how a line fades from the moment it is first on screen, and when the
// strip is at rest. gui/headlines.ts is pure: items and a clock in, lines and opacities out.
const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 9, min)).toISOString();
const bossEvent = (id: string, text: string, min = 0): Item => ({ id, kind: "notice", type: "straw-tower", event: "boss", text: `${BOSS_MARK}\n${text}`, at: at(min) });
const said = (id: string, text: string, min = 0, tools?: Item["tools"]): Item => ({ id, kind: "assistant", text, at: at(min), ...(tools ? { tools } : {}) });
const forward = (id: string, workspace: string, args?: string): NonNullable<Item["tools"]>[number] => ({ id, name: "tower_send", summary: `(workspace: ${workspace})`, args: args ?? JSON.stringify({ workspace, message: "do it" }) });
const answer = (id: string, workspace: string, ask: string, text: string, min = 0): Item => ({
	id, kind: "notice", type: "straw-tower", event: "intercom", at: at(min),
	text: `[intercom from tower · ${workspace} (abc123)]\n[straw net from="tower · ${workspace}" id=abc123 role=tower workspace="${workspace}" kind=tower_send scope=one to="head tower" reply=none in-reply-to=${ask}] ${text}`,
});

test("the boss's turn, the head's final words, a forward, and an answer become lines, in order, with their times", () => {
	const lines = headLines([
		bossEvent("u1", "Start MP-4129 for me", 1),
		said("a1", "Handing it to MP Center.", 2, [{ ...forward("t1", "MP Center") }]),
		answer("n1", "MP Center", "H12", "Opened main for MP-4129.", 5),
		said("a2", "MP Center says main is open.", 6),
	]);
	assert.deepEqual(lines.map((l) => [l.who, l.text]), [
		["boss", "Start MP-4129 for me"],
		["note", "→ MP Center tower"],
		["head", "Handing it to MP Center."],
		["note", "Answer from the MP Center tower"],
		["head", "MP Center says main is open."],
	]);
	assert.equal(lines[0]!.at, Date.parse(at(1)));
	assert.equal(new Set(lines.map((l) => l.id)).size, lines.length, "every line has an id of its own");
});

test("a plain user item is the boss's too, and the server's marker line is never part of his words", () => {
	const lines = headLines([{ id: "u1", kind: "user", text: "hello there", at: at(0) }, bossEvent("u2", "and the second\nof two lines", 1)]);
	assert.deepEqual(lines.map((l) => l.text), ["hello there", "and the second of two lines"], "marker off, line breaks folded into one space");
	assert.ok(!lines.some((l) => l.text.includes(BOSS_MARK)));
});

test("a head turn gives one line: the final text of the turn, even when it spoke before a tool call", () => {
	const lines = headLines([bossEvent("u1", "go"), said("a1", "Let me look.", 1, [forward("t1", "Harbor API")]), said("a2", "Done: sent to Harbor API.", 2)]);
	assert.deepEqual(lines.map((l) => l.text), ["go", "→ Harbor API tower", "Done: sent to Harbor API."]);
});

test("a tool-only assistant item gives no head line; a forward whose arguments were cut is still found, and one with no workspace gives no note", () => {
	const cut = forward("t1", "Lighthouse Web", `{"workspace":"Lighthouse Web","message":"${"x".repeat(2000)}`);
	const lines = headLines([said("a1", "", 1, [cut, { id: "t2", name: "tower_send", summary: "()", args: "{" }, { id: "t3", name: "board_read", summary: "(x)" }])]);
	assert.deepEqual(lines.map((l) => [l.who, l.text]), [["note", "→ Lighthouse Web tower"]]);
});

test("chapter dividers, results, other notices, and an intercom message that is no answer are skipped, and each ends the head's turn", () => {
	const lines = headLines([
		{ id: "d1", kind: "divider", type: "chapter", code: "first", at: at(0) },
		bossEvent("u1", "one", 1),
		said("a1", "first reply", 2),
		{ id: "r1", kind: "result", callId: "x", text: "ok" },
		{ id: "x1", kind: "notice", type: "straw-tower", event: "intercom", text: "[intercom from someone (id9)]\n[straw net from=bob id=id9 role=main kind=call_tower scope=one to=x reply=none] hi", at: at(3) },
		said("a2", "second reply", 4),
		{ id: "x2", kind: "notice", type: "straw-tower", event: "notice", text: "[notice from the sb server]\nrestarted", at: at(5) },
	]);
	assert.deepEqual(lines.map((l) => l.text), ["one", "first reply", "second reply"]);
});

test("only the last three lines show (two on a phone); the same lines come back for the same items", () => {
	const items = [bossEvent("u1", "a", 1), said("a1", "b", 2), bossEvent("u2", "c", 3), said("a2", "d", 4)];
	const lines = headLines(items);
	assert.equal(SHOWN, 3);
	assert.equal(SHOWN_SMALL, 2);
	assert.deepEqual(lines.slice(-SHOWN).map((l) => l.text), ["b", "c", "d"]);
	assert.deepEqual(headLines(items), lines);
});

test("a line is clear for 20 s, then fades over 3 minutes to 0.16; the newest line is the clearest", () => {
	assert.equal(REST, 0.16);
	assert.equal(CLEAR[0], 1);
	assert.ok(CLEAR[0] > CLEAR[1] && CLEAR[1] > CLEAR[2] && CLEAR[2] > REST, "ranks step down but stay above the rest level");
	for (const rank of [0, 1, 2]) {
		assert.equal(levelOf(rank, 0), CLEAR[rank]);
		assert.equal(levelOf(rank, CLEAR_MS), CLEAR[rank], "still clear at 20 s");
		assert.equal(levelOf(rank, CLEAR_MS + FADE_MS), REST, "at rest after the fade");
		assert.equal(levelOf(rank, CLEAR_MS + FADE_MS + 60_000), REST);
		const mid = levelOf(rank, CLEAR_MS + FADE_MS / 2);
		assert.ok(Math.abs(mid - (CLEAR[rank]! + REST) / 2) < 1e-9, "linear between");
	}
	assert.equal(FADE_MS, 180_000);
});

test("the clock starts when a line is first on screen, not when it was written", () => {
	let t = 1_000_000;
	const fade = createFade(() => t);
	fade.see(["a"]);
	t += 10_000;
	fade.see(["a", "b"]); // b arrives now, though its item may be hours old
	assert.equal(fade.age("a"), 10_000);
	assert.equal(fade.age("b"), 0);
	t += 30_000;
	assert.equal(levelOf(0, fade.age("a")), levelOf(0, 40_000));
	assert.equal(levelOf(0, fade.age("b")), levelOf(0, 30_000));
	assert.equal(fade.age("never seen"), 0, "a line not seen yet is brand new");
	t += 500_000;
	fade.see(["a"]);
	assert.equal(fade.age("a"), 540_000, "seeing it again does not restart it");
});

test("the strip is at rest only when every shown line is at its rest level and nothing is held; a wait for the boss keeps the strip from resting", () => {
	let t = 0;
	const fade = createFade(() => t);
	fade.see(["a", "b"]);
	assert.equal(fade.rested(["a", "b"], false), false, "fresh lines are not at rest");
	t = CLEAR_MS + FADE_MS - 1;
	assert.equal(fade.rested(["a", "b"], false), false, "a millisecond short");
	t = CLEAR_MS + FADE_MS;
	assert.equal(fade.rested(["a", "b"], false), true);
	assert.equal(fade.rested([], false), true, "no lines: the strip is at rest, so the mindfulness line shows");
	assert.equal(fade.rested(["a", "b"], true), false, "held: the mindfulness line stays away");
	assert.equal(fade.restAt(["a", "b"], false), CLEAR_MS + FADE_MS, "the time the last line gets there, for the one timer");
	assert.equal(fade.restAt([], false), undefined);
});

test("the label of a tower's answer names the tower and never the ask's internal id", async () => {
	for (const file of ["en", "zh-TW"]) {
		const { readFile } = await import("node:fs/promises");
		const label = JSON.parse(await readFile(new URL(`../gui/messages/${file}.json`, import.meta.url), "utf8")).head_from_tower as string;
		assert.doesNotMatch(label, /\{ask\}/, file);
	}
});
