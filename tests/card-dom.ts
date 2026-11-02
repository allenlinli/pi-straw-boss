// A small fake DOM for the terminal card (gui/termcard.ts) and its places (gui/stepslot.ts): elements with attributes, classes, data, handlers, focus, and a parent; importing this module installs `document`, `HTMLElement`, and `matchMedia`.

export class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	parent: El | undefined;
	dataset: Record<string, string> = {};
	handlers: Record<string, ((e: Record<string, unknown>) => void)[]> = {};
	onclick: ((e: { isTrusted: boolean }) => void) | null = null;
	disabled = false;
	value = "";
	classes = new Set<string>();
	readonly tag: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	classList = { toggle: (c: string, on?: boolean) => void ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)), contains: (c: string) => this.classes.has(c) };
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name === "class") this.classes = new Set(value.split(" "));
		if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	get type() {
		return this.attrs.get("type") ?? "";
	}
	set type(v: string) {
		this.attrs.set("type", v);
	}
	addEventListener(type: string, on: (e: Record<string, unknown>) => void) {
		(this.handlers[type] ??= []).push(on);
	}
	append(...kids: (El | string)[]) {
		for (const k of kids) (k instanceof El && (k.parent?.drop(k), (k.parent = this)), this.kids.push(k));
	}
	prepend(...kids: (El | string)[]) {
		for (const k of kids) (k instanceof El && (k.parent?.drop(k), (k.parent = this)), this.kids.unshift(k));
	}
	private drop(k: El) {
		this.kids = this.kids.filter((x) => x !== k);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [];
		this.append(...kids);
	}
	remove() {
		if (page.focus && this.contains(page.focus)) page.focus = undefined; // a browser drops the focus from what leaves the page
		this.parent?.drop(this);
		this.parent = undefined;
	}
	contains(other: unknown) {
		for (let at = other as El | undefined; at; at = at.parent) if (at === this) return true;
		return false;
	}
	closest(sel: string): El | null {
		for (let at: El | undefined = this; at; at = at.parent) if (at.classes.has(sel.replace(/^[.[]|\]$/g, "")) || at.attrs.has(sel.replace(/^[.[]|\]$/g, ""))) return at;
		return null;
	}
	get isConnected() {
		for (let at: El | undefined = this; at; at = at.parent) if (at === page.root) return true;
		return false;
	}
	focus() {
		page.focus = this;
	}
	get textContent(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
	}
	set textContent(t: string) {
		this.replaceChildren(...(t ? [t] : []));
	}
	all(): El[] {
		return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : []));
	}
	querySelector(sel: string) {
		return this.byClass(sel.slice(1)) ?? null;
	}
	byClass(c: string) {
		return this.all().find((e) => e.classes.has(c));
	}
	/** Fires a listener-style event and returns whether preventDefault was called. */
	fire(type: string, e: Record<string, unknown> = {}) {
		let prevented = false;
		for (const on of this.handlers[type] ?? []) on({ isTrusted: true, preventDefault: () => void (prevented = true), ...e });
		return prevented;
	}
}
/** The page: `focus` is the focused element, `fine` whether the pointer is a mouse, `root` the body whose descendants are connected. */
export const page = { focus: undefined as El | undefined, fine: true, root: new El("body") };
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag), addEventListener() {}, hidden: false, get activeElement() { return page.focus ?? page.root; }, body: page.root }, HTMLElement: El, matchMedia: () => ({ matches: page.fine }) });
