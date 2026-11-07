import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import { createFollow } from "../gui/follow.ts";
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
	const timers = new Map<number, { at: number; fn: () => void }>(), sentries: ((seen: { isIntersecting: boolean }[]) => void)[] = [], resizes: (() => void)[] = [], firsts: (() => void)[] = [];
	const globals = globalThis as unknown as Record<string, unknown>, saved = { setTimeout: globals.setTimeout, clearTimeout: globals.clearTimeout, IntersectionObserver: globals.IntersectionObserver, ResizeObserver: globals.ResizeObserver };
	Object.assign(globals, {
		setTimeout: (fn: () => void, ms = 0) => (timers.set(nextTimer, { at: clock + ms, fn }), nextTimer++),
		clearTimeout: (id: number) => void timers.delete(id),
		// As a browser's: a target that is observed gets a first notice with where it stands (on the next frame), and observing it again while connected is nothing.
		IntersectionObserver: class {
			on = false; index = sentries.length;
			constructor(f: (seen: { isIntersecting: boolean }[]) => void) { sentries.push(f); }
			observe() { if (!this.on && this.index === 1) firsts.push(() => this.on && sentries[1]!([{ isIntersecting: end() - top <= 80 }])); this.on = true; }
			disconnect() { this.on = false; }
		},
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
		arrive(by = ROW) { content += by; chat.apply({ key: "a1", items: [user(++rows + 100)] }); frame(); },
		tick(ms: number) {
			for (const first of firsts.splice(0)) first();
			const to = clock + ms;
			for (let next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]; next; next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]) (timers.delete(next[0]), (clock = next[1].at), next[1].fn());
			clock = to;
		},
		/** The log shrinks (an entry takes its real height): the browser clamps the offset, the observers run, and the clamp's scroll event follows a frame later (`late`) or at once. */
		shrink(by: number, late = false) { content -= by; const clamped = top > end(); if (clamped) top = end(); if (clamped && !late) log.bubble("scroll"); frame(); },
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
		for (let v = 40; v >= 1; v *= 0.9) {
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

test("at the end, the tail of a wheel fling down has nowhere to go: the entry lands at once, and nothing moves after it", () => {
	const r = rig();
	try {
		for (let i = 0; i < 20; i++) {
			r.wheel(30 * 0.9 ** i);
			r.tick(16);
			if (i === 5) r.arrive();
			if (i === 5) assert.equal(r.top, r.end, "landed in the frame it arrived");
		}
		assert.equal(r.end, 800);
		const n = r.writes.length;
		r.tick(300);
		assert.deepEqual([r.writes.length, r.top], [n, 800], "no second jump when the tail is over");
		quiet(r);
	} finally {
		r.done();
	}
});

test("a wheel up that its scroll has not followed yet holds the log: an entry that arrives then waits, and lands in one jump if the user did not leave the end", () => {
	const r = rig();
	try {
		r.wheel(-40);
		r.arrive();
		assert.deepEqual([r.writes.length, r.top], [0, 700], "held");
		r.tick(300);
		assert.deepEqual([r.writes.length, r.top], [1, 800], "the wheel moved nothing (no room above, say): one jump");
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

test("a log under a finger that shrinks and then grows before the clamp's scroll event arrives is not read as a scroll up", () => {
	const r = rig();
	try {
		r.log.bubble("touchstart");
		r.shrink(50, true);
		r.arrive(50); // back to where it was: still inside the sentinel's margin (a first notice from a reconnected observer says so)
		r.scroll(r.top);
		r.log.bubble("touchend");
		r.tick(300);
		assert.deepEqual([r.top, r.end], [r.end, 700], "still following: it lands at the end when the finger is gone");
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

test("a short scroll up in a quiet log (the sentinels disconnected, no entries) stays where the reader left it: the sentinel's first notice on reconnecting is not a crossing", () => {
	for (const up of [10, 50]) {
		const r = rig();
		try {
			r.tick(1000);
			r.wheel(-up);
			r.scroll(r.end - up);
			r.tick(16);
			assert.equal(r.pill.hidden, false, `${up} px up: the way back is offered`);
			r.tick(400);
			assert.deepEqual([r.top, r.writes.length], [700 - up, 0], `${up} px up: nothing pulls the log back`);
			quiet(r);
		} finally {
			r.done();
		}
	}
});

test("a return to the end in steps of half a pixel follows again", () => {
	const r = rig();
	try {
		r.wheel(-10);
		r.scroll(690);
		r.tick(400);
		for (let at = 690.5; at <= 700; at += 0.5) r.scroll(at);
		assert.equal(r.pill.hidden, true, "it follows again");
		r.arrive();
		assert.equal(r.top, r.end, "and the entry is shown");
	} finally {
		r.done();
	}
});

test("every key that moves the log up holds it, and Space down does not", () => {
	for (const key of [{ key: "ArrowUp" }, { key: "PageUp" }, { key: "Home" }, { key: " ", shiftKey: true }]) {
		const r = rig();
		try {
			r.log.bubble("keydown", key);
			r.arrive();
			assert.equal(r.writes.length, 0, `${JSON.stringify(key)} holds the log`);
			r.tick(300);
			assert.equal(r.writes.length, 1, "and it lands in one jump when the hold ends");
		} finally {
			r.done();
		}
	}
	const r = rig();
	try {
		r.log.bubble("keydown", { key: " ", shiftKey: false });
		r.log.bubble("keydown", { key: "ArrowDown" });
		r.arrive();
		assert.equal(r.top, r.end, "Space and Down hold nothing: the entry lands at once");
	} finally {
		r.done();
	}
});

test("the hold lasts 250 ms after the last input: still held at 249, over at 250", () => {
	const r = rig();
	try {
		r.wheel(-40);
		r.tick(200);
		r.arrive();
		assert.equal(r.writes.length, 0, "held at 200 ms");
		r.tick(49);
		assert.equal(r.writes.length, 0, "held at 249 ms");
		r.tick(1);
		assert.equal(r.writes.length, 1, "over at 250 ms");
	} finally {
		r.done();
	}
});

test("an anchor opened on the last entry (`hold`) is not re-pinned by a move down to the end until the sentinel has seen the end", () => {
	const f = createFollow(), end = () => 700;
	f.parked(700);
	f.hold();
	assert.equal(f.pinned, false);
	assert.equal(f.moved(699, end), false);
	assert.equal(f.moved(700, end), false, "a scroll down onto the end, with the sentinel unheard: still reading");
	assert.equal(f.pinned, false);
	f.scrolled(true);
	assert.equal(f.pinned, true, "the sentinel's crossing pins it");
});

test("the sentinel acts on a crossing only: the same report again changes nothing", () => {
	const f = createFollow(), end = () => 700;
	f.parked(700);
	assert.equal(f.moved(690, end), true, "a move up unpins");
	f.scrolled(true);
	assert.equal(f.pinned, false, "a report of 'inside' that is nothing new does not re-pin");
	f.scrolled(false);
	f.scrolled(true);
	assert.equal(f.pinned, true, "a crossing out and back in does");
});

test("a return to the very end drops the count of entries seen from above, and the tolerance is one pixel", () => {
	const f = createFollow(), end = () => 700;
	f.parked(700);
	f.moved(690, end);
	f.arrived(2);
	assert.equal(f.button(false), m.new_entries({ count: 2 }));
	assert.equal(f.moved(698.5, end), false, "1.5 px above the end is not the end");
	assert.equal(f.moved(699.5, end), true, "0.5 px above it is");
	assert.equal(f.button(false), undefined);
	f.moved(600, end);
	assert.equal(f.button(false), m.jump_latest(), "no count carried over");
});
