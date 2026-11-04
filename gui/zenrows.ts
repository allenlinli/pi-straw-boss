import { KEYMAP, type Row } from "./hotkeys.ts";

// Zen's rows of the keymap (hotkeys.ts), registered by the Zen chunk: Space ends the pause wherever the focus is, and Enter does too, else it unfolds the head tower's input on the circle screen, except on a native control (a button or link keeps its Enter and Space,
// however it got focus); H expands the history; [ and ] step the companion (also typed with Option, or AltGr, which a browser reports as Ctrl and Alt together, because some layouts make the key that way:
// the key the layout made is what counts, not the Alt gate); ⌘K (Ctrl+K off a Mac) opens the palette, from a box being typed in too. The same gates apply (typing, modifiers, composing, a modal).
// A key pressed before the chunk has loaded changes nothing: Zen is not shown yet, and the page reads "dialogs".
/** What sends its keys to a terminal: the mirror's sink and scroll, the step card's input, and anything inside a terminal tile or layer. The palette row yields here (Ctrl+K is the terminal's kill-line). */
const TERMINAL = ".term-sink, .term-scroll, .tcard-input, .tcard, .term, .term-tile, .zen-term";
const isMac = () => /Mac|iPhone|iPad|iPod/i.test(globalThis.navigator?.platform ?? "");
const alt: Row["takes"] = (e) => !e.metaKey && (e.altKey || !e.ctrlKey);
const mod: Row["takes"] = (e, mac = isMac()) => !e.altKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
KEYMAP.zen = [
	{ keys: ["enter"], hotkey: "talk", native: "any" },
	{ keys: [" "], hotkey: "pause", native: "any" },
	{ keys: ["h"], hotkey: "history" },
	{ keys: ["["], hotkey: "prev-companion", takes: alt },
	{ keys: ["]"], hotkey: "next-companion", takes: alt },
	{ keys: ["k"], hotkey: "palette", takes: mod, blocks: (at) => at?.closest?.(TERMINAL) },
];
