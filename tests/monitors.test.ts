import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MONITORS, MONITOR_TEXT, monitorsOk, trackMonitors } from "../src/monitors.ts";
import * as monitors from "../src/monitors.ts";

const progressOf = (line: unknown) => (monitors as unknown as { progressOf(line: unknown): { message: string; load?: unknown } | undefined }).progressOf(line);

function bus() {
	const hs = new Map<string, Set<(d: unknown) => void>>();
	return {
		emit: (c: string, d: unknown) => hs.get(c)?.forEach((h) => h(d)),
		on: (c: string, h: (d: unknown) => void) => (hs.set(c, (hs.get(c) ?? new Set()).add(h)), () => void hs.get(c)!.delete(h)),
		count: () => [...hs.values()].reduce((n, s) => n + s.size, 0),
	};
}

test("monitors: pi-loop-monitor's events become each monitor's state, its last line, and how it ended", () => {
	let now = 1_000, changes = 0;
	const b = bus(), t = trackMonitors(b, () => changes++, { now: () => now, throttleMs: 0 });
	b.emit("monitor:started", { monitorId: "1", command: "npm test", description: "unit tests", timestamp: now });
	b.emit("monitor:started", { monitorId: "2", command: "vite --port 5199" });
	b.emit("monitor:output", { monitorId: "1", line: "\u001b[32mok\u001b[0m 41 passed", outputLines: 12 });
	assert.deepEqual(t.list().map(({ id, what, status, last, lines }) => ({ id, what, status, last, lines })), [
		{ id: "2", what: "vite --port 5199", status: "running", last: undefined, lines: 0 },
		{ id: "1", what: "unit tests", status: "running", last: "ok 41 passed", lines: 12 },
	], "newest first; a description over the command; terminal escapes gone");
	now = 2_000;
	b.emit("monitor:finished", { monitorId: "1", status: "error", exitCode: 1, outputLines: 13 });
	b.emit("monitor:finished", { monitorId: "2", status: "stopped", reason: "timeout", outputLines: 0 });
	const [two, one] = t.list();
	assert.deepEqual([one!.status, one!.exit, one!.ended, two!.status], ["error", 1, 2_000, "stale"], "a stop for inactivity reads stale");
	b.emit("monitor:started", { monitorId: "3", command: "sleep 9" });
	b.emit("monitor:finished", { monitorId: "3", status: "stopped", reason: "manual" });
	b.emit("monitor:started", { monitorId: "4", command: "true" });
	b.emit("monitor:finished", { monitorId: "4", status: "completed", exitCode: 0 });
	assert.deepEqual(t.list().map((m) => m.status), ["done", "stopped", "stale", "error"]);
	assert.ok(changes >= 8);
	t.off();
	assert.equal(b.count(), 0, "off unsubscribes");
});

test("monitors: running ones first, ended ones kept 15 minutes, at most six, text cut, junk ignored", () => {
	let now = 0;
	const b = bus(), t = trackMonitors(b, () => {}, { now: () => now, throttleMs: 0 });
	b.emit("monitor:started", { monitorId: "old", command: "x" });
	b.emit("monitor:finished", { monitorId: "old", status: "completed", exitCode: 0 });
	for (let i = 0; i < 7; i++) b.emit("monitor:started", { monitorId: `r${i}`, command: `${"c".repeat(400)}${i}` });
	b.emit("monitor:started", { monitorId: 5 });
	b.emit("monitor:output", { monitorId: "nobody", line: "x" });
	const list = t.list();
	assert.equal(list.length, MAX_MONITORS);
	assert.ok(list.every((m) => m.status === "running" && m.what.length <= MONITOR_TEXT && m.what.endsWith("…")));
	assert.ok(monitorsOk(list));
	now = 15 * 60_000 + 1;
	for (let i = 0; i < 7; i++) b.emit("monitor:finished", { monitorId: `r${i}`, status: "completed", exitCode: 0 });
	assert.ok(!t.list().some((m) => m.id === "old"), "an ended monitor goes after 15 minutes, as pi-loop-monitor prunes it");
	t.clear();
	assert.deepEqual(t.list(), []);
});

test("monitors: the hub takes only well-formed lists", () => {
	const ok = { id: "1", what: "npm test", status: "running", lines: 0, at: 1 };
	assert.ok(monitorsOk([ok, { ...ok, id: "2", status: "error", exit: 1, last: "boom", ended: 2 }]));
	for (const bad of [[{ ...ok, status: "weird" }], [{ ...ok, what: "x".repeat(MONITOR_TEXT + 1) }], [{ ...ok, last: "a\u0007b" }], Array(MAX_MONITORS + 1).fill(ok), [{ ...ok, lines: -1 }], "x", [null]])
		assert.equal(monitorsOk(bad), false, JSON.stringify(bad).slice(0, 50));
});

// Task 5 of the train workers (docs/specs/2026-11-07-train-workers.md §8.2, §11.1): every monitor learns the progress line a train's gate wrapper prints.

const wrapper = (message: string, load?: unknown, extra: object = {}) => JSON.stringify({ progress: { message, ...(load !== undefined ? { load } : {}) }, sb: { v: 1, state: "waiting" }, ...extra });

test("monitors: a JSON progress line shows its message instead of the raw JSON and keeps its load", () => {
	const b = bus(), t = trackMonitors(b, () => {}, { now: () => 1, throttleMs: 0 });
	b.emit("monitor:started", { monitorId: "1", command: "gate", description: "train 1106m #4 full-check" });
	b.emit("monitor:output", { monitorId: "1", line: wrapper("waiting: load <=30 (now 42)", { max: 30, now: 42 }), outputLines: 1 });
	const [waiting] = t.list();
	assert.equal(waiting!.last, "waiting: load <=30 (now 42)", "the message, not JSON");
	assert.deepEqual(waiting!.load, { max: 30, now: 42 });
	assert.ok(monitorsOk(t.list()), "the hub takes the list with a load");
	b.emit("monitor:output", { monitorId: "1", line: wrapper("running 12m: unit (load 18)", { max: 30, now: 18 }), outputLines: 2 });
	assert.deepEqual([t.list()[0]!.last, t.list()[0]!.load], ["running 12m: unit (load 18)", { max: 30, now: 18 }], "the newest line wins");
	b.emit("monitor:output", { monitorId: "1", line: wrapper("verifying: pipeline"), outputLines: 3 });
	assert.deepEqual([t.list()[0]!.last, t.list()[0]!.load], ["verifying: pipeline", undefined], "a progress line without a load clears it");
	b.emit("monitor:output", { monitorId: "1", line: wrapper("waiting: load <=30 (now 31)", { max: 30, now: 31 }), outputLines: 4 });
	b.emit("monitor:output", { monitorId: "1", line: "plain text", outputLines: 5 });
	assert.deepEqual([t.list()[0]!.last, t.list()[0]!.load], ["plain text", undefined], "a plain line shows as before and clears it");
	b.emit("monitor:output", { monitorId: "1", line: wrapper("waiting: load <=30 (now 40)", { max: 30, now: 40 }), outputLines: 6 });
	b.emit("monitor:finished", { monitorId: "1", status: "completed", exitCode: 0 });
	assert.deepEqual([t.list()[0]!.status, t.list()[0]!.load], ["done", undefined], "an ended monitor waits for nothing");
});

test("monitors: a progress line is untrusted: only a string message counts, the message is cleaned and cut, a bad load is dropped without spoiling the message", () => {
	assert.equal(progressOf('{"progress":{"current":3,"total":9}}'), undefined, "no message: not shown as one");
	assert.equal(progressOf('{"progress":{"message":7}}'), undefined);
	assert.equal(progressOf('{"progress":"x"}'), undefined);
	assert.equal(progressOf('{"progress":[{"message":"a"}]}'), undefined);
	assert.equal(progressOf('{"progress":{"message":"   "}}'), undefined, "an empty message shows the raw line instead");
	assert.equal(progressOf("[1]"), undefined);
	assert.equal(progressOf("{not json"), undefined);
	assert.equal(progressOf(undefined), undefined);
	assert.equal(progressOf(`{"progress":{"message":"${"x".repeat(9000)}"}}`), undefined, "a line over 8 KB is not parsed");
	assert.deepEqual(progressOf(wrapper("\u001b[31mred\u001b[0m\u0007 ok")), { message: "red  ok" }, "terminal escapes and controls go");
	assert.equal(progressOf(wrapper("m".repeat(500)))!.message.length, MONITOR_TEXT, "cut like any monitor text");
	for (const bad of [{ max: "30", now: 42 }, { max: 30 }, { max: -1, now: 1 }, { max: 30, now: Number.NaN }, { max: 30, now: 1e7 }, [30, 42], "x", null])
		assert.deepEqual(progressOf(wrapper("m", bad)), { message: "m" }, `load ${JSON.stringify(bad)} is dropped`);
	assert.deepEqual(progressOf(wrapper("m", { max: 30, now: 42, extra: "x".repeat(50) })), { message: "m", load: { max: 30, now: 42 } }, "the load is rebuilt from its two numbers, whatever else rides with it");
	const ok = { id: "1", what: "gate", status: "running" as const, lines: 1, at: 1 };
	assert.ok(monitorsOk([{ ...ok, load: { max: 30, now: 42 } }]));
	for (const bad of [{ max: 30 }, { max: "30", now: 1 }, { max: 30, now: -1 }, { max: 30, now: 1, more: 1 }, [30, 1], 5, null])
		assert.equal(monitorsOk([{ ...ok, load: bad }]), false, `the hub refuses load ${JSON.stringify(bad)}`);
});
