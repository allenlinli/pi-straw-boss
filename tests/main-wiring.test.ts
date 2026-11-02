import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// gui/main.ts builds the page and cannot be imported (a document, the stream, lazy chunks, a top-level await), so its one-line bindings to the page core (gui/pagecore.ts) are read as text: a mutation of any of them
// passes the type check and every behaviour test of the core, which runs against fakes (VC3-F003). Each line is the binding as written, and the order in `report()` is the one the connect overlay needs (VC3-F002).
const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8");
const body = (name: string) => {
	const at = main.indexOf(`function ${name}(`), end = main.indexOf("\n}\n", at);
	assert.ok(at >= 0 && end > at, `${name} is in main.ts`);
	return main.slice(at, end);
};

test("an overlay's Show terminal and a pane an answer opened go to the core: the session's terminal mode, and the pane's registration", () => {
	assert.match(main, /showTerminal: \(ws, key\) => core\.openSession\(ws, key, \{ mode: "term" \}\)/);
	assert.match(main, /^onPane\(core\.openPane\);/m);
});

test("Escape reaches the core twice: the capture phase with its flag true (Zen takes the key first), the bubble phase with false", () => {
	assert.match(main, /addEventListener\("keydown", \(event\) => core\.escape\(event, true\), true\)/);
	assert.match(main, /addEventListener\("keydown", \(event\) => core\.escape\(event, false\)\);/);
});

test("the header's Zen button returns through the core, and the Zen layer's exits, watch, and terminal are the core's and the page's one embed", () => {
	assert.match(main, /mountZenBack\(el\("zen-back"\), view, root, \(\) => core\.enterZen\(\)\)/);
	assert.match(main, /leave: core\.leaveZen, embed, watch: core\.watchLog/);
	assert.match(main, /embedTerminal: \(key, name, host\) => embed\(key, name, host, \{ keys: false \}\)/, "the session view's terminal mode keeps its own focus rule");
	assert.ok(main.includes("done(p.terminal.embed(key, name, host, o))"), "the one embed hands the options (keys, end) to the terminals");
});

test("report() opens or closes the connect overlay before the core tells Zen the state (the overlay notes and restores the focus Zen's card moves)", () => {
	const report = body("report");
	const connect = report.indexOf("connect(next)"), status = report.indexOf("core.status(next)");
	assert.ok(connect >= 0 && status > connect, "connect(next) comes first");
});
