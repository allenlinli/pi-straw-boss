import assert from "node:assert/strict";
import { test } from "node:test";
import { unitLabel } from "../src/server/dispatcher.ts";

// What a controller is told asks a question (src/server/dispatcher.ts): the unit's name, with its role where the name alone does not say what it is, scrubbed as every label that leaves the box is.

test("a main, a member, a subagent and an ally run are named with their role; a tower or an outside pi by its name alone", () => {
	assert.equal(unitLabel({ name: "trial10 scout check", role: "main" }), "main - trial10 scout check");
	assert.equal(unitLabel({ name: "docs", role: "member" }), "member - docs");
	assert.equal(unitLabel({ name: "scout", role: "subagent" }), "subagent - scout");
	assert.equal(unitLabel({ name: "Mei's Mac", role: "ally" }), "ally run - Mei's Mac");
	assert.equal(unitLabel({ name: "tower · Alpha", role: "tower" }), "tower · Alpha");
	assert.equal(unitLabel({ name: "ops", role: "outside" }), "ops");
});

test("a name that already starts with the role is not given it twice: the tab's `main · trial11` is told as it is, `maintenance` and `mainframe` are other words", () => {
	assert.equal(unitLabel({ name: "main · trial11", role: "main" }), "main · trial11");
	assert.equal(unitLabel({ name: "Main trial11", role: "main" }), "Main trial11");
	assert.equal(unitLabel({ name: "main", role: "main" }), "main");
	assert.equal(unitLabel({ name: "subagent-scout", role: "subagent" }), "subagent-scout");
	assert.equal(unitLabel({ name: "ally run Mei", role: "ally" }), "ally run Mei");
	assert.equal(unitLabel({ name: "maintenance", role: "main" }), "main - maintenance");
	assert.equal(unitLabel({ name: "mainframe batch", role: "main" }), "main - mainframe batch");
	assert.equal(unitLabel({ name: "main · trial11", role: "member" }), "member - main · trial11", "another role's word is no reason to drop this one");
});

test("the separator is ASCII, so the controller's notice (restrictLabel: letters, digits, space, dot, underscore, hyphen) keeps it; the name is restricted there and whole on the card", () => {
	assert.match(unitLabel({ name: "docs", role: "main" })!, /^[A-Za-z0-9 ._-]+$/);
});

test("the name is scrubbed as the board's labels are: a path or a token does not leave the box, and a name that was only that says nothing", () => {
	assert.equal(unitLabel({ name: "fix /Users/me/secret/app.ts now", role: "main" }), "main - fix … now");
	assert.equal(unitLabel({ name: "token sk-abcdefghijklmnopqrstuvwxyz0123456789", role: "main" }), "main - token …");
	assert.equal(unitLabel({ name: "sk-abcdefghijklmnopqrstuvwxyz0123456789", role: "main" }), undefined);
	assert.equal(unitLabel({ name: "  ", role: "main" }), undefined);
});

test("a unit the registry does not know says nothing, and the question is told by the package that owns it", () => {
	assert.equal(unitLabel(undefined), undefined);
});
