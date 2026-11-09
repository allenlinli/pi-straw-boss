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

test("a phone keeps the map's perched raven (56 px, on the band, taking no tap) and the head page's stays off it", () => {
	const phone = /@media \(max-width: 600px\) \{ (html\[data-view="raven"\]:has\(#stage\[data-view="map"\]\) body::after[^\n]*)\n/.exec(raven)?.[1] ?? "";
	assert.ok(phone.length > 0, "the map's phone block");
	assert.ok(!/\.head-node > \.perch \{ display: none/.test(phone) && !/\.head-node > \.perch,? ?\{? ?display/.test(phone), "the band's perch is not hidden");
	assert.match(phone, /\.head-node \{ --rk-pw: 56px; margin-top: calc\(var\(--rk-pw\) \* 0\.806 - 8px\); \}/);
	assert.match(raven, /\.head-node > \.perch \{\s*display: block; position: absolute; pointer-events: none;/);
	assert.match(raven, /@media \(max-width: 600px\) \{ html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\) body::after[^\n]*\.stage\[data-view="head"\] > \.perch \{ display: none; \}/, "the head page's perch is on the gate, off a phone's visible part of the frame");
});

test("the head turn is lit: the turned frame is lifted from the profile's resting dark, rimmed in cool moonlight, and has a glint in its eye, all static so only its opacity animates", () => {
	const turn = (selector: string) => rules.filter((r) => r.parts.includes(`html[data-view="raven"] ${selector}`)).map((r) => r.body).join(";");
	const element = turn(".perch-turn");
	assert.match(element, /opacity:\s*0/, "it dissolves in");
	assert.match(element, /filter:\s*drop-shadow\(0 0 1px rgb\(205 222 255 \/ 0\.95\)\) drop-shadow\(0 0 calc\(var\(--rk-pw\) \* 0\.06\) rgb\(120 150 255 \/ 0\.55\)\)/, "a cool moonlight rim: a hairline and a halo");
	assert.ok(!/animation/.test(element), "the rim is static: the element's only animation is the opacity keyframes in the motion block");
	const lit = (layer: string) => Number(/brightness\(([\d.]+)\)/.exec(turn(`.perch-turn::${layer}`))?.[1]);
	assert.ok(lit("after") >= 1, `the turned frame rests at ${lit("after")}, not the profile's 0.34`);
	assert.ok(lit("before") > lit("after"), "and brighter again under a strike");
	assert.match(turn(".perch-turn::after"), /radial-gradient\(circle calc\(var\(--rk-pw\) \* 0\.05\) at 27\.2% 10%, #fff 0/, "the eye's glint, a white-cored dot where the eye is in the turned frame");
	const dark = Number(/\.perch::after\s*\{[^}]*brightness\(([\d.]+)\)/.exec(raven)?.[1]);
	assert.equal(dark, 0.34, "the profile keeps its resting dark");
	// the hold: opaque 68 to 86 percent of the 17 s cycle, 3.06 s
	const keys = /@keyframes rk-perch-turn \{([^\n]*)\}\n/.exec(raven)?.[1] ?? "";
	assert.match(keys, /68%, 86% \{ opacity: 1; \}/);
	assert.ok(((86 - 68) / 100) * 17 >= 3, "it holds the turned frame for about 3 s");
	assert.match(raven, /\.head-node \{ --rk-pw: clamp\(52px, calc\(var\(--rk-w\) \* 0\.07\), 100px\)/, "a desktop's perch is 100 px wide");
});

test("the head page's glass is thin (so the castle shows) and its bare text has a backing; a phone hides the page's header behind the comms and leaves a strip of the picture above the log", () => {
	const token = (name: string, scope: string) => {
		const rule = rules.find((r) => r.parts.includes(scope) && new RegExp(`--${name}:`).test(r.body));
		assert.ok(rule, `${name} on ${scope}`);
		return declarations(rule.body).find(([p]) => p === `--${name}`)![1];
	};
	const HEAD = 'html[data-view="raven"]:has(#stage[data-view="head"]) .comms-in', ALL = 'html[data-view="raven"]';
	const alpha = (v: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(v)?.[1]);
	assert.ok(alpha(token("rk-glass", HEAD)) <= 0.2 && alpha(token("rk-glass", HEAD)) < alpha(token("rk-glass", ALL)) / 3, `the head page's fill is ${token("rk-glass", HEAD)} against ${token("rk-glass", ALL)}`);
	assert.ok(parseFloat(token("rk-blur", HEAD)) <= 2 && parseFloat(token("rk-blur", HEAD)) < parseFloat(token("rk-blur", ALL)), "and its blur is no wider than 2 px");
	const supports = /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raven)?.[1] ?? "";
	const backed = rulesOf(supports).filter((r) => r.parts.some((p) => p.startsWith(HEAD.replace(" .comms-in", ""))) && /var\(--rk-backing\)/.test(r.body)).map((r) => r.selector).join(" ");
	for (const part of [".tx.rule > p", ".tx.rule > details", ".tx.rule > div", ".tx.you > header", ".tx.note", ".act", ".tower-notes", ".queue-bar", ".queue-list", ".queue-act", ".bubble", ".notice"]) assert.ok(backed.includes(part), `${part} has the backing on the head page`);
	const phone = /@media \(max-width: 640px\) \{\s*@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{([^@]*)\}\s*\}/.exec(raven)?.[1] ?? "";
	assert.match(phone, /:is\(\.hud, \.bar, \.foot\) \{ visibility: hidden; \}/, "the page's header, crumbs, and foot do not ghost through");
	assert.match(phone, /\.comms-head \{ margin-bottom: clamp\(0px, calc\(var\(--vvh, 100dvh\) - 520px\), 120px\); \}/, "a strip up to 120 px, none when the screen is short");
});
