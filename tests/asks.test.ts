import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answer } from "../gui/post.ts";

// What a reply to the boss's answer meant (gui/asks.ts): the one table every view reads, over the shapes the server's routes give for the same intent (a dialog answer, a trust answer, a message to a tower, a dismissed wait).

const { outcome } = await import("../gui/asks.ts");
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
