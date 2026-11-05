import assert from "node:assert/strict";
import { test } from "node:test";
import type { Answer } from "../gui/post.ts";

// What a reply to the boss's answer meant (gui/asks.ts): the one table every view reads, over the shapes the server's routes give for the same intent (a dialog answer, a trust answer, a message to a tower, a dismissed wait).

const { joined, outcome, waitActions } = await import("../gui/asks.ts");
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
	assert.deepEqual(told, [["input", { text: "Use the staging token", as: "send", answers: "W2" }]], "through the send the caller gives (answerPost of the tower's key, or the demo's stand-in); `answers` names the wait, which the server marks answered");
	await acts.dismiss();
	await waitActions({ ws: "@head", id: "W9", tower: "sb-head" }, async () => ({ ok: true, status: 200, body: {} })).dismiss();
	assert.deepEqual(sent, [["api/tower/w/memory", { op: "drop", id: "W2" }], ["api/head/memory", { op: "drop", id: "W9" }]]);
	assert.deepEqual(acts.goto, { view: "session", ws: "w", key: "sb-tower-w" });
});

test("a reason after \"did not take it:\" starts in lower case, an acronym or another script stays", () => {
	assert.equal(joined("The tower is busy."), "the tower is busy.");
	assert.equal(joined("API is down"), "API is down");
	assert.equal(joined("塔台忙線"), "塔台忙線");
});

// --- the other answers of the boss (link confirm, forwarded dialog, LAN pair request, memory proposal): one set of functions for Standard's rows and Zen's cards ---------------------------------------------

const fetched = (reply: (path: string) => { status: number; body: unknown }) => {
	const sent: [string, Record<string, unknown>][] = [];
	Object.assign(globalThis, { document: { querySelector: () => ({ content: "CSRF" }) }, fetch: async (path: string, init: { body: string }) => { sent.push([path, JSON.parse(init.body)]); const { status, body } = reply(path); return { ok: status < 400, status, json: async () => body }; } });
	return sent;
};

test("a link confirm's Allow and Deny are the confirm-answer route with the dialog's id; a plain success reads as accepted, a refusal keeps the server's reason", async () => {
	const { confirmActions } = await import("../gui/asks.ts");
	const sent = fetched((path) => (path.includes("link/confirm-answer") ? { status: 200, body: {} } : { status: 404, body: {} }));
	const acts = confirmActions({ dialogId: "dc1", digest: "e".repeat(64) });
	assert.equal(outcome(await acts.allow()), "accepted");
	assert.equal(outcome(await acts.deny()), "accepted");
	assert.deepEqual(sent, [["api/link/confirm-answer", { dialogId: "dc1", digest: "e".repeat(64), allow: true }], ["api/link/confirm-answer", { dialogId: "dc1", digest: "e".repeat(64), allow: false }]]);
	fetched(() => ({ status: 409, body: { error: "link_failed", reason: "That request is gone or has timed out" } }));
	const refused = await acts.allow();
	assert.equal(outcome(refused), "refused");
	assert.equal(refused.body.reason, "That request is gone or has timed out");
	const { confirmWhy } = await import("../gui/asks.ts");
	const { m } = await import("../gui/paraglide/messages.js");
	assert.equal(confirmWhy(refused), m.link_confirm_gone(), "a known refusal is said by the page's message");
	assert.equal(confirmWhy({ status: 409, body: { reason: "That team is not running on this device" } }), m.link_confirm_team_off());
	assert.equal(confirmWhy({ status: 409, body: { reason: "That request changed; look at it again" } }), m.link_confirm_changed());
	assert.equal(confirmWhy({ status: 409, body: { reason: "Something new" } }), "Something new", "an unknown reason is the server's");
});

test("a forwarded dialog's answer goes to dialog-answer with the device, dialog and digest the holder checks again, and says only which choice or words", async () => {
	const { forwardedAnswer } = await import("../gui/asks.ts");
	const sent = fetched(() => ({ status: 200, body: {} }));
	const send = forwardedAnswer({ device: "dev-b", dialogId: "dd1", digest: "f".repeat(64) });
	assert.equal(outcome(await send("answer", { choice: 1, dialog: "dd1", digest: "x", answerId: "a" })), "accepted");
	await send("answer", { cancel: true });
	await send("answer", { answers: [["x"]] });
	assert.deepEqual(sent.map(([, b]) => b.answer), [{ choice: 1 }, { cancel: true }, { answers: [["x"]] }]);
	assert.deepEqual(sent[0], ["api/link/dialog-answer", { device: "dev-b", dialogId: "dd1", digest: "f".repeat(64), answer: { choice: 1 } }]);
	fetched(() => ({ status: 409, body: { reason: "The dialog closed" } }));
	const failed = await send("answer", { choice: 0 });
	assert.equal(outcome(failed), "refused");
	assert.match(String(failed.body.reason), /The dialog closed/);
});

test("a memory proposal is confirmed with the rev the snapshot carried and rejected by its id, at the tower's memory route (the head's at head/memory)", async () => {
	const { proposalActions } = await import("../gui/asks.ts");
	const sent = fetched(() => ({ status: 200, body: { rev: 8, proposals: [], entries: [] } }));
	const acts = proposalActions({ ws: "w", id: "P1", rev: () => 7 });
	assert.equal(outcome(await acts.confirm()), "accepted");
	assert.equal(outcome(await acts.reject()), "accepted");
	await proposalActions({ ws: "@head", id: "P2", rev: () => 1 }).reject();
	assert.deepEqual(sent, [["api/tower/w/memory", { op: "confirm", proposal: "P1", rev: 7 }], ["api/tower/w/memory", { op: "reject", proposal: "P1" }], ["api/head/memory", { op: "reject", proposal: "P2" }]]);
});

test("a LAN decision is the approve route: the typed number alone, or one request's id, or all; the reply is read in words by one function", async () => {
	const { lanActions, lanReading } = await import("../gui/asks.ts");
	const sent: [string, Record<string, unknown>][] = [];
	const acts = lanActions(async (path, body) => (sent.push([path, body]), { ok: true, status: 200, body: { paired: { id: "i", label: "Mei's iPhone", peer: "p" } } }));
	assert.equal(outcome(await acts.approve("1234")), "accepted");
	await acts.deny("ab12cd34ef56");
	await acts.denyAll();
	assert.deepEqual(sent, [["lan/approve", { number: "1234" }], ["lan/approve", { deny: "ab12cd34ef56" }], ["lan/approve", { deny: "all" }]]);
	const gone = lanActions(async () => ({ ok: true, status: 200, body: { denied: 0 } }));
	assert.equal(outcome(await gone.deny("ab12cd34ef56")), "refused", "a request the server no longer holds is not an answered one");
	assert.deepEqual(lanReading({ ok: true, status: 200, body: {} }), { answer: "", verdict: "" });
	assert.deepEqual(lanReading({ ok: false, status: 404, body: { error: "no_match" } }), { answer: "No request has that number.", verdict: "" });
	assert.deepEqual(lanReading({ ok: false, status: 404, body: { error: "no_match", denied: 2 } }), { answer: "", verdict: "Three wrong numbers in a row, so every waiting request was denied. Press New code and pair again." });
	assert.equal(lanReading({ ok: false, status: 409, body: { error: "secondary", reason: "Another server holds Wi-Fi access." } }).answer, "Another server holds Wi-Fi access.");
});
