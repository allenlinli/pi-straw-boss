import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

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

test("zen.css: the visual language (Z-D15): no boxes, selection is light with a dot, the seal marks only the keys and never as a ring around a box, overlays let the page recede", () => {
	const at = zen.indexOf("The visual language (Z-D15");
	assert.ok(at > 0, "the block");
	const v = zen.slice(at, zen.indexOf("@media (prefers-reduced-motion: reduce) { [data-view=\"zen\"] .zen-ripples", at));
	assert.match(v, /\.zen-card button\.ask-opt \{ display: grid;[^}]*row-gap: 0;[^}]*border: 1px solid transparent;[^}]*background: transparent;/, "a choice is a line, not a pill");
	assert.match(v, /\.zen-card button\.ask-opt::before \{ content: "";[^}]*border-radius: 50%;/, "with a dot before it");
	assert.match(v, /\.ask-opt\[aria-checked="true"\]::before \{ border-color: var\(--zen-paper\); background: var\(--zen-paper\); \}/, "the dot fills when chosen");
	assert.match(v, /button\.ask-opt:focus-visible::before \{ border-color: var\(--zen-seal\);/, "the keys ring the dot, inside the line");
	assert.match(v, /#zen :is\([^)]*\.ask-send[^)]*\):focus-visible \{ outline: none; text-decoration: underline 1px var\(--zen-seal\)/, "a button the keys are on is underlined in seal, not ringed");
	assert.match(v, /:is\(\.zen-card \.ask-own, \.composer textarea, \.tcard-input\) \{ border: 1px solid transparent; border-bottom-color: var\(--zen-line\); border-radius: 0; background: transparent;/, "a text field is one line under the words");
	assert.match(v, /#zen :is\([^)]*\.palette-box\):focus-visible \{ outline: none; border-radius: 0;/, "and its focus beats the page-wide ring");
	assert.match(v, /:is\(\.ask-send, \.cmp-send, \.cmp-yes, \.pad-yes, \.tcard-go, \.zen-term-back\) \{ border-color: transparent; background: transparent;/, "Send is a word");
	assert.match(v, /\.zen-log \.bubble \{ padding-inline: 0; background: transparent; color: var\(--zen-ash\); \}/, "what you said: at the right, in ash, no ground (the boss's pick)");
	assert.match(v, /\.palette-back \{ background: var\(--zen-veil\);[^}]*(?<!-)backdrop-filter: blur\(10px\);/, "the palette's page recedes (the unprefixed property, not only -webkit-)");
	assert.match(v, /\.palette-panel \{[^}]*border-color: transparent; background: transparent;/, "and the palette has no panel");
	assert.match(v, /:is\(\.zen-menuhost:has\(> \.zen-menu:not\(\[hidden\]\)\), \.zen-musichost:has\(> \.zen-musicpanel:not\(\[hidden\]\)\)\)::before \{ content: ""; position: fixed; inset: 0;[^}]*pointer-events: auto;/, "the menu and the music list lay the same veil, which takes the press that closes them (ZVL-F002)");
	assert.match(v, /\.zen-term-host :is\(\.pad-yes, \.tcard-go\) \{ border-color: transparent; background: transparent; color: var\(--zen-paper\);/, "the terminal layer's yes is a word, over its pill rule (ZVL-F001)");
	assert.match(v, /\.zen-term-host :is\(\.pad-no, \.tcard-mask\) \{ border-color: transparent; background: transparent; color: var\(--zen-ash\); \}/, "and its no is the quieter word");
	assert.match(v, /\.zen-term-host :is\(\.pad-yes, \.tcard-go\):hover:not\(:disabled\) \{ background: var\(--zen-glow\); \}/, "its hover is the glow, not the warm pill");
	assert.doesNotMatch(zen, /\.zen-term-host[^{]*\{[^}]*background: var\(--zen-warm\)/, "no older term-host rule fills a pair button with the warm ground (a mask[aria-pressed] in its :is outranked the block)");
	assert.match(v, /:is\(\.zen-menu, \.zen-musicpanel\) \{ border-color: transparent; background: transparent;/);
	assert.match(zen.slice(zen.indexOf("@media (forced-colors: active) {\n")), /^\t\[data-view="zen"\] \.zen-card \.ask-opt\[aria-checked="true"\]::before \{ forced-color-adjust: none; border-color: Highlight; background: Highlight; \}/m, "forced colours keeps the chosen dot (ZVL-F003)");
	assert.doesNotMatch(zen, /\.zen-company \.composer textarea \{ border: 0/, "the companion's box is a transparent border with a line under it, not border 0 (ZVL-F004)");
	assert.doesNotMatch(v, /border: 0[;\s]|border: none/, "borders turn transparent, never go: forced colours draws them");
	assert.doesNotMatch(v, /rgba?\(|#[0-9a-f]{3,8}\b/i, "the block's colours are the ink tokens");
});

test("zen.css: every rule is under the Zen view, the answer card has no Standard chrome, targets are 44 px, and motion keeps breathing at rest (Z-D13) and stills under reduced motion and forced colours", () => {
	const body = zen.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const sel of body.matchAll(/^(\[data-view="zen"\][^{]*|@[^{]*)\{/gm)) assert.ok(sel[1]!.includes('data-view="zen"') || sel[1]!.startsWith("@"), sel[1]);
	assert.ok(!/(^|\n)(?!\s|\[data-view|@|\}|--)\S/.test(body.replace(/@keyframes[^{]*\{[\s\S]*?\}\s*\}|@keyframes[^{]*\{[^}]*\}/g, "")), "no rule outside the Zen view");
	assert.match(zen, /\.zen-(fs|menubtn)[^{]*\{ width: 44px; height: 44px;/, "the corner controls are 44 px");
	assert.match(zen, /\.zen-row \{[^}]*min-height: 44px/, "and the menu's rows");
	assert.match(zen, /\.zen-opt[^{]*\{ min-width: 44px; min-height: 44px;/);
	assert.ok(!/\[data-calm\]/.test(zen.replace(/\/\*[\s\S]*?\*\//g, "")), "calm stills nothing in Zen: the circle and the ground keep breathing (Z-D13)");
	assert.match(zen, /\.zen-stage:has\(\.zen-company\) > \.zen-circle \{[^}]*animation-name: zen-breath-low;/, "the circle breathes behind the companion's log");
	assert.match(zen, /@keyframes zen-breath-low \{ 0% \{ transform: scale\(0\.72\)[^}]*\} 40% \{ transform: scale\(1\)/);
	assert.match(zen, /\.zen-drift i:last-child \{[^}]*animation: zen-tide 30s[^;]*, zen-wander 47s/, "the ground's tide is half a minute, and it wanders");
	assert.match(zen, /@keyframes zen-wander \{ from \{ transform: translate3d\(/, "the wander moves by transform alone");
	assert.match(zen, /animation: zen-wash 24s/, "the washes drift within half a minute");
	assert.match(zen, /\.zen-log :is\(\.tx-body, \.bubble, details\.act, \.thought, \.more, pre, th, td, \.pic\) \{ border-color: transparent;/, "the companion's log has no boxes");
	assert.match(zen, /\.zen-log :is\(\.thought, \.more\)::before \{ border-color: transparent; \}/, "nor the outline a touch screen draws on ::before");
	assert.match(zen, /\.zen-company \.composer textarea \{ border: 1px solid transparent; border-bottom-color: var\(--zen-line\)/, "its composer is one line");
	assert.match(zen, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(zen, /@media \(forced-colors: active\)[\s\S]*\.zen-drift[\s\S]*CanvasText/);
	assert.match(zen, /:focus-visible \{ outline: 2px solid var\(--zen-seal\)/, "a visible focus ring");
	assert.match(zen, /\.zen-card-in > \* \{ animation: zen-in 1\.8s/, "the card's parts arrive slowly, one after another");
	assert.ok(!/transition:[^;}]*\b(height|width|max-height|all)\b/.test(zen) && !/animation[^;}]*\b(height|width)\b/.test(zen), "no height or width animation anywhere on a Zen card: it takes its size at once");
	assert.match(zen, /@keyframes zen-in \{ from \{ opacity: 0; \} \}/, "a card's parts arrive by opacity alone");
	assert.match(zen, /\.zen-card \[data-fade\] \{ animation: zen-fade 0\.3s/, "a swap of what the card holds fades in over a short moment");
	assert.match(zen, /prefers-reduced-motion: reduce\) \{[^\n]*\.zen-card-in > \*, \[data-view="zen"\] \.zen-card \[data-fade\] \{ animation: none; \}/, "and under reduced motion nothing fades");
	assert.match(zen, /animation-delay: calc\(var\(--n, 0\) \* 0\.22s\)/);
	assert.match(zen, /\.zen-log \.chat-scroll \{ overscroll-behavior: contain; touch-action: pan-y; \}/, "the log scrolls itself only: nothing chains to the page, a finger moves it up and down");
	assert.match(zen, /\.zen-card \{ overscroll-behavior: contain; \}/);
	assert.match(zen, /\.chat-pill \{ border: 1px solid var\(--zen-line\); background: var\(--zen-warm\); color: var\(--zen-paper\);/, "the log's pill is paper on warm (7 : 1, tests/zen-contrast.test.ts), not paper on paper");
	assert.match(zen, /#zen \{ overscroll-behavior: none; \}/, "no pull-to-refresh or history swipe from the layer");
	assert.match(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), /html\[data-view="zen"\], html\[data-view="zen"\] body \{[^}]*overscroll-behavior: none;/, "nor from the page under it, from the first frame");
	assert.ok(!/\.zen-(header|bar|nav)\b/.test(zen) && !/zen-nothing/.test(zen));
});

test("the key pad's confirm buttons are one pair in Standard and Geek: one box rule for both (the same height, a border, 12 px words), the yes filled with --amber and its --ink words, the no outlined, and both 44 px on a phone", () => {
	const both = rulesOf(css).find((r) => r.parts.some((p) => p === ".pad-yes, .pad-no" || (p === ".pad-yes" && r.parts.includes(".pad-no"))));
	assert.ok(both, "one rule holds both");
	const d = Object.fromEntries(declarations(both.body));
	assert.equal(d["min-height"], "34px");
	assert.match(d.border ?? "", /^1px solid/);
	assert.match(d.font ?? "", /^600 12px/);
	const yes = rulesOf(css).find((r) => r.parts.length === 1 && r.parts[0] === ".pad-yes");
	assert.ok(yes && /background: var\(--amber\)/.test(yes.body) && /color: var\(--ink\)/.test(yes.body), "filled, with the ink on the fill");
	assert.match(css, /\(pointer: coarse\) \{ \.pad-key, \.pad-yes, \.pad-no[^{]*\{ min-height: 44px; \}/);
	assert.ok(!/\.pad-yes[^{]*\{[^}]*text-decoration/.test(css), "no link underline on either");
});

test("the terminal card is the dock's other box: a dialog's box rules, the confirm pair's box for its mask and Send, 44 px targets and a bottom sheet on a phone, flat in Geek, ink in Zen with no header", () => {
	const box = rulesOf(css).find((r) => r.parts.includes(".dialog") && r.parts.includes(".tcard") && r.body.includes("border-radius: 18px"));
	assert.ok(box, "the card is drawn as a dialog is");
	const pair = rulesOf(css).find((r) => r.parts.includes(".pad-yes") && r.parts.includes(".pad-no"));
	assert.ok(pair?.parts.includes(".tcard-mask") && pair.parts.includes(".tcard-go"), "its buttons are the confirm pair's box: one height, one border, 12 px words");
	assert.match(css, /\.tcard-go \{[^}]*background: var\(--amber\); color: var\(--ink\)/, "the one that sends is filled");
	assert.match(css, /\.tcard-mask \{ background: transparent/, "the mask toggle is outlined");
	assert.match(css, /\(pointer: coarse\) \{ \.pad-key, \.pad-yes, \.pad-no, \.tcard-mask, \.tcard-go, \.tcard-input, \.tcard \.x, \.tcard-full \{ min-height: 44px; \}/, "44 px targets, in the pad's phone rule");
	assert.match(css, /@media \(max-width: 640px\) \{ \.tcard \{[^}]*env\(safe-area-inset-bottom\)/, "a sheet clear of the home bar");
	assert.match(css, /\.dock > \.dialog \{ z-index: 1; \}/, "a dialog opened over the card covers it");
	assert.match(css, /\[data-view="geek"\] :is\([^)]*\.tcard[^)]*\) \{ background: var\(--surface-0\); \}/, "flat in Geek");
	assert.match(css, /forced-colors: active\) \{[\s\S]*\.tcard \{ border: 1px solid CanvasText; \}/);
	assert.match(zen, /\.tcard > header \{ position: absolute;[^}]*clip-path/, "Zen's layer names the unit: the card's header is for readers only");
	assert.match(zen, /\.zen-term-host :is\(\.pad-yes, \.pad-no, \.tcard-mask, \.tcard-go\) \{ min-height: 44px/);
	assert.match(zen, /prefers-reduced-motion: reduce\) \{ \[data-view="zen"\] \.tcard \{ animation: none; \} \}/);
});

test("the terminal card's input label is only for screen readers, in every view: no rule shows it", () => {
	const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	const own = (text: string) => text.split("\n").flatMap((line) => line.match(/[^{}]*\.tcard-label[^{]*\{[^}]*\}/g) ?? []);
	const rules = [...own(css), ...own(zen)];
	assert.equal(rules.length, 1, "one rule names it");
	assert.match(rules[0]!, /position:\s*absolute[^}]*width:\s*1px[^}]*height:\s*1px[^}]*clip-path:\s*inset\(50%\)/);
	assert.doesNotMatch(css + zen, /tcard-row:focus-within/, "nothing reveals it on focus");
});

// Zen Z7 layout fixes: each of these was a defect seen in the demo's pictures at 390 x 844, 844 x 390, or 1280 x 800.
const zenRule = (needle: string) => rulesOf(zen).filter((r) => r.parts.some((p) => p.includes(needle)));

test("Zen: the log is the positioned box of its jump-to-latest pill, so the pill sits above the composer", () => {
	const log = zenRule(".zen-log").find((r) => r.parts.includes('[data-view="zen"] .zen-log'))!;
	assert.match(log.body, /position:\s*relative/);
	assert.match(css, /\.chat-root \{ position: relative/, "Standard's own place for the pill is unchanged");
});

test("Zen: a choice is never squeezed below its label and description, and the list scrolls instead", () => {
	assert.match(zenRule(".zen-card .ask-opts").map((r) => r.body).join(";"), /grid-auto-rows:\s*max-content/);
});

test("Zen: the open history leaves the item whole and takes the room that is left", () => {
	const open = ':has(.zen-history:not([hidden]))';
	const rules = rulesOf(zen).filter((r) => r.selector.includes(open));
	const body = (needle: string) => rules.filter((r) => r.selector.includes(needle)).map((r) => r.body).join(";");
	assert.match(body(".zen-answer"), /flex:\s*none/);
	assert.match(body(".ask > :not"), /overflow:\s*visible/);
	assert.match(body(".ask > :not"), /mask-image:\s*none/, "no soft edge over the question's subtitle");
	assert.match(body(".zen-history"), /flex:\s*1 1 12rem[^}]*min-height:\s*12rem/);
});

test("Zen: the pause's circle and the item's card take the focus without a ring, and the circle stays round", () => {
	const ring = rulesOf(zen).filter((r) => r.selector.includes(".zen-circle, .zen-card):focus-visible"));
	assert.equal(ring.length, 1);
	assert.match(ring[0]!.body, /outline:\s*none/);
	assert.match(zenRule(".zen-circle:focus-visible").map((r) => r.body).join(";"), /border-radius:\s*50%/);
});

test("Zen: a trust list is centred without bullets, and the companion's name has the line below the strip", () => {
	assert.match(zenRule(".trust-group ul").map((r) => r.body).join(";"), /list-style:\s*none/);
	assert.match(zenRule(".zen-company > header").map((r) => r.body).join(";"), /padding:\s*24px 100px 0 0/);
});

test("Zen: on a phone the status strip stands at the left, clear of the corner buttons", () => {
	const narrow = /@media \(max-width: 640px\) \{[^@]*\.zen-strip \{[^}]*left:\s*max\(12px[^}]*translate:\s*none[^}]*max-width:\s*calc\(100vw - 190px\)/;
	assert.match(zen, narrow);
});

test("Zen: a page under 900 px high and one under 600 px wide spend less on air before a question's choices scroll", () => {
	const media = (q: string) => zen.slice(zen.indexOf(`@media (${q}) {`)).split(/\n\}/)[0]!;
	assert.match(media("max-height: 900px"), /\.zen-card-in \{ gap: 10px/);
	assert.match(media("max-height: 900px"), /button\.ask-opt \{ padding-block: 7px/);
	assert.match(media("max-width: 600px"), /\.zen-card-in \{ gap: 6px/);
	assert.match(media("max-width: 600px"), /button\.ask-opt \{ padding: 6px 16px; font-size: 1rem/);
	assert.match(media("max-width: 600px"), /\.ask-opt small \{ font-size: 0\.78rem/);
});
