import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent, bindDir, deleteService, HEAD_KEY, headDir, KEEP_MS, listServices, MAX_QUEUE, purgeAll, purgeQueues, putLedger, queueLength, readLedger, readQueue, readService, type ServiceRecord, towerDir, unbindDir, writeService } from "../src/server/towerstore.ts";
import type { Slot } from "../src/server/record.ts";

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-tq-")) }) as Slot;
const service = (): ServiceRecord => ({ workspace: "wA", label: "A", id: "sb-tower-wa", name: "tower · A", pane: "wA:p1", tab: "wA:t1", created: "x", seq: 0 });
const event = (n: number) => ({ kind: "intercom" as const, from: { id: "x" }, text: `t${n}`, at: "now", messageId: `m${n}` });

test("B4R-F007: the queue keeps at most MAX_QUEUE events: the oldest go first, the sequence goes on", () => {
	const slot = slotIn(), svc = service();
	for (let n = 0; n < 12; n++) appendEvent(slot, svc, event(n), 10);
	assert.equal(queueLength(slot, "wA"), 10);
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	assert.ok(MAX_QUEUE >= 100);
});

test("B4R-F007: events older than a day go while the service lives", () => {
	const slot = slotIn(), svc = service();
	appendEvent(slot, svc, event(1));
	appendEvent(slot, svc, event(2));
	const dir = join(slot.dir, "tower", "wA", "queue"), [first] = readdirSync(dir).sort();
	const old = new Date(Date.now() - KEEP_MS - 60_000);
	utimesSync(join(dir, first!), old, old);
	assert.equal(purgeQueues(slot, Date.now()), 1);
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [1]);
});

test("B4R-F007: a reopened service numbers past the events still queued, with the count cached per process", () => {
	const slot = slotIn();
	appendEvent(slot, service(), event(1));
	appendEvent(slot, service(), event(2)); // a service record that starts again at 0
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [0, 1]);
});

test("B5R-F001/F004: an old queue/parked folder does not throw; its old files age out; purgeAll removes parked, runs, notes and the rest", async () => {
	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { purgeAll } = await import("../src/server/towerstore.ts");
	const slot = slotIn();
	appendEvent(slot, service(), event(1));
	const base = join(slot.dir, "tower", "wA"), parked = join(base, "queue", "parked");
	mkdirSync(parked, { recursive: true });
	writeFileSync(join(parked, "old.json"), "{}");
	writeFileSync(join(parked, "new.json"), "{}");
	const old = new Date(Date.now() - KEEP_MS - 60_000);
	utimesSync(parked, old, old);
	utimesSync(join(parked, "old.json"), old, old);
	assert.equal(purgeQueues(slot, Date.now()), 1);
	assert.deepEqual(readdirSync(parked), ["new.json"]);
	mkdirSync(join(base, "runs"), { recursive: true });
	for (const f of ["runs/r1.json", "notes.jsonl", "expects.json", "timer.json", "seen.jsonl", "ally-routes.json", "ally-answers.json", "ally-opened.json"]) writeFileSync(join(base, f), "x");
	assert.ok(purgeAll(slot) >= 10);
	assert.deepEqual(readdirSync(base), []);
	assert.equal(existsSync(parked), false);
});

// The service's state folder (docs/specs/2026-11-04-head-tower.md, State: `ServiceRef.dir`): a workspace tower's is `tower/<workspace id>/`, the head's is `head/`, whatever the Herdr id of its workspace is.
// The store resolves a service's folder from its key once (`towerDir`), so every function that takes the workspace id (the queue, the records, the ledger, runs, notes, memory) reaches the head's folder by the id the head is bound to.
const head = (): ServiceRecord => ({ workspace: "w9", label: "Head tower", id: "sb-head", name: "head tower", pane: "w9:p1", tab: "w9:t1", created: "x", seq: 0, kind: "head" });
const modeOf = (path: string) => statSync(path).mode & 0o777;

test("a workspace tower's folder is tower/<id>/ until the id is bound to a folder, and the head's folder is head/ beside it, not inside it", () => {
	const slot = slotIn();
	assert.equal(towerDir(slot, "w9"), join(slot.dir, "tower", "w9"));
	assert.equal(headDir(slot), join(slot.dir, "head"));
	bindDir(slot, "w9", headDir(slot));
	assert.equal(towerDir(slot, "w9"), headDir(slot));
	assert.equal(towerDir(slot, "wA"), join(slot.dir, "tower", "wA"), "other ids are untouched");
	assert.equal(towerDir({ dir: join(slot.dir, "other") } as Slot, "w9"), join(slot.dir, "other", "tower", "w9"), "and so is another slot's");
	unbindDir(slot, "w9");
	assert.equal(towerDir(slot, "w9"), join(slot.dir, "tower", "w9"));
});

test("the queue, the service record, and the ledger of a bound id are written in head/ (mode 700, files 600), and the tower listing does not find them", () => {
	const slot = slotIn(), svc = head();
	bindDir(slot, "w9", headDir(slot));
	writeService(slot, svc);
	assert.equal(modeOf(headDir(slot)), 0o700);
	assert.equal(modeOf(join(headDir(slot), "service.json")), 0o600);
	assert.deepEqual(readService(slot, "w9"), svc);
	assert.equal(readService(slot, "w9")?.kind, "head");
	const written = appendEvent(slot, svc, event(1));
	assert.equal(modeOf(join(headDir(slot), "queue")), 0o700);
	assert.equal(modeOf(join(headDir(slot), "queue", readdirSync(join(headDir(slot), "queue"))[0]!)), 0o600);
	assert.deepEqual(readQueue(slot, "w9").map((e) => e.id), [written.id]);
	assert.equal(queueLength(slot, "w9"), 1);
	putLedger(slot, "w9", { key: "k", at: Date.now() } as never, Date.now());
	assert.equal(readLedger(slot, "w9", Date.now()).length, 1);
	assert.deepEqual(listServices(slot), [], "tower/ holds no head record");
	assert.equal(existsSync(join(slot.dir, "tower", "w9")), false);
});

test("purgeQueues and purgeAll reach head/ too: the queue ages out after a day and the flag off purges service.json and the queue, but not the conversation's files", () => {
	const slot = slotIn(), svc = head();
	bindDir(slot, "w9", headDir(slot));
	writeService(slot, svc);
	appendEvent(slot, svc, event(1));
	appendEvent(slot, svc, event(2));
	const dir = join(headDir(slot), "queue"), [first] = readdirSync(dir).sort();
	const old = new Date(Date.now() - KEEP_MS - 60_000);
	utimesSync(join(dir, first!), old, old);
	assert.equal(purgeQueues(slot, Date.now()), 1);
	assert.deepEqual(readQueue(slot, "w9").map((e) => e.seq), [1]);
	for (const f of ["boss-session.json", "chapters.json", "asks.json", "memory.json"]) writeFileSync(join(headDir(slot), f), "{}");
	mkdirSync(join(headDir(slot), "runs"), { recursive: true });
	writeFileSync(join(headDir(slot), "runs", "r1.json"), "{}");
	assert.ok(purgeAll(slot) >= 3, "service.json, the queue's file, the run's record");
	assert.deepEqual(readdirSync(headDir(slot)).sort(), ["asks.json", "boss-session.json", "chapters.json", "memory.json"]);
});

// HH1-F004: a record is kept where its kind says, not where its key happens to be bound; the head's constant key reaches head/ with no head service standing.
test("HH1-F004: a `kind: head` record is written to head/ whatever its key is bound to, and a tower's record to tower/<id>/ even while the same id is bound to head/", () => {
	const slot = slotIn();
	writeService(slot, head());
	assert.equal(existsSync(join(headDir(slot), "service.json")), true, "unbound: still head/");
	assert.equal(existsSync(join(slot.dir, "tower", "w9")), false);
	bindDir(slot, "w9", headDir(slot));
	const tower = { ...service(), workspace: "w9", id: "sb-tower-w9" };
	writeService(slot, tower);
	assert.equal(existsSync(join(slot.dir, "tower", "w9", "service.json")), true, "the tower's record is in its own folder");
	assert.equal(readService(slot, "w9")?.kind, "head", "head/ keeps the head's record");
	assert.deepEqual(listServices(slot).map((r) => r.id), ["sb-tower-w9"]);
});

test("HH1-F004: listServices skips a `kind: head` record found in tower/<id>/, so a head record that landed there is not adopted as a second head", () => {
	const slot = slotIn();
	mkdirSync(join(slot.dir, "tower", "w9"), { recursive: true });
	writeFileSync(join(slot.dir, "tower", "w9", "service.json"), JSON.stringify(head()));
	writeService(slot, service());
	assert.deepEqual(listServices(slot).map((r) => r.id), ["sb-tower-wa"]);
});

test("HH1-F001: deleteService takes the record's kind: a tower's record is deleted from tower/<id>/ and the head's from head/, whatever the id is bound to", () => {
	const slot = slotIn();
	writeService(slot, head());
	const tower = { ...service(), workspace: "w9" };
	writeService(slot, tower);
	bindDir(slot, "w9", headDir(slot));
	deleteService(slot, "w9");
	assert.equal(existsSync(join(slot.dir, "tower", "w9", "service.json")), false, "the tower's record went");
	assert.equal(existsSync(join(headDir(slot), "service.json")), true, "the head's stays");
	deleteService(slot, "w9", "head");
	assert.equal(existsSync(join(headDir(slot), "service.json")), false);
});

test("HH1 (H3's way in): towerDir(HEAD_KEY) is head/ with nothing bound, and a bound Herdr id does not change it", () => {
	const slot = slotIn();
	assert.equal(towerDir(slot, HEAD_KEY), headDir(slot));
	bindDir(slot, "w9", join(slot.dir, "elsewhere"));
	assert.equal(towerDir(slot, HEAD_KEY), headDir(slot));
	appendEvent(slot, { ...head(), workspace: HEAD_KEY }, event(1));
	assert.equal(queueLength(slot, HEAD_KEY), 1);
	assert.equal(existsSync(join(headDir(slot), "queue")), true);
});
