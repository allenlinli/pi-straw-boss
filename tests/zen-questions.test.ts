import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { El, page } from "./zen-dom.ts";
import { rulesOf } from "./css-rules.ts";

// Several questions in Zen (gui/zenquestions.ts): the real answer panel (gui/ask.ts, with its keys from gui/askkeys.ts) on a fake document, enhanced the way the Zen card does, and the stylesheet's rules read as text.
// The layout is a browser's, so the geometry is a test's: three blocks 200 tall at 100, 400, and 700 in a scroller 300 tall, so centring block k puts scrollTop at 50, 350, and 650.
const { mountAsk } = await import("../gui/ask.ts");
const { BEAT_MS, HOLD_MS, syncQuestions } = await import("../gui/zenquestions.ts");

const Q = (question: string, titles: string[], multiple = false) => ({ question, header: question.slice(0, 1), multiple, options: titles.map((title) => ({ title })) });
const pending = (...qs: ReturnType<typeof Q>[]): Pending => ({ callId: "c", tool: "ask_user_question", answer: { dialog: "q", digest: "1".repeat(64), cancel: true, questions: qs } });
const THREE = () => pending(Q("A?", ["a1", "a2"]), Q("B?", ["b1", "b2"]), Q("C?", ["c1", "c2"]));
const cls = (name: string) => (el: El) => (el.getAttribute("class") ?? "").split(" ").includes(name);

function rig(p: Pending = THREE(), o: { reduced?: boolean } = {}) {
	let t = 0;
	const timers: { at: number; fn: () => void }[] = [];
	const env = {
		reduced: () => Boolean(o.reduced),
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const advance = (ms: number) => {
		t += ms;
		for (;;) {
			const due = timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
			if (!due) return;
			timers.splice(timers.indexOf(due), 1);
			due.fn();
		}
	};
	const hold = new El("div");
	page.body.replaceChildren(hold);
	page.focused = undefined;
	const ask = mountAsk(hold as never, (async () => ({ ok: true, status: 200, body: { outcome: "accepted" } })) as never, false);
	ask.update(p, true);
	syncQuestions(hold as never, env);
	const panel = hold.children[0]!, scroller = hold.all(cls("zen-qs"))[0];
	const blocks = scroller ? scroller.children : [];
	if (scroller) {
		[scroller.clientHeight, scroller.scrollHeight] = [300, 1000];
		blocks.forEach((b, i) => ([b.offsetTop, b.offsetHeight] = [100 + i * 300, 200]));
	}
	const choices = (k: number) => blocks[k]!.all((el) => ["radio", "checkbox"].includes(el.getAttribute("role") ?? ""));
	const dim = () => blocks.map((b) => b.dataset.dim !== undefined);
	const inside = () => blocks.findIndex((b) => b.contains(page.focused));
	const key = (to: El, k: string, extra: object = {}) => to.bubble("keydown", { key: k, shiftKey: false, ...extra });
	/** A pointer's tap on `el` (the button's own handler, then the click that rises). */
	const tap = (el: El) => (el.onclick?.(), el.bubble("click", { detail: 1 }));
	/** The same tap landing on the words inside a button (a browser's click target is the innermost element). */
	const tapWord = (el: El) => (el.onclick?.(), el.children[0]!.bubble("click", { detail: 1 }));
	const scrollTo = (top: number) => ((scroller!.scrollTop = top), scroller!.bubble("scroll"));
	return { hold, ask, panel, scroller: scroller!, blocks, choices, dim, inside, key, tap, tapWord, scrollTo, advance, env };
}

test("two questions or more go into one scroller; the first is focused and the others faded; the send row stays outside it", () => {
	const r = rig();
	assert.equal(r.hold.all(cls("zen-qs")).length, 1);
	assert.equal(r.blocks.length, 3);
	assert.ok(r.blocks.every(cls("ask-one")));
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.deepEqual(r.panel.children.map((el) => el.getAttribute("class")), ["zen-qs", "ask-acts", "ask-note"], "Send and Cancel, and the outcome line, are pinned below the scroller");
	assert.equal(r.panel.all((el) => el.textContent === "Send answer").length, 1);
	r.advance(0);
	assert.deepEqual(r.scroller.scrolls, [{ top: 50, behavior: "auto" }], "the first block is brought to the middle, without a glide");
});

test("a dialog with one question is left as Standard draws it, and a second update does not enhance twice", () => {
	const one = rig(pending(Q("A?", ["a1", "a2"])));
	assert.equal(one.hold.all(cls("zen-qs")).length, 0);
	assert.ok(one.panel.children.some(cls("ask-one")));
	const r = rig();
	r.ask.update(THREE(), true);
	syncQuestions(r.hold as never, r.env);
	assert.equal(r.hold.all(cls("zen-qs")).length, 1, "the same dialog keeps its panel and its scroller");
	assert.equal(r.panel.all(cls("ask-one")).length, 3);
	r.scroller.scrolls.length = 0;
	r.advance(0);
	r.choices(0)[0]!.focus();
	assert.equal(r.scroller.scrolls.length, 1, "one listener set only: the focus moved nothing twice");
});

test("Tab, Shift+Tab, and Enter on an option move the focus to the next question and scroll it to the middle, smoothly", () => {
	const r = rig();
	r.choices(0)[0]!.focus();
	r.key(r.choices(0)[0]!, "Tab");
	assert.equal(r.inside(), 1, "the keyboard focus lands inside the focused question");
	assert.deepEqual(r.dim(), [true, false, true]);
	assert.deepEqual(r.scroller.scrolls.at(-1), { top: 350, behavior: "smooth" });
	r.key(page.focused as El, "Tab", { shiftKey: true });
	assert.equal(r.inside(), 0);
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.deepEqual(r.scroller.scrolls.at(-1), { top: 50, behavior: "smooth" });
	r.key(page.focused as El, "Enter");
	assert.equal(r.choices(0)[0]!.getAttribute("aria-checked"), "true", "Enter picks, as in Standard");
	assert.equal(r.inside(), 1, "and goes on to the next question without an answer");
	assert.deepEqual(r.dim(), [true, false, true]);
	assert.deepEqual(r.scroller.scrolls.at(-1), { top: 350, behavior: "smooth" });
});

test("a pointer's pick of a single choice brings the next unanswered question in after a beat; arrows, multiple choice, and Enter do not add a second move", () => {
	const r = rig(pending(Q("A?", ["a1", "a2"]), Q("B?", ["b1", "b2"]), Q("C?", ["c1", "c2"])));
	r.choices(1)[0]!.onclick?.(); // B answered without a tap: it is passed over
	r.tapWord(r.choices(0)[1]!); // a click lands on the words in the button
	assert.equal(r.choices(0)[1]!.getAttribute("aria-checked"), "true");
	assert.deepEqual(r.dim(), [false, true, true], "the pick is seen first");
	r.advance(BEAT_MS - 1);
	assert.deepEqual(r.dim(), [false, true, true]);
	r.advance(1);
	assert.deepEqual(r.dim(), [true, true, false], "C is the next one without an answer");
	assert.equal(r.inside(), 2);
	assert.deepEqual(r.scroller.scrolls.at(-1), { top: 650, behavior: "smooth" });
	r.tap(r.choices(2)[0]!);
	r.advance(BEAT_MS);
	assert.deepEqual(r.dim(), [true, true, false], "all answered: nothing is left to go to");

	const arrows = rig();
	arrows.choices(0)[0]!.focus();
	arrows.key(arrows.choices(0)[0]!, "ArrowDown");
	assert.equal(arrows.choices(0)[1]!.getAttribute("aria-checked"), "true", "an arrow picks as the focus moves");
	arrows.advance(BEAT_MS * 3);
	assert.deepEqual(arrows.dim(), [false, true, true], "and stays in the question");

	const several = rig(pending(Q("A?", ["a1", "a2"], true), Q("B?", ["b1"])));
	several.tap(several.choices(0)[0]!);
	several.advance(BEAT_MS * 3);
	assert.deepEqual(several.dim(), [false, true], "a multiple choice has no end to its picks");
});

test("the next question is not forced in when the boss has moved on during the beat", () => {
	const r = rig();
	r.tap(r.choices(0)[0]!);
	r.blocks[2]!.bubble("click", { detail: 1 }); // a tap on C inside the beat
	assert.deepEqual(r.dim(), [true, true, false]);
	r.advance(BEAT_MS);
	assert.deepEqual(r.dim(), [true, true, false], "C stays");
});

test("a tap on a faded question brings it in and puts the focus inside it; a tap on the focused one does nothing", () => {
	const r = rig();
	r.advance(0);
	r.scroller.scrolls.length = 0;
	r.blocks[0]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.scroller.scrolls, []);
	r.blocks[2]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.dim(), [true, true, false]);
	assert.equal(r.inside(), 2);
	assert.deepEqual(r.scroller.scrolls, [{ top: 650, behavior: "smooth" }]);
});

test("scrolling by hand changes the focused question, and the keyboard focus follows it out of a faded one", () => {
	const r = rig();
	r.advance(0);
	r.scroller.scrolls.length = 0;
	r.choices(0)[0]!.focus();
	r.scrollTo(150);
	assert.deepEqual(r.dim(), [false, true, true], "nearer A than B");
	r.scrollTo(350);
	assert.deepEqual(r.dim(), [true, false, true]);
	assert.equal(r.inside(), 1, "the focus was in a question and goes with the scroll");
	r.scrollTo(660);
	assert.deepEqual(r.dim(), [true, true, false]);
	assert.deepEqual(r.scroller.scrolls, [], "a scroll the hand makes is not scrolled again");
	page.focused = undefined;
	r.scrollTo(40);
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.equal(r.inside(), -1, "a focus that was elsewhere is not pulled in");
});

test("a scroll we start holds the focus where it goes until it arrives; a hand on the scroller or the hold's end lets go", () => {
	const r = rig();
	r.advance(0);
	r.choices(0)[0]!.focus();
	r.key(r.choices(0)[0]!, "Tab");
	r.scrollTo(100); // the way there passes A and B
	assert.deepEqual(r.dim(), [true, false, true], "no flicker on the way");
	r.scrollTo(350);
	assert.deepEqual(r.dim(), [true, false, true]);
	r.scrollTo(150);
	assert.deepEqual(r.dim(), [false, true, true], "arrived: a later scroll is the hand's");

	const wheel = rig();
	wheel.advance(0);
	wheel.choices(0)[0]!.focus();
	wheel.key(wheel.choices(0)[0]!, "Tab");
	wheel.scroller.bubble("wheel");
	wheel.scrollTo(100);
	assert.deepEqual(wheel.dim(), [false, true, true], "a wheel takes over from ours");

	const stuck = rig();
	stuck.advance(0);
	stuck.choices(0)[0]!.focus();
	stuck.key(stuck.choices(0)[0]!, "Tab");
	stuck.advance(HOLD_MS);
	stuck.scrollTo(100);
	assert.deepEqual(stuck.dim(), [false, true, true], "a scroll that never arrived does not hold for ever");
});

test("under reduced motion the scroll is instant", () => {
	const r = rig(THREE(), { reduced: true });
	r.choices(0)[0]!.focus();
	r.key(r.choices(0)[0]!, "Tab");
	r.blocks[2]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.scroller.scrolls, [{ top: 350, behavior: "auto" }, { top: 650, behavior: "auto" }]);
});

const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
const rule = (part: string) => rulesOf(css).find((x) => x.parts.includes(part));
const decl = (body: string, prop: string) => new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`).exec(body)?.[1]?.trim();

test("the stylesheet: a scroller of a fixed height that snaps to the centre, faded blocks that stay readable and answer only a tap, and no motion under reduced motion", () => {
	const qs = rule('[data-view="zen"] .zen-qs');
	assert.ok(qs, "the scroller's rule");
	assert.match(decl(qs.body, "height") ?? "", /^clamp\(/, "a fixed height: the card's size (zensize.ts) never follows the focus");
	assert.equal(decl(qs.body, "scroll-snap-type"), "y mandatory");
	assert.equal(decl(qs.body, "overflow-y"), "auto");
	assert.equal(decl(qs.body, "overscroll-behavior"), "contain");
	const one = rule('[data-view="zen"] .zen-qs > .ask-one');
	assert.equal(decl(one!.body, "scroll-snap-align"), "center");
	const faded = rule('[data-view="zen"] .zen-qs > .ask-one[data-dim]');
	assert.ok(Number(decl(faded!.body, "opacity")) >= 0.35 && Number(decl(faded!.body, "opacity")) < 1, "faded, not gone");
	assert.equal(decl(rule('[data-view="zen"] .zen-qs > .ask-one[data-dim] > *')!.body, "pointer-events"), "none", "a faded block's controls take no pointer; the block itself takes the tap");
	const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(forced, /\.zen-qs > \.ask-one\[data-dim\] \{ opacity: 0\.[4-9][^}]*border: 1px dashed GrayText/, "forced colours: a border says which is the other question");
	const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf("@media (forced-colors: active)"));
	assert.match(reduced, /\.zen-qs > \.ask-one \{ transition: none; \}/, "the fade is instant");
	assert.match(rule('[data-view="zen"] .zen-card')!.body, /transition: height/, "the card still eases its own box");
});
