import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

// The glass, the phone's cover frame, and the strike's early start are Raven's alone (boss, 2026-11-09: Standard and Geek change only by a boss decision). Raven's stylesheet is loaded the first time a page shows the view and stays in the document after a switch back, so every selector of it must name the raven view; Standard's and Geek's stylesheets are not touched by this work.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const raven = read("gui/themes/raven/raven.css"), rules = rulesOf(raven);

test("every selector of raven.css names the raven view, so its glass, frame, and animations reach no other view even once the file is loaded", () => {
	for (const rule of rules) for (const part of rule.parts) assert.match(part, /^(?:html)?\[data-view="raven"\]/, `${part} is scoped to the raven view`);
});

test("the glass is inside @supports and the phone frame inside a 600 px query, so a browser without backdrop-filter keeps the opaque fills and a wide screen the frame it had", () => {
	const supports = /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raven)?.[1] ?? "";
	const inside = rulesOf(supports);
	assert.ok(inside.length >= 5, "the glass rules are in the block");
	for (const r of inside) assert.ok(r.parts.every((p) => /^html\[data-view="raven"\]/.test(p)), `${r.selector} is scoped`);
	const phone = /@media \(max-width: 600px\) \{\s*html\[data-view="raven"\] \{ --rk-w: max\(100vw, calc\(100vh \* 1\.7753\)\); --rk-w: max\(100vw, calc\(100svh \* 1\.7753\)\); \}([^@]*)\}/.exec(raven);
	assert.ok(phone, "the phone frame: the screen's height times 1280 / 721, never narrower than the screen, with a vh fallback for the svh");
	assert.match(phone[1]!, /\{ left: 0; translate: none; \}/, "pinned to the left edge, where the castle is");
	assert.ok(Math.abs(1280 / 721 - 1.7753) < 1e-4, "the picture's aspect");
	// the wide-screen frame is what it was
	const token = declarations(rules.find((r) => r.selector === '[data-view="raven"]')!.body).find(([p]) => p === "--rk-w")![1];
	assert.equal(token, "min(100vw, 1600px)");
});

test("Standard's and Geek's stylesheets carry no raven glass: neither names a raven token", () => {
	for (const file of ["gui/style.css", "gui/themes/geek/geek.css"]) assert.ok(!/--rk-|data-view="raven"/.test(read(file)), `${file} has no raven rule`);
});

test("a phone keeps the map's perched raven (44 px, on the band, taking no tap) and the head page's stays off it", () => {
	const phone = /@media \(max-width: 600px\) \{ (html\[data-view="raven"\]:has\(#stage\[data-view="map"\]\) body::after[^\n]*)\n/.exec(raven)?.[1] ?? "";
	assert.ok(phone.length > 0, "the map's phone block");
	assert.ok(!/\.head-node > \.perch \{ display: none/.test(phone) && !/\.head-node > \.perch,? ?\{? ?display/.test(phone), "the band's perch is not hidden");
	assert.match(phone, /\.head-node \{ --rk-pw: 44px; margin-top: calc\(var\(--rk-pw\) \* 0\.806 - 8px\); \}/);
	assert.match(raven, /\.head-node > \.perch \{\s*display: block; position: absolute; pointer-events: none;/);
	assert.match(raven, /@media \(max-width: 600px\) \{ html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\) body::after[^\n]*\.stage\[data-view="head"\] > \.perch \{ display: none; \}/, "the head page's perch is on the gate, off a phone's visible part of the frame");
});
