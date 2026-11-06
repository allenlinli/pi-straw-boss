import assert from "node:assert/strict";
import { test } from "node:test";
import type { UnitCard } from "../gui/linkmodel.ts";
import { El, page } from "./fake-dom.ts";

// An unattended device's units on the card of its ally base (gui/allyunits.ts), on the fake document: the state word and when it was updated, the monitors on one line, the report folded to its first line, a crash's notice behind a
// fold, a stale unit marked; a teammate's text only ever becomes text.

const { fillAllyUnits } = await import("../gui/allyunits.ts");
const { m } = await import("../gui/paraglide/messages.js");

const card = (over: Partial<UnitCard> = {}): UnitCard => ({ unit: "Harbor API", state: "running", tone: "working", word: m.link_unit_running(), at: Date.now() - 40_000, stale: false, monitors: [], report: "", ...over });
const draw = (cards: UnitCard[], named = false) => {
	const list = new El("ul");
	page.body.replaceChildren(list);
	fillAllyUnits(list as unknown as HTMLElement, cards, named);
	return list;
};
const one = (list: El, selector: string) => list.querySelector(selector)!;

test("a unit says its state in a word and when it was updated, with its tone for the colour; the card's title is its name, so a unit of a workspace does not repeat it", () => {
	const list = draw([card()]);
	const li = one(list, ".ally-unit");
	assert.equal(li.dataset.tone, "working");
	assert.equal(one(list, ".au-word").textContent, m.link_unit_running());
	assert.equal(one(list, ".au-name").textContent, "", "no name beside the card's title");
	assert.equal(one(list, ".au-head .age").textContent, "40s");
	assert.ok(Number(one(list, ".au-head .age").dataset.since) > 0, "the page's clock keeps it current");
	assert.equal(one(list, ".au-head .au-time").textContent, `${m.link_unit_updated_pre()}40s${m.link_unit_updated_post()}`);
	assert.equal(draw([card({ unit: "Quarry Tools" })], true).querySelector(".au-name")!.textContent, "Quarry Tools", "a whole device (no workspace of its own) says each unit's name");
});

test("monitors are one compact line with their count, and none draws nothing", () => {
	const list = draw([card({ monitors: ["tail -f deploy.log", "npm run watch"] })]);
	assert.equal(one(list, ".au-mons").hidden, false);
	assert.equal(one(list, ".au-mons b").textContent, m.link_unit_monitors({ count: 2 }));
	assert.equal(one(list, ".au-mons span").textContent, "tail -f deploy.log · npm run watch");
	assert.equal(draw([card()]).querySelector(".au-mons")!.hidden, true);
});

test("the report is folded to its first line with no Markdown marks, and no report draws no fold", () => {
	const list = draw([card({ report: "## Staging deploy\n\nDeployed **v1.2**." })]);
	const fold = one(list, ".au-report");
	assert.equal(fold.hidden, false);
	assert.equal(one(list, ".au-label").textContent, m.link_unit_report());
	assert.equal(one(list, ".au-peek").textContent, "Staging deploy");
	assert.equal(one(list, ".au-md").textContent, "", "its Markdown is made when the fold opens");
	assert.equal(draw([card()]).querySelector(".au-report")!.hidden, true);
});

test("a crash shows its word and its notice behind a fold of its own, with how long ago; no crash hides the fold", () => {
	const list = draw([card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at: Date.now() - 4 * 60_000, text: "An ally run crashed: <b>exit 1</b>" } })]);
	assert.equal(one(list, ".ally-unit").dataset.tone, "crashed");
	assert.equal(one(list, ".au-word").textContent, m.link_unit_crashed());
	const fold = one(list, ".au-crash");
	assert.equal(fold.hidden, false);
	assert.equal(one(list, ".au-crash summary b").textContent, m.link_unit_crash());
	assert.equal(one(list, ".au-crash .age").textContent, "4m");
	assert.equal(one(list, ".au-crash pre").textContent, "An ally run crashed: <b>exit 1</b>", "text, never markup");
	assert.equal(draw([card()]).querySelector(".au-crash")!.hidden, true);
});

test("a stale unit is marked in words and drawn as stale; a fresh one is not", () => {
	const stale = draw([card({ stale: true, at: Date.now() - 8 * 60_000 })]);
	assert.equal(one(stale, ".au-stale").hidden, false);
	assert.equal(one(stale, ".au-stale").textContent, m.link_unit_stale());
	assert.ok(one(stale, ".ally-unit").classes.has("stale"));
	assert.equal(one(stale, ".au-head .age").textContent, "8m");
	const fresh = draw([card()]);
	assert.equal(one(fresh, ".au-stale").hidden, true);
	assert.equal(one(fresh, ".ally-unit").classes.has("stale"), false);
});

test("a redraw keeps the unit's element (and so its open folds) and a unit that is gone leaves", () => {
	const list = new El("ul");
	page.body.replaceChildren(list);
	const el = list as unknown as HTMLElement;
	fillAllyUnits(el, [card({ report: "one" })], false);
	const first = list.querySelector(".ally-unit")!;
	fillAllyUnits(el, [card({ report: "two", state: "standing", tone: "idle", word: m.mark_standing() })], false);
	assert.equal(list.querySelector(".ally-unit"), first);
	assert.equal(one(list, ".au-peek").textContent, "two");
	assert.equal(first.dataset.state, "standing");
	fillAllyUnits(el, [], false);
	assert.equal(list.children.every((x) => x.classes.has("leaving")), true);
});
