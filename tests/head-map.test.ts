import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { HeadUnit } from "../src/nethead.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// The map's head node and the wires from it (docs/specs/2026-11-04-head-tower.md, Standard: the head page and its entries; H4): no base carries a crown any more, the head node is a crowned tower in a row of its own above the bases,
// faint and dashed while the head is not open, and it is the hub of the wires.

sessionGlobals();
const { fillHeadNode, headWires } = await import("../gui/render.ts");
const { m } = await import("../gui/paraglide/messages.js");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const head = (over: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "standing", asks: [], ...over });
const node = () => {
	const root = new El("a"), tower = new El("div"), state = new El("span"), title = new El("b");
	root.className = "head-node";
	tower.className = "tower"; state.className = "tstate"; title.className = "head-name";
	root.append(tower, title, state);
	return { root, tower, state, title };
};

test("no base carries a crown any more: the base card and the zoomed base have none, and the map's styles keep no `.base.head`", () => {
	for (const file of ["gui/render.ts", "gui/workspace.ts"]) assert.doesNotMatch(read(file), /class="crown"><svg><use href="#i-crown"/, `${file} draws no crown on a base`);
	assert.doesNotMatch(read("gui/style.css"), /\.base\.head\b|\.base:not\(\.head\) \.crown/, "the dead rules go with the crown");
	assert.match(read("gui/index.html"), /id="head-node"/, "the head node is in the map's markup, above the bases");
	const map = read("gui/index.html");
	assert.ok(map.indexOf('id="head-node"') < map.indexOf('id="bases"'), "in a row of its own above the bases");
});

test("the head node says Head tower with its state word, is dashed and faint while the head is not open, and hidden without a head on the net", () => {
	const n = node();
	fillHeadNode(n.root as unknown as HTMLElement, head({ mark: "working", state: "running" }));
	assert.deepEqual([n.root.hidden, n.root.classes.has("absent"), n.root.dataset.mark, n.tower.dataset.mark, n.title.textContent], [false, false, "working", "working", "Head tower"]);
	assert.match(n.state.textContent, /working|running/i);
	fillHeadNode(n.root as unknown as HTMLElement, head({ state: "absent" }));
	assert.deepEqual([n.root.classes.has("absent"), n.state.textContent], [true, m.head_state_absent()]);
	assert.equal(n.tower.classes.has("ghost"), true, "the tower is drawn as a ghost, as a base without a tower is");
	assert.equal(n.root.getAttribute("href"), "head", "a click opens the page");
	fillHeadNode(n.root as unknown as HTMLElement, undefined);
	assert.equal(n.root.hidden, true);
	assert.equal(n.root.classes.has("off"), true, "a hidden node is no hub for the wires");
	fillHeadNode(n.root as unknown as HTMLElement, head());
	assert.equal(n.root.classes.has("off"), false);
});

test("the wires run from the head node to every base's tower, none without a hub or while the head is not open", () => {
	const hub = [100, 20] as const, ends = [[40, 140], [160, 140], [300, 220]] as const;
	assert.deepEqual(headWires(hub, ends), [
		{ x1: 100, y1: 20, x2: 40, y2: 140, mid: 70 },
		{ x1: 100, y1: 20, x2: 160, y2: 140, mid: 130 },
		{ x1: 100, y1: 20, x2: 300, y2: 220, mid: 200 },
	]);
	assert.deepEqual(headWires(undefined, ends), [], "no head node, no wires");
	assert.deepEqual(headWires(hub, []), []);
});
