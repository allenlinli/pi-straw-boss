import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { chatKey, createAnswered } from "../src/answered.ts";
import { answeredFileDeps } from "../src/server/answeredfile.ts";

// The record's file on disk (BSR-F002): read as the house reads its records (src/server/record.ts `readOwned`): a link is not followed, a file of another account is not read, a missing file is a new record and anything else is an unreadable one,
// which is set aside, not replaced, by the first write.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-answered-file-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const dir = () => join(scratch, `d${n++}`);
const planted = (key: string) => JSON.stringify({ v: 1, entries: [[key, { state: "done", fields: [["q", "planted"]], at: 1 }]] });

test("a missing file is a new record, and the first write makes it mode 600", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const file = join(d, "answered.json"), a = createAnswered(answeredFileDeps(file));
	assert.equal(a.unreadable, false);
	assert.equal(a.begin(chatKey("S", "e", 0)), "ok");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(createAnswered(answeredFileDeps(file)).get(chatKey("S", "e", 0))?.state, "pending");
});

test("BSR-F002: a link is not followed: a record planted behind it is not read, and the link is set aside by the first write, its target untouched", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const key = chatKey("S", "e", 7), target = join(d, "elsewhere.json"), file = join(d, "answered.json");
	writeFileSync(target, planted(key));
	symlinkSync(target, file);
	const a = createAnswered(answeredFileDeps(file));
	assert.equal(a.unreadable, true);
	assert.equal(a.get(key), undefined, "the planted entry did not lock its block");
	assert.equal(a.begin(chatKey("S", "e", 1)), "ok");
	assert.equal(readFileSync(target, "utf8"), planted(key), "nothing was written through the link");
	assert.equal(statSync(file).isFile(), true, "the link is gone from the record's place");
	const aside = readdirSync(d).filter((name) => name.startsWith("answered.json.unreadable-"));
	assert.equal(aside.length, 1, "the link is kept aside");
	assert.equal(createAnswered(answeredFileDeps(file)).unreadable, false, "the next server reads the new file");
});

test("BSR-F002: a link to nothing is unreadable too, not a new record", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const file = join(d, "answered.json");
	symlinkSync(join(d, "nowhere.json"), file);
	assert.equal(createAnswered(answeredFileDeps(file)).unreadable, true);
});

test("BSR-F002: a file that is not JSON is unreadable, kept aside byte for byte when the first answer is written, and the page keeps its note", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const file = join(d, "answered.json");
	writeFileSync(file, "{not json", { mode: 0o600 });
	const a = createAnswered(answeredFileDeps(file));
	assert.equal(a.unreadable, true);
	a.begin(chatKey("S", "e", 0));
	assert.equal(a.unreadable, true, "still unreadable for the life of the process");
	const aside = readdirSync(d).filter((name) => name.startsWith("answered.json.unreadable-"));
	assert.equal(aside.length, 1);
	assert.equal(readFileSync(join(d, aside[0]!), "utf8"), "{not json");
	a.begin(chatKey("S", "e", 1));
	assert.equal(readdirSync(d).filter((name) => name.startsWith("answered.json.unreadable-")).length, 1, "set aside once");
});

test("BSR-F002: a directory where the file belongs is unreadable and cannot be written over", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const file = join(d, "answered.json");
	mkdirSyncOnce(file);
	const a = createAnswered(answeredFileDeps(file));
	assert.equal(a.unreadable, true);
	assert.ok(existsSync(file));
});

test("BSR-F002: a file over 32 MB is not read", () => {
	const d = dir();
	mkdirSyncOnce(d);
	const file = join(d, "answered.json");
	const record = JSON.stringify({ v: 1, entries: [] });
	writeFileSync(file, record + " ".repeat(33 * 1024 * 1024), { mode: 0o600 });
	assert.equal(createAnswered(answeredFileDeps(file)).unreadable, true, "valid JSON, too big");
	writeFileSync(file, record + " ".repeat(1024 * 1024), { mode: 0o600 });
	assert.equal(createAnswered(answeredFileDeps(file)).unreadable, false, "the same under the limit");
});

const mkdirSyncOnce = (path: string) => void mkdirSync(path, { recursive: true });
