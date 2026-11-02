import assert from "node:assert/strict";
import { test } from "node:test";
import { RULES, rulesOf } from "../gui/faces.ts";
import type { View } from "../gui/view.ts";

// The rules table (gui/faces.ts) is the one place that says what a view does beyond its skin, as typegate.test.ts is for the server's typing rule: each row is written out in full, so a changed cell fails here and nowhere else.
const STANDARD = { count: true, clips: true, announce: "arrivals", keys: "dialogs", drawer: true, calm: true, chime: true, escape: "stay" } as const;

test("Standard: the tab icon counts, arrivals make the clips and reminders, the dialog keys and the drawer are on, the page calms, new link notices chime, Esc stays in a filled field", () => {
	assert.deepEqual(RULES.standard, STANDARD);
});

test("Geek is Standard's behavior with one difference: its stylesheet keeps the still signs always, so the page never calms", () => {
	assert.deepEqual(RULES.geek, { ...STANDARD, calm: false });
});

test("Zen: no count, no clip, no Standard keys, no drawer, no chime; it announces the current item itself; calm on; Esc blurs a filled field first", () => {
	assert.deepEqual(RULES.zen, { count: false, clips: false, announce: "current", keys: "zen", drawer: false, calm: true, chime: false, escape: "blur" });
});

test("Zen shows no count anywhere: every rule that could carry one is off", () => {
	const z = RULES.zen;
	assert.equal(z.count, false, "the tab icon");
	assert.equal(z.clips, false, "the clips");
	assert.equal(z.chime, false, "the link bar's chime");
	assert.equal(z.drawer, false, "the drawer's per-unit list");
	assert.equal(z.announce, "current", "one item at a time, not every arrival");
});

test("rulesOf: a page that left Zen (or sits on the settings page) follows Standard's rules; the other views ignore `away`", () => {
	for (const away of [false, true]) {
		assert.equal(rulesOf("standard", away), RULES.standard);
		assert.equal(rulesOf("geek", away), RULES.geek);
	}
	assert.equal(rulesOf("zen", false), RULES.zen);
	assert.equal(rulesOf("zen", true), RULES.standard);
});

test("every view has a row, and no row has a field another lacks", () => {
	const views: View[] = ["standard", "geek", "zen"];
	assert.deepEqual(Object.keys(RULES).sort(), [...views].sort());
	for (const v of views) assert.deepEqual(Object.keys(RULES[v]).sort(), Object.keys(STANDARD).sort(), v);
});
