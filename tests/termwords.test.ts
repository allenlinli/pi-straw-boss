import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { endedWhy, refusalText, REFUSAL_CODES } from "../gui/termwords.ts";

// The refusals of a terminal's keys (src/keys.ts) and mirror (src/mirror.ts) in the page's language, by the server's code; a code the page does not know shows the server's own text.

const ans = (error: string, reason = "the server's words", status = 409) => ({ ok: false, status, body: { error, reason } });
const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const codes = [...new Set([...source("keys.ts").matchAll(/\bno\(\d+, "([a-z_]+)"/g), ...source("mirror.ts").matchAll(/\bno\(\d+, "([a-z_]+)"/g)].map((x) => x[1]!))].filter((c) => c !== "confirm");
const CJK = /[\u4e00-\u9fff]/;

test("every code the server's keys and mirror refuse with has the page's words, and the table lists no code the server lacks", () => {
	assert.ok(codes.length >= 12, `${codes.length} codes found in the sources`);
	assert.deepEqual([...REFUSAL_CODES].sort(), [...codes].sort());
});

for (const code of codes) {
	test(`${code}: the page's words in English and in Traditional Chinese, not the server's text`, () => {
		const en = refusalText(ans(code), "en"), zh = refusalText(ans(code), "zh-TW");
		assert.notEqual(en, "the server's words");
		assert.notEqual(zh, en);
		assert.match(zh, CJK);
		assert.doesNotMatch(zh.replace(/\/boss gui lan|Esc|Escape|Ctrl\+Z|Ctrl|Alt|Delete|Tab|pi|session|Herdr/g, ""), /[A-Za-z]{4,}/, "no English sentence in the Chinese words");
	});
}

test("an unknown code shows the server's text, and one with no text shows Refused (status)", () => {
	assert.equal(refusalText(ans("something_new"), "zh-TW"), "the server's words");
	assert.equal(refusalText({ ok: false, status: 418, body: {} }, "en"), "Refused (418).");
	assert.equal(refusalText({ ok: false, status: 418, body: {} }, "zh-TW"), "已拒絕（418）。");
});

test("the mirror's ended reasons are said in the page's language, and an unknown reason is shown as the server wrote it", () => {
	for (const why of ["The session is no longer live in this pane.", "The pane runs something else now.", "The pane closed.", "The pane could not be read.", "The session moved to another pane."]) {
		assert.match(source("mirror.ts"), new RegExp(why.replace(/\./g, "\\.")), `${why} is still the server's text`);
		assert.match(endedWhy(why, "zh-TW"), CJK);
		assert.notEqual(endedWhy(why, "en"), "");
	}
	assert.equal(endedWhy("Something else.", "zh-TW"), "Something else.");
});
