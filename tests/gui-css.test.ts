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

test("the 'More below' cue sits in the Send row, never absolutely over option text; the 360 placeholder is small and its hint short", () => {
	const cue = /ask-acts::before \{[^}]*\}/.exec(rule(".comms-in .ask[data-more] .ask-acts::before"))![0];
	assert.doesNotMatch(cue, /position:\s*absolute/);
	assert.match(cue, /flex:\s*1 1 100%/);
	assert.match(css, /@media \(max-width: 380px\) \{\s*\n\s*\.composer textarea::placeholder \{ font-size: 12px/);
	const en = JSON.parse(readFileSync(new URL("../gui/messages/en.json", import.meta.url), "utf8"));
	assert.ok(en.blocked_answer_above.length <= 22, "fits one 12px monospace line in the 360 px one-row box");
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

test("a question card's Cancel is a 44 px target on a phone, quieter than Send, and shares Send's press feedback", () => {
	assert.match(rule(".ask-cancel {"), /border:\s*1px solid var\(--line\)[^}]*background:\s*none/);
	assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.ask-send, \.ask-cancel, \.ask-opt[^{]*\{ min-height: 44px; \}/);
	assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.ask-send, \.ask-cancel, \.sheet-yes, \.cmp-yes\) \{ min-width: 44px; \}/);
	assert.match(css, /:is\(\.ask, \.term-bar, \.doc-acts, \.composer\) :is\(button, \.cmp-link\) \{ min-height: 44px; \}/, "and the narrow rule covers every button in the card");
});

test("the settings column keeps one width: auto side margins never shrink it to its content in the stacked (column) layout, and its Go buttons drop the UA border", () => {
	const column = rule(".settings.view {");
	assert.match(column, /margin-inline:\s*auto/);
	assert.match(column, /(^|[\s;{])width:\s*100%/, "auto margins turn off a column flex item's stretch; the explicit width keeps it full");
	assert.match(column, /max-width:\s*760px/);
	assert.match(rule(".teams-tile .go {"), /border:\s*0/);
});

const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");

test("Zen's first frame in style.css is scoped to the Zen view, so Standard and Geek keep their rules: the breathing ring, its calm still, and its keyframes are the only additions", () => {
	for (const line of css.split("\n").filter((l) => /zen-breath|#zen:empty/.test(l))) assert.match(line, /data-view="zen"|@keyframes zen-breath/, line.slice(0, 80));
	assert.match(css, /#zen:empty:not\(\[hidden\]\)::after \{[^}]*animation: zen-breath 10s infinite/);
	assert.match(css, /\[data-view="zen"\]\[data-calm\] #zen:empty:not\(\[hidden\]\)::after \{ animation: none; \}/);
	assert.match(css, /40% \{ transform: scale\(1\)/, "4 s in of the 10 s breath");
	assert.ok(!/zen/.test(css.slice(css.indexOf('[data-view="geek"] {'))), "nothing of Zen's after the Geek block opens");
});

test("zen.css: every rule is under the Zen view, the answer card has no Standard chrome, targets are 44 px, and motion stills under calm, reduced motion, and forced colours", () => {
	const body = zen.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const sel of body.matchAll(/^(\[data-view="zen"\][^{]*|@[^{]*)\{/gm)) assert.ok(sel[1]!.includes('data-view="zen"') || sel[1]!.startsWith("@"), sel[1]);
	assert.ok(!/(^|\n)(?!\s|\[data-view|@|\}|--)\S/.test(body.replace(/@keyframes[^{]*\{[\s\S]*?\}\s*\}|@keyframes[^{]*\{[^}]*\}/g, "")), "no rule outside the Zen view");
	assert.match(zen, /\.zen-(fs|menubtn)[^{]*\{ width: 44px; height: 44px;/, "the corner controls are 44 px");
	assert.match(zen, /\.zen-row \{[^}]*min-height: 44px/, "and the menu's rows");
	assert.match(zen, /\.zen-opt[^{]*\{ min-width: 44px; min-height: 44px;/);
	assert.match(zen, /\[data-calm\] :is\(\.zen-circle, \.zen-circle i, \.zen-drift i\) \{ animation: none; \}/);
	assert.match(zen, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(zen, /@media \(forced-colors: active\)[\s\S]*\.zen-drift[\s\S]*CanvasText/);
	assert.match(zen, /:focus-visible \{ outline: 2px solid var\(--zen-seal\)/, "a visible focus ring");
	assert.match(zen, /\.zen-card-in > \* \{ animation: zen-in 1\.8s/, "the card's parts arrive slowly, one after another");
	assert.match(zen, /\.zen-card \{[^}]*transition: height 0\.52s var\(--zen-ease\)/, "the card's box eases to the size its content needs (zensize.ts), 400 to 600 ms");
	assert.match(zen, /prefers-reduced-motion: reduce\) \{[^\n]*\.zen-card\) \{ transition: none; \}/, "and follows at once under reduced motion");
	assert.match(zen, /animation-delay: calc\(var\(--n, 0\) \* 0\.22s\)/);
	assert.match(zen, /\.zen-log \.chat-scroll \{ overscroll-behavior: contain; touch-action: pan-y; \}/, "the log scrolls itself only: nothing chains to the page, a finger moves it up and down");
	assert.match(zen, /\.zen-card \{ overscroll-behavior: contain; \}/);
	assert.match(zen, /\.chat-pill \{ border: 1px solid var\(--zen-line\); background: var\(--zen-warm\); color: var\(--zen-paper\);/, "the log's pill is paper on warm (7 : 1, tests/zen-contrast.test.ts), not paper on paper");
	assert.match(zen, /#zen \{ overscroll-behavior: none; \}/, "no pull-to-refresh or history swipe from the layer");
	assert.match(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), /html\[data-view="zen"\], html\[data-view="zen"\] body \{[^}]*overscroll-behavior: none;/, "nor from the page under it, from the first frame");
	assert.ok(!/\.zen-(header|bar|nav)\b/.test(zen) && !/zen-nothing/.test(zen));
});
