import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sessionGlobals } from "./fake-dom.ts";

// The map's head band and the wires from it (docs/specs/2026-11-07-head-band.md; the band's content is tests/head-band.test.ts): no base carries a crown, the band is the first thing in the map's flow, one column wide and 44 px tall at most, and it is the hub of the wires,
// which are dashed and straight, orthogonal segments only: a drop, a bus above the grid, down each column's left gutter, across into each tower.

sessionGlobals();
const { headWires } = await import("../gui/render.ts");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("no base carries a crown any more: the base card and the zoomed base have none, and the map's styles keep no `.base.head`", () => {
	for (const file of ["gui/render.ts", "gui/workspace.ts"]) assert.doesNotMatch(read(file), /class="crown"><svg><use (?:data-icon="crown"|href="#i-crown")/, `${file} draws no crown on a base`);
	assert.doesNotMatch(read("gui/style.css"), /\.base\.head\b|\.base:not\(\.head\) \.crown/, "the dead rules go with the crown");
	assert.match(read("gui/index.html"), /id="head-node"/, "the head node is in the map's markup, before the bases");
	const map = read("gui/index.html");
	assert.ok(map.indexOf('id="head-node"') < map.indexOf('id="bases"'), "before the bases in the map");
});

const rule = (css: string, selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()|*+?^$]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

test("the band takes a row of its own in the flow: centred above the bases, at most a column wide and 44 px tall, with 32 px under it; Geek stays flat", () => {
	const css = read("gui/style.css"), own = rule(css, ".head-node");
	assert.match(own, /position: relative;/, "in the flow, not out of it");
	assert.match(own, /margin: 0 auto 32px;/, "centred, the bases start 32 px under it (the approved mockup: room for the wires' bus halfway)");
	assert.match(own, /width: var\(--col, min\(100%, 330px\)\);/, "one grid column wide (render.ts sets --col to the masonry's column)");
	assert.match(own, /max-width: 100%;/);
	assert.match(own, /height: 44px;/, "44 px: at most that on a desktop, at least that to tap on a phone");
	assert.match(read("gui/themes/geek/geek.css"), /\[data-view="geek"\] :is\(\.head-node, \.drawer-head\) \{ background: var\(--surface-0\); box-shadow: none; \}/, "Geek stays flat");
	assert.match(rule(css, ".head-node.absent"), /opacity: 0\.55; border-style: dashed;/, "faint and dashed while the head is not open");
	assert.match(rule(css, ".head-node .head-line"), /min-width: 0;/, "the newest line gives way first");
	assert.match(rule(css, ".head-node .head-line"), /text-overflow: ellipsis;/);
	assert.match(rule(css, ".head-node .head-waits"), /flex: none;/, "the chip always shows");
	assert.match(css, /@container \(max-width: \d+px\) \{ \.head-node \.head-line \{ display: none; \} \}/, "a band too narrow for it drops the line");
	assert.match(rule(css, ".wire"), /stroke-dasharray: \d+ \d+;/, "dashed");
});

const hub = [600, 58] as const;
const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 });

test("the wires run orthogonally: a drop to the bus, the bus, down the column's left gutter, across into the tower; the first column, a lower card in a column, no hub", () => {
	// First column: the map's left padding is its gutter.
	const first = headWires(hub, 74, [{ x: 60, y: 121, gutter: 12 }]);
	assert.deepEqual(first.routes, [[[600, 58], [600, 74], [12, 74], [12, 121], [60, 121]]]);
	assert.deepEqual(first.segments, [seg(600, 58, 600, 74), seg(12, 74, 600, 74), seg(12, 74, 12, 121), seg(12, 121, 60, 121)]);
	// Three columns, a lower card in the middle one: its trunk is shared and runs on to the lower tower.
	const ends = [{ x: 60, y: 121, gutter: 12 }, { x: 460, y: 121, gutter: 412 }, { x: 460, y: 313, gutter: 412 }, { x: 860, y: 121, gutter: 812 }];
	const all = headWires(hub, 74, ends);
	assert.deepEqual(all.routes[2], [[600, 58], [600, 74], [412, 74], [412, 313], [460, 313]], "the lower card's wire goes down its column's gutter past the first card");
	assert.deepEqual(all.segments, [
		seg(600, 58, 600, 74),
		seg(12, 74, 812, 74),
		seg(12, 74, 12, 121),
		seg(412, 74, 412, 313),
		seg(812, 74, 812, 121),
		seg(12, 121, 60, 121),
		seg(412, 121, 460, 121),
		seg(812, 121, 860, 121),
		seg(412, 313, 460, 313),
	]);
	for (const s of all.segments) assert.ok(s.x1 === s.x2 || s.y1 === s.y2, "no diagonal");
	// A single column (a phone): the bus runs from the band to the one gutter.
	const one = headWires([195, 40], 52, [{ x: 30, y: 100, gutter: 4 }, { x: 30, y: 300, gutter: 4 }]);
	assert.deepEqual(one.segments, [seg(195, 40, 195, 52), seg(4, 52, 195, 52), seg(4, 52, 4, 300), seg(4, 100, 30, 100), seg(4, 300, 30, 300)]);
	// No hub, no head: no wires. A hub with nothing to reach draws no drop.
	assert.deepEqual(headWires(undefined, 74, ends), { routes: [], segments: [] });
	assert.deepEqual(headWires(hub, 74, []), { routes: [], segments: [] });
});

test("no vertical runs through a card, and each horizontal at a tower's height enters only the card of its own tower", () => {
	const cards = [[24, 90, 376, 290], [424, 90, 776, 260], [824, 90, 1176, 230], [424, 282, 776, 432], [824, 252, 1176, 422]] as const;
	const ends = [{ x: 60, y: 121, gutter: 12 }, { x: 460, y: 121, gutter: 412 }, { x: 460, y: 313, gutter: 412 }, { x: 860, y: 121, gutter: 812 }, { x: 860, y: 283, gutter: 812 }];
	const { segments } = headWires(hub, 74, ends);
	for (const s of segments.filter((s) => s.x1 === s.x2)) for (const [l, t, r, b] of cards) assert.ok(!(s.x1 > l && s.x1 < r && s.y2 > t && s.y1 < b), `the vertical at ${s.x1} (${s.y1} to ${s.y2}) runs through a card`);
	for (const s of segments.filter((s) => s.y1 === s.y2 && s.y1 > 74)) {
		const hit = cards.filter(([l, t, r, b]) => s.y1 > t && s.y1 < b && s.x2 > l && s.x1 < r);
		assert.equal(hit.length, 1, `the stretch at y ${s.y1} enters one card`);
		assert.ok(s.x1 < hit[0]![0], "it starts outside it, in the gutter");
	}
});
