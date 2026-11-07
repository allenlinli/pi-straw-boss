import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import { El } from "./fake-dom.ts";

// The comms log's follow against a scroller with real clamping and a clock the test moves (todo #123): at the bottom nothing keeps moving once input and inertia end, new output lands in one instant jump,
// and a user's own scroll up (a short one, a wheel flick, a finger drag, the first pixels of a fling) is never pulled back. Wheel events, scroll events, the sentinels and the resize observer are sent by hand,
// in the order a browser sends them: a wheel (or touch) event first, the scroll it causes a frame later; an entry's arrival, then the frame's resize observers.

const { mountChat } = await import("../gui/chat.ts");
const { m } = await import("../gui/paraglide/messages.js");

const VIEW = 300, ROW = 100;
const user = (n: number): Item => ({ id: `u${n}`, kind: "user", text: `message ${n}`, at: "2026-11-07T08:00:00.000Z" });

/** Mounts a chat over a log of 1000 px, following its end; `tick` moves the clock the chat's timers run on. Restores the globals with `done`. */
function rig() {
	let clock = 0, nextTimer = 1;
	const timers = new Map<number, { at: number; fn: () => void }>(), sentries: ((seen: { isIntersecting: boolean }[]) => void)[] = [], resizes: (() => void)[] = [];
	const globals = globalThis as unknown as Record<string, unknown>, saved = { setTimeout: globals.setTimeout, clearTimeout: globals.clearTimeout, IntersectionObserver: globals.IntersectionObserver, ResizeObserver: globals.ResizeObserver };
	Object.assign(globals, {
		setTimeout: (fn: () => void, ms = 0) => (timers.set(nextTimer, { at: clock + ms, fn }), nextTimer++),
		clearTimeout: (id: number) => void timers.delete(id),
		IntersectionObserver: class { constructor(f: (seen: { isIntersecting: boolean }[]) => void) { sentries.push(f); } observe() {} disconnect() {} },
		ResizeObserver: class { constructor(f: () => void) { resizes.push(f); } observe() {} },
	});
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "a1", name: "main", role: "main", mark: "idle" as const }), link: () => undefined });
	const log = chat.log as unknown as El, pill = root.find((el) => el.className === "chat-pill")[0]!;
	let top = 0, content = 1000, rows = 0;
	const writes: number[] = [], end = () => Math.max(0, content - VIEW);
	Object.defineProperty(log, "scrollHeight", { get: () => content });
	Object.defineProperty(log, "clientHeight", { get: () => VIEW });
	Object.defineProperty(log, "scrollTop", { get: () => top, set: (v: number) => void writes.push((top = Math.min(Math.max(v, 0), end()))) });
	const frame = () => resizes.forEach((f) => f());
	const rigged = {
		pill, writes, log,
		get top() { return top; },
		get end() { return end(); },
		/** A user's move to `to`, as a browser makes it: the offset changes, then the scroll event. Not a write of the page. */
		scroll(to: number) { top = Math.min(Math.max(to, 0), end()); log.bubble("scroll"); },
		wheel: (deltaY: number) => log.bubble("wheel", { deltaY }),
		/** The user's fling: wheel events of decaying deltas, each with the scroll it causes, 16 ms apart. */
		fling(v0: number, k: number, sign: 1 | -1) { for (let v = v0; v >= 1; v *= k) { rigged.wheel(sign * v); rigged.scroll(top + sign * v); rigged.tick(16); } },
		/** The sentinel at the log's end, as the observer reports it. */
		sentinel: (isIntersecting: boolean) => sentries.at(-1)!([{ isIntersecting }]),
		/** An entry arrives: the log grows, the page is told, the frame's resize observers run. */
		arrive() { content += ROW; chat.apply({ key: "a1", items: [user(++rows + 100)] }); frame(); },
		tick(ms: number) {
			const to = clock + ms;
			for (let next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]; next; next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]) (timers.delete(next[0]), (clock = next[1].at), next[1].fn());
			clock = to;
		},
		/** The log shrinks (an entry takes its real height): the browser clamps the offset and sends its scroll event; the observers run. */
		shrink(by: number) { content -= by; if (top > end()) rigged.scroll(end()); frame(); },
		done: () => void Object.assign(globals, saved),
	};
	chat.apply({ key: "a1", reset: true, items: [user(1), user(2), user(3)] });
	frame();
	assert.deepEqual([top, rigged.end, writes.length > 0], [700, 700, true], "it opens at the end");
	writes.length = 0;
	return rigged;
}

const quiet = (r: ReturnType<typeof rig>) => { const n = r.writes.length; r.tick(5000); assert.equal(r.writes.length, n, "nothing writes the offset once the input has ended"); };

test("a short scroll up with the wheel is not pulled back by the next entry (the first 80 px are inside the sentinel's margin)", () => {
	const r = rig();
	try {
		r.wheel(-30);
		r.scroll(r.top - 30);
		r.wheel(-20);
		r.scroll(r.top - 20);
		r.tick(300);
		r.arrive();
		assert.equal(r.top, 650, "the reader stays where the wheel left them");
		assert.deepEqual([r.pill.hidden, r.pill.textContent], [false, m.new_entries({ count: 1 })], "and is offered the way back");
		r.tick(300);
		r.arrive();
		assert.equal(r.top, 650);
		quiet(r);
	} finally {
		r.done();
	}
});

test("an entry that arrives between a wheel event and the scroll it causes does not pull the log back", () => {
	const r = rig();
	try {
		r.wheel(-40);
		r.arrive();
		assert.equal(r.writes.length, 0, "the log is the user's while the wheel (and its fling) lasts");
		r.scroll(r.top - 40);
		r.tick(400);
		assert.equal(r.top, 660);
		quiet(r);
	} finally {
		r.done();
	}
});

test("a fling up from the end is never fought, and entries arriving during it do not move the log", () => {
	const r = rig();
	try {
		const tops: number[] = [];
		for (let v = 90; v >= 1; v *= 0.9) {
			r.wheel(-v);
			r.scroll(r.top - v);
			tops.push(r.top);
			r.tick(16);
			if (tops.length % 4 === 0) r.arrive();
		}
		assert.ok(tops.every((t, i) => i === 0 || t < tops[i - 1]!), "the offset only goes up");
		const rest = r.top;
		r.tick(400);
		assert.equal(r.top, rest, "and stays where the fling stopped");
		quiet(r);
	} finally {
		r.done();
	}
});

test("at the end, the tail of a wheel fling that has nowhere to go holds the log; one jump lands the entries after it, then nothing moves", () => {
	const r = rig();
	try {
		for (let i = 0; i < 20; i++) {
			r.wheel(30 * 0.9 ** i);
			r.tick(16);
			if (i === 5) r.arrive();
		}
		assert.equal(r.writes.length, 0, "no write while the tail runs");
		r.tick(300);
		assert.deepEqual([r.writes.length, r.top], [1, r.end], "one jump to the end when it is over");
		assert.equal(r.end, 800);
		quiet(r);
	} finally {
		r.done();
	}
});

test("a finger that drags the log up a little and lets go is not pulled back when the touch ends", () => {
	const r = rig();
	try {
		r.log.bubble("touchstart");
		r.scroll(660);
		r.log.bubble("touchend");
		r.arrive();
		assert.equal(r.writes.length, 0, "a coasting fling holds the log");
		r.tick(300);
		assert.equal(r.top, 660, "and it stays where the finger left it");
		assert.equal(r.pill.hidden, false);
		quiet(r);
	} finally {
		r.done();
	}
});

test("scrolling back to the very end follows again, and an entry that shrinks the log (its offset clamped) is not a scroll up", () => {
	const r = rig();
	try {
		r.wheel(-30);
		r.scroll(670);
		r.arrive();
		assert.equal(r.top, 670);
		r.wheel(130);
		r.scroll(800);
		r.tick(300);
		r.arrive();
		r.tick(300);
		assert.deepEqual([r.top, r.end], [900, 900], "back at the end it follows (the entry is shown)");
		r.shrink(60);
		r.wheel(10);
		r.tick(300);
		r.arrive();
		assert.deepEqual([r.top, r.end], [r.end, 940], "a log that shrank under its end still follows");
		quiet(r);
	} finally {
		r.done();
	}
});

test("a log read from higher up follows only once the end is reached again", () => {
	const r = rig();
	try {
		r.wheel(-300);
		r.scroll(300);
		r.sentinel(false);
		r.arrive();
		assert.equal(r.top, 300);
		r.fling(60, 0.9, 1);
		r.scroll(r.end);
		r.sentinel(true);
		r.tick(300);
		r.arrive();
		r.tick(300);
		assert.equal(r.top, r.end);
		quiet(r);
	} finally {
		r.done();
	}
});
