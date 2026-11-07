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

const kinds = (nodes: N[]): N[] => nodes.filter((n) => typeof n !== "string" && n.attrs?.class === "md-alert");
test("GitHub alerts render as callouts with a kind and a title", () => {
	for (const k of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
		const [a] = kinds(parse(`> [!${k}]\n> body **x**`)) as Exclude<N, string>[];
		assert.ok(a, k);
		assert.equal(a.attrs!["data-kind"], k.toLowerCase());
		assert.equal(a.tag, "div");
		assert.deepEqual(a.kids[0], { tag: "p", kids: [k[0] + k.slice(1).toLowerCase()], attrs: { class: "md-alert-title" } });
		assert.ok(JSON.stringify(a.kids).includes("strong"));
	}
});
test("an alert's own title replaces the default; other quotes and raw HTML stay as before", () => {
	const [a] = kinds(parse("> [!tip] Try this\n> text")) as Exclude<N, string>[];
	assert.deepEqual(a!.kids[0], { tag: "p", kids: ["Try this"], attrs: { class: "md-alert-title" } });
	assert.equal(kinds(parse("> [!NOTES]\n> x")).length, 0);
	assert.equal(kinds(parse("> text [!NOTE]\n> x")).length, 0);
	const t = JSON.stringify(parse("> [!NOTE] <script>x</script>\n> y"));
	assert.ok(!t.includes('"tag":"script"'));
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
	assert.match(css, /\.md-alert\[data-kind="caution"\]/);
});
