import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { El, page } from "./zen-dom.ts";
import { rulesOf } from "./css-rules.ts";

// Several questions in Zen (gui/zenquestions.ts): the real answer panel (gui/ask.ts, with its keys from gui/askkeys.ts) on a fake document, enhanced the way the Zen card does, and the stylesheet's rules read as text.
// The layout is a browser's, so the geometry is a test's: blocks are 200 tall with nothing to scroll unless a test says otherwise, and the wheel and the touches are events with the times the test gives them.
const { mountAsk } = await import("../gui/ask.ts");
const { BEAT_MS, syncQuestions } = await import("../gui/zenquestions.ts");

// A faded block shows only its summary line (zen.css: display none), and a browser cannot focus what is not shown: the fake does not either, so a test that moves the focus into a faded block passes only when the layer shows it first.
const hidden = (el: El) => {
	for (let at = el.parent; at; at = at.parent) if ((at.getAttribute("class") ?? "").split(" ").includes("ask-one") && at.dataset.dim !== undefined) return !(el.getAttribute("class") ?? "").split(" ").includes("zen-sum");
	return false;
};
const focus = El.prototype.focus;
El.prototype.focus = function (this: El, ...args: []) {
	if (!hidden(this)) focus.apply(this, args);
};

const Q = (question: string, titles: string[], multiple = false, header: string | undefined = question.slice(0, 1)) => ({ question, header, multiple, options: titles.map((title) => ({ title })) });
const pending = (...qs: ReturnType<typeof Q>[]): Pending => ({ callId: "c", tool: "ask_user_question", answer: { dialog: "q", digest: "1".repeat(64), cancel: true, questions: qs } });
const THREE = () => pending(Q("A?", ["a1", "a2"]), Q("B?", ["b1", "b2"]), Q("C?", ["c1", "c2"]));
const cls = (name: string) => (el: El) => (el.getAttribute("class") ?? "").split(" ").includes(name);

function rig(p: Pending = THREE()) {
	let t = 0;
	const timers: { at: number; fn: () => void }[] = [];
	const env = {
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
	// A browser keeps no scroll position it is told while the block is not drawn (a faded block): the fake does the same; `left` puts a place there as the user left it.
	const put = new Map<El, (top: number) => void>();
	blocks.forEach((b) => {
		let top = 0;
		Object.defineProperty(b, "scrollTop", { get: () => top, set: (v: number) => void (b.dataset.dim === undefined && (top = v)) });
		put.set(b, (v) => void (top = v));
		[b.clientHeight, b.scrollHeight] = [200, 200];
	});
	const left = (b: El, top: number) => put.get(b)!(top);
	const choices = (k: number) => blocks[k]!.all((el) => ["radio", "checkbox"].includes(el.getAttribute("role") ?? ""));
	const own = (k: number) => blocks[k]!.all((el) => el.tagName === "textarea")[0]!;
	const note = (k: number) => blocks[k]!.all((el) => el.tagName === "input")[0]!;
	const sum = (k: number) => blocks[k]!.children[0]!;
	const dim = () => blocks.map((b) => b.dataset.dim !== undefined);
	const inside = () => blocks.findIndex((b) => b.contains(page.focused));
	/** A key press; whether the form took it (the browser does not move the focus for a key it took). */
	const key = (to: El, k: string, extra: object = {}) => {
		let taken = false;
		to.bubble("keydown", { key: k, shiftKey: false, preventDefault: () => (taken = true), ...extra });
		return taken;
	};
	/** A pointer's tap on `el` (the button's own handler, then the click that rises). */
	const tap = (el: El) => (el.onclick?.(), el.bubble("click", { detail: 1 }));
	/** The same tap landing on the words inside a button (a browser's click target is the innermost element). */
	const tapWord = (el: El) => (el.onclick?.(), el.children[0]!.bubble("click", { detail: 1 }));
	/** A wheel event over `over` at time `at`; whether the layer took it from the browser. */
	const wheel = (deltaY: number, at: number, over: El = scroller!) => {
		let taken = false;
		over.bubble("wheel", { deltaY, deltaMode: 0, timeStamp: at, preventDefault: () => (taken = true) });
		return taken;
	};
	/** A finger down at `from`, `during` run, and up at `to` after `ms`. */
	const swipe = (from: number, to: number, ms: number, during?: () => void, over: El = scroller!) => {
		over.bubble("touchstart", { touches: [{ clientY: from }], timeStamp: 1000 });
		during?.();
		over.bubble("touchend", { changedTouches: [{ clientY: to }], touches: [], timeStamp: 1000 + ms });
	};
	return { hold, ask, panel, scroller: scroller!, blocks, left, choices, own, note, sum, dim, inside, key, tap, tapWord, wheel, swipe, advance, env };
}

test("two questions or more go into one scroller; the first is focused and the others faded to a line; the send row stays outside it", () => {
	const r = rig();
	assert.equal(r.hold.all(cls("zen-qs")).length, 1);
	assert.equal(r.blocks.length, 3);
	assert.ok(r.blocks.every(cls("ask-one")));
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.deepEqual(r.panel.children.map((el) => el.getAttribute("class")), ["zen-qs", "ask-acts", "ask-note"], "Send and Cancel, and the outcome line, are pinned below the scroller");
	assert.equal(r.panel.all((el) => el.textContent === "Send answer").length, 1);
	assert.ok(r.blocks.every((b, k) => cls("zen-sum")(r.sum(k)) && r.sum(k).tagName === "button"), "each block begins with its summary line, a button");
	assert.equal(r.scroller.scrolls.length, 0, "the scroller does not scroll: the focused question is expanded in place");
});

test("a dialog with one question is left as Standard draws it, and a second update does not enhance twice", () => {
	const one = rig(pending(Q("A?", ["a1", "a2"])));
	assert.equal(one.hold.all(cls("zen-qs")).length, 0);
	assert.ok(one.panel.children.some(cls("ask-one")));
	assert.equal(one.hold.all(cls("zen-sum")).length, 0);
	const r = rig();
	r.ask.update(THREE(), true);
	syncQuestions(r.hold as never, r.env);
	assert.equal(r.hold.all(cls("zen-qs")).length, 1, "the same dialog keeps its panel and its scroller");
	assert.equal(r.panel.all(cls("ask-one")).length, 3);
	assert.equal(r.hold.all(cls("zen-sum")).length, 3);
	assert.equal(r.scroller.handlers.wheel?.length, 1, "one listener set only");
});

test("a faded question is one line: its header (or its question without one), and its answer after a dot once it has one", () => {
	const r = rig(pending(Q("B?", ["b1", "b2", "b3"], true), Q("Pick one?", ["x", "y"], false, ""), Q("Own?", ["o1"])));
	assert.equal(r.sum(1).textContent, "Pick one?", "no header: the question stands for it");
	assert.equal(r.sum(2).textContent, "O", "an unanswered question is its header alone");
	r.sum(1).bubble("click", { detail: 1 });
	r.tap(r.choices(1)[0]!);
	r.advance(BEAT_MS);
	assert.deepEqual(r.dim(), [true, true, false], "the beat goes on to the next question without an answer");
	assert.equal(r.sum(1).textContent, "Pick one? · x", "the answer it was left with");
	r.blocks[0]!.bubble("click", { detail: 1 });
	r.tap(r.choices(0)[0]!);
	r.tap(r.choices(0)[2]!);
	r.blocks[2]!.bubble("click", { detail: 1 });
	assert.equal(r.sum(0).textContent, "B · b1, b3", "several picks are listed");
	r.own(2).type("é".repeat(80));
	r.blocks[1]!.bubble("click", { detail: 1 });
	const said = r.sum(2).textContent;
	assert.ok(said.startsWith("O · ééé") && said.endsWith("…") && said.length < 50, `own words are cut short: ${said}`);
	r.own(1).type("");
	assert.equal(r.own(2).value.length, 80, "what was typed is kept whole");
});

test("a faded question's controls are not drawn, so a screen reader's activation only reaches its line; the line brings the question in", () => {
	const r = rig();
	assert.equal(hidden(r.choices(1)[0]!), true, "the fake document refuses a focus there, as display: none does");
	r.sum(1).focus();
	assert.deepEqual(r.dim(), [true, false, true], "Tab onto the line shows the question");
	assert.ok(r.choices(1).includes(page.focused as El), "and the focus goes in, onto an option: the line itself is gone");
	r.blocks[0]!.bubble("click", { detail: 0 }); // Enter or Space on the line is a click without a pointer
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.equal(r.inside(), 0);
});

test("Enter on an option and Tab from a question's last box move the focus into the next question, which comes in even though it was faded", () => {
	const r = rig();
	r.choices(0)[0]!.focus();
	assert.equal(r.key(r.choices(0)[0]!, "Tab"), false, "Tab from an option is the browser's: it goes to the question's own words");
	r.note(0).focus();
	assert.equal(r.key(r.note(0), "Tab"), true, "from the last box it goes on to the next question");
	assert.equal(r.inside(), 1, "the keyboard focus lands inside the next question");
	assert.deepEqual(r.dim(), [true, false, true]);
	assert.equal(r.key(r.choices(1)[0]!, "Tab", { shiftKey: true }), true);
	assert.equal(page.focused, r.note(0), "Shift+Tab goes back to the box the question before it ends in");
	assert.deepEqual(r.dim(), [false, true, true]);
	r.choices(0)[0]!.focus();
	r.key(r.choices(0)[0]!, "Enter");
	assert.equal(r.choices(0)[0]!.getAttribute("aria-checked"), "true", "Enter picks, as in Standard");
	assert.equal(r.inside(), 1, "and goes on to the next question without an answer");
	assert.deepEqual(r.dim(), [true, false, true]);
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
	r.blocks[2]!.bubble("click", { detail: 1 }); // a tap on C's line inside the beat
	assert.deepEqual(r.dim(), [true, true, false]);
	r.advance(BEAT_MS);
	assert.deepEqual(r.dim(), [true, true, false], "C stays");
});

test("a tap on a faded question's line brings it in and puts the focus inside it; a tap on the focused one does nothing", () => {
	const r = rig();
	r.blocks[0]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.dim(), [false, true, true]);
	r.blocks[2]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.dim(), [true, true, false]);
	assert.equal(r.inside(), 2);
});

test("a wheel notch moves one question, whatever its size, and the next notch later moves one more; the ends stay", () => {
	const r = rig();
	assert.equal(r.wheel(100, 1000), true, "the layer takes the wheel from the page");
	assert.deepEqual(r.dim(), [true, false, true], "one notch, one question");
	for (const dy of [53, 120, 15]) {
		r.wheel(dy, 5000 + dy * 100); // notches a pause apart each move once, up to the last question
	}
	assert.deepEqual(r.dim(), [true, true, false], "and no further than the last");
	assert.equal(r.wheel(100, 9000), true, "at the end the wheel is still the layer's: the page behind does not move");
	assert.deepEqual(r.dim(), [true, true, false]);
	r.wheel(-100, 9500);
	assert.deepEqual(r.dim(), [true, false, true], "up goes back");
	r.wheel(-40, 10000);
	r.wheel(-40, 10400);
	assert.deepEqual(r.dim(), [false, true, true], "no further than the first");
});

test("one fling is one move: the wheel events that follow a move closely are its inertia and do nothing", () => {
	const r = rig();
	let at = 2000;
	for (const dy of [4, 12, 40, 90, 120, 100, 70, 45, 30, 18, 9, 4, 2, 1]) r.wheel(dy, (at += 16)); // a trackpad: it grows, then fades over 200 ms
	assert.deepEqual(r.dim(), [true, false, true], "a gentle start adds up to a move, once");
	for (const dy of [30, 60, 90, 60, 30]) r.wheel(dy, (at += 16)); // a second push inside the same fling
	assert.deepEqual(r.dim(), [true, false, true], "it is still the same gesture");
	r.wheel(100, (at += 400));
	assert.deepEqual(r.dim(), [true, true, false], "a gesture after a pause is a new one");
	const fast = rig();
	for (const t of [0, 50, 100, 150]) fast.wheel(100, 3000 + t);
	assert.deepEqual(fast.dim(), [true, false, true], "a wheel spun fast is one gesture too");
});

test("a wheel too small to mean a move adds up within its gesture and is forgotten after a pause", () => {
	const r = rig();
	r.wheel(10, 1000);
	r.wheel(10, 1500);
	r.wheel(10, 2000);
	assert.deepEqual(r.dim(), [false, true, true], "three whispers apart are nothing");
	r.wheel(10, 2016);
	r.wheel(10, 2032);
	assert.deepEqual(r.dim(), [true, false, true], "ten close together are a move");
});

test("the focused question's own scroll takes the wheel first, and its end then lets the next notch move on", () => {
	const r = rig();
	const tall = r.blocks[0]!;
	[tall.clientHeight, tall.scrollHeight, tall.scrollTop] = [300, 700, 0];
	assert.equal(r.wheel(100, 1000, tall), false, "over the question the browser scrolls it");
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.equal(r.wheel(100, 3000, r.blocks[1]!), true, "over a faded line the layer scrolls it for the browser");
	assert.equal(tall.scrollTop, 100);
	tall.scrollTop = 400; // the end: 400 + 300 = 700
	assert.equal(r.wheel(100, 5000, tall), true, "at the end the browser would scroll nothing");
	assert.deepEqual(r.dim(), [true, false, true], "so the notch moves on");
	[tall.scrollTop] = [0];
	r.wheel(-100, 7000, r.blocks[1]!);
	assert.deepEqual(r.dim(), [false, true, true], "and from the top a notch up moves back");

	const inertia = rig();
	const t2 = inertia.blocks[0]!;
	[t2.clientHeight, t2.scrollHeight, t2.scrollTop] = [300, 700, 380];
	inertia.wheel(100, 1000, t2);
	t2.scrollTop = 400;
	for (let at = 1016; at < 1400; at += 16) inertia.wheel(60, at, t2); // its inertia runs on past the end
	assert.deepEqual(inertia.dim(), [false, true, true], "the same gesture does not carry on into the next question");
	inertia.wheel(100, 2000, t2);
	assert.deepEqual(inertia.dim(), [true, false, true], "the next one does");
});

test("a swipe of more than 40 px, or a quick flick, moves one question; a short slow drag, and a drag that scrolled the question, do not", () => {
	const r = rig();
	r.swipe(500, 440, 300);
	assert.deepEqual(r.dim(), [true, false, true], "up by 60 px: the next");
	r.swipe(500, 470, 600);
	assert.deepEqual(r.dim(), [true, false, true], "30 px slowly is a drag that means nothing");
	r.swipe(300, 340, 200);
	assert.deepEqual(r.dim(), [true, false, true], "40 px is not more than 40");
	r.swipe(300, 345, 200);
	assert.deepEqual(r.dim(), [false, true, true], "down by 45 px: the one before");
	r.swipe(500, 480, 40);
	assert.deepEqual(r.dim(), [true, false, true], "20 px in 40 ms is a flick");
	r.swipe(500, 300, 300);
	r.swipe(500, 300, 300);
	assert.deepEqual(r.dim(), [true, true, false], "and no further than the last");

	const tall = rig();
	const b = tall.blocks[0]!;
	[b.clientHeight, b.scrollHeight] = [300, 700];
	tall.swipe(500, 300, 400, () => (b.scrollTop = 150), b);
	assert.deepEqual(tall.dim(), [false, true, true], "the question moved under the finger: that was its scroll");
	tall.swipe(500, 300, 400, undefined, tall.blocks[1]!);
	assert.deepEqual(tall.dim(), [true, false, true], "a drag that moved nothing is a swipe");
});

test("a question that goes on below the fold says so while it does, and a lone question does the same", () => {
	const r = rig();
	const tall = r.blocks[0]!;
	[tall.clientHeight, tall.scrollHeight] = [300, 700];
	tall.bubble("scroll");
	assert.equal(tall.getAttribute("data-more"), "", "more lies below");
	r.left(tall, 399);
	tall.bubble("scroll");
	assert.equal(tall.getAttribute("data-more"), null, "the end (within 4 px) is the end");
	tall.scrollTop = 100;
	tall.bubble("scroll");
	assert.equal(tall.getAttribute("data-more"), "");
	const one = rig(pending(Q("A?", ["a1", "a2"])));
	const lone = one.panel.children.find(cls("ask-one"))!;
	[lone.clientHeight, lone.scrollHeight] = [200, 600];
	lone.bubble("scroll");
	assert.equal(lone.getAttribute("data-more"), "", "the same for a dialog of one question, which is not wrapped");
	assert.equal(one.panel.children.find(cls("ask-acts"))!.getAttribute("data-more"), null, "and the send row is never marked");
});

test("a scroll inside the focused question leaves the keyboard focus where it is; a move takes it along", () => {
	const r = rig();
	r.own(0).focus();
	r.scroller.bubble("scroll");
	r.blocks[0]!.bubble("scroll");
	assert.equal(page.focused, r.own(0), "the caret stays in the question's own words");
	assert.deepEqual(r.dim(), [false, true, true]);
	r.wheel(100, 1000);
	assert.equal(r.inside(), 1, "paging takes the keyboard focus out of the question that fades");
	page.focused = undefined;
	r.wheel(-100, 3000);
	assert.deepEqual(r.dim(), [false, true, true]);
	assert.equal(r.inside(), -1, "a focus that was elsewhere is not pulled in");
});

test("a question taller than the space arrives at its top, however it was left", () => {
	const r = rig();
	const b = r.blocks[1]!;
	[b.clientHeight, b.scrollHeight] = [300, 900];
	r.left(b, 400);
	assert.equal(b.scrollTop, 400);
	r.blocks[1]!.bubble("click", { detail: 1 });
	assert.equal(b.scrollTop, 0, "its header and its question are what the boss sees");
	assert.equal(r.scroller.scrollTop, 0);
	assert.equal(r.scroller.scrolls.length, 0, "and the scroller around it never moved");
	b.scrollTop = 300;
	r.blocks[2]!.bubble("click", { detail: 1 });
	r.left(b, 300);
	r.key(r.choices(2)[0]!, "Tab", { shiftKey: true }); // a key press into a question taller than the space too
	assert.deepEqual(r.dim(), [true, false, true]);
	assert.equal(b.scrollTop, 0);
});

const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
const rule = (part: string) => rulesOf(css).find((x) => x.parts.includes(part));
const decl = (body: string, prop: string) => new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`).exec(body)?.[1]?.trim();

test("the stylesheet: a column of a fixed height with a soft edge that holds the focused question and the lines, faded lines that show nothing but their summary, and no motion under reduced motion", () => {
	const qs = rule('[data-view="zen"] .zen-qs');
	assert.ok(qs, "the scroller's rule");
	assert.match(decl(qs.body, "height") ?? "", /^clamp\(/, "a fixed height: the card's size (zensize.ts) never follows the focus");
	assert.equal(decl(qs.body, "overflow"), "hidden", "it does not scroll itself: the layer pages it");
	assert.match(decl(qs.body, "display") ?? "", /^flex$/);
	assert.equal(decl(qs.body, "flex-direction"), "column");
	assert.doesNotMatch(qs.body, /scroll-snap/, "no snapping to fight the paging");
	assert.match(qs.body, /(?:-webkit-)?mask-image: var\(--zen-edge\)/, "the soft edge");
	assert.match(css, /--zen-edge: linear-gradient\(to bottom, transparent, #000 10px, #000 calc\(100% - 10px\), transparent\)/);
	const focused = rule('[data-view="zen"] .zen-qs > .ask-one:not([data-dim])');
	assert.equal(decl(focused!.body, "overflow-y"), "auto", "a question taller than the space scrolls inside itself");
	assert.equal(decl(focused!.body, "overscroll-behavior"), "contain");
	const faded = rule('[data-view="zen"] .zen-qs > .ask-one[data-dim]');
	assert.ok(Number(decl(faded!.body, "opacity")) >= 0.35 && Number(decl(faded!.body, "opacity")) < 1, "faded, not gone");
	assert.equal(decl(rule('[data-view="zen"] .zen-qs > .ask-one[data-dim] > :not(.zen-sum)')!.body, "display"), "none", "a faded question's controls are not drawn: a screen reader's activation cannot reach them");
	assert.equal(rule('[data-view="zen"] .zen-qs > .ask-one[data-dim] > *'), undefined, "no pointer-events trick in place of it");
	assert.equal(decl(rule('[data-view="zen"] .zen-qs > .ask-one:not([data-dim]) > .zen-sum')!.body, "display"), "none", "the focused question is not its own summary");
	const line = rule('[data-view="zen"] .zen-sum');
	assert.ok(line && Number.parseFloat(decl(line.body, "min-height") ?? "0") >= 44, "a line is a control, 44 px at least");
	assert.equal(decl(rule('[data-view="zen"] .zen-sum-q')!.body, "text-overflow"), "ellipsis", "one line, however long the question");
	assert.match(css, /\.zen-qs > \.ask-one:not\(\[data-dim\]\)\[data-more\][^}]*var\(--zen-edge-more\)/, "the foot fades deeper while more lies below");
	assert.match(css, /--zen-edge-more: linear-gradient\(to bottom, transparent, #000 10px, #000 calc\(100% - 40px\), transparent\)/);
	const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(forced, /\.zen-qs > \.ask-one\[data-dim\] \{ opacity: 0\.[4-9][^}]*border: 1px dashed GrayText/, "forced colours: a border says which is the other question");
	const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf("@media (forced-colors: active)"));
	assert.match(reduced, /\.zen-qs > \.ask-one \{ transition: none; animation: none; \}/, "the fade is instant");
	assert.match(rule('[data-view="zen"] .zen-card')!.body, /transition: height/, "the card still eases its own box");
});

test("the stylesheet: on a short window the question area gives way and the send row, Cancel, the outcome, and Maybe later stay on the page", () => {
	const inner = rule('[data-view="zen"] .zen-card:has(.zen-ask) .zen-card-in');
	assert.ok(inner, "a card that holds a dialog");
	assert.equal(decl(inner.body, "display"), "flex");
	assert.equal(decl(inner.body, "flex-direction"), "column");
	assert.match(decl(inner.body, "max-height") ?? "", /100dvh/, "no taller than the page");
	assert.match(css, /\.zen-card:has\(\.zen-ask\) :is\(\.zen-answer, \.zen-ask, \.ask\) \{[^}]*min-height: 0/, "the chain down to the questions can be squeezed");
	assert.match(css, /\.zen-card:has\(\.zen-ask\) :is\(\.zen-answer, \.zen-ask, \.ask\) \{[^}]*display: flex; flex-direction: column/, "the panel is a column: the questions, then the send row");
	assert.match(css, /\.zen-ask \.ask > :not\(\.ask-acts, \.ask-note\) \{[^}]*min-height: 5rem[^}]*overflow-y: auto/, "whatever the questions are (one, a select's options) they scroll inside the space left");
	assert.match(css, /\.zen-ask \.ask > :is\(\.ask-acts, \.ask-note\) \{[^}]*flex: none/, "and the send row does not shrink");
});

/** The browser's layout for a column `room` px tall: a folded line is 44 px and a 6 px gap, a line dropped (`data-far`) none, and the focused question takes what is left. */
function column(room: number, p: Pending) {
	const r = rig(p);
	const shown = () => r.blocks.filter((b) => b.dataset.dim !== undefined && b.dataset.far === undefined).length;
	r.blocks.forEach((b) => {
		Object.defineProperty(b, "clientHeight", { configurable: true, get: () => (b.dataset.dim !== undefined ? 44 : Math.max(0, room - shown() * 50)) });
		Object.defineProperty(b, "scrollHeight", { configurable: true, get: () => (b.dataset.dim !== undefined ? 44 : 400) });
	});
	return { ...r, far: () => r.blocks.map((b) => b.dataset.far !== undefined), open: () => r.blocks.find((b) => b.dataset.dim === undefined)! };
}
const FOUR = () => pending(Q("A?", ["a1", "a2"]), Q("B?", ["b1", "b2"]), Q("C?", ["c1", "c2"]), Q("D?", ["d1", "d2"]));

test("a short column keeps the focused question in sight: the farthest lines are dropped first until its header and first option fit", () => {
	for (const [room, goes, far] of [
		[112, 0, [false, true, true, true]], // nothing but the question fits
		[175, 0, [false, false, true, true]], // one neighbour line is kept
		[175, 3, [true, true, false, false]],
		[465, 1, [false, false, false, false]], // plenty of room: nothing is dropped
	] as [number, number, boolean[]][]) {
		const r = column(room, FOUR());
		r.blocks[(goes + 1) % 4]!.bubble("click", { detail: 1 });
		r.blocks[goes]!.bubble("click", { detail: 1 });
		assert.equal(r.open(), r.blocks[goes]);
		assert.deepEqual(r.far(), far, `room ${room}, question ${goes}`);
		assert.ok(r.open().clientHeight >= Math.min(96, room), `room ${room}: the focused question has at least its header and first option (${r.open().clientHeight})`);
		assert.equal(r.far()[goes], false);
	}
	const r = column(112, pending(Q("A?", ["a1", "a2"]), Q("B?", ["b1", "b2"])));
	r.scroller.scrollTop = 40; // a native focus scroll left the column offset
	r.blocks[1]!.bubble("click", { detail: 1 });
	assert.equal(r.scroller.scrollTop, 0, "a move puts the column back at its start");
	assert.deepEqual(r.far(), [true, false], "the only other question's line gives way when it would squeeze the focused one");
	r.blocks[0]!.bubble("click", { detail: 1 });
	assert.deepEqual(r.far(), [false, true], "and the line that was dropped comes back when the focus moves");
});

test("the stylesheet: the focused question may shrink to the column and scrolls inside, and a dropped line is not drawn", () => {
	const open = rule('[data-view="zen"] .zen-qs > .ask-one:not([data-dim])');
	assert.equal(decl(open!.body, "min-height"), "0", "no floor above the column's own");
	assert.equal(decl(rule('[data-view="zen"] .zen-qs > .ask-one[data-far]')!.body, "display"), "none");
});

test("a Ctrl+wheel (pinch or browser zoom) is the browser's: it moves no question and is not taken", () => {
	const r = rig();
	let taken = false;
	r.scroller.bubble("wheel", { deltaY: 100, ctrlKey: true, deltaMode: 0, timeStamp: 1000, preventDefault: () => (taken = true) });
	assert.equal(taken, false);
	assert.deepEqual(r.dim(), [false, true, true]);
});

test("a folded line is one line however many lines the own words have, and says what it is to a screen reader", () => {
	const r = rig();
	r.own(0).value = "only the lead\nand ops\n\tafter 9";
	r.own(0).bubble("input");
	r.blocks[1]!.bubble("click", { detail: 1 });
	const said = r.hold.all(cls("zen-sum-a"))[0]!.textContent;
	assert.equal(said, " · only the lead and ops after 9");
	const line = r.sum(0);
	assert.equal(line.getAttribute("aria-expanded"), "false");
	assert.match(line.getAttribute("aria-label") ?? "", /1.*3.*A/);
	assert.match(line.getAttribute("aria-label") ?? "", /only the lead and ops after 9/);
	assert.match(r.sum(2).getAttribute("aria-label") ?? "", /3.*3.*C/);
});

test("the stylesheet: a short window (max-height 560px) gives the questions the room: no unit sub-line or intro, smaller type, one-line send row", () => {
	const at = css.indexOf("@media (max-height: 560px)");
	assert.ok(at > 0, "the short-window block");
	const block = css.slice(at, css.indexOf("@media (prefers-reduced-motion", at));
	assert.match(block, /:is\(\.zen-meta, \.zen-said\) \{ display: none; \}/);
	assert.match(block, /\.zen-who \{ font-size: 1\.05rem/);
	assert.match(block, /:is\(\.ask-q, \.ask-title\) \{ font-size: 1\.1rem/);
	assert.match(block, /\.ask-acts \{ flex-wrap: nowrap/);
	assert.match(block, /button\.ask-opt \{ padding-block: 6px/);
});
