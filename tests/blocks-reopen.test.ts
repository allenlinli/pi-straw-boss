import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import "./fake-dom.ts";
import { answeredHooks, forgetAnswered, readAnswered } from "../gui/answered.ts";
import { forgetLocks, lockFor } from "../gui/blocklock.ts";

// How the page follows the server's record of answered blocks (gui/answered.ts, gui/blocklock.ts): it reads the unit's record again when the last read is older than three seconds, and a block the record showed as on its way (another device's answer, or a 504)
// opens again when a later record no longer lists it (BSR-F004), while a block this page is sending itself, or one that is answered, is not opened by a record that says nothing of it.

type Record_ = { done: [string, number, [string, string][]][]; pending: [string, number][]; unreadable?: boolean };
let record: Record_, asked: number, clock: number;
beforeEach(() => {
	forgetLocks();
	forgetAnswered();
	record = { done: [], pending: [] };
	asked = 0;
	clock = 1_000_000;
	mock.method(Date, "now", () => clock);
	answeredHooks.get = async () => (asked++, record) as never;
});
afterEach(() => mock.restoreAll());

test("BSR-F007 P11: the record is read again once the last read is older than three seconds, and one read is shared before that", async () => {
	await Promise.all([readAnswered("S1"), readAnswered("S1")]);
	assert.equal(asked, 1, "two drawings together share a read");
	clock += 2_999;
	await readAnswered("S1");
	assert.equal(asked, 1, "still fresh");
	clock += 2;
	record = { done: [["e1", 0, [["text", "Go"]]]], pending: [] };
	await readAnswered("S1");
	assert.equal(asked, 2, "stale: read again");
	assert.equal(lockFor("S1", "e1").get(0).state, "done", "and another device's answer is on this page without a reload");
});

test("BSR-F004: a block the record showed as on its way opens again when the record drops it, whether its entry still has other rows or none", async () => {
	record = { pending: [["e1", 0], ["e1", 1], ["e2", 0]], done: [] };
	await readAnswered("S1");
	assert.deepEqual([lockFor("S1", "e1").get(0).state, lockFor("S1", "e1").get(1).state, lockFor("S1", "e2").get(0).state], ["pending", "pending", "pending"]);
	const views: string[] = [];
	lockFor("S1", "e2").watch(0, { show: (cell) => void views.push(cell.state) });
	clock += 3_001;
	record = { pending: [["e1", 1]], done: [["e1", 0, [["text", "Go"]]]] };
	await readAnswered("S1");
	assert.equal(lockFor("S1", "e1").get(0).state, "done", "answered meanwhile: locked with the fields");
	assert.equal(lockFor("S1", "e1").get(1).state, "pending", "still on its way");
	assert.equal(lockFor("S1", "e2").get(0).state, "open", "its entry has no row any more: the answer was refused, or expired");
	assert.deepEqual(views, ["open"], "the drawing is told");
	clock += 3_001;
	record = { pending: [], done: [["e1", 0, [["text", "Go"]]]] };
	await readAnswered("S1");
	assert.equal(lockFor("S1", "e1").get(1).state, "open");
	assert.equal(lockFor("S1", "e1").get(0).state, "done", "an answered block never opens by a record that says nothing of it");
});

test("BSR-F004: a block this page is sending itself stays pending whatever the record says, and a document's seed reopens its stale pending blocks the same way", () => {
	const lock = lockFor("doc", "cap", "rev");
	lock.seed({ done: [], pending: [0, 1] });
	lock.pend(1); // this page's own send takes block 1 over
	lock.seed({ done: [], pending: [] });
	assert.equal(lock.get(0).state, "open", "seeded as on its way, no longer listed");
	assert.equal(lock.get(1).state, "pending", "mine: it ends when my delivery does");
	lock.done(1, [["q", "a"]]);
	lock.seed({ done: [], pending: [] });
	assert.equal(lock.get(1).state, "done");
	lockFor("doc", "cap", "other").seed({ done: [], pending: [] });
	lock.seed({ done: [], pending: [2] });
	lockFor("doc", "cap", "other").seed({ done: [], pending: [] });
	lockFor("doc", "cap").seed({ done: [], pending: [] });
	assert.equal(lock.get(2).state, "pending", "another scope's seed does not touch it, nor does one whose scope is a prefix of its");
});

test("BSR-F004: a seed looks at its own scope's blocks only: another scope's pending block of the same number, or a longer scope that starts with the same parts, does not open this one's send in flight", () => {
	const mine = lockFor("S", "e1"), other = lockFor("S", "e2"), shorter = lockFor("S");
	mine.pend(3); // this page is sending block 3 of S/e1
	shorter.pend(3); // and block 3 of S itself
	other.seed({ done: [], pending: [3] }); // another message's block 3 is on its way elsewhere
	mine.seed({ done: [], pending: [] });
	shorter.seed({ done: [], pending: [] });
	assert.equal(mine.get(3).state, "pending", "not another entry's block 3");
	assert.equal(shorter.get(3).state, "pending", "not a longer scope's block 3");
	assert.equal(other.get(3).state, "pending");
	other.seed({ done: [], pending: [] });
	assert.equal(other.get(3).state, "open", "its own seed does reopen it");
});

test("PBS-F001: a lock keeps all 64 questions and the reserved pi-note, on a send and on a seed from the record", () => {
	const fields: [string, string][] = [...Array.from({ length: 64 }, (_, i) => [`q${i}`, "a"] as [string, string]), ["pi-note", "the note"]];
	const lock = lockFor("doc", "cap", "pbs-f001");
	lock.done(0, fields);
	lock.seed({ done: [[1, fields]], pending: [] });
	for (const i of [0, 1]) {
		const cell = lock.get(i);
		assert.equal(cell.state, "done");
		assert.deepEqual(cell.state === "done" ? cell.fields.at(-1) : undefined, ["pi-note", "the note"], `block ${i} shows the note`);
	}
});
