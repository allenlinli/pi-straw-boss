import { h } from "./dom.ts";
import { m } from "./sentences.ts";

// The command palette, shared by the views (Zen shows it first; Standard and Geek can mount it the same way): a box, a filtered list, and the keys of a combobox. It knows no page action: the caller gives
// `entries` (read at each opening and after an entry that keeps it open, so labels and hints are current) and what to make inert behind it. Its box is a text box, so the page's own keys stay out of it (hotkeys.ts).
/** One thing the palette can do. `hint`: its state, beside the label. `keep`: the palette stays open after it runs (a switch, a volume step). */
export interface Entry { id: string; label: string; hint?: string; keep?: boolean; run(): void }
export interface PaletteDeps { entries(): Entry[]; /** The page behind the palette is inert while it is open. */ inert?(on: boolean): void; /** Called after the palette closed and the focus went back: the page may have something else for the focus now (an item that arrived meanwhile). */ closed?(): void }

/** The entries whose label has every word of the query (any case, any order). */
export function filterEntries(all: Entry[], query: string): Entry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return all.filter((e) => words.every((w) => e.label.toLowerCase().includes(w)));
}

export function mountPalette(deps: PaletteDeps) {
	const box = h("input", { type: "text", class: "palette-box", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "palette-list", "aria-label": m.pal_label(), placeholder: m.pal_placeholder(), autocomplete: "off", spellcheck: "false" });
	const list = h("ul", { id: "palette-list", class: "palette-list", role: "listbox", "aria-label": m.pal_label() }), none = h("p", { class: "palette-none", role: "status" }, m.pal_none());
	const back = h("div", { class: "palette-back" }), el = h("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": m.pal_label(), hidden: "" }, back, h("div", { class: "palette-panel" }, box, list, none));
	let open = false, all: Entry[] = [], shown: Entry[] = [], at = 0, returnTo: HTMLElement | null = null;
	function draw() {
		shown = filterEntries(all, box.value);
		at = Math.min(at, Math.max(0, shown.length - 1));
		list.replaceChildren(...shown.map((e, i) => {
			const li = h("li", { id: `palette-${i}`, class: "palette-item", role: "option", "aria-selected": String(i === at), "data-id": e.id }, h("span", { class: "palette-label" }, e.label), e.hint ? h("span", { class: "palette-hint" }, e.hint) : null);
			li.onclick = () => run(e);
			return li;
		}));
		none.hidden = shown.length > 0;
		if (shown.length) box.setAttribute("aria-activedescendant", `palette-${at}`);
		else box.removeAttribute("aria-activedescendant");
	}
	function run(e: Entry) {
		if (e.keep) return (e.run(), (all = deps.entries()), draw());
		close(); // the focus goes back first: an entry that moves it keeps it
		e.run();
	}
	function close() {
		if (!open) return false;
		[open, el.hidden] = [false, true];
		box.setAttribute("aria-expanded", "false");
		deps.inert?.(false);
		if (returnTo?.isConnected) returnTo.focus();
		returnTo = null;
		deps.closed?.();
		return true;
	}
	function show() {
		if (open) return;
		returnTo = document.activeElement as HTMLElement | null;
		[open, el.hidden, box.value, at, all] = [true, false, "", 0, deps.entries()];
		deps.inert?.(true);
		box.setAttribute("aria-expanded", "true");
		draw();
		box.focus();
	}
	const step = (by: number) => ((at = (at + by + shown.length) % shown.length), draw());
	box.oninput = () => ((at = 0), draw());
	box.addEventListener("keydown", (k) => {
		if (k.isComposing || !shown.length) return;
		if (k.key === "ArrowDown" || k.key === "ArrowUp") (k.preventDefault(), step(k.key === "ArrowDown" ? 1 : -1));
		else if (k.key === "Enter") (k.preventDefault(), run(shown[at]!));
	});
	el.addEventListener("pointerdown", (e) => e.stopPropagation()); // a press here is not a tap on the page behind (the pause's)
	back.onclick = () => void close();
	return { el, isOpen: () => open, open: show, close, toggle: () => (open ? close() : show()) };
}
