import assert from "node:assert/strict";
import { test } from "node:test";
import { readSecret, showScreen } from "../src/secretscreen.ts";

// A pi screen for a secret (src/secretscreen.ts): what is typed is drawn as bullets, nothing is returned but through the promise, and a paste, backspace, Escape and Enter work the way pi's own input does.

type Component = { render(width: number): string[]; handleInput(data: string): void };
/** A ui whose `custom` hands the component its keys one by one and records every frame; the promise resolves with what the component handed to `done`. */
function screen(keys: string[]) {
	const frames: string[][] = [];
	let renders = 0;
	const ui = {
		custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Component | Promise<Component>) => {
			let result: unknown, finished = false;
			const comp = await factory({ requestRender: () => void renders++ }, {}, {}, (v) => ((finished = true), (result = v)));
			frames.push(comp.render(40));
			for (const k of keys) {
				if (finished) break;
				comp.handleInput(k);
				frames.push(comp.render(40));
			}
			assert.ok(finished, "left open");
			return result;
		},
	};
	return { ui: ui as never, frames, renders: () => renders };
}
const SECRET = "tk_live_Zx81QpL0";

test("readSecret returns what was typed and draws only bullets, never a character of it", async () => {
	const s = screen([...SECRET.split(""), "\r"]);
	assert.equal(await readSecret(s.ui, { title: "Relay token", hint: "Paste the token.", footer: "Enter sends, Esc cancels" }), SECRET);
	const drawn = s.frames.flat().join("\n");
	assert.ok(!drawn.includes(SECRET) && !/[A-Za-z]{2}Zx|Zx8|tk_/.test(drawn), "no character of the token is drawn");
	assert.match(drawn, /Relay token/);
	assert.match(drawn, /Enter sends, Esc cancels/);
	assert.ok(s.frames.at(-2)!.some((line) => line.includes("•".repeat(SECRET.length))), `${SECRET.length} bullets after the last key`);
	assert.ok(s.renders() > 0, "each key asks for a redraw");
	assert.ok(s.frames.flat().every((line) => [...line].length <= 40));
});

test("readSecret takes a bracketed paste, backspace, and Escape", async () => {
	assert.equal(await readSecret(screen([`\x1b[200~${SECRET}\r\n\x1b[201~`, "\r"]).ui, { title: "t", hint: "h", footer: "f" }), SECRET, "a paste, without its trailing newline");
	assert.equal(await readSecret(screen(["a", "b", "c", "\x7f", "d", "\r"]).ui, { title: "t", hint: "h", footer: "f" }), "abd");
	assert.equal(await readSecret(screen(["a", "b", "\x1b"]).ui, { title: "t", hint: "h", footer: "f" }), undefined);
	assert.equal(await readSecret(screen(["\r"]).ui, { title: "t", hint: "h", footer: "f" }), "", "Enter on nothing is an empty string, for the caller to refuse");
});

test("readSecret without a custom screen is undefined, not a fallback that would echo", async () => {
	assert.equal(await readSecret({} as never, { title: "t", hint: "h", footer: "f" }), undefined);
});

test("showScreen draws the lines wrapped to the width and closes on Enter or Escape", async () => {
	const long = "strawlink1:" + "Ab3_-".repeat(40);
	for (const key of ["\r", "\x1b"]) {
		const s = screen([key]);
		await showScreen(s.ui, { title: "Invite", lines: [long, "", "Valid for 9 min"], footer: "Enter closes" });
		const first = s.frames[0]!;
		assert.ok(first.every((line) => [...line].length <= 40));
		assert.equal(first.join("").replace(/\s/g, "").includes(long), true, "the whole text, cut across lines");
		assert.match(first.join("\n"), /Valid for 9 min/);
	}
	const open = screen(["x", "y", "\r"]);
	await showScreen(open.ui, { title: "t", lines: ["l"], footer: "f" });
	assert.equal(open.frames.length, 4, "the first frame and one per key: other keys change nothing, and the screen stays until Enter");
});
