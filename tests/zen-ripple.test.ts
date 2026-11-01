import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, rulesOf } from "./css-rules.ts";
import { El } from "./zen-dom.ts";

// The ripples (gui/zenripple.ts): the rules for starting one (rate, travel, cap, touch), the rings' shape, the contrast budget computed from the stroke values, and the page's switches (reduced motion,
// forced colours, hidden, calm, the layer's showing), on a stand-in page.
const { CAP, createRipples, domRipples, INK, mountRipples, OVERLAP, PEAK, RATE_MS, RING_MS, RINGS, MIN_MOVE } = await import("../gui/zenripple.ts");
type Env = import("../gui/zenripple.ts").RippleEnv;
type Ctx = import("../gui/zenripple.ts").Canvas2D;

test("a mouse or pen leaves a ripple every MIN_MOVE px at most every RATE_MS; a touch's move never does; a press makes one under the same rate", () => {
	let t = 1000;
	const r = createRipples(() => t);
	assert.equal(r.move(100, 100, "mouse"), true, "the first move leaves one");
	assert.equal(r.move(200, 100, "mouse"), false, "not within the rate");
	t += RATE_MS - 1;
	assert.equal(r.move(200, 100, "mouse"), false, "just short of it");
	t += 1;
	assert.equal(r.move(100 + MIN_MOVE - 1, 100, "mouse"), false, "and not before it has travelled");
	assert.equal(r.move(100 + MIN_MOVE, 100, "pen"), true, "a pen leaves one, after the rate and the travel");
	t += RATE_MS;
	assert.equal(r.move(500, 500, "touch"), false, "a touch's move is a scroll: never");
	assert.equal(r.tap(500, 500), true, "a tap makes one, wherever the last was");
	assert.equal(r.tap(500, 500), false, "a second tap too soon makes none");
	t += RATE_MS;
	assert.equal(r.tap(10, 10), true);
	assert.equal(r.alive(), 4);
});

test("at most 12 ripples in any second and CAP alive at once, however the pointer moves; the cap holds with a lower rate too", () => {
	let t = 0;
	const r = createRipples(() => t), starts: number[] = [];
	let alive = 0;
	for (let i = 0; i < 2500; i++, t += 4) {
		if (r.move(i * 40, (i % 2) * 40, "mouse")) starts.push(t);
		alive = Math.max(alive, (r.rings(), r.alive()));
	}
	for (const from of starts) assert.ok(starts.filter((s) => s >= from && s < from + 1000).length <= 12, "no second holds more than 12");
	assert.ok(starts.length >= 100, "and it keeps leaving them");
	assert.ok(alive <= CAP && alive >= 15, `${alive} alive at most`);
	let u = 0;
	const fast = createRipples(() => u, { rateMs: 1 });
	for (let i = 0; i < 200; i++, u += 2) fast.move(i * 50, 0, "mouse");
	assert.equal(fast.alive(), CAP, "the cap itself holds when the rate would let more through");
	assert.equal(fast.move(99999, 0, "mouse"), false);
	u += RING_MS;
	assert.deepEqual([fast.rings().length, fast.alive()], [0, 0], "they all fade and go");
});

test("a ripple is RINGS concentric rings that spread, fade, and are gone after RING_MS", () => {
	let t = 0;
	const r = createRipples(() => t);
	r.move(10, 20, "mouse");
	let before = { r: 0, a: PEAK + 1 };
	const seen: number[] = [];
	for (t = 50; t < RING_MS; t += 50) {
		const rings = r.rings();
		seen.push(rings.length);
		assert.ok(rings.every((x) => x.x === 10 && x.y === 20 && x.a > 0 && x.a <= PEAK && x.r >= 6), "centred where it passed, never brighter than the peak");
		const lead = rings[0]!;
		assert.ok(lead.r > before.r && lead.a < before.a, "the leading ring spreads and fades");
		before = lead;
	}
	assert.equal(Math.max(...seen), RINGS, "all the rings show together for a while");
	t = RING_MS;
	assert.deepEqual([r.rings(), r.alive()], [[], 0]);
});

/** A stroke of INK at PEAK alpha OVERLAP times over the Zen ground, as a hex colour. */
function stacked(ground: string) {
	const g = [1, 3, 5].map((i) => parseInt(ground.slice(i, i + 2), 16)), a = 1 - (1 - PEAK) ** OVERLAP;
	return `#${INK.map((c, i) => Math.round(g[i]! + (c - g[i]!) * a).toString(16).padStart(2, "0")).join("")}`;
}

test("contrast: the ground with the budgeted rings stacked on it still holds every text colour at 7 : 1", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	const block = rulesOf(css).find((x) => x.parts.includes('[data-view="zen"] :is(#zen, .connect)'))!;
	const tokens = Object.fromEntries(declarations(block.body).filter(([p, v]) => p.startsWith("--zen-") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(6), v.toLowerCase()])) as Record<string, string>;
	for (const ground of ["ground", "ground-2"]) for (const text of ["paper", "ash", "clay"]) {
		const under = stacked(tokens[ground]!);
		assert.ok(contrast(tokens[text]!, under) >= 7, `--zen-${text} on --zen-${ground} under ${OVERLAP} peak rings (${under}): ${contrast(tokens[text]!, under).toFixed(2)}`);
	}
	assert.ok(PEAK <= 0.1 && OVERLAP >= 3);
});

function page(o: { still?: boolean; idle?: boolean } = {}) {
	let t = 0, still = o.still ?? false, idle = o.idle ?? false;
	const frames: (() => void)[] = [], cleared: number[] = [], arcs: { x: number; y: number; r: number; style: string }[] = [];
	const env: Env = { now: () => t, frame: (fn) => (frames.push(fn), () => void (frames.includes(fn) && frames.splice(frames.indexOf(fn), 1))), still: () => still, idle: () => idle, size: () => ({ w: 800, h: 600, dpr: 2 }) };
	const ctx = { clearRect: () => void cleared.push(t), beginPath() {}, stroke() {}, arc: (x: number, y: number, r: number) => arcs.push({ x, y, r, style: String(ctx.strokeStyle) }), strokeStyle: "", lineWidth: 0 } as unknown as Ctx;
	const root = new El("section");
	const m = mountRipples(root as unknown as HTMLElement, env, () => ctx);
	const frame = () => void frames.splice(0).forEach((f) => f());
	return { m, root, env, frames, arcs, cleared, advance: (ms: number) => (t += ms), frame, set: (k: "still" | "idle", v: boolean) => (k === "still" ? (still = v) : (idle = v)), move: (x: number, y: number, type = "mouse") => root.bubble("pointermove", { clientX: x, clientY: y, pointerType: type }), press: (x: number, y: number, type = "touch") => root.bubble("pointerdown", { clientX: x, clientY: y, pointerType: type }) };
}

test("the layer draws on one canvas only while a ripple lives, in device pixels, and the loop stops when the last one fades", () => {
	const p = page();
	p.m.on();
	assert.equal(p.frames.length, 0, "nothing runs at rest");
	p.move(100, 50);
	assert.equal(p.frames.length, 1, "a ripple starts the loop");
	p.advance(300);
	p.frame();
	assert.ok(p.arcs.length >= 1 && p.arcs.every((a) => a.x === 200 && a.y === 100), "drawn at twice the pointer's place");
	assert.match(p.arcs[0]!.style, /^rgba\(120, 106, 88, 0\.0\d+\)$/);
	assert.equal(p.frames.length, 1, "and asks for the next frame");
	p.advance(RING_MS);
	p.frame();
	assert.equal(p.frames.length, 0, "the last one faded: the loop stops");
	assert.equal(p.m.alive(), 0);
});

test("off under reduced motion and forced colours, and while the page is calm or hidden; off before the layer shows and after it hides; a hidden page drops what lives", () => {
	const p = page({ still: true });
	p.m.on();
	p.move(10, 10);
	p.press(10, 10);
	assert.equal(p.m.alive(), 0, "reduced motion or forced colours: none");
	p.set("still", false);
	p.set("idle", true);
	p.move(10, 10);
	assert.equal(p.m.alive(), 0, "calm or a hidden page: none");
	p.set("idle", false);
	p.move(10, 10);
	assert.equal(p.m.alive(), 1, "the page is awake and moving: one");
	p.m.visible(false);
	assert.deepEqual([p.m.alive(), p.frames.length], [0, 0], "hiding the page drops what lived");
	p.advance(RATE_MS);
	p.move(300, 300);
	p.m.off();
	assert.deepEqual([p.m.alive(), p.frames.length], [0, 0], "hiding the layer clears it");
	p.advance(RATE_MS);
	p.move(10, 400);
	assert.equal(p.m.alive(), 0, "and it makes none while hidden");
	const early = page();
	early.move(10, 10);
	assert.equal(early.m.alive(), 0, "none before the layer shows");
	const touch = page();
	touch.m.on();
	touch.move(10, 10, "touch");
	assert.equal(touch.m.alive(), 0, "a finger scrolling makes none");
	touch.press(10, 10, "touch");
	assert.equal(touch.m.alive(), 1, "a tap makes one");
});

test("the canvas is under everything and takes no pointer; reduced motion and forced colours hide it in the sheet; the page's own switches read the media queries and the calm mark", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	assert.match(css, /\.zen-ripples \{ position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; \}/);
	assert.match(css, /prefers-reduced-motion: reduce\) \{ \[data-view="zen"\] \.zen-ripples \{ display: none; \}/);
	assert.match(css, /forced-colors: active\) \{[^}]*\.zen-ripples \{ display: none; \}/);
	assert.match(css, /\.zen-stage \{ position: relative; z-index: 1;/, "the stage and its content are above the canvas");
	const g = globalThis as Record<string, unknown>, saved = [g.matchMedia, g.document, g.requestAnimationFrame];
	try {
		const asked: string[] = [];
		g.matchMedia = (q: string) => (asked.push(q), { matches: q.includes("forced") });
		g.document = { hidden: false, documentElement: { dataset: {} } };
		const env = domRipples(() => 0);
		assert.equal(env.still(), true, "forced colours is still");
		assert.deepEqual(asked, ["(prefers-reduced-motion: reduce)", "(forced-colors: active)"]);
		assert.equal(env.idle(), false);
		(g.document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset.calm = "";
		assert.equal(env.idle(), true, "the calm mark");
		(g.document as { hidden: boolean }).hidden = true;
		(g.document as { documentElement: { dataset: Record<string, string> } }).documentElement.dataset = {};
		assert.equal(env.idle(), true, "a hidden page");
	} finally {
		[g.matchMedia, g.document, g.requestAnimationFrame] = saved;
	}
});
