import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_STATES, demoCard, isCard, stepOf } from "../gui/democard.ts";

const quiet = () => {};

test("every demo state has a step: a pane for the pane states, a prompt for the rest, and a reload that ends the session", () => {
	assert.ok(CARD_STATES.every((s) => isCard(s)) && !isCard("zen") && !isCard(null));
	for (const s of CARD_STATES) assert.equal(stepOf(s).kind, ["type", "run", "secretmiss", "stale", "gone"].includes(s) ? "pane" : "prompt", s);
	assert.equal(stepOf("reload").command, "/reload");
	assert.equal(stepOf("held").asker, "t1");
});

test("the script answers only its own terminal", () => {
	const card = demoCard("prompt", quiet);
	assert.equal(card.mirror("other", true), undefined);
	assert.equal(card.keys("other", { key: "enter" }), undefined);
});

test("a prompt's Enter asks to confirm, then is taken with the token it named", () => {
	const card = demoCard("prompt", quiet), key = stepOf("prompt").key;
	const ask = card.keys(key, { key: "enter" })!;
	assert.deepEqual([ask.ok, ask.status, ask.body.confirm], [false, 409, "command"]);
	assert.equal(card.keys(key, { key: "enter", confirmed: "reload" })!.ok, false);
	assert.deepEqual(card.keys(key, { key: "enter", confirmed: "command" })!.body, { accepted: true });
	assert.equal(demoCard("reload", quiet).keys(stepOf("reload").key, { key: "enter" })!.body.confirm, "reload");
});

test("refusals: keys refused, a hidden session, a second page, and a pane that is gone", () => {
	for (const [state, status] of [["refused", 409], ["hidden", 409]] as const) assert.equal(demoCard(state, quiet).keys(stepOf(state).key, { key: "enter" })!.status, status, state);
	const second = demoCard("second", quiet), gone = demoCard("gone", quiet);
	assert.deepEqual([second.mirror(stepOf("second").key, true)!.status, gone.mirror(stepOf("gone").key, true)!.status], [409, 404]);
	assert.equal(second.mirror(stepOf("second").key, false)!.ok, true);
});

test("a pane's Enter walks the password prompt, then the output, and a detach stops the frames", () => {
	const sent: [string, any][] = [], card = demoCard("type", (t, p) => sent.push([t, p])), key = stepOf("type").key;
	assert.equal(card.mirror(key, true)!.ok, true);
	card.keys(key, { key: "enter" });
	assert.ok(sent.at(-1)![1].set.some(([, row]: [number, string]) => row.includes("password")));
	card.keys(key, { key: "enter" });
	assert.ok(sent.at(-1)![1].set.some(([, row]: [number, string]) => row.startsWith("Reading package lists")));
	card.mirror(key, false);
});
