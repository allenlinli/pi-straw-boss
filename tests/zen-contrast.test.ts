import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, rulesOf } from "./css-rules.ts";

// The Zen ink palette (gui/zen.css, the token block) holds 7 : 1 for text and 3 : 1 for borders and the focus ring on the grounds and on the lofi surfaces the answer card and composer use,
// computed from the values in the stylesheet. No browser runs here.
const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8"), first = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const block = rulesOf(css).find((r) => r.parts.includes('[data-view="zen"] :is(#zen, .connect)'));
assert.ok(block, "the token block exists");
const tokens = Object.fromEntries(declarations(block.body).filter(([p, v]) => p.startsWith("--zen-") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(6), v.toLowerCase()])) as Record<string, string>;
const TEXT = ["paper", "ash", "clay"];

test("every text colour is at least 7 : 1 on both grounds, the card's surfaces, and the Send fill (paper on warm)", () => {
	for (const t of TEXT) for (const g of ["ground", "ground-2", "soft", "sunken"]) assert.ok(contrast(tokens[t]!, tokens[g]!) >= 7, `--zen-${t} on --zen-${g}: ${contrast(tokens[t]!, tokens[g]!).toFixed(2)}`);
	assert.ok(contrast(tokens.paper!, tokens.warm!) >= 7, "Send's paper on its warm fill");
	assert.ok(contrast(tokens.paper!, tokens["warm-hi"]!) >= 7, "and on its hover");
	assert.ok(contrast(tokens.moss!, tokens.ground!) >= 3 && contrast(tokens.moss!, tokens["ground-2"]!) >= 3);
});

test("every border and the focus ring is at least 3 : 1 on the grounds and the card's surfaces; the ring's mark stays out of body text", () => {
	for (const b of ["line", "seal"]) for (const g of ["ground", "ground-2", "soft", "sunken"]) assert.ok(contrast(tokens[b]!, tokens[g]!) >= 3, `--zen-${b} on --zen-${g}: ${contrast(tokens[b]!, tokens[g]!).toFixed(2)}`);
	assert.ok(contrast(tokens.line!, tokens.warm!) >= 1.5, "the picked option's border is a hairline on its fill");
	assert.ok(contrast(tokens.paper!, tokens.warm!) >= 7, "and its text is the paper");
	assert.ok(!css.split("\n").some((l) => /\bcolor: var\(--zen-seal\)/.test(l)), "--zen-seal is never a text colour");
});

test("the first frame's ring (style.css) is 3 : 1 on the ground, and the sheet only animates transform, opacity, and filter", () => {
	const ring = /#zen:empty:not\(\[hidden\]\)::after \{[^}]*border: 1px solid (#[0-9a-f]{6})/.exec(first)?.[1];
	assert.ok(ring, "the first-frame ring exists");
	assert.ok(contrast(ring, "#14110e") >= 3);
	for (const [name, source] of [["zen.css", css], ["style.css", first]] as const)
		for (const [, body] of source.matchAll(/@keyframes zen-[\w-]+ \{((?:[^{}]|\{[^}]*\})*)\}/g))
			for (const [, steps] of body!.matchAll(/\{([^}]*)\}/g)) for (const [prop] of declarations(steps!)) assert.ok(["transform", "opacity", "filter", "animation-timing-function"].includes(prop), `${name}: a zen keyframe moves ${prop}`);
});

test("text on a coloured fill (`--ink`) is the ground, never the paper: Standard's fills (the confirm's Send Enter, Send, a badge) are paper or ash in Zen and a paper label on them was blank", () => {
	assert.match(block.body, /--ink: var\(--zen-ground\)/);
	for (const fill of ["paper", "ash", "clay", "moss"]) assert.ok(contrast(tokens.ground!, tokens[fill]!) >= 7, `--zen-ground on --zen-${fill}: ${contrast(tokens.ground!, tokens[fill]!).toFixed(2)}`);
	const pair = rulesOf(css).filter((r) => r.parts.some((p) => p.includes(".pad-yes") && p.includes(".pad-no")));
	assert.ok(pair.length, "the confirm's two buttons share one Zen rule");
	const box = declarations(pair[0]!.body);
	assert.ok(box.some(([p, v]) => p === "min-height" && v === "44px"), "a 44 px target");
	assert.ok(box.some(([p, v]) => p === "color" && v === "var(--zen-paper)"), "paper words");
	const yes = rulesOf(css).find((r) => r.parts.some((p) => /\.pad-yes$/.test(p.trim())));
	assert.ok(yes && declarations(yes.body).some(([p, v]) => p === "background" && v === "var(--zen-warm)"), "the one that sends is filled (paper on warm, 7 : 1 above)");
});
