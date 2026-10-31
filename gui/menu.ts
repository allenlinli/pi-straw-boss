import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";

// A phone's `⋯` menu: a 44 px button that opens a panel of the controls the phone's layout keeps out of the way (Quit of a base or a squad, a tower's + Main and Quit tower, the boss
// conversation's Leave and New). The panel is a native popover, so Escape and a tap outside close it and the browser puts focus back on the button; it hangs under the button
// (above it when the screen ends first), in the top layer, so no card clips it. Above 640 px the button is `display: none` and the panel `display: contents`: the controls stay in the row
// they always had (style.css, "A phone's menus"), so nothing here changes the desktop layout. The controls inside keep their own `data-close` and handlers: Quit still asks first (quit.ts).

let serial = 0;
const ITEMS = "button:not([disabled]):not([hidden]), a[href]:not([hidden])";

/** The `⋯` button of the popover `panel` (given an id when it has none). `name` says what the menu is for, in the button's label. */
export function moreButton(panel: HTMLElement, name?: string): HTMLButtonElement {
	panel.id ||= `menu-${++serial}`;
	const label = name ? m.menu_more_for({ name }) : m.menu_more();
	return h("button", { type: "button", class: "pair-btn menu-btn", popovertarget: panel.id, "aria-haspopup": "true", "aria-label": label, title: label }, "⋯");
}
/** A `⋯` menu holding `items`: the button and its panel in one wrapper (`display: contents` above 640 px). */
function menu(items: HTMLElement[], name?: string, cls = ""): HTMLElement {
	const panel = h("div", { class: "menu-pop hud-pop", popover: "auto", role: "group", "aria-label": name ? m.menu_more_for({ name }) : m.menu_more() }, ...items);
	return h("span", { class: `menu ${cls}`.trim() }, moreButton(panel, name), panel);
}

/** Puts `button`, where it stands, behind a `⋯` menu of its own: the button keeps its place (and its row) above 640 px. */
export function menuAround(button: HTMLElement): HTMLElement {
	const slot = document.createComment("");
	button.replaceWith(slot);
	const wrapper = menu([button]);
	slot.replaceWith(wrapper);
	return wrapper;
}
/** Names a menu for what it belongs to, after the fact (a base's label changes): its button and its panel. */
export function nameMenu(root: HTMLElement, name: string) {
	const label = m.menu_more_for({ name });
	for (const el of [root.querySelector(".menu-btn"), root.querySelector(".menu-pop")]) if (el && el.getAttribute("aria-label") !== label) el.setAttribute("aria-label", label);
	root.querySelector(".menu-btn")?.setAttribute("title", label);
}

/** Hangs `pop` under `button`, its right edge on the button's, inside the window; above the button when there is no room below. */
export function place(pop: HTMLElement, button: HTMLElement, win = { width: innerWidth, height: innerHeight }) {
	const at = button.getBoundingClientRect(), width = pop.offsetWidth, height = pop.offsetHeight;
	const below = at.bottom + 8 + height <= win.height - 8 || at.top - 8 - height < 8;
	pop.style.top = `${Math.max(8, below ? at.bottom + 8 : at.top - 8 - height)}px`;
	pop.style.left = `${Math.max(8, Math.min(at.right - width, win.width - width - 8))}px`;
}
/** The item the arrow keys land on: the next or previous of `items` from `from`, wrapping; Home and End go to the ends. Undefined for any other key. */
export function step<T>(items: T[], from: number, key: string): T | undefined {
	if (!items.length) return undefined;
	if (key === "Home") return items[0];
	if (key === "End") return items.at(-1);
	if (key === "ArrowDown") return items[(from + 1) % items.length];
	if (key === "ArrowUp") return items[(from < 0 ? 0 : from - 1 + items.length) % items.length];
	return undefined;
}

const pops = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".menu-pop") : null);
const invoker = (pop: HTMLElement) => document.querySelector<HTMLElement>(`[popovertarget="${CSS.escape(pop.id)}"]`);

/** One listener set for every menu on the page (the panels come and go with the views): placement and first focus on open, arrow keys inside, Escape, and a tap on an item. */
export function mountMenus() {
	document.addEventListener("toggle", (event) => {
		const pop = pops(event.target);
		if (!pop || (event as ToggleEvent).newState !== "open") return;
		const button = invoker(pop);
		if (button) place(pop, button);
		pop.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true }); // a keyboard or a switch lands in the panel; Tab would otherwise have to find it
	}, true);
	document.addEventListener("keydown", (event) => {
		const pop = pops(event.target);
		if (!pop) return;
		if (event.key === "Escape") {
			if (pop.matches(":popover-open")) (event.preventDefault(), pop.hidePopover(), invoker(pop)?.focus());
			return;
		}
		const list = [...pop.querySelectorAll<HTMLElement>(ITEMS)], next = step(list, list.indexOf(document.activeElement as HTMLElement), event.key);
		if (next) (event.preventDefault(), next.focus());
	});
	// An item that acts closes the menu (a Quit opens its own dialog); one that opens another popover (Stashed) or says it keeps the menu (`data-menu-keep`: a result shows inside) leaves it open.
	document.addEventListener("click", (event) => {
		const pop = pops(event.target), item = event.target instanceof Element ? event.target.closest<HTMLElement>("button, a") : null;
		if (!pop || !item || !pop.contains(item) || item.hasAttribute("popovertarget") || item.hasAttribute("data-menu-keep")) return;
		if (pop.matches(":popover-open")) pop.hidePopover();
	});
}
