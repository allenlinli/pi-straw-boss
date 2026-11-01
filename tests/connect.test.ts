import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { connectOf, mountConnect } from "../gui/connect.ts";
import { m } from "../gui/paraglide/messages.js";
import { createStream, type Source, type Status } from "../gui/stream.ts";

// gui/connect.ts: while the page has no live state (before the stream's first snapshot, and while it reconnects), a modal overlay covers the page, the app root is inert,
// and no click or key reaches the page's handlers. The DOM is a fake: a window that runs capture listeners before bubble ones and honours stopPropagation, a modal dialog,
// and two guarded roots; the real browser is measured in the demo build.

type Listener = (event: FakeEvent) => void;
interface FakeEvent { type: string; target: unknown; stopped: boolean; defaultPrevented: boolean; stopPropagation(): void; preventDefault(): void }
class Target {
	listeners: { type: string; fn: Listener; capture: boolean }[] = [];
	addEventListener(type: string, fn: Listener, capture?: boolean | { capture?: boolean }) {
		this.listeners.push({ type, fn, capture: capture === true || (typeof capture === "object" && capture.capture === true) });
	}
	run(event: FakeEvent, capture: boolean) {
		for (const l of [...this.listeners]) if (l.type === event.type && l.capture === capture) l.fn(event);
	}
}
class Part extends Target {
	hidden = false;
	inert = false;
	textContent = "";
	dataset: Record<string, string> = {};
	parent: Part | undefined;
	contains = (other: unknown): boolean => other === this || (other instanceof Part && other.parent !== undefined && this.contains(other.parent));
}
class Dialog extends Part {
	open = false;
	modal = false;
	opened = 0;
	showModal() {
		assert.equal(this.modal, false, "showModal on a dialog that is already modal throws");
		this.open = this.modal = true;
		this.opened++;
	}
	close() {
		this.open = this.modal = false;
		this.fire("close");
	}
	fire(type: string) {
		const event = { type, target: this, stopped: false, defaultPrevented: false, stopPropagation() {}, preventDefault() { this.defaultPrevented = true; } };
		this.run(event, false);
		return event;
	}
}

/** The page: the overlay in `window`, an app element, and the handlers main.ts keeps on the window. */
function page(preopen = true) {
	const win = new Target(), dialog = new Dialog(), text = new Part(), retry = new Part(), shell = new Part(), dock = new Part(), app = new Part(), reached: string[] = [];
	[text.parent, retry.parent, app.parent] = [dialog, dialog, shell];
	dialog.open = preopen; // index.html ships it open (not yet modal) so that nothing can be tapped before the script runs
	let retries = 0;
	const status = mountConnect(() => retries++, { win, dialog, text, retry, guarded: [shell, dock], doc: {} } as never);
	for (const type of ["click", "keydown", "pointerdown", "touchstart"]) win.addEventListener(type, () => reached.push(type));
	/** One event from `target`: the window's capture phase, the target's own handlers, the overlay's bubble phase when inside it, then the window's bubble phase. */
	const fire = (type: string, target: Part) => {
		const event: FakeEvent = { type, target, stopped: false, defaultPrevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
		win.run(event, true);
		if (event.stopped) return event;
		if (target === retry) target.run(event, false);
		if (target.contains(event.target) && dialog.contains(target)) dialog.run(event, false);
		if (!event.stopped) win.run(event, false);
		return event;
	};
	return { win, dialog, text, retry, shell, dock, app, reached, status, fire, retries: () => retries };
}
const of = (state: Status["state"], attempt = 0): Status => ({ state, attempt });

test("before the first state the overlay is modal over an inert page, with the connecting line", () => {
	const p = page();
	assert.equal(connectOf(of("connecting")), "connecting");
	p.status(of("connecting"));
	assert.deepEqual([p.dialog.modal, p.shell.inert, p.dock.inert], [true, true, true]);
	assert.equal(p.text.textContent, m.connect_connecting());
	assert.equal(p.dialog.dataset.state, "connecting");
	assert.equal(p.retry.hidden, true, "nothing to retry while it is still trying");
});

test("the first state takes the overlay away and gives the page back", () => {
	const p = page();
	p.status(of("connecting"));
	p.status(of("live"));
	assert.equal(connectOf(of("live")), undefined);
	assert.deepEqual([p.dialog.open, p.shell.inert, p.dock.inert], [false, false, false]);
});

test("a stream that drops brings the overlay back with the reconnecting line until its next state", () => {
	const sources: { error(): void; send(): void }[] = [];
	const p = page();
	const stream = createStream({
		open: () => {
			let fail = () => {}, message = (_: string) => {};
			sources.push({ error: () => fail(), send: () => message(JSON.stringify({ bases: [] })) });
			return { onError: (h) => (fail = h), listen: (type, h) => type === "message" && (message = h), close() {} } satisfies Source;
		},
		now: () => 1,
		setTimeout: () => 0,
		clearTimeout() {},
		random: () => 0.5,
		hidden: () => false,
		onNet() {},
		onStatus: p.status,
	});
	stream.start();
	assert.equal(p.dialog.modal, true, "up from the first attempt");
	sources[0]!.send();
	assert.deepEqual([p.dialog.open, p.shell.inert], [false, false], "the first snapshot opens the page");
	sources[0]!.error();
	assert.deepEqual([p.dialog.modal, p.shell.inert, p.dock.inert, p.dialog.dataset.state], [true, true, true, "reconnecting"]);
	assert.equal(p.text.textContent, m.connect_reconnecting());
	stream.restart();
	assert.equal(p.dialog.modal, true, "still up while the retry has not answered");
	sources[1]!.send();
	assert.deepEqual([p.dialog.open, p.shell.inert, p.dock.inert], [false, false, false]);
	stream.stop();
});

test("while the overlay is up no click, touch, or key reaches the page's handlers, and they do again once it is gone", () => {
	const p = page();
	p.status(of("connecting"));
	for (const type of ["click", "pointerdown", "touchstart", "keydown"]) {
		p.fire(type, p.app);
		p.fire(type, p.dialog);
		p.fire(type, p.text);
	}
	assert.deepEqual(p.reached, [], "taps on the page, on the overlay, and keys from anywhere are all stopped");
	assert.equal(p.fire("click", p.app).defaultPrevented, true, "a link that was clicked does not navigate either");
	assert.equal(p.fire("keydown", p.app).defaultPrevented, false, "but a key keeps its default, so Tab still moves inside the overlay");
	p.status(of("live"));
	p.fire("click", p.app);
	p.fire("keydown", p.app);
	assert.deepEqual(p.reached, ["click", "keydown"]);
	p.status(of("reconnecting", 1));
	p.fire("click", p.app);
	assert.deepEqual(p.reached, ["click", "keydown"], "and stopped again on a drop");
});

test("Escape cannot dismiss it: the cancel is refused and a close puts it back", () => {
	const p = page();
	p.status(of("reconnecting", 1));
	assert.equal(p.dialog.fire("cancel").defaultPrevented, true);
	p.dialog.open = p.dialog.modal = false; // the browser closed it anyway (a second Escape)
	p.dialog.fire("close");
	assert.deepEqual([p.dialog.open, p.dialog.modal], [true, true]);
	p.status(of("live"));
	p.dialog.fire("close");
	assert.equal(p.dialog.open, false, "once the page is live a close stays closed");
});

test("a stream that gave up shows its error and a Try again that reaches only its own handler", () => {
	const p = page();
	p.status(of("offline", 9));
	assert.equal(p.dialog.modal, true);
	assert.equal(p.text.textContent, m.banner_offline({ tries: 8 }));
	assert.equal(p.retry.hidden, false);
	assert.equal(p.dialog.dataset.state, "offline");
	p.retry.addEventListener("click", () => {});
	// main.ts hands mountConnect its retry; the button's own click calls it.
	p.retry.run({ type: "click" } as never, false);
	assert.equal(p.retries(), 1);
	p.fire("click", p.retry);
	assert.deepEqual(p.reached, [], "the click stops at the overlay");
	p.status(of("reconnecting", 0));
	assert.deepEqual([p.retry.hidden, p.text.textContent], [true, m.connect_reconnecting()], "pressing it starts the next attempt, which the overlay shows");
});

test("an address the server refuses shows why, with no retry that could work", () => {
	const p = page();
	p.status(of("replaced", 1));
	assert.equal(p.text.textContent, m.banner_replaced());
	assert.equal(p.retry.hidden, true);
	assert.equal(p.dialog.modal, true);
});

test("a page whose script never ran is already blocked: index.html ships the overlay open and the app root inert", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	assert.match(html, /<dialog\b[^>]*\bclass="connect"[^>]*\bid="connect"[^>]*\bopen\b/);
	assert.match(html, /<div class="shell"[^>]*\binert\b/);
	assert.match(html, /<div class="dock" id="dock"[^>]*\binert\b/);
	assert.ok(html.indexOf('id="connect"') < html.indexOf('src="./main.ts"'));
});

test("the overlay's ring rests with calm and in Geek, the page has a still sign without motion, and the overlay covers the page", () => {
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	assert.match(css, /:is\(\[data-calm\], \[data-view="geek"\]\) :is\([^)]*\.connect-ring/);
	assert.match(css, /\.connect-ring \{[^}]*animation: spin [\d.]+s linear infinite/);
	assert.match(css, /\.connect-ring \{[^}]*border-top-color: var\(--accent\)/, "a ring with a bright arc is a sign that reads without motion");
	assert.match(css, /\.connect\[open\] \{[^}]*position: fixed[^}]*inset: 0|\.connect \{[^}]*position: fixed[^}]*inset: 0/);
});
