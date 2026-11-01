import assert from "node:assert/strict";
import { test } from "node:test";
import { glide, settle, SIZE_MS } from "../gui/zensize.ts";

// A card's box follows its content's height (gui/zensize.ts): set from an observer on the inner box, the first reading without anything to ease from, a hidden layer's 0 ignored, and stopped
// when the card leaves. The easing itself is zen.css (tests/gui-css.test.ts); here the box is a plain object and the observer a stand-in the test fires.

function rig() {
	const watchers: { fire(): void; observed?: unknown; disconnected: boolean }[] = [];
	class Fake {
		w: { fire(): void; observed?: unknown; disconnected: boolean };
		constructor(fn: () => void) {
			this.w = { fire: fn, disconnected: false };
			watchers.push(this.w);
		}
		observe(el: unknown) {
			this.w.observed = el;
		}
		disconnect() {
			this.w.disconnected = true;
		}
	}
	const outer = { style: { height: "" } } as unknown as HTMLElement, inner = { offsetHeight: 120 } as unknown as HTMLElement;
	return { outer, inner, watchers, Fake: Fake as never, size: (h: number) => ((inner as { offsetHeight: number }).offsetHeight = h) };
}

test("the outer box takes the inner one's height at each reading: entering, a line arriving, an outcome, a second question", () => {
	const r = rig();
	glide(r.outer, r.inner, r.Fake);
	assert.equal(r.watchers[0]!.observed, r.inner, "the content is what is watched");
	r.watchers[0]!.fire();
	assert.equal(r.outer.style.height, "120px", "the first reading is the card's size");
	for (const h of [148, 148, 176, 96]) {
		r.size(h);
		r.watchers[0]!.fire();
		assert.equal(r.outer.style.height, `${h}px`);
	}
	assert.ok(SIZE_MS >= 400 && SIZE_MS <= 600, "eased over 400 to 600 ms");
});

test("a reading of 0 (the layer is hidden) leaves the height alone; settling stops the watch; with no observer the box keeps its natural size", () => {
	const r = rig();
	glide(r.outer, r.inner, r.Fake);
	r.watchers[0]!.fire();
	r.size(0);
	r.watchers[0]!.fire();
	assert.equal(r.outer.style.height, "120px");
	settle(r.outer);
	assert.equal(r.watchers[0]!.disconnected, true);
	settle(r.outer); // twice is harmless
	const bare = rig();
	glide(bare.outer, bare.inner, undefined);
	assert.equal(bare.outer.style.height, "");
});
