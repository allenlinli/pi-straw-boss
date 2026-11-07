import assert from "node:assert/strict";
import { test } from "node:test";
import { chatKey, createAnswered, docKey } from "../src/answered.ts";

// The sb server's record of which blocks were answered (docs/specs/2026-11-07-better-show-host.md, "Answered"): one owned file, bounded and pruned, read by every device and base; an answer is `pending` while it is on its way and
// `done` with the fields that went; a block that is pending or done is never answered again; a storage error never reopens a block silently.

const disk = (initial?: string) => {
	const box = { text: initial, saves: 0, fail: false, failLoad: false };
	return {
		box,
		load: () => { if (box.failLoad) throw new Error("EIO"); return box.text; },
		save: (text: string) => { if (box.fail) throw new Error("ENOSPC"); box.text = text; box.saves++; },
	};
};
const F: [string, string][] = [["store", "SQLite"], ["why", "simple"]];

test("an answer is begun once, pending until it is done, and then answered for good: nobody begins it again", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e7", 2);
	assert.equal(a.get(key), undefined);
	assert.equal(a.begin(key), "ok");
	assert.equal(a.get(key)?.state, "pending");
	assert.equal(a.begin(key), "pending", "a second device while the first answer is on its way");
	assert.equal(a.done(key, F), true);
	assert.deepEqual(a.get(key), { state: "done", fields: F, at: a.get(key)!.at });
	assert.equal(a.begin(key), "answered");
	a.cancel(key);
	assert.equal(a.get(key)?.state, "done", "a finished answer is not cancelled");
});

test("a refused or failed delivery is cancelled: the block is open again, on this server and after a restart", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e7", 0);
	a.begin(key);
	a.cancel(key);
	assert.equal(a.get(key), undefined);
	assert.equal(createAnswered({ ...d }).get(key), undefined);
	assert.equal(a.begin(key), "ok");
});

test("the record survives a restart of the server: answered and pending both, and a pending one expires", () => {
	const d = disk();
	let now = 1_000_000;
	const a = createAnswered({ ...d, now: () => now, pendingMs: 120_000 });
	const k1 = chatKey("S1", "e1", 0), k2 = docKey("S1", "docs/plan.md", "0123456789abcdef", 3);
	a.begin(k1);
	a.done(k1, F);
	a.begin(k2);
	const again = createAnswered({ ...d, now: () => now, pendingMs: 120_000 });
	assert.deepEqual(again.get(k1), { state: "done", fields: F, at: 1_000_000 });
	assert.equal(again.get(k2)?.state, "pending");
	assert.equal(again.begin(k2), "pending");
	now += 120_001;
	assert.equal(again.get(k2), undefined, "an answer never confirmed within two minutes was not delivered, or was and told the page so");
	assert.equal(again.begin(k2), "ok");
});

test("a document's key is its owner, its name, the text's hash, and the block: it holds no capability, so it outlives a restart and a new capability", () => {
	const k = docKey("S1", "docs/plan.md", "0123456789abcdef", 3);
	assert.equal(k, docKey("S1", "docs/plan.md", "0123456789abcdef", 3));
	for (const other of [docKey("S2", "docs/plan.md", "0123456789abcdef", 3), docKey("S1", "docs/other.md", "0123456789abcdef", 3), docKey("S1", "docs/plan.md", "fedcba9876543210", 3), docKey("S1", "docs/plan.md", "0123456789abcdef", 4), chatKey("S1", "docs/plan.md", 3)]) assert.notEqual(k, other);
	assert.notEqual(chatKey("S1", "a\u001fb", 0), chatKey("S1\u001fa", "b", 0), "a separator inside a part cannot move a boundary");
	assert.notEqual(chatKey("S1", "a", 0), chatKey("S1", "a\u0000", 0));
});

test("the record is bounded and pruned: the oldest go past the limit, old ones go at load, a long answer is cut", () => {
	const d = disk();
	let now = 1_000_000;
	const a = createAnswered({ ...d, now: () => now, max: 3, keepMs: 10_000 });
	for (let i = 0; i < 5; i++) {
		now += 100;
		a.begin(chatKey("S", `e${i}`, 0));
		a.done(chatKey("S", `e${i}`, 0), [["q", String(i)]]);
	}
	assert.deepEqual(a.list("chat", "S").map(([k]) => JSON.parse(k)[2]), ["e2", "e3", "e4"], "three newest");
	const saved = createAnswered({ ...d, now: () => now + 9_950, max: 3, keepMs: 10_000 });
	assert.deepEqual(saved.list("chat", "S").map(([k]) => JSON.parse(k)[2]), ["e4"], "e2 and e3 are older than keepMs at load");
	const long = chatKey("S", "long", 0);
	saved.begin(long);
	saved.done(long, Array.from({ length: 80 }, (_, i) => [`f${i}`, "x".repeat(5000)] as [string, string]));
	const kept = saved.get(long);
	assert.ok(kept?.state === "done" && kept.fields.length <= 64 && kept.fields.every(([n, v]) => n.length <= 256 && v.length <= 1024), "at most 64 fields, values of at most 1024 characters");
	assert.ok((d.box.text ?? "").length < 400_000);
});

test("a file that cannot be written refuses to begin: nothing is sent, and the block stays as the source shows it", () => {
	const d = disk(), a = createAnswered({ ...d });
	d.box.fail = true;
	const key = chatKey("S1", "e1", 0);
	assert.equal(a.begin(key), "unsaved");
	assert.equal(a.get(key), undefined, "not even in memory: the page is told, and the block is as it was");
	d.box.fail = false;
	assert.equal(a.begin(key), "ok");
	d.box.fail = true;
	assert.equal(a.done(key, F), false, "delivered, but the record could not be written");
	assert.equal(a.get(key)?.state, "done", "this server still holds it, so no device reopens it before a restart");
	assert.equal(a.begin(key), "answered");
});

test("a file that cannot be read starts empty and says so, once; the first write heals it", () => {
	const bad = disk("{not json");
	const a = createAnswered({ ...bad });
	assert.equal(a.unreadable, true);
	assert.deepEqual(a.list("chat", "S1"), []);
	const key = chatKey("S1", "e1", 0);
	assert.equal(a.begin(key), "ok");
	assert.equal(a.unreadable, false);
	const gone = disk();
	gone.box.failLoad = true;
	assert.equal(createAnswered({ ...gone }).unreadable, true, "an unreadable file (not a missing one)");
	assert.equal(createAnswered({ ...disk() }).unreadable, false, "a missing file is a new record");
	const odd = createAnswered({ ...disk(JSON.stringify({ v: 1, entries: [[chatKey("S", "e", 0), { state: "done", fields: "nope", at: 1 }], 7, ["k", { state: "pending", at: 1 }]] })) });
	assert.deepEqual(odd.list("chat", "S"), [], "an entry out of shape is dropped");
});

test("the file holds only the record: a version, and the entries", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e1", 0);
	a.begin(key);
	a.done(key, F);
	const parsed = JSON.parse(d.box.text!) as { v: number; entries: [string, { state: string; fields?: unknown }][] };
	assert.equal(parsed.v, 1);
	assert.deepEqual(parsed.entries.map(([k, s]) => [k, s.state, s.fields]), [[key, "done", F]]);
});
