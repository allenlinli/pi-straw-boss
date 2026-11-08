import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readJsonFile } from "../src/train/board.ts";

// The one reader of the files a train's session can write (TY-F004): the descriptor is opened without following a link or waiting for a writer, and what it is and how big it is are read from the descriptor, so a file swapped for a
// FIFO or a device between a check and the read cannot block the server or lift the size cap.

const ROOT = process.env.SB_TEST_ROOT!, dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const folder = () => (dirs.push(mkdtempSync(join(ROOT, "rj-"))), dirs.at(-1)!);
const posix = process.platform !== "win32";

test("a regular file reads; not JSON, too big, and a folder are each refused with a reason", () => {
	const dir = folder();
	writeFileSync(join(dir, "ok.json"), '{"a":1}');
	writeFileSync(join(dir, "bad.json"), "{nope");
	writeFileSync(join(dir, "big.json"), JSON.stringify({ pad: "x".repeat(2000) }));
	mkdirSync(join(dir, "sub.json"));
	assert.deepEqual(readJsonFile(join(dir, "ok.json"), 1024), { ok: true, value: { a: 1 } });
	const bad = readJsonFile(join(dir, "bad.json"), 1024), big = readJsonFile(join(dir, "big.json"), 1024), sub = readJsonFile(join(dir, "sub.json"), 1024), none = readJsonFile(join(dir, "none.json"), 1024);
	assert.ok(!bad.ok && /not JSON/.test(bad.reason));
	assert.ok(!big.ok && /more than 1 KB/.test(big.reason), JSON.stringify(big));
	assert.ok(!sub.ok && /not a regular file/.test(sub.reason));
	assert.ok(!none.ok && none.reason === "cannot read: ENOENT");
});

test("a link is not followed, and a FIFO with no writer is refused at once instead of waiting", { skip: !posix }, () => {
	const dir = folder();
	writeFileSync(join(dir, "real.json"), "{}");
	symlinkSync(join(dir, "real.json"), join(dir, "link.json"));
	execFileSync("mkfifo", [join(dir, "pipe.json")]);
	const link = readJsonFile(join(dir, "link.json"), 1024), pipe = readJsonFile(join(dir, "pipe.json"), 1024);
	assert.ok(!link.ok && /not a regular file/.test(link.reason), JSON.stringify(link));
	assert.ok(!pipe.ok && /not a regular file/.test(pipe.reason), JSON.stringify(pipe));
});

test("a budget is spent by the size of each file read; a file larger than what is left is refused and costs nothing", () => {
	const dir = folder();
	writeFileSync(join(dir, "a.json"), JSON.stringify({ pad: "x".repeat(100) }));
	writeFileSync(join(dir, "b.json"), JSON.stringify({ pad: "y".repeat(100) }));
	const budget = { left: 150 };
	assert.equal(readJsonFile(join(dir, "a.json"), 1024, budget).ok, true);
	const spent = readJsonFile(join(dir, "b.json"), 1024, budget);
	assert.ok(!spent.ok && /budget/.test(spent.reason), JSON.stringify(spent));
	assert.ok(budget.left > 0 && budget.left < 150, "only the file that was read was paid for");
});
