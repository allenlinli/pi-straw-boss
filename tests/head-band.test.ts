import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { El, sessionGlobals } from "./fake-dom.ts";

// The head band's content (docs/specs/2026-11-07-head-band.md, "The band"): the crown, the name, the newest line, the waits chip; one link to the head page, faint and dashed while the head is not open.

sessionGlobals();
const { bandModel, bossWaits, gutter, newestLine, routeFrames } = await import("../gui/headband.ts");
const { fillHeadNode } = await import("../gui/render.ts");
const { headDemo, headAsks } = await import("../gui/demo-head.ts");
const { m } = await import("../gui/paraglide/messages.js");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0), HOUR = 3_600_000;
const head = (over: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "running", asks: [], ...over });
const row = (over: Partial<HeadAskRow>): HeadAskRow => ({ id: "H1", group: "H1", workspace: "w1", label: "Harbor API", since: NOW - HOUR, at: NOW - HOUR, first: "Ship it", state: "waiting", answers: 0, ...over });
const memory = (bossWaits: { id: string; text: string; at: string; state?: string }[]) => ({ rev: 1, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] }) as never;

test("waits for the boss: counted as the head page's rows, none when the head has none, the demo's lapsed wait left out", () => {
	assert.equal(bossWaits(headDemo("waiting", NOW)), 1, "the demo holds a lapsed wait and a fresh one: one chip count");
	assert.equal(bossWaits(headDemo("answers", NOW)), 0);
	assert.equal(bossWaits(headDemo("talk", NOW)), 0);
	assert.equal(bossWaits(headDemo("absent", NOW)), 0);
	const at = new Date(NOW).toISOString();
	const service = { ...headDemo("waiting", NOW).service!, memory: memory([{ id: "a", text: "x", at }, { id: "b", text: "y", at }, { id: "c", text: "dismissed", at, state: "dismissed" }]) };
	assert.equal(bossWaits(head({ service })), 2, "a wait with a state (dismissed) has no row on the page, so no count");
});

test("the newest line is the newest ask's one-line summary while it is not lapsed, else nothing the snapshot holds", () => {
	const asks = headAsks(NOW);
	const line = newestLine(head({ asks }), NOW);
	assert.ok(line, "the demo's newest broadcast gives a line");
	assert.doesNotMatch(line, /\n/, "one line");
	assert.match(line, /Keep the machine awake|caffeinate|Remove the time limit|time limit/i, "the newest of the chain (the third correction), by the head page's own one-line rule");
	assert.equal(newestLine(head({ asks: [] }), NOW), "", "no asks, no line");
	const old = [row({ id: "H1", group: "H1", since: NOW - 40 * HOUR, at: NOW - 40 * HOUR, first: "Old order" })];
	assert.equal(newestLine(head({ asks: old }), NOW), "", "an ask with no activity for a day is lapsed: no line");
	const two = [row({ id: "H1", group: "H1", since: NOW - 3 * HOUR, at: NOW - 3 * HOUR, first: "Earlier order" }), row({ id: "H2", group: "H2", workspace: "w2", since: NOW - HOUR, at: NOW - HOUR, first: "Later order" })];
	assert.equal(newestLine(head({ asks: two }), NOW), "Later order", "the newest broadcast wins");
});

test("the band's model over the head's states: waiting, asks, talk, absent", () => {
	const waiting = bandModel(headDemo("waiting", NOW), NOW);
	assert.deepEqual([waiting.absent, waiting.waits, waiting.name], [false, 1, m.head_tower()]);
	assert.ok(waiting.line.length > 0 && waiting.line === newestLine(headDemo("waiting", NOW), NOW));
	assert.match(waiting.label, new RegExp(`^${m.head_tower()} · `), "the state and the wait are in the accessible name");
	assert.ok(waiting.label.includes(`1 · ${m.memory_wait_boss()}`), "the waits are in the accessible name");
	assert.ok(waiting.label.includes(waiting.state));
	const answers = bandModel(headDemo("answers", NOW), NOW);
	assert.deepEqual([answers.waits, answers.line === newestLine(headDemo("answers", NOW), NOW)], [0, true]);
	assert.ok(!answers.label.includes(m.memory_wait_boss()), "no waits, no chip words");
	const talk = bandModel(headDemo("talk", NOW), NOW);
	assert.deepEqual([talk.waits, talk.line], [0, ""], "a head with nothing handed out and nothing waiting has a name and a state, no line");
	const absent = bandModel(headDemo("absent", NOW), NOW);
	assert.deepEqual([absent.absent, absent.waits, absent.line, absent.state], [true, 0, m.head_state_absent(), m.head_state_absent()], "not open: the name and `not open`, no line, no chip");
	assert.equal(absent.label, `${m.head_tower()} · ${m.head_state_absent()}`);
});

const band = () => {
	const root = new El("a"), crown = new El("svg"), name = new El("b"), line = new El("span"), waits = new El("em");
	root.className = "head-node";
	crown.className = "head-crown"; name.className = "head-name"; line.className = "head-line"; waits.className = "head-waits";
	root.append(crown, name, line, waits);
	return { root: root as unknown as HTMLElement, el: root, line, waits, name };
};

test("fillHeadNode draws the band: name, newest line, the waits chip shown only above 0, the whole band one link with the state in its name", () => {
	const b = band();
	fillHeadNode(b.root, headDemo("waiting", NOW), NOW);
	assert.deepEqual([b.el.hidden, b.el.classes.has("absent"), b.el.classes.has("off"), b.el.getAttribute("href")], [false, false, false, "head"]);
	assert.equal(b.name.textContent, m.head_tower());
	assert.equal(b.line.textContent, bandModel(headDemo("waiting", NOW), NOW).line);
	assert.deepEqual([b.waits.hidden, b.waits.textContent], [false, "1"]);
	assert.equal(b.el.getAttribute("aria-label"), bandModel(headDemo("waiting", NOW), NOW).label);
	assert.equal(b.el.title, b.el.getAttribute("aria-label"), "a hover reads the whole line the band ellipsises");
	fillHeadNode(b.root, headDemo("answers", NOW), NOW);
	assert.equal(b.waits.hidden, true, "no waits, no chip");
	fillHeadNode(b.root, headDemo("absent", NOW), NOW);
	assert.deepEqual([b.el.classes.has("absent"), b.line.textContent, b.waits.hidden, b.el.getAttribute("href")], [true, m.head_state_absent(), true, "head"], "faint and dashed, still a link");
	fillHeadNode(b.root, undefined, NOW);
	assert.deepEqual([b.el.hidden, b.el.classes.has("off")], [true, true], "no head on the net, no band and no hub for the wires");
});

test("the old pill is gone: the head node is no tower mark, no state line, no absolute pill in the map's top band", () => {
	const html = read("gui/index.html"), css = read("gui/style.css");
	const markup = /<a class="head-node"[^>]*>.*?<\/a>/s.exec(html)?.[0] ?? "";
	assert.ok(markup, "the band is in the map's markup");
	assert.match(markup, /id="head-node"[^>]*href="head"[^>]*data-route="head"/, "one link to /head");
	assert.match(markup, /<use data-icon="crown" href="#i-crown"\/>/, "the crown");
	assert.match(markup, /class="head-name"[^>]*data-m="head_tower"/);
	assert.match(markup, /class="head-line"/);
	assert.match(markup, /class="head-waits"[^>]*hidden/);
	assert.doesNotMatch(markup, /class="tower"|class="tstate"|class="sweep"|class="pulse"|class="badge"/, "the pill's tower mark, state line, and sweep are gone");
	assert.ok(html.indexOf('id="head-node"') < html.indexOf('id="bases"'), "before the bases");
	assert.doesNotMatch(css, /\.head-node::before|\.map:has\(> \.head-node|\.head-node \.tower|\.head-node \.tstate|\.head-node \.crown/, "the pill's rules go");
	assert.doesNotMatch(css, /\.head-node \{[^}]*position: absolute/, "in the flow");
	assert.doesNotMatch(read("gui/render.ts"), /"tower"\)!;\s*tower\.classList\.toggle\("ghost", !open\)|\.head-node:not\(\.off\) \.tower/, "render.ts no longer reads a tower mark in the node");
});

test("the gutter on the left of a column: the middle of the map's padding for the first, half the column gap before the others", () => {
	assert.equal(gutter(20, 20, 20), 10, "the first column: half of the padding");
	assert.equal(gutter(8, 8, 18), 4, "a phone's padding");
	assert.equal(gutter(370, 20, 20), 360, "a later column: half a gap before its cards");
	assert.equal(gutter(369.6, 20, 19), 360, "rounded");
});

test("a packet travels the route at an even pace: its keyframes sit on the corners at the share of the length reached there", () => {
	assert.deepEqual(routeFrames([[0, 0], [0, 10], [30, 10]]), [{ at: 0, x: 0, y: 0 }, { at: 25, x: 0, y: 10 }, { at: 100, x: 30, y: 10 }]);
	assert.deepEqual(routeFrames([[5, 5]]), [], "a point is no route");
});
