import assert from "node:assert/strict";
import { test } from "node:test";
import "./pbs-loader.ts";
import { commandLine, deliverToDoc, deliverToUnit, docFields } from "../gui/blockanswer.ts";
import { hasBlocks } from "../gui/mdbody.ts";
import type { Answer as Posted } from "../gui/post.ts";

// How a block's answer leaves the page: the hint that decides whether the block code loads at all, the text a chat block sends as the boss's message (its guards), and the v1 fields a document block's answer goes out on.

const { BLOCK_KINDS, encodeAnswer } = await import("pi-better-show");
const ok = (body: Record<string, unknown> = { accepted: true }): Posted => ({ ok: true, status: 200, body });
const refuse = (status: number, error: string, reason?: string): Posted => ({ ok: false, status, body: { error, ...(reason ? { reason } : {}) } });

test("the hint finds exactly the texts the block parser would split: a fence of a block kind (any fence length, either marker, up to three spaces in) or a GitHub alert", () => {
	for (const kind of BLOCK_KINDS.filter((k) => k !== "alert")) {
		assert.ok(hasBlocks(`text\n\n\`\`\`${kind}\nx\n\`\`\``), kind);
		assert.ok(hasBlocks(`~~~${kind.toUpperCase()}\nx\n~~~`), `${kind} in capitals`);
		assert.ok(hasBlocks(`  \`\`\`\`${kind} extra words\nx\n\`\`\`\``), `${kind} in a long fence with words after`);
	}
	for (const alert of ["NOTE", "tip", "IMPORTANT", "Warning", "CAUTION"]) assert.ok(hasBlocks(`> [!${alert}] t\n> body`), alert);
	assert.ok(hasBlocks("> [!NOTE]"), "an alert with no title");
	for (const none of ["plain **text**", "```js\nlet a\n```", "```formal\nx\n```", "    ```form\nx\n```", "> a quote\n> [!NOTES]\n", "> text [!NOTE]", "`form`", "form\n```\nx\n```"]) assert.ok(!hasBlocks(none), none);
});

test("a command line is a text beginning with ! or /, after any space: a block never sends one", () => {
	for (const line of ["/quit", "  /boss gui stop", "!rm -rf x", "\n!ls", "/new"]) assert.ok(commandLine(line), line);
	for (const text of ["Go ahead", "User picked \"A\".", "a / b", "ok!", "https://x/y"]) assert.ok(!commandLine(text), text);
});

test("a chat block's answer goes to the unit as the boss's message through the composer's input route, held to a paired device's guards", async () => {
	const posts: Record<string, unknown>[] = [];
	const to = deliverToUnit(async (body) => (posts.push(body), ok()));
	assert.deepEqual(await to("Go ahead"), { ok: true });
	assert.deepEqual(posts, [{ text: "Go ahead", as: "send", guarded: true }], "guarded: the server's local-only /boss refusal applies here too");
	assert.equal(posts.length, 1);
});

test("a chat block never sends a command line, and nothing is posted for one", async () => {
	const posts: unknown[] = [];
	const to = deliverToUnit(async (body) => (posts.push(body), ok()));
	for (const line of ["/quit", "/boss gui stop", "!rm -rf ~"]) {
		const r = await to(line);
		assert.equal(r.ok, false, line);
		assert.ok(!r.ok && r.reason.length > 0);
	}
	assert.deepEqual(posts, []);
});

test("what the server refuses is said in its words (or the page's), an unconfirmed send as unsure, a network failure as unsure", async () => {
	const to = (r: Posted | Error) => deliverToUnit(async () => { if (r instanceof Error) throw r; return r; });
	assert.deepEqual(await to(refuse(409, "not_live", "This session is no longer live in a pane."))("x"), { ok: false, reason: "This session is no longer live in a pane." });
	const local = await to(refuse(403, "local_only", "A /boss send is held to the guards of a remote write."))("x");
	assert.ok(!local.ok && /remote write/.test(local.reason));
	const unsure = await to(refuse(504, "timeout"))("x");
	assert.ok(!unsure.ok && /Not confirmed/.test(unsure.reason));
	const down = await to(new Error("network"))("x");
	assert.ok(!down.ok && /Not confirmed/.test(down.reason));
});

test("a document block's answer goes out on the v1 form path: a form's fields as they are, a review under its kind, other answers as a form that names the block", () => {
	assert.deepEqual(docFields({ kind: "form", title: "t", fields: [["a", "1"], ["b", "2"]] }), [["a", "1"], ["b", "2"]]);
	assert.deepEqual(docFields({ kind: "review", fields: [["title", "L"], ["picked", "A"]] }), [["pi-kind", "review"], ["title", "L"], ["picked", "A"]]);
	assert.deepEqual(docFields({ kind: "feedback", fields: [["page", "p"]] }), [["pi-kind", "feedback"], ["page", "p"]]);
	assert.deepEqual(docFields({ kind: "pick", title: "Store", fields: [["picked", "SQLite"]] }), [["block", 'pick "Store"'], ["picked", "SQLite"]]);
	assert.deepEqual(docFields({ kind: "suggest", fields: [["text", "Go"]] }), [["block", "suggest"], ["text", "Go"]]);
	assert.deepEqual(docFields({ kind: "checklist", title: "T", fields: [["Run tests", "checked"]] }), [["block", 'checklist "T"'], ["Run tests", "checked"]]);
	assert.deepEqual(docFields({ kind: "form", fields: [["pi-kind", "review"], ["a", "1"]] }), [["a", "1"]], "a block cannot pick the kind the owner reads");
});

test("the owner's v1 reading of docFields is the text encodeAnswer gives for the kinds v1 knows", () => {
	// The v1 owner (pi-herdr-doc-review) reads `pi-kind`; encodeAnswer is byte-compatible with it for form and review.
	const review = { kind: "review" as const, fields: [["title", "L"], ["picked", "A"], ["item", "A"], ["comment", "good"]] as [string, string][] };
	assert.match(encodeAnswer(review), /^User reviewed "L":\nPicked: A\n- A: good$/);
	assert.deepEqual(docFields(review)[0], ["pi-kind", "review"]);
});

test("a document block's answer is posted to the document's answer route under one answer id, and its result is the delivery", async () => {
	const posts: [string, Record<string, unknown>][] = [];
	const to = deliverToDoc(async (path, body) => (posts.push([path, body]), ok()), "cap/with space");
	assert.deepEqual(await to({ kind: "form", fields: [["a", "1"]] }), { ok: true });
	const [[path, body]] = posts as [[string, { answerId: string; fields: unknown }]];
	assert.equal(path, "doc/cap%2Fwith%20space/answer");
	assert.match(body.answerId, /^[A-Za-z0-9_-]{16,64}$/);
	assert.deepEqual(body.fields, [["a", "1"]]);
	await to({ kind: "form", fields: [["a", "1"]] });
	assert.notEqual((posts[1]![1] as { answerId: string }).answerId, body.answerId, "each answer has an id of its own");
	const gone = await deliverToDoc(async () => refuse(409, "closed", "The document is no longer open in its session."), "c")({ kind: "form", fields: [["a", "1"]] });
	assert.deepEqual(gone, { ok: false, reason: "The document is no longer open in its session." });
	const lost = await deliverToDoc(async () => refuse(504, "not_confirmed", "Check the terminal."), "c")({ kind: "form", fields: [["a", "1"]] });
	assert.ok(!lost.ok && /Check the terminal|Not confirmed/.test(lost.reason));
});
