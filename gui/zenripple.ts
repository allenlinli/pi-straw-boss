import { h } from "./dom.ts";

// Ink-water ripples (docs/specs/2026-11-01-zen-view.md, Ripples): where a mouse or pen passes over the Zen ground it leaves a soft ripple, a few faint concentric rings that spread and fade. Its own small
// module, which moves into the shared core with the views.
//
// Budget. One canvas behind all the content (pointer-events none), redrawn by requestAnimationFrame only while a ripple lives (nothing runs at rest). At most RATE_MS apart (12 a second) and MIN_MOVE px of
// travel apart, at most CAP live at once, each RING_MS long with RINGS rings: about 60 thin arcs a frame at the very most, and none once the pointer rests (the page's 30 s calm then stops nothing
// that is running). Rings are 1.25 px strokes of INK at PEAK alpha, which fades as they spread. Contrast: a ring is a hairline, so a pixel meets at most one ring of a ripple, and the budget for a pixel
// is OVERLAP rings from different ripples; the ground with that many peak rings stays dark enough for the ash text at 7 : 1 (tests/zen-ripple.test.ts computes it from these values).
// Off: under prefers-reduced-motion and forced colours (also hidden in zen.css), while the page is hidden, and while the page is calm. A touch makes no ripples while it scrolls, and one on a tap.

export const RING_MS = 1600, RATE_MS = 85, MIN_MOVE = 28, CAP = 20, RINGS = 3, RING_GAP = 0.14;
/** The stroke colour of a ring at its brightest, as rgb, and its peak alpha; the most rings of different ripples a pixel is budgeted to meet. */
export const INK = [120, 106, 88] as const, PEAK = 0.06, OVERLAP = 4, WIDTH = 1.25;
export interface Ring { x: number; y: number; r: number; a: number }
export type Pointer = "mouse" | "pen" | "touch" | string;

/** The ripples alive and the rules for starting one, with no page in it (a test drives it with its own clock). */
export function createRipples(now: () => number, limits: { cap?: number; rateMs?: number } = {}) {
	const cap = limits.cap ?? CAP, rateMs = limits.rateMs ?? RATE_MS;
	const live: { x: number; y: number; at: number }[] = [];
	let last = { at: -Infinity, x: NaN, y: NaN };
	const room = () => now() - last.at >= rateMs && live.length < cap;
	const start = (x: number, y: number) => {
		live.push({ x, y, at: now() });
		last = { at: now(), x, y };
		return true;
	};
	return {
		/** A pointer moved: a mouse or a pen leaves a ripple every MIN_MOVE px, at most every RATE_MS; a touch never does (it scrolls). True when one started. */
		move: (x: number, y: number, type: Pointer) => (type === "mouse" || type === "pen") && room() && (Number.isNaN(last.x) || Math.hypot(x - last.x, y - last.y) >= MIN_MOVE) && start(x, y),
		/** A press: a touch's tap makes one (a mouse's click too), under the same rate and cap. */
		tap: (x: number, y: number) => room() && start(x, y),
		/** The rings to draw at this moment; ripples past their time are dropped. */
		rings(): Ring[] {
			const t = now();
			for (let i = live.length - 1; i >= 0; i--) if (t - live[i]!.at >= RING_MS) live.splice(i, 1);
			return live.flatMap((p) =>
				Array.from({ length: RINGS }, (_, k) => {
					const age = (t - p.at) / RING_MS - k * RING_GAP;
					return age > 0 && age < 1 ? { x: p.x, y: p.y, r: 6 + (1 - (1 - age) ** 2) * (52 + k * 10), a: PEAK * (1 - age) ** 2 } : undefined;
				}).filter((r): r is Ring => r !== undefined),
			);
		},
		alive: () => live.length,
		clear: () => void (live.length = 0),
	};
}

/** What the layer reads of the page, as plain parts so a test can stand in for it. */
export interface RippleEnv {
	now(): number;
	/** One animation frame later; returns what cancels it. */
	frame(fn: () => void): () => void;
	/** Reduced motion or forced colours: no ripples at all. */
	still(): boolean;
	/** The page is hidden, or calm (30 s without input). */
	idle(): boolean;
	/** The canvas's drawing size in CSS pixels and the pixel ratio. */
	size(): { w: number; h: number; dpr: number };
}
/** The part of the 2D context the rings use. */
export type Canvas2D = Pick<CanvasRenderingContext2D, "clearRect" | "beginPath" | "arc" | "stroke" | "strokeStyle" | "lineWidth">;

export function domRipples(now: () => number): RippleEnv {
	const query = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
	return {
		now,
		frame: (fn) => (typeof requestAnimationFrame === "function" ? ((id) => () => cancelAnimationFrame(id))(requestAnimationFrame(fn)) : () => {}),
		still: () => query("(prefers-reduced-motion: reduce)") || query("(forced-colors: active)"),
		idle: () => document.hidden || (typeof document.documentElement?.dataset === "object" && document.documentElement.dataset.calm !== undefined),
		size: () => ({ w: typeof innerWidth === "number" ? innerWidth : 0, h: typeof innerHeight === "number" ? innerHeight : 0, dpr: Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2) }),
	};
}

/** The canvas and its listeners on `root` (the Zen layer). `on` and `off` follow the layer's showing; the canvas draws only while a ripple lives. */
export function mountRipples(root: HTMLElement, env: RippleEnv, context: (canvas: HTMLCanvasElement) => Canvas2D | null = (c) => (typeof c.getContext === "function" ? c.getContext("2d") : null)) {
	const canvas = h("canvas", { class: "zen-ripples", "aria-hidden": "true" }), core = createRipples(env.now);
	let ctx: Canvas2D | null | undefined, stop = () => {}, running = false, active = false;
	const paint = () => {
		running = false;
		const { w, h: height, dpr } = env.size(), rings = core.rings();
		if (!w || !height) return core.clear();
		ctx ??= context(canvas);
		if (!ctx) return core.clear();
		if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) [canvas.width, canvas.height] = [Math.round(w * dpr), Math.round(height * dpr)];
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.lineWidth = WIDTH * dpr;
		for (const r of rings) {
			ctx.beginPath();
			ctx.strokeStyle = `rgba(${INK[0]}, ${INK[1]}, ${INK[2]}, ${r.a.toFixed(4)})`;
			ctx.arc(r.x * dpr, r.y * dpr, r.r * dpr, 0, Math.PI * 2);
			ctx.stroke();
		}
		if (core.alive() && active && !env.idle()) ((running = true), (stop = env.frame(paint)));
	};
	const wake = () => void (!running && ((running = true), (stop = env.frame(paint))));
	const ok = () => active && !env.still() && !env.idle();
	root.addEventListener("pointermove", (e) => ok() && core.move(e.clientX, e.clientY, e.pointerType ?? "mouse") && wake());
	root.addEventListener("pointerdown", (e) => ok() && core.tap(e.clientX, e.clientY) && wake());
	return {
		el: canvas,
		on: () => void (active = true),
		/** The layer is hidden: nothing is drawn, nothing lives. */
		off() {
			active = false;
			stop();
			running = false;
			core.clear();
			ctx?.clearRect(0, 0, canvas.width, canvas.height);
		},
		/** The page was hidden or came back: what lives is dropped (a ripple that waits out a hidden page would draw late). */
		visible: (on: boolean) => on || (stop(), (running = false), core.clear(), ctx?.clearRect(0, 0, canvas.width, canvas.height)),
		alive: core.alive,
	};
}
