import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { test } from "node:test";
import { createRuns, lineMac, RUN_TTL_MS } from "../src/runs.ts";

// The one-tap prompt run's grants: one per accepted answer that put a shell command in a session's prompt. Each is bound to the answer id and the session, carries a random nonce of its own, answers a keyed MAC of the prompt line once, and expires.

const ID = "a1b2c3d4e5f6a7b8";
const world = () => {
	const w = { t: 1_000_000 };
	return { w, runs: createRuns(() => w.t) };
};
/** What a bridge tells for `line` once the server has given it the grant's nonce. */
const told = (runs: ReturnType<typeof createRuns>, line: string, id = ID, session = "S") => lineMac(runs.nonce(session, id)!, line);

test("a grant matches the keyed MAC of the command as robot_hand puts it in the prompt (`! cmd`), and only that", () => {
	const { runs } = world();
	assert.equal(runs.issue("S", ID, "npm run deploy"), true);
	assert.equal(runs.take("S", ID, told(runs, "! npm run deploy")), "match");
});

test("a `/` command is never granted: whichever of `/x` and `! /x` the owner placed, Enter keeps its confirm (OT-F002, OT-F003)", () => {
	for (const copy of ["/model x", "/usr/bin/x", " /x", "\t/x", "/reload"]) {
		const { runs } = world();
		assert.equal(runs.issue("S", ID, copy), false, JSON.stringify(copy));
		assert.equal(runs.size(), 0);
		assert.equal(runs.nonce("S", ID), undefined);
		assert.equal(runs.take("S", ID, lineMac("0".repeat(32), `! ${copy}`)), "unknown");
	}
	const { runs } = world();
	assert.equal(runs.issue("S", ID, "echo /x"), true, "only a command that starts with `/` is left out");
});

test("an empty or missing command issues nothing", () => {
	const { runs } = world();
	assert.equal(runs.issue("S", ID, ""), false);
	assert.equal(runs.issue("S", ID, "  "), false);
	assert.equal(runs.issue("S", ID, undefined), false);
	assert.equal(runs.take("S", ID, lineMac("0".repeat(32), "! ")), "unknown");
});

test("a prompt line that was edited, even by one character or a trailing space, does not match", () => {
	for (const edited of ["! npm run deploy ", "! npm run deploy;", "!  npm run deploy", "! npm run deplo", "npm run deploy", "! rm -rf x", ""]) {
		const { runs } = world();
		runs.issue("S", ID, "npm run deploy");
		assert.equal(runs.take("S", ID, told(runs, edited)), "changed", JSON.stringify(edited));
	}
});

test("a grant answers once: a match, a mismatch, and a missing MAC all spend it, so a replay is unknown", () => {
	for (const mac of ["match", "wrong", undefined]) {
		const { runs } = world();
		runs.issue("S", ID, "x");
		runs.take("S", ID, mac === "match" ? told(runs, "! x") : mac === "wrong" ? told(runs, "! y") : undefined);
		const nonce = "0".repeat(32);
		assert.equal(runs.take("S", ID, lineMac(nonce, "! x")), "unknown", String(mac));
	}
});

test("another session, or an answer id the server never issued, is unknown, and the other session's grant is not spent by it", () => {
	const { runs } = world();
	runs.issue("S", ID, "x");
	const mac = told(runs, "! x");
	assert.equal(runs.nonce("T", ID), undefined, "another session is not told the nonce");
	assert.equal(runs.take("T", ID, mac), "unknown");
	assert.equal(runs.take("S", "ffffffffffffffff", mac), "unknown");
	assert.equal(runs.take("S", ID, mac), "match");
});

test("a grant expires: after the time to live it is expired once, then unknown; an expired grant gives out no nonce", () => {
	const { runs, w } = world();
	runs.issue("S", ID, "x");
	w.t += RUN_TTL_MS - 1;
	assert.equal(runs.take("S", ID, told(runs, "! x")), "match");
	runs.issue("S", ID, "x");
	const mac = told(runs, "! x");
	w.t += RUN_TTL_MS;
	assert.equal(runs.nonce("S", ID), undefined);
	assert.equal(runs.take("S", ID, mac), "expired");
	assert.equal(runs.take("S", ID, mac), "unknown");
});

test("a bridge that sent no MAC (an old one) is told apart: nohash, and the grant is spent", () => {
	const { runs } = world();
	runs.issue("S", ID, "x");
	assert.equal(runs.take("S", ID, undefined), "nohash");
	assert.equal(runs.take("S", ID, undefined), "unknown");
});

test("the MAC is keyed by the grant's own random nonce: HMAC-SHA-256 of the whole line, never the plain SHA-256 (OT-F004)", () => {
	const { runs } = world();
	runs.issue("S", ID, "ls");
	runs.issue("S", "b1b2c3d4e5f6a7b8", "ls");
	const n = runs.nonce("S", ID)!, m = runs.nonce("S", "b1b2c3d4e5f6a7b8")!;
	assert.match(n, /^[0-9a-f]{32}$/);
	assert.notEqual(n, m, "a nonce for each grant");
	assert.equal(lineMac(n, "! ls"), createHmac("sha256", n).update("! ls", "utf8").digest("hex"));
	assert.notEqual(lineMac(n, "! ls"), createHash("sha256").update("! ls", "utf8").digest("hex"), "not a dictionary-reversible hash");
	assert.notEqual(lineMac(n, "! ls"), lineMac(m, "! ls"), "the same line gives another MAC under another nonce");
	assert.equal(runs.take("S", ID, lineMac(m, "! ls")), "changed", "a MAC made under another grant's nonce is not this grant's");
	assert.equal(runs.nonce("S", ID), undefined, "spent");
	assert.equal(runs.take("S", "b1b2c3d4e5f6a7b8", createHash("sha256").update("! ls", "utf8").digest("hex")), "changed", "the unkeyed hash does not match");
});

test("the store stays small: expired grants leave when another is issued, and at most 64 wait", () => {
	const { runs, w } = world();
	for (let i = 0; i < 100; i++) runs.issue("S", `${String(i).padStart(16, "0")}`, "x");
	assert.equal(runs.size(), 64);
	w.t += RUN_TTL_MS + 1;
	runs.issue("S", ID, "x");
	assert.equal(runs.size(), 1);
});
