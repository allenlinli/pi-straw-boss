import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./fake-dom.ts";
import { begun, watchTouch } from "../gui/zentouch.ts";

// What counts as a card the boss is answering (docs/specs/2026-11-01-zen-view.md, Blocking first): text in a field, a choice picked, a tap or key in the last `hold` ms, or the card's own busy state; looking at it is not.
const card = () => {
	const el = new El("section"), field = new El("textarea"), pick = new El("button");
	pick.setAttribute("role", "radio");
	pick.setAttribute("aria-checked", "false");
	el.append(field, pick);
	return { el, field, pick };
};

test("a card nobody touched is not begun; text in a field or a picked choice is", () => {
	const c = card();
	assert.equal(begun(c.el as never), false);
	c.field.value = "x";
	assert.equal(begun(c.el as never), true);
	c.field.value = "";
	c.pick.setAttribute("aria-checked", "true");
	assert.equal(begun(c.el as never), true);
});

test("a tap, a touch, a key, or an input on the card holds it for `hold` ms; the card's busy state holds it as long as it lasts", () => {
	for (const type of ["pointerdown", "touchstart", "keydown", "input"]) {
		const c = card();
		let t = 0, busy = false;
		const touched = watchTouch(c.el as never, { now: () => t, hold: 20_000, busy: () => busy });
		assert.equal(touched(), false, "a card the page focused by itself and nobody touched");
		t = 5_000;
		c.field.bubble(type, {});
		assert.equal(touched(), true, type);
		t = 24_999;
		assert.equal(touched(), true);
		t = 25_000;
		assert.equal(touched(), false, "20 s on, an empty card lets go");
		busy = true;
		assert.equal(touched(), true, "a sent answer, an open fold or reply box");
	}
});
