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
const ICONS = [...ROLES, "brand"]; // the ten roles and the header's brand mark (the crest, where Standard has its antenna glyph)

test("the sprite draws the ten roles and the brand mark Standard draws, as symbols prefixed raven-, in one colour", () => {
	const sprite = at("gui/themes/raven/sprite.svg");
	const ids = [...sprite.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)"/g)];
	assert.deepEqual(ids.map((x) => x[1]), ICONS.map((r) => `raven-${r}`));
	for (const x of ids) assert.equal(x[2], "0 0 256 256");
	const standard = [...at("gui/index.html").matchAll(/<symbol id="i-(\w+)"/g)].map((x) => x[1]).sort();
	assert.deepEqual([...ICONS].sort(), standard, "the same role keys as Standard's inline sprite");
	assert.ok(!/fill="#|stroke=|<style|<script/.test(sprite), "single colour: currentColor only");
	assert.equal([...sprite.matchAll(/fill="currentColor"/g)].length, ICONS.length);
});

test("the noun pack names each role in both languages with the spec's words, and only keys the chokepoint knows", () => {
	assert.deepEqual(Object.keys(NOUNS).sort(), ["en", "zh-TW"]);
	for (const locale of Object.keys(NOUNS)) for (const key of Object.keys(NOUNS[locale]!)) assert.ok((NOUN_KEYS as readonly string[]).includes(key), `${locale}.${key} is a noun key`);
	const want = {
		en: { head_tower: "Raven Keep", role_tower: "Steward", role_main: "Spawn", role_member: "Wolf", role_subagent: "Bat", spec_base: "Crypt", role_outpost: "Coffin chamber", role_outside: "Ghost", comms: "Ravens", documents: "Tome", you: "the Count" },
		"zh-TW": { head_tower: "鴉閣", role_tower: "管家", role_main: "衍裔", role_member: "狼", role_subagent: "蝙蝠", spec_base: "墓穴", role_outpost: "棺室", role_outside: "遊魂", comms: "渡鴉", documents: "典籍", you: "伯爵" },
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

test("the perched raven is one WebP strip of two frames (profile, head turned) with alpha, at most 40 KB, and is credited as Codex-generated art", () => {
	const buf = readFileSync(join(root, "gui/themes/raven/perch.webp"));
	assert.ok(buf.length <= 40_000, `perch.webp is ${buf.length} bytes`);
	assert.equal(buf.subarray(0, 4).toString(), "RIFF");
	assert.equal(buf.subarray(8, 12).toString(), "WEBP");
	assert.equal(buf.subarray(12, 16).toString(), "VP8X", "an extended WebP, which carries alpha");
	assert.ok((buf[20]! & 0x10) !== 0, "the alpha flag is set");
	const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)), height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
	assert.equal(width, 2 * Math.round(height * 260 / 239), `two square-ish frames side by side (${width} x ${height})`);
	const notice = at("NOTICE.md") + at("gui/ICONS.md");
	assert.match(notice, /perch\.webp/);
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
	assert.ok(![...outside.matchAll(/animation(?:-name)?\s*:\s*([^;}]*)/g)].some((m) => !/^none\b/.test(m[1]!.trim())), "no animation declared outside the no-preference block (forced colours only stop one with `animation: none`)");
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

// The lightning (boss, 2026-11-07): at rest the picture is near black; a strike lights it with a double flicker and it fades back to dark in one to two seconds. Photosensitivity: at most 3 flashes in any second, strikes at least 60 s apart.
/** The frames of `@keyframes name` that set `prop` (a number): [{ at: percent, v }] in time order. */
const framesOf = (name: string, prop: string) => {
	const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(raw)?.[1] ?? "";
	return [...body.matchAll(new RegExp(`([\\d.%,\\s]+?)\\{\\s*${prop}:\\s*([\\d.]+)\\s*;?\\s*\\}`, "g"))].flatMap((m) => m[1]!.split(",").map((t) => ({ at: parseFloat(t), v: Number(m[2]) }))).filter((f) => !Number.isNaN(f.at)).sort((a, b) => a.at - b.at);
};
const boltFrames = () => framesOf("rk-bolt", "--rk-bolt");
test("the lightning lights the picture with at most 3 flashes in any second, strikes 60 s or more apart, and a fade of 1 to 2 s", () => {
	const cycle = Number(/animation:[^;]*\brk-bolt\s+(\d+)s/.exec(raw)?.[1]), frames = boltFrames();
	assert.ok(cycle >= 60, `rk-bolt cycle ${cycle} s`);
	assert.ok(frames.length >= 5, "the keyframes were read");
	const sec = (f: { at: number }) => (f.at / 100) * cycle;
	// a flash is a local peak of at least 0.6
	const peaks = frames.filter((f, i) => f.v >= 0.6 && (frames[i - 1]?.v ?? 0) <= f.v && (frames[i + 1]?.v ?? 0) < f.v);
	assert.ok(peaks.length >= 2 && peaks.length <= 3, `${peaks.length} flashes in a strike`);
	for (const a of peaks) assert.ok(peaks.filter((b) => sec(b) >= sec(a) && sec(b) < sec(a) + 1).length <= 3, "at most 3 flashes in any second");
	const last = peaks[peaks.length - 1]!, after = frames.find((f) => f.at > last.at && f.v === 0)!, fade = sec(after) - sec(last);
	assert.ok(fade >= 1 && fade <= 2.2, `the fade back to dark takes ${fade.toFixed(2)} s`);
	assert.ok(sec(frames.find((f) => f.v >= 0.6)!) - sec(frames.find((f) => f.v === 0 && f.at > 0 && f.at < peaks[0]!.at) ?? { at: 0 }) <= 0.6, "it rises fast");
});

test("at rest the picture is near black: a veil of at least 0.7 over everything but the moon, and the lightning takes it away", () => {
	const rest = /radial-gradient\(circle [^,]*at 16\.8% 15\.3%, transparent [\d.]+%, rgb\(\d+ \d+ \d+ \/ calc\(\(1 - var\(--rk-bolt\)\) \* ([\d.]+)\)\)/.exec(raw);
	assert.ok(rest, "the rest veil, clear over the moon, scaled by (1 - the bolt)");
	assert.ok(Number(rest[1]) >= 0.7, `the rest veil is ${rest[1]} at most`);
	assert.match(raw, /--rk-bolt:\s*1\b/);
});

test("the perched raven sits on the head page only, in two frames of one strip, dark at rest and lit by the strike with the picture, turning its head by an opacity cycle", () => {
	assert.match(raw, /\.stage\[data-view="head"\]::before/);
	assert.match(raw, /\.stage\[data-view="head"\]::after/);
	const perch = css.filter((r) => /\.stage\[data-view="head"\]::(before|after)/.test(r.selector));
	assert.ok(perch.length >= 3, "base rules, plus the animation");
	assert.ok(perch.some((r) => /url\("\.\/perch\.webp"\)/.test(r.body)), "the strip is the layer's image");
	assert.ok(perch.some((r) => /filter:\s*brightness\(/.test(r.body)), "dark at rest through a brightness filter");
	for (const name of ["rk-perch-lit", "rk-perch-turn"]) assert.match(raw, new RegExp(`@keyframes ${name}\\b`), name);
	const cycle = Number(/rk-perch-turn\s+(\d+)s/.exec(raw)?.[1]), t = framesOf("rk-perch-turn", "opacity");
	assert.ok(t.length >= 4 && t.some((f) => f.v === 1) && t.some((f) => f.v === 0), "the keyframes were read");
	const first = t.find((f) => f.v === 1)!, last = [...t].reverse().find((f) => f.v === 1)!;
	const from = [...t].reverse().find((f) => f.at < first.at && f.v === 0)!, to = t.find((f) => f.at > last.at && f.v === 0)!;
	const holdTurned = ((last.at - first.at) / 100) * cycle, holdProfile = ((100 - to.at + from.at) / 100) * cycle;
	assert.ok(holdTurned >= 2 && holdTurned <= 4.5, `turned for ${holdTurned.toFixed(1)} s`);
	assert.ok(holdProfile >= 8 && holdProfile <= 15.5, `in profile for ${holdProfile.toFixed(1)} s`);
	assert.ok(((first.at - from.at) / 100) * cycle <= 1.2 && ((to.at - last.at) / 100) * cycle <= 1.2, "the head turns in a dissolve of about a second at most");
	// a 600 px phone and forced colours do not draw it
	for (const query of ["(max-width: 600px)", "(forced-colors: active)"]) {
		const block = new RegExp(`@media ${query.replace(/[()]/g, "\\$&")} \\{([^\\n]*)\\}`).exec(raw)?.[1] ?? "";
		assert.match(block, /\.stage\[data-view="head"\]::before/, `${query} hides the perch`);
		assert.match(block, /\.stage\[data-view="head"\]::after/, `${query} hides the turned frame`);
	}
	// reduced motion and calm: its animations sit in the no-preference block outside data-calm, so the profile frame stands still in the dark light
	const inMotion = [...raw.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]).join("\n");
	assert.match(inMotion, /:not\(\[data-calm\]\)[^{]*\.stage\[data-view="head"\]::before[^{]*\{[^}]*rk-perch-lit/);
	assert.match(inMotion, /:not\(\[data-calm\]\)[^{]*\.stage\[data-view="head"\]::after[^{]*\{[^}]*rk-perch-turn/);
});

test("the backdrop belongs to the head page only, and fog, flicker, bats, and the raven are all in the stylesheet", () => {
	assert.match(raw, /html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\)::before/);
	for (const name of ["rk-fog", "rk-bat", "rk-raven", "rk-lit-a", "rk-lit-b", "rk-bolt"]) assert.match(raw, new RegExp(`@keyframes ${name}\\b`), name);
});

test("no selector of the theme puts a pseudo-element inside :is() (it matches nothing there)", () => {
	const bad = css.filter((r) => /:is\([^)]*::/.test(r.selector) || /:is\([^)]*:(before|after)\b/.test(r.selector));
	assert.deepEqual(bad.map((r) => r.selector), []);
	for (const query of ["(max-width: 600px)", "(forced-colors: active)"]) {
		const block = new RegExp(`@media ${query.replace(/[()]/g, "\\$&")} \\{([^\\n]*)\\}`).exec(raw)?.[1] ?? "";
		assert.match(block, /::after/, `${query} hides ::after`);
		assert.ok(!/:is\(/.test(block), `${query} writes its selectors out`);
	}
});

test("the head page's veil over the moon keeps the crumb row's text at 4.5 : 1 against the moon's brightest pixel", () => {
	// 243 217 194 is the brightest pixel of backdrop.webp in the crumb row's band (y 88 to 122 of 721), sampled with PIL; the plain veil there is 0.68 falling to 0.3 over 45 percent of the picture.
	const moon = /radial-gradient\(ellipse .* at 16\.4% 17%, rgb\(13 10 16 \/ ([\d.]+)\) 55%/.exec(raw);
	assert.ok(moon, "the moon's own veil layer");
	const plain = 0.68 - (0.68 - 0.3) * (104 / 324), alpha = 1 - (1 - plain) * (1 - Number(moon[1]));
	const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4, lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
	const ground = [243, 217, 194].map((v, i) => (1 - alpha) * v + alpha * [13, 10, 16][i]!);
	for (const [name, text] of Object.entries({ dim: [0xb0, 0xa6, 0xbc], gold: [0xe6, 0xb3, 0x4e], accent: [0xbb, 0xa9, 0xea] })) {
		const [hi, lo] = [lum(text), lum(ground)].sort((a, b) => b - a);
		assert.ok((hi! + 0.05) / (lo! + 0.05) >= 4.5, `${name} on the moon under the veil`);
	}
});

// The model stacks only the layers that reach the crumb row at the peak: the picture, the plain veil, the violet wash, and the moon veil. The foot veil
// is clear above 40% of the picture's height (the text sits at 12–17%), the rest veil is (1 − bolt) × 0.8, so 0 at the peak, with a hole over the moon,
// and the lights sit nowhere near the row (RL-F001).
test("at the brightest lightning frame the moon veil, under the violet wash, still keeps the crumb row's text at 4.5 : 1", () => {
	// the flash adds at most the violet wash (rgb 190 170 255, alpha = bolt * k, fading over the top 60 percent of the picture) over the moon's veils; the rest veil is gone at the flash but has a hole over the moon in any case
	const wash = /linear-gradient\(rgb\((\d+) (\d+) (\d+) \/ calc\(var\(--rk-bolt\) \* ([\d.]+)\)\), transparent (\d+)%\)/.exec(raw);
	assert.ok(wash, "the violet wash");
	const k = Number(wash[4]), fadeAt = Number(wash[5]) / 100, rgb = [Number(wash[1]), Number(wash[2]), Number(wash[3])];
	assert.ok(k <= 0.2, "the wash is faint");
	const moon = /at 16\.4% 17%, rgb\(13 10 16 \/ ([\d.]+)\) 55%/.exec(raw)!;
	assert.ok(raw.indexOf("0.62) 55%") < raw.indexOf("var(--rk-bolt) * 0.16"), "the moon's veil is listed (painted) above the wash");
	const plain = 0.68 - (0.68 - 0.3) * (104 / 324), m = Number(moon[1]);
	// the rows the text covers, y 88 to 122 of 721: the wash is strongest at the top of them. The layers, bottom to top: the plain veil, the wash, the moon's veil.
	const washAlpha = k * (1 - 88 / 721 / fadeAt);
	const lin = (v: number) => ((v / 255 + 0.055) / 1.055) ** 2.4, lum = (c: number[]) => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
	const veiled = [243, 217, 194].map((v, i) => (1 - plain) * v + plain * [13, 10, 16][i]!), washed = veiled.map((v, i) => (1 - washAlpha) * v + washAlpha * rgb[i]!);
	const lit = washed.map((v, i) => (1 - m) * v + m * [13, 10, 16][i]!);
	for (const [name, text] of Object.entries({ dim: [0xb0, 0xa6, 0xbc], gold: [0xe6, 0xb3, 0x4e], accent: [0xbb, 0xa9, 0xea] })) {
		const [hi, lo] = [lum(text), lum(lit)].sort((a, b) => b - a);
		assert.ok((hi! + 0.05) / (lo! + 0.05) >= 4.5, `${name} on the moon at the flash (${lit.map(Math.round)})`);
	}
	assert.ok(lum(lit) < 0.35, "never pure white at the peak");
});

test("no page source reads a role noun straight from the messages: every one goes through the noun chokepoint (a view's pack could not rename it otherwise)", () => {
	const hit = new RegExp(`\\bm\\.(${NOUN_KEYS.join("|")})\\b`);
	const offenders = readdirSync(join(root, "gui")).filter((f) => f.endsWith(".ts") && f !== "nouns.ts" && f !== "towermodel.ts").filter((f) => hit.test(at(`gui/${f}`)));
	assert.deepEqual(offenders, []);
});

// A template drawn once into a host that lives as long as the page (the dossier, the comms, the zoom) keeps the words it was built with, and the
// theme's nouns arrive after it (showTheme awaits its chunk) or change on a view switch: a noun printed as a template's text therefore carries
// `data-m`, so retranslate() rewrites it when the theme lands (RRB-F002).
test("a noun printed into a page template carries data-m, so a theme switch rewrites it", () => {
	const dir = join(root, "gui"), bare: string[] = [];
	for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts")))
		for (const hit of readFileSync(join(dir, f), "utf8").matchAll(/<([a-z0-9]+)([^<>]*)>\$\{noun\("([a-z_]+)"\)\}/g))
			if (!hit[2]!.includes(`data-m="${hit[3]}"`)) bare.push(`${f}: <${hit[1]}${hit[2]}>\${noun("${hit[3]}")}`);
	assert.deepEqual(bare, []);
	const page = readFileSync(join(dir, "i18n.ts"), "utf8");
	for (const key of ["documents", "comms", "outposts", "outside_net"]) assert.match(page, new RegExp(`\\b${key}: \\(\\) => noun\\("${key}"\\)`));
});
