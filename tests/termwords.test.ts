import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { endedWhy, refusalText, REFUSAL_CODES } from "../gui/termwords.ts";

// The refusals of a terminal's keys (src/keys.ts) and mirror (src/mirror.ts) in the page's language, by the server's code; a code the page does not know shows the server's own text.

const ans = (error: string, reason = "the server's words", status = 409) => ({ ok: false, status, body: { error, reason } });
const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
/** The codes the keys and mirror routes refuse with: their own files whole, a pane's answerpane.ts whole, and control.ts's lines for the session routes (the tower standing, the mirror, the session, the key in flight). */
const routes = () => {
	const lines = source("control.ts").split("\n"), from = lines.findIndex((l) => l.includes('if (action === "mirror")'));
	const to = lines.findIndex((l, i) => i > from && l.includes('if (action === "commands")'));
	return [...lines.filter((l) => l.includes('["keys", "mirror", "focus"]') || l.includes("Another input to this session")), ...lines.slice(from, to)].join("\n");
};
const found = (text: string) => [...text.matchAll(/\bno\(\d+, "([a-z_]+)"/g)].map((x) => x[1]!);
const codes = [...new Set([...found(source("keys.ts")), ...found(source("mirror.ts")), ...found(source("answerpane.ts")), ...found(routes())])].filter((c) => c !== "confirm");
const CJK = /[\u4e00-\u9fff]/;

test("every code the server's keys and mirror routes refuse with (keys.ts, mirror.ts, answerpane.ts, control.ts) has the page's words, and the table lists no code the server lacks", () => {
	assert.ok(codes.includes("standing") && codes.includes("not_found") && codes.includes("pane_closed"), "the control.ts and answerpane.ts codes are read");
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

test("an operate refusal with a word of its own (binding, binding-unread, foreground) is said in the page's words; any other why falls back to the generic operate words", () => {
	const op = (why: string) => ({ ok: false, status: 403, body: { error: "operate_refused", reason: "the server's words", why } });
	const generic = refusalText(op("shell"), "en");
	for (const why of ["binding", "binding-unread", "foreground"]) {
		const en = refusalText(op(why), "en"), zh = refusalText(op(why), "zh-TW");
		assert.notEqual(en, generic, why);
		assert.notEqual(en, "the server's words", why);
		assert.match(zh, CJK, why);
	}
	assert.equal(new Set(["binding", "binding-unread", "foreground"].map((why) => refusalText(op(why), "en"))).size, 3);
});
