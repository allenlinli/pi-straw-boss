import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NOUN_KEYS } from "../gui/nouns.ts";
import { NOUNS } from "../gui/themes/raven/nouns.ts";
import { rulesOf } from "./css-rules.ts";

// Raven Keep's own assets (gui/themes/raven/, docs/specs/2026-11-07-raven-view/spec.md §1.4, §1.5): the sprite, the nouns, the favicons, the backdrop, the sounds, and the motion rules.
const root = fileURLToPath(new URL("..", import.meta.url));
const at = (path: string) => readFileSync(join(root, path), "utf8");
const ROLES = ["user", "crown", "tower", "main", "member", "subagent", "outpost", "outside", "comms", "doc"];

test("the sprite draws the ten roles Standard draws, as symbols prefixed raven-, in one colour", () => {
	const sprite = at("gui/themes/raven/sprite.svg");
	const ids = [...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"/g)];
	assert.deepEqual(ids.map((x) => x[1]), ROLES.map((r) => `raven-${r}`));
	for (const x of ids) assert.equal(x[2], "0 0 256 256");
	const standard = [...at("gui/index.html").matchAll(/<symbol id="i-(\w+)"/g)].map((x) => x[1]).sort();
	assert.deepEqual([...ROLES].sort(), standard, "the same role keys as Standard's inline sprite");
	assert.ok(!/fill="#|stroke=|<style|<script/.test(sprite), "single colour: currentColor only");
	assert.equal([...sprite.matchAll(/fill="currentColor"/g)].length, ROLES.length);
});

test("the noun pack names each role in both languages with the spec's words, and only keys the chokepoint knows", () => {
	assert.deepEqual(Object.keys(NOUNS).sort(), ["en", "zh-TW"]);
	for (const locale of Object.keys(NOUNS)) for (const key of Object.keys(NOUNS[locale]!)) assert.ok((NOUN_KEYS as readonly string[]).includes(key), `${locale}.${key} is a noun key`);
	const want = {
		en: { head_tower: "Raven Keep", role_tower: "Steward", role_main: "Spawn", role_member: "Wolf", role_subagent: "Bat", spec_base: "Crypt", role_outpost: "Coffin chamber", role_outside: "Ghost", comms: "Ravens", documents: "Tome", you: "the Count" },
		"zh-TW": { head_tower: "鴉閣", role_tower: "管事", role_main: "衍裔", role_member: "狼", role_subagent: "蝙蝠", spec_base: "墓穴", role_outpost: "棺室", role_outside: "遊魂", comms: "渡鴉", documents: "典籍", you: "伯爵" },
	};
	for (const [locale, words] of Object.entries(want)) for (const [key, word] of Object.entries(words)) assert.equal((NOUNS[locale] as Record<string, string>)[key], word, `${locale}.${key}`);
	assert.deepEqual(Object.keys(NOUNS.en!).sort(), Object.keys(NOUNS["zh-TW"]!).sort(), "both languages cover the same keys");
});

test("each view has its favicon: Zen an open ink circle, Geek >_, raven the bone crest with a crimson touch on a #0d0a10 square", () => {
	for (const view of ["zen", "geek", "raven"]) {
		const svg = at(`gui/themes/${view}/favicon.svg`);
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32"><g transform="scale\(\.5\)">/, view); // 32 units, as Standard's icon: the waiting badge (tabicon.ts) is drawn for that box
		assert.ok(svg.length < 12_000, `${view}'s favicon is ${svg.length} bytes`);
	}
	const raven = at("gui/themes/raven/favicon.svg");
	for (const colour of ["#0d0a10", "#d8c8a8", "#8a1c24"]) assert.ok(raven.includes(colour), colour);
	assert.ok(at("gui/themes/zen/favicon.svg").includes("#14110e"), "Zen's ink ground");
	assert.ok(at("gui/themes/geek/favicon.svg").includes("#000"), "Geek's black");
});

test("the backdrop is a WebP of at most 120 KB, and the three sounds are mono MP3s of at most 30 KB", () => {
	const dir = join(root, "gui/themes/raven");
	const back = readFileSync(join(dir, "backdrop.webp"));
	assert.ok(back.length <= 120_000, `backdrop.webp is ${back.length} bytes`);
	assert.equal(back.subarray(0, 4).toString(), "RIFF");
	assert.equal(back.subarray(8, 12).toString(), "WEBP");
	assert.deepEqual(readdirSync(join(dir, "sounds")).sort(), ["ask.mp3", "done.mp3", "error.mp3"]);
	for (const name of readdirSync(join(dir, "sounds"))) {
		const size = statSync(join(dir, "sounds", name)).size, head = readFileSync(join(dir, "sounds", name)).subarray(0, 4);
		assert.ok(size <= 30_000, `${name} is ${size} bytes`);
		assert.ok((head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) || head.subarray(0, 3).toString() === "ID3", `${name} is MP3`);
	}
});

test("the sounds are credited with their sources and CC0 licences, and the icons as original work traced with potrace", () => {
	const notice = at("NOTICE.md") + at("gui/ICONS.md");
	for (const credit of ["zeroisnotnull", "kgeshev", "soundofsong", "CC0", "potrace", "opengameart.org/content/crow-caw", "freesound.org/people/kgeshev/sounds/378799", "freesound.org/people/soundofsong/sounds/647646"]) assert.ok(notice.includes(credit), credit);
});

test("shipped text and sources name no trademark: no Strahd, Barovia, or Ravenloft in the messages, the theme folder, the page, or the built bundle", () => {
	const hit = /strahd|barovia|ravenloft/i;
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory()) walk(path);
			else if (/\.(json|ts|css|html|svg|js|md|webmanifest)$/.test(entry.name)) files.push(path);
		}
	};
	for (const dir of ["gui/messages", "gui/themes"]) walk(dir);
	files.push("gui/index.html", "gui/style.css", "gui/boot.js");
	if (existsSync(join(root, "dist/gui"))) walk("dist/gui");
	else assert.fail("dist/gui is not built: npm run gui:build");
	const offenders = files.filter((f) => hit.test(at(f)));
	assert.deepEqual(offenders, []);
});

const css = rulesOf(at("gui/themes/raven/raven.css"));
const raw = at("gui/themes/raven/raven.css");

test("every motion rule of the theme sits under prefers-reduced-motion: no-preference and outside data-calm, and forced-colors turns the backdrop's motion off", () => {
	// every `animation:` declaration is inside the no-preference media block
	const blocks = [...raw.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{/g)];
	assert.ok(blocks.length >= 1, "a no-preference block exists");
	const outside = raw.replace(/@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]|\{[^{}]*\})*\}/g, "");
	assert.ok(!/animation(-name)?\s*:/.test(outside), "no animation declared outside the no-preference block");
	for (const rule of css.filter((r) => /animation\s*:/.test(r.body) && !/animation\s*:\s*none/.test(r.body))) assert.ok(/:not\(\[data-calm\]\)/.test(rule.selector), `${rule.selector} stops at data-calm`);
	assert.match(raw, /@media \(forced-colors: active\)/);
});

test("the lightning comes at most once a minute and never washes the screen: its cycle is 60 s or longer and its peak alpha is low", () => {
	const bolt = /animation:[^;]*\brk-bolt\s+(\d+)s/.exec(raw);
	assert.ok(bolt && Number(bolt[1]) >= 60, `rk-bolt cycle ${bolt?.[1]} s`);
	const keyframes = /@keyframes rk-bolt \{([\s\S]*?)\n\}/.exec(raw)?.[1] ?? "";
	const peaks = [...keyframes.matchAll(/--rk-bolt:\s*([\d.]+)/g)].map((x) => Number(x[1]));
	assert.ok(peaks.length >= 2 && Math.max(...peaks) <= 1, "the bolt variable stays within 0..1");
	assert.match(raw, /rgb\([^)]*\/\s*calc\(var\(--rk-bolt\)\s*\*\s*0?\.(1|2)\d*\)\)/, "its gradient scales the variable to at most 0.29 alpha");
	assert.ok(!/(#fff\b|#ffffff|white)[^;]*var\(--rk-bolt\)/i.test(raw), "never a white flash");
});

test("the backdrop belongs to the head page only, and fog, flicker, bats, and the raven are all in the stylesheet", () => {
	assert.match(raw, /html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\)::before/);
	for (const name of ["rk-fog", "rk-bat", "rk-raven", "rk-lit-a", "rk-lit-b", "rk-candle", "rk-bolt"]) assert.match(raw, new RegExp(`@keyframes ${name}\\b`), name);
});
