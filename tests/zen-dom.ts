// The few DOM calls the Zen layer, the answer panel (gui/ask.ts), and the trust panel (gui/trust.ts) make, as a fake document: importing this module installs it (and a
// localStorage) before the gui modules are loaded. Elements keep attributes, children, value, disabled, handlers, and focus; `page` is the document's state a test sets.

type Kid = El | string;
export class El {
	attrs = new Map<string, string>();
	kids: Kid[] = [];
	parent: El | undefined;
	dataset: Record<string, string | undefined> = {};
	handlers: Record<string, ((e: unknown) => void)[]> = {};
	onclick: (() => void) | null = null;
	oninput: (() => void) | null = null;
	hidden = false;
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	private off = false;
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, String(value));
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	removeAttribute(name: string) {
		this.attrs.delete(name);
	}
	toggleAttribute(name: string, on?: boolean) {
		(on ?? !this.attrs.has(name)) ? this.attrs.set(name, "") : this.attrs.delete(name);
	}
	addEventListener(type: string, on: (e: unknown) => void) {
		(this.handlers[type] ??= []).push(on);
	}
	append(...kids: Kid[]) {
		for (const kid of kids) {
			if (kid instanceof El) {
				kid.parent?.kids.splice(kid.parent.kids.indexOf(kid), 1);
				kid.parent = this;
			}
			this.kids.push(kid);
		}
	}
	replaceChildren(...kids: Kid[]) {
		for (const kid of this.kids) if (kid instanceof El) kid.parent = undefined;
		this.kids = [];
		this.append(...kids);
	}
	remove() {
		this.parent?.kids.splice(this.parent.kids.indexOf(this), 1);
		this.parent = undefined;
	}
	contains(other: unknown) {
		for (let at = other as El | undefined; at; at = at.parent) if (at === this) return true;
		return false;
	}
	get isConnected() {
		for (let at: El | undefined = this; at; at = at.parent) if (at === page.body) return true;
		return false;
	}
	focus() {
		page.focused = this;
		this.bubble("focusin");
	}
	blur() {
		if (page.focused === this) page.focused = undefined;
		this.bubble("focusout");
	}
	/** An event that rises from this element through its ancestors' listeners. */
	bubble(type: string, extra: object = {}) {
		for (let at: El | undefined = this; at; at = at.parent) for (const on of at.handlers[type] ?? []) on({ target: this, preventDefault() {}, ...extra });
	}
	/** A browser drops the focus from a control that becomes disabled (to the body). */
	get disabled() {
		return this.off;
	}
	set disabled(v: boolean) {
		this.off = v;
		if (v && page.focused === this) page.focused = undefined;
	}
	scrollIntoView() {}
	get textContent(): string {
		return this.kids.map((kid) => (typeof kid === "string" ? kid : kid.textContent)).join("");
	}
	set textContent(text: string) {
		this.replaceChildren(...(text ? [text] : []));
	}
	click() {
		if (this.disabled) return;
		this.onclick?.();
		this.bubble("click");
	}
	type(text: string) {
		[this.value, this.selectionStart, this.selectionEnd] = [text, text.length, text.length];
		this.oninput?.();
	}
	all(match: (el: El) => boolean): El[] {
		return this.kids.flatMap((kid) => (kid instanceof El ? [...(match(kid) ? [kid] : []), ...kid.all(match)] : []));
	}
	/** The element's text, attributes, and data, as one string: what a reader (or a screen reader) could find in it. */
	dump(): string {
		return [...this.attrs.values(), ...Object.values(this.dataset).filter(Boolean), ...this.kids.map((kid) => (typeof kid === "string" ? kid : kid.dump()))].join(" ");
	}
}
export const page = {
	body: new El("body"),
	focused: undefined as El | undefined,
	hidden: false,
	focus: true,
	on: {} as Record<string, ((e: { target: unknown }) => void)[]>,
	get activeElement() {
		return page.focused ?? page.body;
	},
	hasFocus: () => page.focus,
	addEventListener: (type: string, on: (e: { target: unknown }) => void) => void (page.on[type] ??= []).push(on),
	createElement: (tag: string) => new El(tag),
};
const store = new Map<string, string>();
Object.assign(globalThis, { document: page, localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
export const stored = store;
