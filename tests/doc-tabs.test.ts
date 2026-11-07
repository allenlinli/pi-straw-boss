import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { tabLabels } from "../gui/doctabs.ts";
import { parse, type N } from "../gui/markdown.ts";
import { rulesOf, declarations } from "./css-rules.ts";

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");

test("a tab shows the file name only; the session is not repeated", () => {
	assert.deepEqual(tabLabels(["~/a/notes.md", "/x/plan.html"]), ["notes.md", "plan.html"]);
});

test("same-named documents are told apart by the shortest distinguishing parent path", () => {
	const l = tabLabels(["~/.local/share/sbd-review/wait-cards/decisions.md", "~/.local/share/sbd-review/train-workers/decisions.md", "~/x/other.md"]);
	assert.deepEqual(l, ["wait-cards/decisions.md", "train-workers/decisions.md", "other.md"]);
});

test("the parent path grows only as far as it must", () => {
	assert.deepEqual(tabLabels(["/a/x/y/n.md", "/b/x/y/n.md", "/a/z/n.md"]), ["a/x/y/n.md", "b/x/y/n.md", "z/n.md"]);
	assert.deepEqual(tabLabels(["/a/n.md", "/a/n.md"]), ["/a/n.md", "/a/n.md"], "identical paths fall back to the full path");
});

// GitHub alerts are pi-better-show's `pbs-callout` now (todo #129; the drawing is tests/blocks-doc.test.ts and blocks-chat.test.ts): the page's own Markdown no longer makes the hand-made callout of todo #128, so a quote that opens with [!NOTE] is
// a plain quote wherever no block is drawn, and raw HTML inside it stays text.
test("the page's own Markdown draws a GitHub alert as the quote it is, and the hand-made callout and its styles are gone", () => {
	for (const k of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
		const [q] = parse(`> [!${k}]\n> body **x**`) as Exclude<N, string>[];
		assert.equal(q!.tag, "blockquote", k);
		assert.ok(!JSON.stringify(q).includes("md-alert"));
	}
	assert.ok(!JSON.stringify(parse("> [!NOTE] <script>x</script>\n> y")).includes('"tag":"script"'));
	assert.ok(!/\.md-alert/.test(css), "no .md-alert rule is left in style.css");
});

test("document tabs: one line, ellipsis, scroll sideways, active marked, 44 px on touch", () => {
	const tab = rulesOf(css).find((r) => r.parts.includes(".tiles.tabbed .tile-tabs .tab-btn"));
	assert.ok(tab);
	const d = declarations(tab!.body);
	for (const [p, v] of [["white-space", "nowrap"], ["overflow", "hidden"], ["text-overflow", "ellipsis"]] as const) assert.ok(d.some(([a, b]) => a === p && b === v), p);
	const strip = rulesOf(css).find((r) => r.parts.includes(".tiles.tabbed .tile-tabs"));
	const s = declarations(strip!.body);
	assert.ok(s.some(([p, v]) => p === "flex-wrap" && v === "nowrap") && s.some(([p, v]) => p === "overflow-x" && v === "auto"));
	assert.ok(rulesOf(css).some((r) => r.parts.includes(".tiles.tabbed .tile-tabs .tab-btn.active") && declarations(r.body).some(([p]) => p === "font-weight")));
});
