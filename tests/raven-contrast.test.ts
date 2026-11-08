import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, mix, type Rule, rulesOf } from "./css-rules.ts";

// Raven Keep's palette (gui/themes/raven/raven.css, the `[data-view="raven"]` block; docs/specs/2026-11-07-raven-view/spec.md §1.5): dark only, and every text colour at least 4.5 : 1 on every surface it can sit on,
// every border and the focus ring at least 3 : 1, including text on a state tint as the CSS mixes it. No browser runs here: the block is parsed and the arithmetic done on its values.
const RAVEN = '[data-view="raven"]';
const rules = rulesOf(readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8")), entryRules = rulesOf(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"));
const must = <T>(value: T | undefined, what: string): T => (assert.ok(value, what), value as T);
const block = must(rules.find((r) => r.selector === RAVEN), "the raven token block exists");
const root = must(entryRules.find((r) => r.selector === ":root"), "the palette block exists");
const colours = (rule: Rule) =>
	Object.fromEntries(declarations(rule.body).filter(([p, v]) => p.startsWith("--") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(2), v.toLowerCase()])) as Record<string, string>;
const raven = colours(block);

const SURFACES = ["bg", "bg-2", "surface-0", "surface-1", "raised", "sunken", "plate", "plate-hi", "term-bg"]; // --panel and --well are translucent: they sit over these;
const STATES = ["accent", "working", "gold", "amber", "ok", "err", "err-soft", "violet", "idle", "unknown"];
const TEXT = ["text", "dim", "accent-hi", "term-fg", ...STATES];
const MIN = 4.5;
/** The share a state tint may take: the contrast below holds at it, so it holds under it (style.css mixes a state at up to 22 percent; the card's own tint is `--c1`). */
const TINT_MAX = 22;

test("the raven block gives every colour token of the palette its own value, and is dark", () => {
	for (const name of Object.keys(colours(root))) assert.ok(raven[name], `--${name} is set in the raven block`);
	for (const name of ["panel", "well", "line"]) assert.ok(declarations(block.body).some(([p]) => p === `--${name}`), `--${name} is set`);
	assert.ok(declarations(block.body).some(([p, v]) => p === "color-scheme" && v === "dark"), "color-scheme: dark");
	assert.equal(raven.bg, "#0d0a10", "the ground is the theme-color (gui/view.ts THEME.raven)");
});

test("every text token is at least 4.5 : 1 on every surface", () => {
	for (const text of TEXT) for (const surface of SURFACES) assert.ok(contrast(raven[text]!, raven[surface]!) >= MIN, `--${text} ${raven[text]} on --${surface} ${raven[surface]}: ${contrast(raven[text]!, raven[surface]!).toFixed(2)}`);
});

test("the ink on a state's fill (a badge, Go, Send) is at least 4.5 : 1, and the paper's ink on the paper", () => {
	for (const state of STATES) assert.ok(contrast(raven.ink!, raven[state]!) >= MIN, `--ink on --${state}: ${contrast(raven.ink!, raven[state]!).toFixed(2)}`);
	for (const paper of ["paper-hi", "paper"]) assert.ok(contrast(raven["paper-ink"]!, raven[paper]!) >= MIN, `--paper-ink on --${paper}`);
});

test("every border and ring is at least 3 : 1 on every surface", () => {
	for (const surface of SURFACES) assert.ok(contrast(raven["line-c"]!, raven[surface]!) >= 3, `--line-c on --${surface}: ${contrast(raven["line-c"]!, raven[surface]!).toFixed(2)}`);
	assert.ok(contrast(raven.accent!, raven.bg!) >= 3, "the focus ring (--accent)");
});

test("text keeps 4.5 : 1 on a state tint of up to TINT_MAX percent over each of the cards' surfaces", () => {
	for (const tint of STATES) for (const surface of ["bg", "surface-0", "surface-1"]) {
		const under = mix(raven[tint]!, TINT_MAX / 100, raven[surface]!);
		for (const text of ["text", "dim"]) assert.ok(contrast(raven[text]!, under) >= MIN, `--${text} on ${TINT_MAX}% of --${tint} over --${surface} (${under}): ${contrast(raven[text]!, under).toFixed(2)}`);
	}
});

test("the semantic colours are the ones the spec names: bone text, candle gold for waiting, blood crimson for errors, fog grey for idle, on a violet-cast near-black", () => {
	const hue = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
		const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
		return d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	};
	assert.ok(hue(raven.bg!) > 240 && hue(raven.bg!) < 300, `the ground has a cold violet cast (${hue(raven.bg!).toFixed(0)}°)`);
	assert.ok(hue(raven.gold!) > 30 && hue(raven.gold!) < 50, "candle gold");
	assert.ok(hue(raven.err!) < 10 || hue(raven.err!) > 350, "blood crimson");
	assert.ok(contrast(raven.text!, raven.bg!) >= 10, "bone text is the brightest, the page's body");
});

test("nothing in the raven rules hides the page's text under the backdrop: every panel keeps a translucent solid ground", () => {
	assert.match(block.body, /--well:\s*rgba\(/);
});

test("the head band's text holds 4.5 : 1 on the band as Raven Keep paints it: the name and the newest line on its gold wash over --surface-0, the waits chip's amber on its 16% amber wash (docs/specs/2026-11-07-head-band.md)", () => {
	const band = must(rules.find((r) => r.selector === `${RAVEN} .head-node`), "the keep's band rule");
	const bg = must(declarations(band.body).find(([p]) => p === "background")?.[1], "the band's background");
	const gold = Number(must(/color-mix\(in srgb, var\(--gold\) ([\d.]+)%/.exec(bg) ?? undefined, "the band's gold wash")[1]);
	assert.ok(bg.endsWith("var(--surface-0)"), `the wash sits on --surface-0: ${bg}`);
	const ground = mix(raven.gold!, gold / 100, raven["surface-0"]!);
	for (const text of ["text", "dim"]) for (const under of [ground, raven["surface-0"]!]) assert.ok(contrast(raven[text]!, under) >= MIN, `--${text} on the band (${under}): ${contrast(raven[text]!, under).toFixed(2)}`);
	const chip = must(entryRules.find((r) => r.selector === ".head-node .head-waits"), "the waits chip rule");
	const share = Number(must(/color-mix\(in srgb, var\(--amber\) ([\d.]+)%/.exec(declarations(chip.body).find(([p]) => p === "background")?.[1] ?? "") ?? undefined, "the chip's amber wash")[1]);
	const pill = mix(raven.amber!, share / 100, ground);
	assert.ok(contrast(raven.amber!, pill) >= MIN, `the chip's --amber on ${share}% of itself over the band (${pill}): ${contrast(raven.amber!, pill).toFixed(2)}`);
});

// The map's backdrop (spec §1.5 "On the map"): the map has the picture behind a translucent ground, and the legend sits in the bar above it. At the brightest lightning frame the rest veil is gone and the picture shows through its plain veil, the strike's wash and foot veil, and the lit windows at their peak.
// The brightest pixel of that composite below the header strip (y from 80 of 721) was sampled with PIL at the picture's full 1280 x 721, the layers as CSS paints them (the mask included): rgb(179 154 129), a wall lit by a window at the peak of its glow. The layer values that sampling used are asserted first;
// a change to any of them (or to the picture) makes this test ask for a new sample instead of passing on old arithmetic.
test("under the brightest lightning frame the map's ground and the legend's keep --text and --dim at 4.5 : 1, and --panel does too", () => {
	const raw = readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8");
	const sheet = rulesOf(raw), body = (selector: string) => sheet.filter((r) => r.parts.includes(selector)).map((r) => r.body).join(";");
	const MAP = 'html[data-view="raven"]:has(#stage[data-view="map"])', STAGE = 'html[data-view="raven"] .stage[data-view="map"]';
	const picture = body(`${MAP}::before`);
	for (const layer of ["radial-gradient(ellipse calc(var(--rk-w) * 0.17) calc(var(--rk-w) * 0.1) at 16.4% 17%, rgb(13 10 16 / 0.62) 55%, transparent)", "linear-gradient(rgb(190 170 255 / 0.16), transparent 60%)", "linear-gradient(transparent 40%, rgb(3 2 5 / 0.3))", "linear-gradient(rgb(13 10 16 / 0.68), rgb(13 10 16 / 0.3) 45%, rgb(13 10 16 / 0.3))", "mask-image: linear-gradient(#000 62%, transparent)"]) assert.ok(picture.includes(layer), `the sampled layer is still there: ${layer}`);
	const alphas = [...body(`${STAGE}::after`).matchAll(/rgb\(255 190 92 \/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
	assert.equal(alphas.length, 11, "eleven lit windows and lanterns");
	assert.ok(Math.max(...alphas) <= 0.7125 + 1e-9, `the lights' peak alpha is ${Math.max(...alphas)}; the sample took 0.7125`);
	assert.match(body(`${STAGE}::after`), /opacity:\s*0\.75/);
	const candle = [...(/@keyframes rk-candle \{(.*)\}\n/.exec(raw)?.[1] ?? "").matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
	assert.ok(candle.length >= 4 && Math.max(...candle) <= 1, "the lights breathe at most to full");
	assert.match(raw, /@keyframes rk-rest \{.*94\.4% \{ opacity: 0; \}/, "the rest veil is gone at the flash");
	const worst = "#b39a81"; // rgb(179 154 129)
	const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
	const grounds = (token: string) => {
		const m = new RegExp(`--${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(raw);
		assert.ok(m, `--${token} is set`);
		return mix(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, Number(m[4]), worst);
	};
	for (const token of ["rk-well", "panel"]) for (const text of ["text", "dim"]) assert.ok(contrast(raven[text]!, grounds(token)) >= MIN, `--${text} on --${token} over the brightest lit pixel (${grounds(token)}): ${contrast(raven[text]!, grounds(token)).toFixed(2)}`);
	// who takes the ground: the map and the legend (the cards, the band, and the buttons have grounds of their own)
	assert.match(body(`${STAGE} .map`), /background:\s*var\(--rk-well\)/);
	assert.match(body('html[data-view="raven"] .legend'), /background:\s*var\(--rk-well\)/);
});
