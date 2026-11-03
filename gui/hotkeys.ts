// The page's keys for the alert dialogs: Space opens the next alert (what the HUD alert button does), F enlarges or shrinks the top dialog
// (what its ⤢ does); Escape closes the top dialog (main.ts). They are the page's own and yield to everything else that takes keys: a box
// being typed in (an input, the composer, its `/` menu, the terminal mirror's key sink), a Ctrl, Alt, or ⌘ combination, an input method
// composing, and a modal (a confirmation, the lightbox, an open popover). Space on an answer-form option stays the option's (it selects or toggles).
// Space on a button or a link keeps its own activation only while the keyboard put the focus there: a control the mouse left focused (the logo
// after a click) does not hold the key, so Space still opens the next alert. :focus-visible cannot tell them apart here, because a browser
// turns it on for the focused element as the key goes down, so mountHotkeys notes which focus a pointer press gave.

export type Hotkey = "next" | "zoom" | "pause" | "prev-companion" | "next-companion" | "palette";
/** Which keymap the page reads: the alert dialogs' (Standard, Geek) or Zen's (faces.ts `keys`). */
export type Keys = "dialogs" | "zen";
/** The few fields of a keydown the routing reads. */
export interface Pressed { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean; defaultPrevented: boolean; target: unknown }
interface Reach { isContentEditable?: boolean; closest?(selector: string): object | null }
const TYPING = "input, textarea, select, [role=textbox], [role=combobox], [role=listbox], .term-scroll";
const NATIVE = "button, a, summary, [role=button], [role=link]";
const OPTION = ".ask-opt, [role=radio], [role=checkbox]";
/** What owns the keyboard while it is open. */
export const MODAL = "dialog.sheet[open], dialog.lightbox[open], [popover]:popover-open";

/**
 * One row of a keymap: the keys (compared lowercase), what they ask for, and how the target gates them. `native`: the key keeps the activation of a focused
 * button or link (unless the mouse focused it, and the row says `mouse`), `meta`: ⌘ must be held (and only ⌘). Rows the page has no action for yet (Z4b's `[`, `]`, ⌘K) are
 * here so the table is the one place keys are added; the page's `act` says false for them and the key stays the browser's.
 */
interface Row { keys: string[]; hotkey: Hotkey; native?: "keyboard" | "any"; meta?: boolean }
const KEYMAP: Record<Keys, Row[]> = {
	dialogs: [{ keys: ["f"], hotkey: "zoom" }, { keys: [" "], hotkey: "next", native: "keyboard" }],
	zen: [{ keys: ["enter", " "], hotkey: "pause", native: "any" }, { keys: ["["], hotkey: "prev-companion" }, { keys: ["]"], hotkey: "next-companion" }, { keys: ["k"], hotkey: "palette", meta: true }],
};

/** What a keydown asks for, or undefined when the key is not the page's to take. `owned`: a modal is open; `mouse`: the target got its focus from a pointer press. */
export function hotkeyOf(e: Pressed, owned: boolean, mouse = false, keys: Keys = "dialogs"): Hotkey | undefined {
	if (owned || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey) return;
	const at = e.target as Reach | null;
	if (at?.isContentEditable || at?.closest?.(TYPING)) return;
	const key = e.key.toLowerCase();
	const row = KEYMAP[keys].find((r) => r.keys.includes(key) && Boolean(r.meta) === e.metaKey);
	if (!row) return;
	if (row.native && at?.closest?.(NATIVE) && (row.native === "any" || !mouse)) return;
	if (key === " " && at?.closest?.(OPTION)) return;
	return row.hotkey;
}

/**
 * Listens for the keys. `act` does the hotkey and says whether it did anything: only then is the key taken, so Space with nothing queued
 * still scrolls the page. A held key acts once, and its repeats are taken without acting again.
 */
export function mountHotkeys(act: (hotkey: Hotkey) => boolean, owned = () => document.querySelector(MODAL) !== null, win: Pick<Window, "addEventListener"> = window, keys: () => Keys = () => "dialogs") {
	let held: Hotkey | undefined, pointer = false, clicked: EventTarget | null = null;
	// The element a pointer press focused stays the mouse's until the focus lands anywhere else; a key press ends the pointer's turn, so the focus a key moves (Tab, a script after it) is the keyboard's.
	win.addEventListener("pointerdown", () => (pointer = true), true);
	win.addEventListener("focusin", (e) => (clicked = pointer ? e.target : null), true);
	win.addEventListener("keydown", (e) => {
		const mouse = e.target === clicked;
		pointer = false;
		const hotkey = hotkeyOf(e, owned(), mouse, keys());
		if (!hotkey) return;
		if (e.repeat) return held === hotkey ? e.preventDefault() : undefined;
		if (act(hotkey)) (held = hotkey), e.preventDefault();
	});
	win.addEventListener("keyup", (e) => {
		if ((held === "next" || held === "pause") && e.key === " ") e.preventDefault(); // Firefox clicks on Space's release, whichever control has the focus then
		held = undefined;
	});
}
