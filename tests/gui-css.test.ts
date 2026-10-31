import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// What the page's style sheet must keep (no browser runs here): the hidden slash menu stays hidden, the selected pair tab is shown by more than colour,
// and text boxes and menus are themed.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split("\n").flatMap((line) => (line.includes(selector) ? [line] : [])).join("\n");

test("`.slash[hidden]` is display none", () => {
	assert.match(css, /\.slash\[hidden\]\s*\{\s*display:\s*none/);
});

test("the selected pair tab has a fill and a heavier weight, for `.on` and `aria-selected`", () => {
	const line = rule('.pair-tabs .later[aria-selected="true"]');
	assert.match(line, /\.pair-tabs \.later\.on/);
	assert.match(line, /font-weight:\s*700/);
	assert.match(line, /background:\s*color-mix/);
});

test("the server's facts are a two-column grid and text boxes and menus are themed", () => {
	assert.match(rule(".server-facts {"), /display:\s*grid;\s*grid-template-columns:\s*max-content/);
	assert.match(css, /:where\(input:not\([^)]*\), select\)\s*\{[^}]*background:\s*var\(--surface-0\)/);
});

test("the boss-conversation bar has padding and its phrases wrap as units", () => {
	assert.match(rule(".tower-conv { display: grid"), /padding:\s*8px 10px/);
	assert.match(rule(".tower-conv .conv-line > span"), /display:\s*inline-block/);
});

test("the settings' View control wraps, and a server default gives the long Auto button (Follow server (geek)) a row of its own", () => {
	assert.match(css, /\.view-pick > div \{ flex-wrap: wrap; \}/);
	assert.match(css, /\.view-pick\[data-following\] button\[data-choice="auto"\] \{ flex-basis: 100%; \}/);
});

test("the drawer marks its current unit by a tint and a chevron, never by coloured side stripes", () => {
	const lines = css.split("\n").filter((line) => line.includes(".drawer .unit.current"));
	assert.ok(lines.length > 0);
	for (const line of lines) assert.doesNotMatch(line, /inset\s+-?\d+px\s+0\s+var\(--c\)/, "an inset stripe on one side");
	assert.match(rule(".drawer .unit.current > .card {"), /background:\s*var\(--c1\)/);
	assert.match(rule(".drawer .unit.current > .card > .hit::after"), /content:\s*"›"/);
});

test("a finished card's Dismiss takes its own row on a phone, and a question's card says when more lies below", () => {
	assert.match(rule(".base .card > .quit-btn:not([hidden]) {"), /flex:\s*1 1 100%/);
	assert.match(rule(".base .card:has(> .quit-btn:not([hidden]))"), /flex-wrap:\s*wrap/);
	assert.match(rule(".comms-in .ask[data-more] .ask-acts::before"), /content:\s*attr\(data-cue\)/);
	assert.match(rule(".comms-in .ask-opts"), /max-height:\s*none/);
});

test("forced colors: disabled controls and placeholders take GrayText, and the map's connectors are left out", () => {
	const block = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(block, /:is\(\.composer, \.ask\) button:disabled\s*\{[^}]*GrayText/);
	assert.match(block, /::placeholder\s*\{\s*color:\s*GrayText/);
	assert.match(block, /\.links, \.packets \{ display: none/);
});

test("Geek: a disabled Send is dim words in a dashed outline, a focused timeline tick has a ring, and the settings page drops the bar's chips", () => {
	assert.match(rule('[data-view="geek"] :is(.composer, .ask) button:disabled'), /opacity:\s*1[^}]*dashed/);
	assert.match(rule('[data-view="geek"] .tl-mark:focus-visible'), /outline:\s*2px solid var\(--text\)/);
	assert.match(rule('body[data-route="settings"]'), /display:\s*none/);
});
