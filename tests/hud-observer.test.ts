import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// A ResizeObserver reports the box it was asked to watch: by default the content box, which does not change when a theme thickens the header's border (Raven's 4 px top rule against Standard's 1 px) or its padding. The callback reads the border box, so the observer has to watch that box too, or --hud keeps the old theme's height after an in-page switch
// (todo #138 round 3, RGV-F006: the comms were 3 px too tall after Raven -> Standard until a reload). No browser runs here, so the test reads the call.
const render = readFileSync(new URL("../gui/render.ts", import.meta.url), "utf8");

test("the observer that publishes --hud watches the header's border box, the box it reads", () => {
	const at = render.indexOf('setProperty("--hud"');
	assert.ok(at > 0, "render.ts publishes --hud");
	const statement = render.slice(render.lastIndexOf("\n", at), render.indexOf(";", render.indexOf(".observe(", at)));
	assert.match(statement, /borderBoxSize\[0\]!\.blockSize/, "the callback reads the border box's block size");
	assert.match(statement, /\.observe\(document\.querySelector\("\.hud"\)!, \{ box: "border-box" \}\)/, "and the observer watches the border box, so a border or padding change reports");
});
