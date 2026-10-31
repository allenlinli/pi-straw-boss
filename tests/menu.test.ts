import assert from "node:assert/strict";
import { test } from "node:test";

// A phone's `⋯` menu (gui/menu.ts): a 44 px button that opens a popover with the controls the phone layout keeps out of the row. No browser runs here, so a small fake DOM stands in for the few
// calls the module makes; the live behaviour (a tap, Escape, the focus that returns, the Quit dialog) was measured on the demo page at 390 × 844 and is in the change's report.

type Listener = (event: FakeEvent) => void;
interface FakeEvent { type: string; target: unknown; key?: string; newState?: string; defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }
const event = (type: string, target: unknown, extra: Partial<FakeEvent> = {}): FakeEvent => ({ type, target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });

class FakeElement {
	tag: string;
	attrs = new Map<string, string>();
	kids: FakeElement[] = [];
	classes = new Set<string>();
	parent: FakeElement | undefined;
	open = false;
	hidden = false;
	style: Record<string, string> = {};
	offsetWidth = 200;
	offsetHeight = 100;
	rect = { top: 40, bottom: 84, left: 300, right: 344 };
	constructor(tag: string, cls = "") {
		this.tag = tag;
		for (const c of cls.split(" ").filter(Boolean)) this.classes.add(c);
	}
	append(...kids: (FakeElement | string)[]) {
		for (const k of kids) if (typeof k !== "string") (this.kids.push(k), (k.parent = this));
	}
	setAttribute(name: string, value: string) { this.attrs.set(name, value); }
	getAttribute(name: string) { return this.attrs.get(name) ?? null; }
	hasAttribute(name: string) { return this.attrs.has(name); }
	get id() { return this.attrs.get("id") ?? ""; }
	set id(value: string) { this.attrs.set("id", value); }
	getBoundingClientRect() { return { ...this.rect, width: this.rect.right - this.rect.left, height: this.rect.bottom - this.rect.top }; }
	matches(selector: string) { return selector === ":popover-open" ? this.open : false; }
	hidePopover() { this.open = false; }
	focus() { document.activeElement = this; }
	contains(el: unknown): boolean { return el === this || this.kids.some((k) => k.contains(el)); }
	closest(selector: string): FakeElement | null {
		const ok = (el: FakeElement) => selector.split(",").some((s) => (s.trim().startsWith(".") ? el.classes.has(s.trim().slice(1)) : el.tag === s.trim()));
		for (let el: FakeElement | undefined = this; el; el = el.parent) if (ok(el)) return el;
		return null;
	}
	all(): FakeElement[] { return [this, ...this.kids.flatMap((k) => k.all())]; }
	querySelectorAll(selector: string) {
		// The module asks for the controls inside a panel: a button or a link that is not disabled and not hidden.
		return this.all().filter((el) => el !== this && (el.tag === "button" || el.tag === "a") && !el.hidden && !el.attrs.has("disabled"));
	}
	querySelector(selector: string) {
		return selector.startsWith(".") ? (this.all().find((el) => el.classes.has(selector.slice(1))) ?? null) : (this.querySelectorAll(selector)[0] ?? null);
	}
}
const listeners = new Map<string, { run: Listener; capture: boolean }[]>();
const document = {
	activeElement: null as FakeElement | null,
	invokers: [] as FakeElement[],
	addEventListener(type: string, run: Listener, capture = false) { listeners.set(type, [...(listeners.get(type) ?? []), { run, capture }]); },
	querySelector(selector: string) { const id = /popovertarget="([^"]+)"/.exec(selector)?.[1]; return this.invokers.find((b) => b.attrs.get("popovertarget") === id) ?? null; },
};
Object.assign(globalThis, { document, Element: FakeElement, CSS: { escape: (s: string) => s }, innerWidth: 390, innerHeight: 844 });
const fire = (type: string, target: FakeElement, extra: Partial<FakeEvent> = {}) => { const e = event(type, target, extra); for (const l of listeners.get(type) ?? []) l.run(e); return e; };

const { mountMenus, place, step } = await import("../gui/menu.ts");

/** A `⋯` button and its panel, the way menu.ts builds them: the button names the panel by id, the panel holds the controls. */
function menuOf(items: string[]) {
	const root = new FakeElement("span", "menu"), button = new FakeElement("button", "pair-btn menu-btn"), panel = new FakeElement("div", "menu-pop hud-pop");
	panel.id = "menu-1";
	button.setAttribute("popovertarget", panel.id);
	const controls = items.map((cls) => new FakeElement("button", cls));
	panel.append(...controls);
	root.append(button, panel);
	document.invokers = [button];
	return { root, button, panel, controls };
}

mountMenus();

test("the arrow keys walk the panel's controls and wrap; Home and End go to the ends; any other key is left alone", () => {
	const list = ["a", "b", "c"];
	assert.equal(step(list, 0, "ArrowDown"), "b");
	assert.equal(step(list, 2, "ArrowDown"), "a", "wraps at the end");
	assert.equal(step(list, 0, "ArrowUp"), "c", "wraps at the start");
	assert.equal(step(list, 2, "ArrowUp"), "b");
	assert.equal(step(list, -1, "ArrowDown"), "a", "from no focus the first");
	assert.equal(step(list, -1, "ArrowUp"), "a");
	assert.equal(step(list, 1, "Home"), "a");
	assert.equal(step(list, 1, "End"), "c");
	for (const key of ["Tab", "Enter", "a", "Escape"]) assert.equal(step(list, 1, key), undefined, key);
	assert.equal(step([], 0, "ArrowDown"), undefined);
});

test("the panel hangs under its button with its right edge on the button's, inside the window; above the button when the screen ends first", () => {
	const { button, panel } = menuOf(["quit-btn"]);
	place(panel as never, button as never, { width: 390, height: 844 });
	assert.deepEqual([panel.style.top, panel.style.left], ["92px", "144px"], "8 px under the button, right edges aligned (344 - 200)");
	button.rect = { top: 20, bottom: 64, left: 0, right: 44 };
	place(panel as never, button as never, { width: 390, height: 844 });
	assert.equal(panel.style.left, "8px", "kept off the left edge");
	button.rect = { top: 760, bottom: 804, left: 300, right: 344 };
	place(panel as never, button as never, { width: 390, height: 844 });
	assert.equal(panel.style.top, "652px", "no room below: above the button (760 - 8 - 100)");
});

test("opening a panel places it and puts the focus on its first control, so a keyboard or a switch is already inside", () => {
	const { panel, controls } = menuOf(["quit-btn", "pair-btn"]);
	panel.open = true;
	fire("toggle", panel, { newState: "open" });
	assert.equal(document.activeElement, controls[0]);
	assert.equal(panel.style.top, "92px");
	document.activeElement = null;
	fire("toggle", panel, { newState: "closed" });
	assert.equal(document.activeElement, null, "closing moves nothing");
});

test("ArrowDown and ArrowUp move the focus between the controls; Escape closes the panel and returns the focus to the ⋯ button", () => {
	const { button, panel, controls } = menuOf(["pair-btn head-main", "quit-btn head-quit"]);
	panel.open = true;
	fire("toggle", panel, { newState: "open" });
	let e = fire("keydown", controls[0]!, { key: "ArrowDown" });
	assert.equal(document.activeElement, controls[1]);
	assert.ok(e.defaultPrevented, "the page does not scroll under it");
	fire("keydown", controls[1]!, { key: "ArrowDown" });
	assert.equal(document.activeElement, controls[0], "wraps");
	fire("keydown", controls[0]!, { key: "End" });
	assert.equal(document.activeElement, controls[1]);
	e = fire("keydown", controls[1]!, { key: "Escape" });
	assert.equal(panel.open, false);
	assert.equal(document.activeElement, button);
	assert.ok(e.defaultPrevented);
	fire("keydown", button, { key: "ArrowDown" });
	assert.equal(document.activeElement, button, "a key outside a panel is not the menu's");
});

test("a hidden control is skipped by the arrows (a tower's + Main is hidden for a unit with no base)", () => {
	const { panel, controls } = menuOf(["pair-btn head-main", "quit-btn head-quit"]);
	controls[0]!.hidden = true;
	panel.open = true;
	fire("toggle", panel, { newState: "open" });
	assert.equal(document.activeElement, controls[1], "the first shown control gets the focus");
	fire("keydown", controls[1]!, { key: "ArrowDown" });
	assert.equal(document.activeElement, controls[1], "the only one shown");
});

test("a tap on a control closes the menu and leaves the click alone, so Quit still reaches its own confirmation (quit.ts listens on the document, apart from the menu)", () => {
	const { panel, controls } = menuOf(["quit-btn"]);
	controls[0]!.setAttribute("data-close", "base");
	panel.open = true;
	const e = fire("click", controls[0]!);
	assert.equal(panel.open, false);
	assert.equal(e.defaultPrevented || e.stopped, false, "the menu neither cancels nor swallows the click");
	assert.equal(controls[0]!.getAttribute("data-close"), "base", "and the button is the same one, with its same data");
});

test("a control that opens another popover (Stashed) or keeps the menu for its result (Leave, New) leaves the menu open", () => {
	const { panel, controls } = menuOf(["pair-btn", "pair-btn"]);
	controls[0]!.setAttribute("popovertarget", "stashed-pop");
	controls[1]!.setAttribute("data-menu-keep", "");
	panel.open = true;
	fire("click", controls[0]!);
	assert.equal(panel.open, true);
	fire("click", controls[1]!);
	assert.equal(panel.open, true);
});
