import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, rulesOf, split } from "./css-rules.ts";

// Raven Keep round 2 (boss, 2026-11-08: 「不該用圓角卡片，並且可以考慮簡易裝飾線」): in the Raven view every card-like box has square corners, and a gold double rule and corner ticks are the keep's only ornaments.
// One blanket rule squares everything under `html[data-view="raven"]` except the keep-round set below, which is round by meaning (a ring, a dot, a halo). The test pins that set, so a new round exception needs a change here too.
const root = fileURLToPath(new URL("..", import.meta.url));
const raven = readFileSync(join(root, "gui/themes/raven/raven.css"), "utf8");
const rules = rulesOf(raven);
const radii = (body: string) => declarations(body).filter(([p]) => p === "border-radius");

/** The elements that stay round, with their own pseudo-elements: the status plate and tower and their rings, halos and badges, the avatar, the dots of a link, an ally unit and a timeline mark. */
const KEEP_ELEMENTS = [".plate", ".tower", ".sweep", ".pulse", ".ring", ".badge", ".connect-ring", ".packet", ".ava", ".portrait", ".au-dot", ".au-mdot", ".link i", ".head-btn .dot", '.tl-mark:is([data-mark="done"], .joined, .left)'];
/** The elements that are square themselves and carry a round dot as a pseudo-element (the toggle's dot, the news dot after a drawer name and a bar button's). */
const KEEP_DOTS = [".tog", ".drawer-head .name", ".bar-more[data-news]"];

const blanket = (pseudo: "" | "::before" | "::after") => rules.find((r) => r.parts.length === 1 && r.selector.startsWith('html[data-view="raven"] :not(') && r.selector.endsWith(`)${pseudo}`) && radii(r.body).length > 0);
const notList = (selector: string) => /:not\((.*)\)(?:::\w+)?$/.exec(selector)?.[1];

test("--pbs-radius is 0 in Raven, so pi-better-show's blocks are square too", () => {
	const block = rules.find((r) => r.selector === '[data-view="raven"]')!;
	assert.deepEqual(declarations(block.body).filter(([p]) => p === "--pbs-radius").map(([, v]) => v), ["0"]);
});

test("one blanket rule squares every element, and one each the ::before and ::after of the same, with !important and the keep-round set excepted", () => {
	for (const pseudo of ["", "::before", "::after"] as const) {
		const rule = blanket(pseudo);
		assert.ok(rule, `a blanket rule for ${pseudo || "elements"}`);
		assert.deepEqual(radii(rule.body), [["border-radius", "0 !important"]], `${pseudo || "elements"} get border-radius: 0 !important (a Standard rule of higher specificity, such as .base.remote .box-dev, must not win)`);
		assert.deepEqual(split(notList(rule.selector)!, ",").map((s) => s.trim()), pseudo ? [...KEEP_ELEMENTS, ...KEEP_DOTS] : KEEP_ELEMENTS, `the keep-round set of ${pseudo || "elements"}`);
	}
});

test("no other rule of raven.css gives a card-like selector a radius: a radius outside the blanket is on a keep-round element or is 0", () => {
	const round = [".sweep", ".ring", ".pulse", ".plate", ".tower", ".connect-ring"];
	for (const rule of rules) {
		if (rule === blanket("") || rule === blanket("::before") || rule === blanket("::after")) continue;
		for (const [, value] of radii(rule.body)) {
			if (/^0(px)?( !important)?$/.test(value)) continue;
			for (const part of rule.parts) assert.ok(round.some((k) => part.includes(k)), `${part} keeps a radius (${value}) but is not a keep-round element`);
		}
	}
});

test("the head band, the legend, the crumbs, and the yard's rows and pills have no radius of their own left (they take the blanket's)", () => {
	for (const rule of rules.filter((r) => /\.(head-node|legend|crumbs|yard-row|yard-pill)\b/.test(r.selector) && !r.selector.includes("::"))) {
		assert.deepEqual(radii(rule.body).filter(([, v]) => !/^0/.test(v)), [], `${rule.selector}`);
	}
});

test("the keep's ornament is a gold double rule on top of its panels, and corner ticks on the cards that ask", () => {
	const top = rules.find((r) => r.parts.includes('html[data-view="raven"] .base') && declarations(r.body).some(([p]) => p === "border-top"));
	assert.ok(top, "a rule gives the base a border-top");
	assert.match(declarations(top.body).find(([p]) => p === "border-top")![1], /^4px double /, "a double rule, 4px wide (a line, a gap of two, a line), as the head band wears it");
	for (const sel of ['dialog.sheet', ".dialog", ".tcard", ".ask", ".hud", ".set-group", ".panel", ".comms-in"]) assert.ok(top.parts.some((p) => p.endsWith(sel)), `${sel} has the double rule`);
	const ticks = rules.find((r) => r.parts.some((p) => p.endsWith(".ask::before")) && /linear-gradient/.test(r.body));
	assert.ok(ticks, "the ticks are the ::before of the asking cards");
	for (const sel of ['dialog.sheet', ".dialog", ".tcard", ".ask"]) assert.ok(ticks.parts.some((p) => p.endsWith(`${sel}::before`)), `${sel} has corner ticks`);
	assert.equal((/linear-gradient\(/g.exec(ticks.body) ? ticks.body.match(/linear-gradient\(/g)!.length : 0), 8, "four corners, two arms each");
	assert.match(ticks.body, /pointer-events:\s*none/, "a tick takes no press");
});
