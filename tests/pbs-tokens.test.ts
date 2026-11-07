import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

// docs/specs/2026-11-07-raven-view/spec.md §7: every view maps pi-better-show's tokens (README, Tokens) onto its own palette, so a pbs element in a document or a chat entry follows the active view.
const TOKENS = ["bg", "fg", "muted", "surface", "line", "control", "accent", "on-accent", "note", "ok", "warn", "risk", "radius", "gap", "font", "font-display", "mono", "font-size"].map((t) => `--pbs-${t}`);
const css = (path: string) => rulesOf(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const VIEWS: [string, string, string][] = [
	["standard", "gui/style.css", ":root"],
	["geek", "gui/themes/geek/geek.css", '[data-view="geek"]'],
	["zen", "gui/zen.css", '[data-view="zen"] :is(#zen, .connect)'],
	["raven", "gui/themes/raven/raven.css", '[data-view="raven"]'],
];

for (const [view, path, selector] of VIEWS) {
	test(`${view} maps every --pbs-* token, dark, in ${path}`, () => {
		const rule = css(path).find((r) => r.parts.includes(selector) && declarations(r.body).some(([p]) => p === "--pbs-bg"));
		assert.ok(rule, `a ${selector} rule sets --pbs-bg`);
		const set = new Map(declarations(rule.body));
		for (const token of TOKENS) assert.ok(set.get(token), `${token} is mapped for ${view}`);
		assert.ok(declarations(css(path).filter((r) => r.parts.includes(selector) || (view === "standard" && r.selector === "html")).map((r) => r.body).join(";")).some(([p, v]) => p === "color-scheme" && v === "dark"), `${view} sets color-scheme: dark`);
	});
}
