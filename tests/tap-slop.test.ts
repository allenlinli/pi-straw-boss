import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Todo 141 (RGV-F005): on a phone two rows had a hit area under 44 px: the base name link (24 px) and the head page's Memory summary (17 px). The rules
// that raise them are in one `@media (pointer: coarse)` block after the "Tap slop" comment of gui/style.css, so the fine pointer's look (Standard, Geek,
// Raven) is untouched. The timeline's marks are not here on purpose: a phone's marks take no taps (phone-targets.test.ts), so they are no target.
// No browser runs here: this reads the declared hit areas; the measured ones (elementFromPoint at the edges, 390 x 844) are in the change's report.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const marker = css.indexOf("/* Tap slop");
const open = css.indexOf("@media (pointer: coarse) {", marker);
assert.ok(marker > 0 && open > marker, "the tap slop block is in style.css");
/** The rules of the coarse block as [selector, declarations]; the block ends at the brace that closes the query. */
function block(): { found: [string, string][]; end: number } {
	const found: [string, string][] = [];
	let end = css.length;
	let depth = 0, from = open + "@media (pointer: coarse) {".length, selector = "";
	for (let at = from; at < css.length && depth >= 0; at++) {
		if (css[at] === "{") {
			if (depth === 0) selector = css.slice(from, at).replace(/\/\*[\s\S]*?\*\//g, "").trim();
			depth++;
			from = at + 1;
		} else if (css[at] === "}") {
			depth--;
			if (depth === 0) found.push([selector, css.slice(from, at)]);
			else if (depth < 0) end = at;
			from = at + 1;
		}
	}
	return { found, end };
}
const { found: rules, end } = block();
const body = (selector: string) => rules.filter(([s]) => s === selector).map(([, b]) => b).join(";");
const px = (selector: string, property: string) => Number(body(selector).match(new RegExp(`(?:^|[;\\s])${property}:\\s*(-?[\\d.]+)px`))?.[1]);

test("the base name link's hit area is its header, which is 44 px tall on a phone: the link is 24 px, its ::after stretches over the header", () => {
	assert.ok(rules.length > 0, "the block's rules were read");
	assert.ok(px(".base > header", "min-height") >= 44, "the header keeps 44 px (it is 64 px today)");
	assert.match(css, /\n\.base > header \{ position: relative;/, "the header is what the ::after is sized against");
	assert.match(css, /\n\.hit, \.enter-base::after \{ position: absolute; inset: 0;/);
});

test("the head page's Memory summary is a 44 px box that eats the gap above it and the one below, so its text keeps its place", () => {
	const summary = ".tower-memory .tmem > summary";
	assert.match(body(summary), /box-sizing:\s*border-box/);
	assert.ok(px(summary, "min-height") >= 44, "44 px tall");
	// The text stays where it was: what the box gains above (padding-top) is what the margin takes back. The box reaches no further than the gaps (the head log's 8 px margin above, the notes' 8 px below), so it covers no neighbour's box; the rest of its 44 px pushes what follows down.
	const [above, below] = (body(summary).match(/margin-block:\s*(-[\d.]+)px (-[\d.]+)px/) ?? []).slice(1).map(Number) as [number, number];
	assert.ok(above < 0 && below < 0, "it takes the gap above and the one below");
	assert.equal(px(summary, "padding-top"), -above, "the padding above is the margin taken back");
	assert.ok(-above <= 8 && -below <= 8, "no more than the gaps there are: 8 px (the head log's margin) above, the notes' 8 px margin below");
	assert.match(body(".tmem[open] > summary"), /margin-bottom:\s*-6px/, "open, the body's 6 px margin is all the gap below");
});

test("the coarse block holds the whole fix: no top-level rule of the page gives either row its 44 px (the fine pointer's look does not change)", () => {
	const top = css.slice(0, open) + css.slice(end);
	assert.doesNotMatch(top, /\.tower-memory \.tmem > summary \{[^}]*min-height/);
	assert.doesNotMatch(top, /\n\.base > header \{[^}]*min-height/);
});
