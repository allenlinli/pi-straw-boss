import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answer } from "../gui/post.ts";

// What a reply to the boss's answer meant (gui/asks.ts): the one table every view reads, over the shapes the server's routes give for the same intent (a dialog answer, a trust answer, a message to a tower, a dismissed wait).

const { joined, outcome, waitActions } = await import("../gui/asks.ts");
const { dismissWait } = await import("../gui/towermodel.ts");
const r = (status: number, body: Answer["body"]): Answer => ({ ok: status < 400, status, body });

test("a reply reads as accepted, unknown, or refused by the one table, whichever route it came from", () => {
	const table: [string, Answer, "accepted" | "unknown" | "refused"][] = [
		["a dialog answer the owner took", r(200, { outcome: "accepted" }), "accepted"],
		["an answer to a dialog that was not confirmed", r(200, { outcome: "unknown" }), "unknown"],
		["Herdr did not confirm in time", r(504, {}), "unknown"],
		["a stale dialog", r(200, { outcome: "stale" }), "refused"],
		["a digest the owner refused", r(200, { outcome: "rejected", reason: "digest" }), "refused"],
		["a busy owner", r(200, { outcome: "busy" }), "refused"],
		["a trust answer taken", r(200, { outcome: "accepted", opened: true }), "accepted"],
		["a message the tower took (the input route: no outcome)", r(200, { accepted: true, woke: true }), "accepted"],
		["the conversation's command the tower took", r(200, { accepted: true, command: "new" }), "accepted"],
		["a message the tower refused", r(409, { error: "refused", reason: "The tower did not take it." }), "refused"],
		["a message the server could not reach the tower for", r(409, { error: "standing" }), "refused"],
		["a wait dismissed (the memory route answers its view)", r(200, { rev: 4, proposals: [], entries: [] }), "accepted"],
		["a dismissal of a wait that is gone", r(409, { error: "refused", reason: "No such wait W2" }), "refused"],
		["a body that says nothing", r(200, {}), "refused"],
		["a refusal of the page itself", r(403, { reason: "local_only" }), "refused"],
		["an accepted flag on a failing status", r(500, { accepted: true }), "refused"],
		["the outcome wins over the flag", r(200, { outcome: "stale", accepted: true }), "refused"],
	];
	for (const [what, reply, want] of table) assert.equal(outcome(reply), want, what);
});

test("the wait's actions are plain requests: tell is the tower's session input, dismiss drops the wait at the memory route (the head's at head/memory), goto is the tower's comms", async () => {
	const sent: [string, unknown][] = [];
	Object.assign(globalThis, { document: { querySelector: () => ({ content: "CSRF" }) }, fetch: async (path: string, init: { body: string }) => (sent.push([path, JSON.parse(init.body)]), { ok: true, status: 200, json: async () => ({}) }) });
	const told: [string, Record<string, unknown>][] = [];
	const acts = waitActions({ ws: "w", id: "W2", tower: "sb-tower-w" }, async (action, body) => (told.push([action, body]), { ok: true, status: 200, body: { accepted: true } }));
	assert.equal(outcome(await acts.tell("Use the staging token")), "accepted");
	assert.deepEqual(told, [["input", { text: "Use the staging token", as: "send" }]], "through the send the caller gives (answerPost of the tower's key, or the demo's stand-in)");
	await acts.dismiss();
	await dismissWait("@head", "W9");
	assert.deepEqual(sent, [["api/tower/w/memory", { op: "drop", id: "W2" }], ["api/head/memory", { op: "drop", id: "W9" }]]);
	assert.deepEqual(acts.goto, { view: "session", ws: "w", key: "sb-tower-w" });
});

test("a reason after \"did not take it:\" starts in lower case, an acronym or another script stays", () => {
	assert.equal(joined("The tower is busy."), "the tower is busy.");
	assert.equal(joined("API is down"), "API is down");
	assert.equal(joined("塔台忙線"), "塔台忙線");
});
