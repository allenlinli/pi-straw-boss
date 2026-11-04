import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { sendSignal } from "../src/procs/kill.ts";
import { forgetOwned, guardSignal, KILLS_DIR, leftoverOwned, noteOwned, reapOwned } from "../src/procs/killguard.ts";
import { consumeRefusals, TEST_ROOT } from "../src/server/testguard.ts";

// The kill guard of a test run: a signal goes only to a process the test noted, with the start time it had, working inside the run's root.

const root = process.env[TEST_ROOT]!;
const made: string[] = [], kids: ChildProcess[] = [];
afterEach(() => {
	for (const kid of kids.splice(0)) (kid.kill("SIGKILL"), forgetOwned(kid.pid!));
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	consumeRefusals();
});
const fakeRoot = () => {
	const dir = mkdtempSync(join(tmpdir(), "kg-"));
	made.push(dir);
	return dir;
};
const sleeper = async (cwd: string) => {
	const kid = spawn("sleep", ["30"], { cwd, stdio: "ignore" });
	kids.push(kid);
	await new Promise((done) => kid.once("spawn", done));
	return kid;
};

test("the guard does nothing outside a test run", () => {
	guardSignal(4242, "SIGKILL", { proc: {}, argv: ["node", "/x/main.js"] });
	assert.equal(noteOwned(4242, { proc: {}, argv: ["node", "/x/main.js"], startOf: () => "t" }), undefined);
});

test("a signal to a pid nobody noted, a pid or group of 1 or below, and a run without a root are refused", () => {
	const proc = { [TEST_ROOT]: fakeRoot() };
	const deps = { proc, startOf: () => "t1", cwdOf: () => proc[TEST_ROOT] };
	assert.throws(() => guardSignal(4242, "SIGTERM", deps), /pid 4242, a process this test did not start/);
	assert.throws(() => guardSignal(-4242, "SIGKILL", deps), /SIGKILL to group 4242/);
	assert.throws(() => guardSignal(1, "SIGTERM", deps), /pid 1/);
	assert.throws(() => guardSignal(-1, "SIGTERM", deps), /group 1/);
	assert.throws(() => guardSignal(4242, "SIGTERM", { proc: {}, argv: ["node", "/x/a.test.ts"] }), /without tests\/setup\.ts/);
	assert.equal(consumeRefusals(proc[TEST_ROOT], undefined).length, 4, "the refusals are recorded under the root, for the end-of-run check");
});

test("a noted pid passes while it has its start time and works inside the root; a reused pid and a process elsewhere are refused; a gone one passes (ESRCH)", () => {
	const proc = { [TEST_ROOT]: fakeRoot() };
	let started: string | undefined = "Tue Nov  4 03:50:02 2026", cwd: string | undefined = join(proc[TEST_ROOT], "work");
	const deps = { proc, startOf: () => started, cwdOf: () => cwd };
	assert.equal(noteOwned(4243, deps), "Tue Nov  4 03:50:02 2026");
	guardSignal(4243, "SIGTERM", deps);
	guardSignal(-4243, "SIGKILL", deps);
	started = "Tue Nov  4 09:00:00 2026";
	assert.throws(() => guardSignal(4243, "SIGKILL", deps), /another process now/);
	started = "Tue Nov  4 03:50:02 2026";
	cwd = "/";
	assert.throws(() => guardSignal(4243, "SIGKILL", deps), /outside the run's temp root/);
	cwd = undefined;
	assert.throws(() => guardSignal(4243, "SIGKILL", deps), /not readable/);
	started = undefined;
	guardSignal(4243, "SIGKILL", deps);
	assert.equal(consumeRefusals(proc[TEST_ROOT], undefined).length, 3);
});

test("noteOwned writes nothing for a pid it cannot read the start time of, or for pid 1; forgetOwned drops a note", () => {
	const proc = { [TEST_ROOT]: fakeRoot() };
	assert.equal(noteOwned(4244, { proc, startOf: () => undefined }), undefined);
	assert.equal(noteOwned(1, { proc, startOf: () => "t" }), undefined);
	assert.ok(!existsSync(join(proc[TEST_ROOT], KILLS_DIR, "4244")));
	noteOwned(4245, { proc, startOf: () => "t" });
	assert.ok(existsSync(join(proc[TEST_ROOT], KILLS_DIR, "4245")));
	forgetOwned(4245, proc);
	assert.ok(!existsSync(join(proc[TEST_ROOT], KILLS_DIR, "4245")));
});

test("the real signal path: a process this test did not note is refused and lives; one it noted is signalled; a noted one working outside the root is refused", { skip: process.platform === "win32" }, async () => {
	const inside = await sleeper(root), stranger = await sleeper(root), outside = await sleeper("/");
	assert.ok(noteOwned(inside.pid));
	assert.ok(noteOwned(outside.pid));
	assert.throws(() => sendSignal(stranger.pid!, "SIGKILL"), /did not start/);
	assert.throws(() => sendSignal(outside.pid!, "SIGKILL"), /outside the run's temp root/);
	assert.equal(consumeRefusals().length, 2, "the test asserted both refusals and takes them");
	for (const kid of [stranger, outside]) assert.equal(kid.exitCode, null, "the refused signal did not go out");
	const gone = new Promise((done) => inside.once("exit", done));
	sendSignal(inside.pid!, "SIGKILL");
	await gone;
	assert.equal(inside.signalCode, "SIGKILL");
});

test("reapOwned kills what a run noted and left, only that process's own notes with `by`, and leftoverOwned tells them", { skip: process.platform === "win32" }, async () => {
	const kid = await sleeper(root);
	assert.ok(noteOwned(kid.pid));
	assert.deepEqual(leftoverOwned(root, process.pid), [kid.pid]);
	assert.deepEqual(leftoverOwned(root, process.pid + 1), []);
	const gone = new Promise((done) => kid.once("exit", done));
	assert.deepEqual(reapOwned(root, process.pid), [kid.pid]);
	await gone;
	assert.deepEqual(leftoverOwned(root, process.pid), []);
});

test("RV-F006: a group whose leader is gone is refused (its other members are unchecked); a single gone pid still passes", () => {
	const proc = { [TEST_ROOT]: fakeRoot() };
	const deps = { proc, startOf: () => "t1" as string | undefined, cwdOf: () => proc[TEST_ROOT] };
	assert.equal(noteOwned(4244, deps), "t1");
	deps.startOf = () => undefined;
	guardSignal(4244, "SIGKILL", deps);
	assert.throws(() => guardSignal(-4244, "SIGKILL", deps), /group leader is gone/);
	assert.equal(consumeRefusals(proc[TEST_ROOT], undefined).length, 1);
});

test("RV-F007: a note that cannot be read (removed between the listing and the read) is not a leftover, and does not throw", () => {
	const root = fakeRoot();
	mkdirSync(join(root, KILLS_DIR, "4245"), { recursive: true }); // a read of it fails like a note that was just removed
	assert.deepEqual(leftoverOwned(root, undefined, () => "t"), []);
});
