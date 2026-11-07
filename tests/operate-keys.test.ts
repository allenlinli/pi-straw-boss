import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createKeys, OPERATE_COMBOS } from "../src/keys.ts";

// Operate pad parity (docs/specs/2026-11-07-link-operate.md §7.3, OR-F002): the chords an operate session may send are compared with the installed pi's own default keybindings, so a pi that moves an action onto one of them is caught here. After bumping
// @earendil-works/pi-coding-agent this test must pass (AGENTS.md, Bumping pi). A user's keybindings.json can still rebind any key; the box checks what it can (the probe, the foreground program).

type Bindings = Record<string, { defaultKeys: string | string[] }>;
const keysOf = (b: Bindings[string]) => (Array.isArray(b.defaultKeys) ? b.defaultKeys : [b.defaultKeys]);
const pad = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => undefined });
let n = 0;
const allowed = (key: string) => (pad.check(`k${n++}`, { key, stream: "s" }, true, true) as { key?: string }).key === key;

/** The editor's own: `tui.editor.*`, and `app.clear` (Ctrl+C clears it). Alt+Enter is the follow-up key, which the pad probes like Enter. */
const EDITOR_ONLY = ["ctrl+a", "ctrl+e", "ctrl+b", "ctrl+f", "ctrl+k", "ctrl+u", "ctrl+w", "ctrl+y", "ctrl+c", "alt+b", "alt+f", "alt+d", "alt+y", "alt+backspace", "ctrl+left", "ctrl+right", "alt+left", "alt+right"];
/** The app actions of the main screen (not a dialog's), whose keys leave or change what the editor is. */
const APP = ["app.interrupt", "app.exit", "app.suspend", "app.thinking.cycle", "app.thinking.save", "app.thinking.toggle", "app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.tools.expand", "app.editor.external", "app.message.copy", "app.message.dequeue", "app.clipboard.pasteImage", "app.session.new", "app.session.tree", "app.session.fork", "app.session.resume"];

test("every chord of the operate list is bound to an editor action in the installed pi, and the pattern holds exactly them and Alt+Enter", async () => {
	const pi = (await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href)) as { KEYBINDINGS: Bindings };
	const editor = new Set(Object.entries(pi.KEYBINDINGS).filter(([id]) => id.startsWith("tui.editor.") || id === "app.clear").flatMap(([, b]) => keysOf(b)));
	for (const chord of EDITOR_ONLY) assert.ok(editor.has(chord), `${chord} is not an editor key of this pi`);
	for (const chord of EDITOR_ONLY) assert.ok(allowed(chord), chord);
	assert.ok(allowed("alt+enter"));
	for (const letter of "abcdefghijklmnopqrstuvwxy") for (const mod of ["ctrl", "alt"]) assert.equal(OPERATE_COMBOS.test(`${mod}+${letter}`), EDITOR_ONLY.includes(`${mod}+${letter}`), `${mod}+${letter}`);
});

test("no key of a pi app action that leaves or changes the editor is sent from an operate session (external editor, exit, model and thinking, copy, paste of a file)", async () => {
	const pi = (await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href)) as { KEYBINDINGS: Bindings };
	const external = keysOf(pi.KEYBINDINGS["app.editor.external"]!);
	assert.deepEqual(external, ["ctrl+g"], "pi's external-editor key is the one the tests and the spec name");
	for (const id of APP) for (const key of keysOf(pi.KEYBINDINGS[id]!)) {
		if (!/^(ctrl|alt)\+[a-z]$/.test(key)) continue; // Escape and shift chords are not pad chords; Escape's double is refused in keys.ts
		assert.equal(allowed(key), false, `${id} is on ${key}`);
	}
});
