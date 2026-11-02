import assert from "node:assert/strict";
import { after, test } from "node:test";

// The terminal tile's keyboard (gui/mirror.ts with the pad of gui/keypad.ts) on a phone and a desktop: the Keyboard button focuses the hidden text
// box, text from a soft keyboard (input events, a finished composition, Backspace and Enter as beforeinput) goes to the keys route, and the tile
// closing lets the keyboard go.

type Listener = (e: any) => void;
class El {
	tag: string;
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	listeners = new Map<string, Listener[]>();
	classes = new Set<string>();
	classList = { add: (...c: string[]) => c.forEach((x) => this.classes.add(x)), remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)), contains: (c: string) => this.classes.has(c), toggle: (c: string, force?: boolean) => ((force ?? !this.classes.has(c)) ? !!this.classes.add(c) : !this.classes.delete(c)) };
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	hidden = false;
	disabled = false;
	value = "";
	caret = -1;
	setSelectionRange(a: number) {
		this.caret = a;
	}
	title = "";
	onclick: ((e: { isTrusted: boolean }) => void) | null = null;
	constructor(tag: string) {
		this.tag = tag;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "class") this.classes = new Set(value.split(" "));
		if (name === "hidden") this.hidden = true;
		if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	remove() {}
	get children(): El[] {
		return this.kids.filter((k): k is El => k instanceof El);
	}
	get lastElementChild(): El | null {
		return this.children.at(-1) ?? null;
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(v: string) {
		this.kids = [v];
	}
	all(): El[] {
		return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : []));
	}
	addEventListener(type: string, run: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), run]);
	}
	/** Runs the handlers; the event's preventDefault is recorded on it. */
	fire(type: string, init: Record<string, unknown> = {}) {
		const e = { type, defaultPrevented: false, isComposing: false, preventDefault() { e.defaultPrevented = true; }, ...init };
		for (const run of this.listeners.get(type) ?? []) run(e);
		return e;
	}
	focus() {
		const was = focused;
		if (was === this) return;
		focused = this;
		was?.fire("blur");
		this.fire("focus");
	}
	blur() {
		if (focused !== this) return;
		focused = undefined;
		this.fire("blur");
	}
	getBoundingClientRect() {
		return { left: 0, bottom: 300 };
	}
}
let focused: El | undefined;
const fine = { on: false };
Object.assign(globalThis, {
	document: { createElement: (tag: string) => new El(tag), addEventListener() {}, hidden: false, get activeElement() { return focused; } },
	matchMedia: () => ({ matches: fine.on }),
	ResizeObserver: class { observe() {} disconnect() {} },
	requestAnimationFrame: (run: () => void) => run(),
	getSelection: () => ({ isCollapsed: true }),
	innerHeight: 800,
});
const { mountTerminals } = await import("../gui/mirror.ts");
const { keypad } = await import("../gui/keypad.ts");
const { m } = await import("../gui/paraglide/messages.js");

const closers: (() => void)[] = []; // an open tile keeps a timer, so every tile is closed when the file ends
after(() => closers.forEach((off) => off()));
const gap = () => new Promise((r) => setTimeout(r, 160));
function world(state: "live" | "hidden" | "off" = "live", answer: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: {} }) {
	const sent: Record<string, unknown>[] = [], mirrors: unknown[] = [];
	const post = () => async (action: string, body: Record<string, unknown>) => (action === "keys" ? sent.push(body) : mirrors.push(body), action === "keys" ? answer : { ok: true, status: 200, body: {} });
	const t = mountTerminals({ tiles: { open() {} }, post: post as never, stream: () => JSON.stringify({ stream: "st" }), pad: (x) => keypad({ ...x, state: () => state }) });
	const host = new El("div");
	const off = t.embed("k", "billing", host as never);
	closers.push(off);
	const tile = host.kids[0] as El;
	const find = (cls: string) => tile.all().find((x) => x.classes.has(cls))!;
	return { sent, off, tile, find, sink: find("term-sink"), kb: find("term-kb"), scroll: find("term-scroll"), terminal: t };
}

test("the tile has a Keyboard button (zh-TW 鍵盤) and a hidden text box a soft keyboard can open on", () => {
	fine.on = false;
	const { kb, sink } = world();
	assert.equal(kb.textContent, m.keyboard());
	assert.equal(kb.getAttribute("type"), "button");
	assert.equal(sink.getAttribute("inputmode"), "text");
	for (const a of ["autocapitalize", "autocorrect", "autocomplete"]) assert.equal(sink.getAttribute(a), "off", a);
	assert.equal(sink.getAttribute("spellcheck"), "false");
});

test("the Keyboard button focuses the text box on a phone (no fine pointer), and a second tap, or the tile closing, lets it go", () => {
	fine.on = false;
	const { kb, sink, off } = world();
	assert.equal(focused, undefined, "nothing takes the keyboard by itself on a phone");
	kb.fire("mousedown").defaultPrevented || assert.fail("the button must not take the focus from the text box");
	kb.fire("click");
	assert.equal(focused, sink);
	assert.equal(kb.getAttribute("aria-pressed"), "true");
	kb.fire("click");
	assert.equal(focused, undefined, "tapping again closes it");
	assert.equal(kb.getAttribute("aria-pressed"), "false");
	kb.fire("click");
	assert.equal(focused, sink);
	off();
	assert.equal(focused, undefined, "switching away from the terminal closes it");
});

test("a phone's click into the mirror does not claim the keyboard; a desktop's does, and its physical keys go to the pane", async () => {
	fine.on = false;
	let w = world();
	w.scroll.fire("click");
	assert.equal(focused, undefined);
	fine.on = true;
	w = world();
	w.scroll.fire("click");
	assert.equal(focused, w.sink);
	const down = w.sink.fire("keydown", { key: "ArrowUp", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
	assert.ok(down.defaultPrevented);
	w.sink.value = "a";
	w.sink.fire("input", {});
	await gap();
	assert.deepEqual(w.sent, [{ key: "up", stream: "st" }, { text: "a", stream: "st" }]);
	fine.on = false;
});

test("text from a soft keyboard goes to the keys route as text, and the text box is empty again", async () => {
	fine.on = false;
	const { sink, kb, sent } = world();
	kb.fire("click");
	sink.value = "ls";
	sink.fire("input", { inputType: "insertText" });
	assert.equal(sink.value, "\u200b", "only the sentinel stays");
	await gap();
	assert.deepEqual(sent, [{ text: "ls", stream: "st" }]);
});

test("a composition (an input method) goes as one write of the composed text, when it ends", async () => {
	fine.on = false;
	const { sink, kb, sent } = world();
	kb.fire("click");
	for (const part of ["ㄋ", "你", "你好"]) (sink.value = part, sink.fire("input", { isComposing: true }));
	await gap();
	assert.deepEqual(sent, [], "nothing while composing");
	sink.fire("compositionend", { data: "你好" });
	await gap();
	assert.deepEqual(sent, [{ text: "你好", stream: "st" }]);
	sink.fire("input", { isComposing: false });
	await gap();
	assert.equal(sent.length, 1, "the input that follows the end finds the box empty");
});

test("Backspace and Enter from a soft keyboard (a beforeinput; its keydown has no key) send the pad's keys, once", async () => {
	fine.on = false;
	const { sink, kb, sent } = world();
	kb.fire("click");
	sink.fire("keydown", { key: "Unidentified", keyCode: 229, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
	const back = sink.fire("beforeinput", { inputType: "deleteContentBackward" });
	assert.ok(back.defaultPrevented);
	await gap();
	sink.fire("beforeinput", { inputType: "insertLineBreak" });
	await gap();
	sink.fire("beforeinput", { inputType: "deleteContentBackward", isComposing: true });
	sink.fire("beforeinput", { inputType: "insertText" });
	await gap();
	assert.deepEqual(sent, [{ key: "backspace", stream: "st" }, { key: "enter", stream: "st" }]);
	sent.length = 0;
	const real = sink.fire("keydown", { key: "Backspace", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
	assert.ok(real.defaultPrevented, "a real Backspace keydown is the pane's, and the browser then sends no beforeinput for it");
	await gap();
	assert.deepEqual(sent, [{ key: "backspace", stream: "st" }]);
});

test("an open box keeps a sentinel, so Backspace on an empty box is a deletion that sends one backspace, and the sentinel is never typed", async () => {
	fine.on = false;
	const { sink, kb, sent } = world();
	kb.fire("click");
	assert.equal(sink.value, "\u200b");
	assert.equal(sink.caret, 1);
	sink.fire("beforeinput", { inputType: "deleteContentBackward" });
	await gap();
	assert.deepEqual(sent, [{ key: "backspace", stream: "st" }]);
	assert.equal(sink.value, "\u200b");
	sink.value = "\u200bhi\u200b";
	sink.fire("input", { inputType: "insertText" });
	await gap();
	assert.deepEqual(sent.at(-1), { text: "hi", stream: "st" });
	sink.value = "\u200b";
	sink.fire("input", { inputType: "insertText" });
	await gap();
	assert.equal(sent.length, 2, "an empty box sends no text");
	sink.value = "\u200bq";
	sink.fire("beforeinput", { inputType: "deleteContentBackward" });
	assert.equal(sent.length, 2, "a box with typed text deletes it itself");
	kb.fire("click");
	assert.equal(sink.value, "");
});

test("the keyboard has the pad's refusals: a standing or read-only unit's 409 shows in the pad, and nothing is sent while the mirror is off", async () => {
	fine.on = false;
	const w = world("live", { ok: false, status: 409, body: { error: "standing", reason: "This unit is standing by." } });
	w.kb.fire("click");
	w.sink.value = "x";
	w.sink.fire("input", {});
	await gap();
	assert.equal(w.sent.length, 1);
	assert.match(w.tile.all().find((x) => x.classes.has("pad-note"))!.textContent, /standing by/);
	const off = world("off");
	off.kb.fire("click");
	off.sink.value = "x";
	off.sink.fire("input", {});
	off.sink.fire("beforeinput", { inputType: "deleteContentBackward" });
	await gap();
	assert.deepEqual(off.sent, []);
});

test("embed with `keys` gives the sink the keyboard on a desktop only, and `end` runs when the terminal's mirror ends, never after it is taken away", () => {
	fine.on = true;
	focused = undefined;
	const kept = world();
	assert.equal(focused, undefined, "embed alone leaves the focus to its caller (the session view)");
	const post = () => async () => ({ ok: true, status: 200, body: {} });
	const t = mountTerminals({ tiles: { open() {} }, post: post as never, stream: () => JSON.stringify({ stream: "st" }), pad: (x) => keypad({ ...x, state: () => "live" }) });
	const ends: string[] = [], host = new El("div");
	const off = t.embed("p", "pane", host as never, { keys: true, end: () => ends.push("p") });
	closers.push(off);
	assert.equal(focused, (host.kids[0] as El).all().find((x) => x.classes.has("term-sink")), "a desktop: the keyboard goes to the pane");
	t.frame(JSON.stringify({ key: "p", seq: 1, rows: 1, cols: 10, whole: true, set: [[0, "hi"]] }));
	assert.deepEqual(ends, [], "a frame is no end");
	t.frame(JSON.stringify({ key: "p", ended: "The pane closed." }));
	assert.deepEqual(ends, ["p"]);
	off();
	t.frame(JSON.stringify({ key: "p", ended: "The pane closed." }));
	assert.deepEqual(ends, ["p"], "a terminal taken away hears nothing");
	fine.on = false;
	focused = undefined;
	closers.push(t.embed("q", "pane", new El("div") as never, { keys: true }));
	assert.equal(focused, undefined, "a phone opens its soft keyboard with the Keyboard button");
	kept.off();
});

test("ZT-F003: a pane whose attach the server refuses (the grant is gone) ends like an ended frame; a network failure does not", async () => {
	fine.on = false;
	for (const [res, ends] of [[{ ok: false, status: 404, body: { error: "not_found", reason: "That pane is not open here any more." } }, 1], [{ ok: false, status: 409, body: { error: "pane_closed" } }, 1], [{ ok: false, status: 429, body: {} }, 0], [undefined, 0]] as const) {
		const calls: string[] = [], post = () => async (action: string) => (action === "mirror" && !res ? Promise.reject(new Error("down")) : action === "mirror" ? res : { ok: true, status: 200, body: {} });
		const t = mountTerminals({ tiles: { open() {} }, post: post as never, stream: () => JSON.stringify({ stream: "st" }), pad: (x) => keypad({ ...x, state: () => "live" }) });
		closers.push(t.embed("g", "pane", new El("div") as never, { end: () => calls.push("end") }));
		t.hello();
		await gap();
		assert.equal(calls.length > 0, ends > 0, JSON.stringify(res)); // the tile attaches when it opens and again on hello
	}
});

test("ZT-F002: Shift+Esc in the sink lets the keyboard go (nothing is sent to the pane), where plain Esc goes to the pane; the sink says whether its pad is live", async () => {
	fine.on = true;
	const w = world();
	w.sink.focus();
	const esc = w.sink.fire("keydown", { key: "Escape", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false });
	assert.ok(esc.defaultPrevented);
	assert.ok(focused !== w.sink, "the sink let go");
	assert.ok(focused === w.scroll, "the focus stays in the terminal's body, where Tab moves on");
	await gap();
	assert.deepEqual(w.sent, [], "no Esc reached the pane");
	w.sink.focus();
	w.sink.fire("keydown", { key: "Escape", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
	await gap();
	assert.deepEqual(w.sent, [{ key: "esc", stream: "st" }], "a plain Esc is the pane's");
	assert.equal(w.sink.dataset.pad, "off", "no frame yet: nothing to take keys");
	w.terminal.frame(JSON.stringify({ key: "k", seq: 1, rows: 1, cols: 10, whole: true, set: [[0, "hi"]] }));
	assert.equal(w.sink.dataset.pad, "live");
	w.terminal.frame(JSON.stringify({ key: "k", ended: "The pane closed." }));
	assert.equal(w.sink.dataset.pad, "off", "an ended mirror takes no key");
	fine.on = false;
});

test("the pad tells its owner when the server took its Enter (a 200), and not when the Enter was going, asked to confirm, or refused", async () => {
	fine.on = false;
	for (const [answer, seen] of [[{ ok: true, status: 200, body: {} }, [true]], [{ ok: false, status: 409, body: { error: "confirm", confirm: "tok", reason: "r" } }, []], [{ ok: false, status: 409, body: { error: "no_mirror", reason: "r" } }, []]] as const) {
		const heard: true[] = [], post = () => async () => answer;
		const t = mountTerminals({ tiles: { open() {} }, post: post as never, stream: () => JSON.stringify({ stream: "st" }), pad: (x) => keypad({ ...x, state: () => "live" }) });
		const host = new El("div");
		closers.push(t.embed("k", "billing", host as never, { taken: () => heard.push(true) }));
		const sink = (host.kids[0] as El).all().find((x) => x.classes.has("term-sink"))!;
		sink.fire("keydown", { key: "ArrowUp", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
		await gap();
		assert.deepEqual(heard, [], "other keys are no Enter");
		sink.fire("keydown", { key: "Enter", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
		await gap();
		assert.deepEqual(heard, seen);
	}
});
