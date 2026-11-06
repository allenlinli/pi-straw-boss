import assert from "node:assert/strict";
import { test } from "node:test";
import { El } from "./fake-dom.ts";
import { watchTouch } from "../gui/zentouch.ts";

// What counts as a card the boss is answering (docs/specs/2026-11-01-zen-view.md, Blocking first, boss ruling 2026-11-06 「Touched expires after 20 s; draft kept」): the card's answer on its way, or a tap, touch, key, wheel, or input that reached it in the last `hold` ms. An open box, a draft, or a pick holds nothing once the boss has let go; looking at it holds nothing either.
const card = () => {
	const el = new El("section"), field = new El("textarea"), pick = new El("button");
	pick.setAttribute("role", "radio");
	pick.setAttribute("aria-checked", "false");
	el.append(field, pick);
	return { el, field, pick };
};

test("a tap, a touch, a key, a wheel, or an input on the card holds it for `hold` ms and no longer; the card's answer on its way holds it as long as it lasts", () => {
	for (const type of ["pointerdown", "touchstart", "keydown", "input", "wheel"]) {
		const c = card();
		let t = 0, sending = false;
		const touched = watchTouch(c.el as never, { now: () => t, hold: 20_000, busy: () => sending });
		assert.equal(touched(), false, "a card the page focused by itself and nobody touched");
		t = 5_000;
		c.field.bubble(type, {});
		assert.equal(touched(), true, type);
		t = 24_999;
		assert.equal(touched(), true);
		t = 25_000;
		assert.equal(touched(), false, "20 s on, the card lets go");
		sending = true;
		assert.equal(touched(), true, "a sent answer");
	}
});

test("text in a field and a picked choice hold nothing by themselves: a draft the boss walked away from does not keep a blocking question off the screen", () => {
	const c = card();
	let t = 0;
	const touched = watchTouch(c.el as never, { now: () => t, hold: 20_000, busy: () => false });
	c.field.bubble("input", {});
	c.field.value = "half a sentence";
	c.pick.setAttribute("aria-checked", "true");
	assert.equal(touched(), true, "typing");
	t = 20_000;
	assert.equal(touched(), false, "20 s on, the draft stays on the card and holds nothing");
});
