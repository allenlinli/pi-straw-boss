import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_TYPES, checkTodoCall, compareCodes, isoTime, KINDS, mergeMetadata, shortCode, todoEffects, validateStep } from "../src/train/spec.ts";
import { CODE, type Json, result, runCheck, SHA_A, SHA_B, sb } from "./train-fixtures.ts";

// The contract of a train's step (spec 2026-11-07-train-workers §6, §7.1): one `metadata.sb` object per todo, a closed set of kinds that only classify, four check types, the common fields, and the words a refusal uses.

const expectRefused = (value: unknown, pattern: RegExp, opts?: Parameters<typeof validateStep>[1]) => {
	const refusals = validateStep(value, opts);
	assert.ok(refusals.some((r) => pattern.test(r)), `${pattern} not in ${JSON.stringify(refusals)}`);
	for (const r of refusals) assert.match(r, /^sb: /, "every refusal opens with `sb: `");
};
const check = (extra: Json, base: Json = runCheck()) => sb({}, { check: { ...base, ...extra } });

test("the kinds are the nine of §6.2 and no others; the check types are run, git, report, notice", () => {
	assert.deepEqual([...KINDS], ["assemble", "review", "full-check", "merge", "ci", "deploy", "deploy-verify", "rollback", "land"]);
	assert.deepEqual([...CHECK_TYPES], ["run", "git", "report", "notice"]);
});

test("a well-formed step has no refusal", () => {
	assert.deepEqual(validateStep(sb()), []);
});

test("a kind decides nothing: one check passes the same under every kind, and a bad one is refused the same way", () => {
	const checks: Json[] = [
		runCheck(), { type: "git", cwd: "/w", contains: [SHA_B] }, { type: "report", path: "/r/review.md", expect: "P0=0 P1=0" }, { type: "notice", cars: ["T-1"], state: "landed" },
	];
	for (const c of checks) {
		const spec = { check: c, ...(c.type === "notice" ? {} : { on: { head: SHA_A } }) };
		for (const kind of KINDS) assert.deepEqual(validateStep({ ...sb({ kind }), spec }), [], `${kind} with ${c.type}`);
	}
	const bad = { ...sb(), spec: { check: { type: "run", cwd: "/w" }, on: { head: SHA_A } } };
	const first = validateStep({ ...bad, kind: KINDS[0] });
	assert.ok(first.length > 0);
	for (const kind of KINDS) assert.deepEqual(validateStep({ ...bad, kind }), first, `${kind}`);
});

test("kinds that are not a step's are refused with the list; an answer, e2e and uat are no train's", () => {
	expectRefused(sb({ kind: "answer" }), /^sb: kind "answer" is not a step kind \(assemble, review, full-check, merge, ci, deploy, deploy-verify, rollback, land\)/);
	expectRefused(sb({ kind: "" }), /kind "" is not a step kind/);
	expectRefused(sb({ kind: undefined }), /metadata\.sb\.kind/);
	expectRefused(sb({ kind: "e2e" }), /^sb: the train runs no acceptance: .*e2e/);
	expectRefused(sb({ kind: "uat" }), /^sb: the train runs no acceptance: .*uat/);
	expectRefused(check({ type: "answer" }), /^sb: check type "answer" is not one a train runs \(run, git, report, notice\)/);
	for (const type of ["e2e", "uat", "human", "page"]) assert.ok(validateStep(check({ type })).length > 0, type);
	expectRefused(sb({ spec: {} }), /a check is required|needs check/);
	expectRefused(sb({ spec: { check: "npm test" } }), /needs check|check must be an object/);
});

test("each check type's fields: a run needs cwd, run and log; a git cwd and contains; a report path and expect; a notice cars and state", () => {
	const cases: [Json, RegExp][] = [
		[{ type: "run", run: "x", log: "l" }, /a run check needs cwd/],
		[{ type: "run", cwd: "/w", log: "l" }, /a run check needs run/],
		[{ type: "run", cwd: "/w", run: "x" }, /a run check needs log/],
		[{ type: "run", cwd: "/w", run: "", log: "l" }, /a run check needs run/],
		[{ type: "run", cwd: "/w", run: 3, log: "l" }, /a run check needs run/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", verify: 4 }, /a run check's verify must be a string/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", expect: "ok" }, /expect needs verify/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", verify: "v", poll: { everySec: 5, forMin: 10 } }, /poll needs expect/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", verify: "v", expect: "ok", poll: { everySec: 0, forMin: 10 } }, /poll\.everySec/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", verify: "v", expect: "ok", poll: { everySec: 5 } }, /poll\.forMin/],
		[{ type: "run", cwd: "/w", run: "x", log: "l", extra: 1 }, /metadata\.sb\.spec\.check\.extra is not a field/],
		[{ type: "git", contains: [SHA_B] }, /a git check needs cwd/],
		[{ type: "git", cwd: "/w" }, /a git check needs contains/],
		[{ type: "git", cwd: "/w", contains: [] }, /a git check needs contains/],
		[{ type: "git", cwd: "/w", contains: ["abc"] }, /contains/],
		[{ type: "git", cwd: "/w", contains: [SHA_B], ref: "" }, /ref/],
		[{ type: "report", expect: "P0=0 P1=0" }, /a report check needs path/],
		[{ type: "report", path: "/r" }, /a report check needs expect/],
		[{ type: "notice", state: "landed" }, /a notice check needs cars/],
		[{ type: "notice", cars: [], state: "landed" }, /a notice check needs cars/],
		[{ type: "notice", cars: ["T-1"] }, /a notice check needs state/],
		[{ type: "notice", cars: ["T-1"], state: "received" }, /a notice check's state must be landed, returned or dropped/],
		[{ type: "notice", cars: ["T-1"], state: "landed", cwd: "/w" }, /cwd is not a field/],
	];
	for (const [c, pattern] of cases) expectRefused(sb({}, { check: c, on: { head: SHA_A } }), pattern);
	assert.deepEqual(validateStep(check({ verify: "gh run view", expect: "success", poll: { everySec: 30, forMin: 45 } })), []);
	assert.deepEqual(validateStep(sb({}, { check: { type: "git", cwd: "/w", contains: [SHA_B], ref: "pre-dev/x" } })), []);
});

test("the less common malformed fields are each refused: a spec or poll that is no object, too many commits or tickets, a target that is no text, a result head or verdict that is wrong", () => {
	expectRefused(sb({}, { on: "x" }), /spec\.on must be an object/);
	expectRefused(sb({}, { load: 5 }), /spec\.load must be an object/);
	expectRefused(sb({}, { holds: "x" }), /spec\.holds must be an object/);
	expectRefused(sb({ result: "ok" }), /result must be an object/, { status: "completed" });
	expectRefused(sb({ spec: undefined }), /metadata\.sb\.spec must be an object/);
	expectRefused(sb({ spec: "x" }), /metadata\.sb\.spec must be an object/);
	expectRefused(check({ verify: "v", expect: 5 }), /a run check's expect must be a string/);
	expectRefused(check({ verify: "v", expect: "ok", poll: 5 }), /spec\.check\.poll must be an object/);
	expectRefused(check({ verify: "v", expect: "ok", poll: { everySec: 5, forMin: 5, more: 1 } }), /poll\.more is not a field/);
	expectRefused(sb({}, { check: { type: "git", cwd: "/w", contains: Array.from({ length: 65 }, () => SHA_B) } }), /contains has more than 64 commits/);
	expectRefused(sb({}, { check: { type: "notice", cars: ["T 1"], state: "landed" } }), /cars\[0\] must be a ticket without spaces/);
	expectRefused(sb({}, { check: { type: "notice", cars: [5], state: "landed" } }), /cars\[0\] must be a ticket/);
	expectRefused(sb({}, { check: { type: "notice", cars: Array.from({ length: 33 }, (_, i) => `T-${i}`), state: "landed" } }), /cars has more than 32 tickets/);
	expectRefused(sb({}, { on: { target: "", version: "1" } }), /spec\.on\.target must be a non-empty string/);
	expectRefused(sb({}, { on: { target: 5, version: "1" } }), /spec\.on\.target/);
	expectRefused(sb({ result: result({ head: "abc" }) }), /result\.head must be 40 hex/, { status: "completed" });
	expectRefused(sb({ result: result({ verdict: "" }) }), /result\.verdict must be a non-empty string/, { status: "completed" });
	expectRefused(sb({ result: result({ verdict: "P0=1 P1=0" }) }, { check: { type: "report", path: "/r", expect: "P0=0 P1=0" }, on: { head: SHA_A } }), /result\.verdict must equal the check's expect \(P0=0 P1=0\)/, { status: "completed" });
});

test("`on` is required for every check but notice, and is a head or a target with its version", () => {
	expectRefused(sb({}, { on: undefined }), /metadata\.sb\.spec\.on is required/);
	expectRefused(sb({}, { on: {} }), /spec\.on/);
	expectRefused(sb({}, { on: { head: "abc" } }), /spec\.on\.head must be 40 hex/);
	expectRefused(sb({}, { on: { target: "target-a" } }), /spec\.on\.version/);
	expectRefused(sb({}, { on: { head: SHA_A, target: "t", version: "1" } }), /spec\.on/);
	assert.deepEqual(validateStep(sb({}, { on: { target: "target-a", version: "1.2.3" } })), []);
	assert.deepEqual(validateStep(sb({}, { check: { type: "notice", cars: ["T-1"], state: "landed" }, on: undefined })), [], "a notice needs no `on`");
});

test("the common fields: v, project and app path-safe, the train's code, the round, a name", () => {
	expectRefused(sb({ v: 2 }), /metadata\.sb\.v must be 1/);
	expectRefused(sb({ project: "a/b" }), /metadata\.sb\.project must be/);
	expectRefused(sb({ project: "" }), /metadata\.sb\.project/);
	for (const dots of ["..", ".", "..."]) expectRefused(sb({ project: dots, app: dots }), /metadata\.sb\.(project|app) must be/);
	expectRefused(sb({ app: "x".repeat(65) }), /metadata\.sb\.app must be/);
	expectRefused(sb({ app: "..a b" }), /metadata\.sb\.app/);
	for (const train of ["2026-11-06", "2026-11-06-M", "2026-11-06-abc", "26-11-06-m", "2026-13-06-m", "2026-11-31-m", "../2026-11-06-m"]) expectRefused(sb({ train }), /metadata\.sb\.train must be/);
	for (const round of [0, -1, 1.5, "1", undefined]) expectRefused(sb({ round }), /metadata\.sb\.round must be a whole number from 1/);
	expectRefused(sb({ name: "" }), /metadata\.sb\.name/);
	expectRefused(sb({ name: "n".repeat(65) }), /metadata\.sb\.name/);
	expectRefused(sb({ name: "a\nb" }), /metadata\.sb\.name/);
	expectRefused(sb({ unknown: 1 }), /metadata\.sb\.unknown is not a field/);
	expectRefused("a string", /metadata\.sb must be an object/);
	expectRefused(null, /metadata\.sb must be an object/);
	expectRefused([], /metadata\.sb must be an object/);
	assert.deepEqual(validateStep(sb({ project: "a.b_c-1", app: "web2", train: "2026-02-28-aa", round: 3, name: "type-check · build" })), []);
});

test("load, lock and holds belong to a run check; load is a max or a per-core factor with an optional weight", () => {
	assert.deepEqual(validateStep(sb({}, { load: { max: 30, weight: 4 }, lock: "heavy", holds: { lane: "web" } })), []);
	assert.deepEqual(validateStep(sb({}, { load: { perCore: 1.5 } })), []);
	assert.deepEqual(validateStep(sb({}, { holds: { lane: "web", target: "target-a" } })), []);
	expectRefused(sb({}, { load: {} }), /spec\.load needs max or perCore/);
	expectRefused(sb({}, { load: { max: 30, perCore: 2 } }), /spec\.load takes max or perCore, not both/);
	expectRefused(sb({}, { load: { max: 0 } }), /spec\.load\.max/);
	expectRefused(sb({}, { load: { max: "30" } }), /spec\.load\.max/);
	expectRefused(sb({}, { load: { max: 30, weight: 0 } }), /spec\.load\.weight/);
	expectRefused(sb({}, { load: { max: 30, weight: 1025 } }), /spec\.load\.weight/);
	expectRefused(sb({}, { lock: "Heavy" }), /spec\.lock must be/);
	expectRefused(sb({}, { lock: "a".repeat(33) }), /spec\.lock must be/);
	expectRefused(sb({}, { lock: "" }), /spec\.lock/);
	expectRefused(sb({}, { holds: {} }), /spec\.holds needs lane or target/);
	expectRefused(sb({}, { holds: { lane: "a/b" } }), /spec\.holds\.lane must be/);
	expectRefused(sb({}, { holds: { target: "" } }), /spec\.holds\.target/);
	expectRefused(sb({}, { holds: { lane: "web", other: "x" } }), /spec\.holds\.other is not a field/);
	for (const extra of [{ load: { max: 30 } }, { lock: "heavy" }]) {
		expectRefused(sb({}, { check: { type: "git", cwd: "/w", contains: [SHA_B] }, ...extra }), /only a run check takes (load|lock)/);
		expectRefused(sb({}, { check: { type: "notice", cars: ["T-1"], state: "landed" }, ...extra }), /only a run check takes (load|lock)/);
	}
	assert.deepEqual(validateStep(sb({}, { check: { type: "git", cwd: "/w", contains: [SHA_B] }, holds: { lane: "web" } })), [], "a git step may declare a hold");
});

test("a result is set only on completed: passed, failed, or void with why; git and report pass with their head and verdict", () => {
	assert.deepEqual(validateStep(sb({ result: result() }), { status: "completed" }), []);
	assert.deepEqual(validateStep(sb({ result: result({ outcome: "failed" }) }), { status: "completed" }), []);
	assert.deepEqual(validateStep(sb({ result: result({ outcome: "void", why: "superseded" }) }), { status: "completed" }), []);
	assert.deepEqual(validateStep(sb({ result: result({ outcome: "void", why: "skipped" }) }), { status: "completed" }), []);
	expectRefused(sb(), /completed needs a result/, { status: "completed", id: 7 });
	expectRefused(sb({ result: result() }), /result is set only on completed/, { status: "in_progress" });
	expectRefused(sb({ result: result() }), /result is set only on completed/, { status: "pending" });
	expectRefused(sb({ result: result({ outcome: "ok" }) }), /result\.outcome must be passed, failed or void/, { status: "completed" });
	expectRefused(sb({ result: result({ outcome: "void" }) }), /result\.why must be superseded or skipped/, { status: "completed" });
	expectRefused(sb({ result: result({ outcome: "passed", why: "superseded" }) }), /result\.why belongs to a void/, { status: "completed" });
	expectRefused(sb({ result: result({ evidence: "" }) }), /result\.evidence/, { status: "completed" });
	expectRefused(sb({ result: result({ at: "yesterday" }) }), /result\.at must be an ISO time/, { status: "completed" });
	expectRefused(sb({ result: { outcome: "passed" } }), /result\.evidence/, { status: "completed" });
	const git = { check: { type: "git", cwd: "/w", contains: [SHA_B] }, on: { head: SHA_A } };
	assert.deepEqual(validateStep(sb({ result: result({ head: SHA_A }) }, git), { status: "completed" }), []);
	expectRefused(sb({ result: result() }, git), /git check passes with result\.head/, { status: "completed" });
	expectRefused(sb({ result: result({ head: SHA_B }) }, git), /on\.head must equal result\.head/, { status: "completed" });
	assert.deepEqual(validateStep(sb({ result: result({ outcome: "failed" }) }, git), { status: "completed" }), [], "a failed git step needs no head");
	const report = { check: { type: "report", path: "/r/review.md", expect: "P0=0 P1=0" }, on: { head: SHA_A } };
	assert.deepEqual(validateStep(sb({ result: result({ verdict: "P0=0 P1=0" }) }, report), { status: "completed" }), []);
	expectRefused(sb({ result: result() }, report), /report check passes with result\.verdict/, { status: "completed" });
});

test("metadata.sb stays within 8 KB", () => {
	const big = sb({}, { check: runCheck({ run: "x".repeat(8300) }) });
	expectRefused(big, /^sb: metadata\.sb is 8\.\d KB, more than 8/);
	assert.ok(!validateStep(sb({}, { check: runCheck({ run: "x".repeat(2000) }) })).length);
});

test("a step names this train and its round, or is refused with both", () => {
	const here = { project: "acme", app: "web", train: CODE, round: 2 };
	assert.deepEqual(validateStep(sb({ round: 2 }), { expect: here, id: 4 }), []);
	expectRefused(sb({ train: "2026-11-06-n", round: 1 }), /^sb: step #4 names train 2026-11-06-n, round 1; this train is 2026-11-06-m, round 2/, { expect: here, id: 4 });
	expectRefused(sb({ round: 1 }), /^sb: step #4 names train 2026-11-06-m, round 1; this train is 2026-11-06-m, round 2/, { expect: here, id: 4 });
	expectRefused(sb({ train: "2026-11-06-n", round: 2 }), /^sb: step #4 names train 2026-11-06-n, round 2; this train is 2026-11-06-m, round 2/, { expect: here, id: 4 });
	expectRefused(sb({ project: "other" }), /step #4 names project other/, { expect: here, id: 4 });
	expectRefused(sb({ app: "api" }), /step #4 names app api/, { expect: here, id: 4 });
});

test("a time is ISO with its zone and a real date: zones, bounds, leap days, fractions", () => {
	for (const ok of ["2026-11-07T08:40:00Z", "2026-11-07T08:40Z", "2026-11-07T08:40:00.250Z", "2026-11-07T08:40:00+08:00", "2026-11-07T08:40:00-05:30", "2024-02-29T00:00:00Z", "2026-11-07T23:59:59Z", "2026-11-07T00:00:00+23:59"]) assert.equal(isoTime(ok), true, ok);
	for (const bad of ["2026-11-07T08:40:00", "2026-11-07", "2026-11-07 08:40:00Z", "2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-31T00:00:00Z", "2026-11-07T24:00:00Z", "2026-11-07T07:60:00Z", "2026-11-07T07:00:60Z", "2026-11-07T08:40:00+24:00", "2026-11-07T08:40:00+05:60", "yesterday", "", 5, undefined, null]) assert.equal(isoTime(bad), false, String(bad));
});

test("codes: MMDDx short form, and departure order that keeps two letters after one", () => {
	assert.equal(shortCode("2026-11-06-m"), "1106m");
	assert.equal(shortCode("2026-01-09-aa"), "0109aa");
	assert.throws(() => shortCode("1106m"), /code/);
	const sorted = ["2026-11-07-a", "2026-11-06-aa", "2026-11-06-z", "2026-11-06-b", "2025-12-31-z"].sort(compareCodes);
	assert.deepEqual(sorted, ["2025-12-31-z", "2026-11-06-b", "2026-11-06-z", "2026-11-06-aa", "2026-11-07-a"]);
	assert.equal(compareCodes("2026-11-06-m", "2026-11-06-m"), 0);
});

test("a metadata patch merges top-level keys, null deletes one, and an empty result is no metadata", () => {
	assert.deepEqual(mergeMetadata({ a: 1, sb: { x: 1 } }, { b: 2 }), { a: 1, sb: { x: 1 }, b: 2 });
	assert.deepEqual(mergeMetadata({ a: 1, sb: { x: 1 } }, { sb: { y: 2 } }), { a: 1, sb: { y: 2 } }, "a key is replaced whole, not merged deep");
	assert.deepEqual(mergeMetadata({ a: 1, sb: { x: 1 } }, { sb: null }), { a: 1 });
	assert.equal(mergeMetadata({ sb: { x: 1 } }, { sb: null }), undefined);
	assert.deepEqual(mergeMetadata(undefined, { a: 1 }), { a: 1 });
	assert.deepEqual(mergeMetadata({ a: 1 }, undefined), { a: 1 });
	const base = { a: 1 };
	mergeMetadata(base, { b: 2 });
	assert.deepEqual(base, { a: 1 }, "the input is not changed");
});

test("the effects of a todo call: a create, a batch create with ids from nextId, an update merged onto the list, and calls that change no step", () => {
	const list = [{ id: 1, status: "pending", metadata: { sb: sb() } }, { id: 2, status: "in_progress", metadata: { sb: sb({ name: "lint" }), keep: true } }];
	assert.deepEqual(todoEffects({ action: "create", subject: "s", metadata: { sb: sb() } }, list), [{ id: 3, created: true, status: "pending", metadata: { sb: sb() } }]);
	const batch = todoEffects({ action: "create", tasks: [{ subject: "a", metadata: { sb: sb() } }, { subject: "b" }] }, list, 10);
	assert.deepEqual(batch.map((e) => [e.id, e.created, e.metadata === undefined]), [[10, true, false], [11, true, true]]);
	const done = todoEffects({ action: "update", id: 2, status: "completed", metadata: { sb: sb({ result: result() }) } }, list);
	assert.deepEqual(done.map((e) => [e.id, e.created, e.status, e.metadata?.keep]), [[2, false, "completed", true]]);
	const nulled = todoEffects({ action: "update", id: 1, metadata: { sb: null } }, list);
	assert.equal(nulled[0]!.metadata, undefined, "null deletes sb");
	const onlyStatus = todoEffects({ action: "update", id: 1, status: "in_progress" }, list);
	assert.deepEqual(onlyStatus[0], { id: 1, created: false, status: "in_progress", metadata: { sb: sb() } });
	assert.deepEqual(todoEffects({ action: "update", id: 99, status: "completed" }, list), [], "an unknown id is rpiv-todo's error, not ours");
	for (const action of ["list", "get", "delete", "clear"]) assert.deepEqual(todoEffects({ action, id: 1 }, list), [], action);
	assert.deepEqual(todoEffects("nonsense", list), []);
});

test("a todo call is checked for what it leaves in the list: a todo without a step, a step of an unknown kind, an sb deleted by null, a bad item of a batch", () => {
	const here = { project: "acme", app: "web", train: CODE, round: 1 };
	const list = [{ id: 1, status: "pending", metadata: { sb: sb() } }];
	const call = (input: unknown) => checkTodoCall(input, list, here);
	assert.deepEqual(call({ action: "create", subject: "s", metadata: { sb: sb() } }), []);
	assert.deepEqual(call({ action: "list" }), []);
	assert.match(call({ action: "create", subject: "s" })[0]!, /^sb: every todo of a train is a step: add metadata\.sb \(kinds: assemble, review, full-check, merge, ci, deploy, deploy-verify, rollback, land\)/);
	assert.match(call({ action: "create", subject: "s", metadata: { other: 1 } })[0]!, /every todo of a train is a step/);
	assert.match(call({ action: "update", id: 1, metadata: { sb: null } })[0]!, /every todo of a train is a step/);
	assert.match(call({ action: "create", subject: "s", metadata: { sb: sb({ kind: "e2e" }) } })[0]!, /^sb: the train runs no acceptance/);
	assert.match(call({ action: "create", subject: "s", metadata: { sb: sb({ kind: "answer" }) } })[0]!, /kind "answer" is not a step kind/);
	assert.match(call({ action: "create", subject: "s", metadata: { sb: sb({ round: 2 }) } })[0]!, /names train 2026-11-06-m, round 2; this train is 2026-11-06-m, round 1/);
	assert.deepEqual(call({ action: "update", id: 1, status: "in_progress" }), [], "a status change keeps the step it has");
	const legacy = [...list, { id: 5, status: "pending", metadata: { note: "from before" } }];
	assert.match(checkTodoCall({ action: "update", id: 5, subject: "x" }, legacy, here)[0]!, /every todo of a train is a step/);
	assert.deepEqual(checkTodoCall({ action: "update", id: 5, status: "deleted" }, legacy, here), [], "a todo that is being deleted need not be a step");
	assert.match(call({ action: "update", id: 1, status: "completed" })[0]!, /completed needs a result/);
	const mixed = call({ action: "create", tasks: [{ subject: "a", metadata: { sb: sb() } }, { subject: "b" }, { subject: "c", metadata: { sb: sb({ kind: "answer" }) } }] });
	assert.equal(mixed.length, 2);
	assert.match(mixed[0]!, /^sb: tasks\[1\]: every todo of a train is a step/);
	assert.match(mixed[1]!, /^sb: tasks\[2\]: kind "answer" is not a step kind/);
});

const deep = (levels: number): unknown => {
	let value: unknown = [];
	for (let i = 0; i < levels; i++) value = [value];
	return value;
};

test("F003: a nested step is refused, never thrown, and the refusal comes before any walk of it", () => {
	for (const levels of [33, 20_000]) {
		const out = validateStep(sb({ extra: deep(levels) }));
		assert.equal(out.length, 1, String(levels));
		assert.match(out[0]!, /^sb: metadata\.sb is nested more than 32 levels$/);
	}
	const here = { project: "acme", app: "web", train: CODE, round: 1 };
	const refusals = checkTodoCall({ action: "create", subject: "s", metadata: { sb: sb({ extra: deep(20_000) }) } }, [], here);
	assert.match(refusals.join("\n"), /nested more than 32 levels/);
	assert.deepEqual(validateStep(sb({ extra: deep(5) })).map((r) => r.replace(/ .*/, "")), ["sb:"], "shallow nesting is only an unknown field");
	const cyclic: Json = {};
	cyclic.self = cyclic;
	assert.match(validateStep(sb({ extra: cyclic }))[0]!, /nested more than 32 levels/);
	assert.match(validateStep(sb({ extra: 10n }))[0]!, /^sb: metadata\.sb is not JSON/);
});

test("F010: a batch's refusal names the item's own index, whatever precedes it", () => {
	const here = { project: "acme", app: "web", train: CODE, round: 1 };
	const refusals = checkTodoCall({ action: "create", tasks: [5, { subject: "s", metadata: { sb: sb({ round: 0 }) } }] }, [], here);
	assert.ok(refusals.length > 0);
	for (const r of refusals) assert.match(r, /^sb: tasks\[1\]: /);
});
