import assert from "node:assert/strict";
import { test } from "node:test";
import { commandHash, createRuns, RUN_TTL_MS } from "../src/runs.ts";

// The one-tap prompt run's grants: one per accepted answer that put a command in a session's prompt. Each is bound to the answer id and the session, answers a hash of the prompt line once, and expires.

const ID = "a1b2c3d4e5f6a7b8";
const world = () => {
	const w = { t: 1_000_000 };
	return { w, runs: createRuns(() => w.t) };
};

test("a grant matches the hash of the command as robot_hand puts it in the prompt (`! cmd`, or a pi command as it is), and only that", () => {
	const { runs } = world();
	assert.equal(runs.issue("S", ID, "npm run deploy"), true);
	assert.equal(runs.take("S", ID, commandHash("! npm run deploy")), "match");
	assert.equal(runs.issue("S", ID, "/model x"), true);
	assert.equal(runs.take("S", ID, commandHash("/model x")), "match", "a pi command goes as it is");
});

test("an empty or missing command issues nothing", () => {
	const { runs } = world();
	assert.equal(runs.issue("S", ID, ""), false);
	assert.equal(runs.issue("S", ID, undefined), false);
	assert.equal(runs.take("S", ID, commandHash("! ")), "unknown");
});

test("a prompt line that was edited, even by one character or a trailing space, does not match", () => {
	for (const edited of ["! npm run deploy ", "! npm run deploy;", "!  npm run deploy", "! npm run deplo", "npm run deploy", "! rm -rf x", ""]) {
		const { runs } = world();
		runs.issue("S", ID, "npm run deploy");
		assert.equal(runs.take("S", ID, commandHash(edited)), "changed", JSON.stringify(edited));
	}
});

test("a grant answers once: a match, a mismatch, and a missing hash all spend it, so a replay is unknown", () => {
	for (const hash of [commandHash("! x"), commandHash("! y"), undefined]) {
		const { runs } = world();
		runs.issue("S", ID, "x");
		runs.take("S", ID, hash);
		assert.equal(runs.take("S", ID, commandHash("! x")), "unknown", String(hash));
	}
});

test("another session, or an answer id the server never issued, is unknown, and the other session's grant is not spent by it", () => {
	const { runs } = world();
	runs.issue("S", ID, "x");
	assert.equal(runs.take("T", ID, commandHash("! x")), "unknown");
	assert.equal(runs.take("S", "ffffffffffffffff", commandHash("! x")), "unknown");
	assert.equal(runs.take("S", ID, commandHash("! x")), "match");
});

test("a grant expires: after the time to live it is expired once, then unknown", () => {
	const { runs, w } = world();
	runs.issue("S", ID, "x");
	w.t += RUN_TTL_MS - 1;
	assert.equal(runs.take("S", ID, commandHash("! x")), "match");
	runs.issue("S", ID, "x");
	w.t += RUN_TTL_MS;
	assert.equal(runs.take("S", ID, commandHash("! x")), "expired");
	assert.equal(runs.take("S", ID, commandHash("! x")), "unknown");
});

test("a bridge that sent no hash (an old one) is told apart: nohash, and the grant is spent", () => {
	const { runs } = world();
	runs.issue("S", ID, "x");
	assert.equal(runs.take("S", ID, undefined), "nohash");
	assert.equal(runs.take("S", ID, undefined), "unknown");
});

test("the store stays small: expired grants leave when another is issued, and at most 64 wait", () => {
	const { runs, w } = world();
	for (let i = 0; i < 100; i++) runs.issue("S", `${String(i).padStart(16, "0")}`, "x");
	assert.equal(runs.size(), 64);
	w.t += RUN_TTL_MS + 1;
	runs.issue("S", ID, "x");
	assert.equal(runs.size(), 1);
});
