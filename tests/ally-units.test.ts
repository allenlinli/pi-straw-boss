import assert from "node:assert/strict";
import { test } from "node:test";
import type { UnitCard } from "../gui/linkmodel.ts";
import { El, page } from "./fake-dom.ts";
import { until } from "./fakes.ts";

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

test("ALLY-F005: opening the report's fold paints its Markdown (headings and lists) in a chunk of its own; raw HTML and a javascript: link stay text", async () => {
	const report = "## Staging deploy\n\n- Migration `0042` applied\n- **green** 48 of 48\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://example.com)";
	Object.assign(document, { createDocumentFragment: () => new El("#fragment"), createTextNode: (t: string) => t }); // the fake document has neither
	const list = draw([card({ report })]);
	const fold = one(list, ".au-report") as El & { open: boolean; ontoggle: () => void };
	assert.equal(list.querySelectorAll(".au-md h2").length, 0, "nothing is made while the fold is shut");
	fold.open = true;
	fold.ontoggle();
	await until(() => list.querySelectorAll(".au-md h2").length === 1, "the heading");
	assert.equal(list.querySelectorAll(".au-md ul li").length, 2);
	assert.equal(list.querySelectorAll(".au-md strong").length, 1);
	assert.equal(list.querySelectorAll(".au-md img").length, 0, "an <img onerror> is text");
	assert.deepEqual(list.querySelectorAll(".au-md a").map((a) => a.getAttribute("href")), ["https://example.com"], "only the https link is a link; the javascript: one is text");
	assert.ok(one(list, ".au-md").textContent.includes("<img src=x onerror=alert(1)>") && one(list, ".au-md").textContent.includes("javascript:alert(1)"));
	// A redraw with another report repaints the open fold; a shut fold keeps its last Markdown until it opens again.
	fillAllyUnits(list as unknown as HTMLElement, [card({ report: "# Second" })], false);
	await until(() => list.querySelectorAll(".au-md h1").length === 1, "the new report");
	assert.equal(list.querySelectorAll(".au-md h2").length, 0);
});

test("ALLY-F003: a trust question nobody answered reads 'Why it stopped' with the notice and the hint where trust is granted; a crash keeps 'What happened' and no hint", () => {
	const at = Date.now() - 4 * 60_000;
	const trust = draw([card({ tone: "waiting", word: m.link_unit_trust(), state: "standing", crash: { at, text: "An ally run crashed: No trust decision for /work/p", trust: true } })]);
	assert.equal(one(trust, ".ally-unit").dataset.tone, "waiting");
	assert.equal(one(trust, ".au-word").textContent, m.link_unit_trust());
	assert.equal(one(trust, ".au-crash summary b").textContent, m.link_unit_trust_why());
	assert.equal(one(trust, ".au-crash pre").textContent, "An ally run crashed: No trust decision for /work/p");
	assert.equal(one(trust, ".au-hint").hidden, false);
	assert.equal(one(trust, ".au-hint").textContent, m.link_unit_trust_hint());
	assert.ok(one(trust, ".au-crash").hasAttribute("data-trust"));
	const crashed = draw([card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at, text: "An ally run crashed: exit 1" } })]);
	assert.equal(one(crashed, ".au-crash summary b").textContent, m.link_unit_crash());
	assert.equal(one(crashed, ".au-hint").hidden, true);
	assert.equal(one(crashed, ".au-crash").hasAttribute("data-trust"), false);
	// The same element redrawn from a trust notice to a crash drops the hint.
	fillAllyUnits(trust as unknown as HTMLElement, [card({ tone: "crashed", word: m.link_unit_crashed(), state: "standing", crash: { at, text: "An ally run crashed: exit 1" } })], false);
	assert.equal(one(trust, ".au-hint").hidden, true);
	assert.equal(one(trust, ".au-crash summary b").textContent, m.link_unit_crash());
});

// The card itself (gui/render.ts `fillAlly`): the box's own mains and workers are never listed, and the card says one state, the units'.
const ally = (over: object = {}) => ({ id: "ally/t/d1", team: "t", teamName: "moldplan", device: "d1", short: "9f3a1c", label: "ci-box", online: true, workspace: null, tower: "working", tabs: [{ label: "main \u00b7 trial13", state: "working" }, { label: "worker \u00b7 scout", state: "idle" }], ...over });
const link = (units: object[] = []) => ({ allies: [], alerts: [], confirms: [], units: units.length ? [{ team: "t", device: "d1", at: Date.now() - 5_000, units }] : [] });
const unit = (name: string, state = "standing") => ({ unit: name, state, monitors: [], report: "" });
async function drawn(a: object, l: object) {
	const { allyEl, fillAlly } = await import("../gui/render.ts");
	const el = allyEl() as unknown as El;
	page.body.replaceChildren(el);
	fillAlly(el as unknown as HTMLElement, a as never, l as never);
	return el;
}

test("ALLY-F005/F009: a card that has units lists no tab of the box; one without says how many units are online in one line, never their names", async () => {
	const withUnits = await drawn(ally(), link([unit("Quarry Tools"), unit("Lighthouse Web")]));
	assert.equal(withUnits.querySelectorAll(".ally-tab").length, 0, "the units are the card's content, the box's mains are not listed beside them");
	await until(() => withUnits.querySelectorAll(".ally-unit").length === 2, "the units");
	assert.ok(!withUnits.dump().includes("trial13") && !withUnits.dump().includes("scout"));
	const none = await drawn(ally(), link());
	const rows = none.querySelectorAll(".ally-tab");
	assert.equal(rows.length, 1, "no unit status (an older box, a presence-only team, the minute after a restart): one summary line");
	assert.equal(rows[0]!.textContent, m.link_unit_summary({ count: 2 }));
	assert.ok(!none.dump().includes("trial13") && !none.dump().includes("scout"), "no main or worker is named");
	assert.equal((await drawn(ally({ tabs: [{ label: "main", state: "idle" }] }), link())).querySelectorAll(".ally-tab")[0]!.textContent, m.link_unit_summary({ count: 1 }));
	assert.equal((await drawn(ally({ tabs: [] }), link())).querySelectorAll(".ally-tab").length, 0, "nothing online, nothing said");
	assert.equal((await drawn(ally({ online: false }), link())).querySelectorAll(".ally-tab").length, 0, "an offline box says nothing about units");
	assert.equal((await drawn(ally({ tower: "blocked" }), link())).querySelectorAll(".ally-tab")[0]!.dataset.state, "blocked", "a question that waits keeps the line a way into the panel");
});

test("ALLY-F008: once the card shows units, its subtitle names the box and whether it is there and not what its tower does; without units it says that too", async () => {
	const withUnits = await drawn(ally({ workspace: "Harbor API" }), link([unit("Harbor API", "standing")]));
	assert.equal(one(withUnits, ".tstate").textContent, "ci-box \u00b7 9f3a1c", "the unit's own word is the card's only state");
	assert.equal(one(await drawn(ally({ workspace: "Harbor API", online: false }), link([unit("Harbor API")])), ".tstate").textContent, `ci-box \u00b7 9f3a1c \u00b7 ${m.link_offline()}`);
	assert.equal(one(await drawn(ally(), link()), ".tstate").textContent, `9f3a1c \u00b7 ${m.mark_working()}`, "with no units the tower's state stands in");
});
