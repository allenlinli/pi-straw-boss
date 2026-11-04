import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, TowerService } from "../src/net.ts";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { El, sessionGlobals, stored } from "./fake-dom.ts";

// The head page and its entries (docs/specs/2026-11-04-head-tower.md, Standard: the head page and its entries; H4): the header's crown button and its dot, the asks as chips under the conversation box, the state line, the absent state,
// and the head found by the session view as the unit it is. In both languages. The pictures of every state are taken by hand from the demo (`?head=`).

sessionGlobals();
const { askChips, fillHeadAsks, fillHeadButton, fillHeadTitle, headDot, headLine, remember, seenAt, SEEN } = await import("../gui/headpage.ts");
const { locate } = await import("../gui/scene.ts");
const { towerRoute } = await import("../gui/towermodel.ts");
const { formatRoute, parseRoute } = await import("../gui/router.ts");
const { m } = await import("../gui/paraglide/messages.js");
const zh = { locale: "zh-TW" } as const;

const NOW = Date.parse("2026-11-04T10:00:00Z");
const ask = (over: Partial<HeadAskRow> = {}): HeadAskRow => ({ id: "H1", workspace: "wA", label: "MP Center", at: NOW - 12 * 60_000, open: true, ...over });
const svc = (over: Partial<TowerService> = {}): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], ...over });
const head = (over: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "standing", service: svc(), asks: [], ...over });
const btn = () => {
	const b = new El("button"), dot = new El("i");
	dot.className = "dot";
	b.append(dot);
	return { b: b as unknown as HTMLElement, dot };
};

test("the dot is on while the head said something newer than this device has seen, and never for a head that said nothing", () => {
	assert.equal(headDot(head({ said: 2000 }), 1000), true);
	assert.equal(headDot(head({ said: 1000 }), 1000), false, "seen up to it");
	assert.equal(headDot(head({ said: 1000 }), 2000), false);
	assert.equal(headDot(head(), 0), false, "nothing said");
	assert.equal(headDot(undefined, 0), false, "no head on the net");
	assert.equal(seenAt(), 0, "a device that never opened the page has seen nothing");
	remember(5000);
	assert.equal(stored.get(SEEN), "5000");
	assert.equal(seenAt(), 5000);
	remember(3000);
	assert.equal(seenAt(), 5000, "what was seen never goes back");
	stored.set(SEEN, "garbage");
	assert.equal(seenAt(), 0);
	stored.delete(SEEN);
});

test("the header's button is there while the net has a head, carries its state, and shows the dot only when there is news and the page is not the head page", () => {
	const { b, dot } = btn();
	fillHeadButton(b, undefined, 0, false);
	assert.equal(b.hidden, true, "no head on the net (the tower service is off): no button");
	fillHeadButton(b, head({ said: 2000, mark: "working", state: "running" }), 1000, false);
	assert.deepEqual([b.hidden, dot.hidden, b.dataset.mark, b.dataset.state], [false, false, "working", "running"]);
	fillHeadButton(b, head({ said: 2000 }), 1000, true);
	assert.equal(dot.hidden, true, "on the head page what it said is read");
	assert.equal(b.getAttribute("aria-current"), "page");
	fillHeadButton(b, head({ said: 2000 }), 2000, false);
	assert.deepEqual([dot.hidden, b.hasAttribute("aria-current")], [true, false]);
	fillHeadButton(b, head({ state: "absent" }), 0, false);
	assert.deepEqual([b.hidden, b.dataset.state], [false, "absent"], "the button opens the page before the head exists: its first message opens the head");
	assert.match(b.title, /Head tower/);
	assert.doesNotMatch((b as unknown as El).dump(), /\d/, "a dot, never a number");
});

test("an ask is a chip: the workspace, how long ago, and open or answered; it links to that tower's comms when the net knows the tower, in both languages", () => {
	const net = { bases: [{ id: "wA", label: "MP Center", mark: "idle", tower: { key: "sb-tower-wa", name: "tower · MP Center" }, tabs: [], outposts: [], outside: [] }] } as unknown as Net;
	const chips = askChips([ask(), ask({ id: "H2", workspace: "wB", label: "Beta", open: false, at: NOW - 3 * 3600_000, last: "landed" })], NOW, net);
	assert.deepEqual(chips.map((c) => [c.id, c.text, c.open, c.route]), [
		["H1", "MP Center · 12m · open", true, "w/wA/s/sb-tower-wa"],
		["H2", "Beta · 3h · answered", false, undefined],
	]);
	assert.equal(chips[1]!.title, "landed", "the first line of the answer is the tooltip");
	assert.deepEqual(askChips([ask()], NOW, net, zh).map((c) => c.text), ["MP Center・12m・交辦中"]);
	assert.deepEqual(askChips([ask({ open: false })], NOW, net, zh).map((c) => c.text), ["MP Center・12m・已回覆"]);
	assert.deepEqual(askChips([], NOW, net), []);
});

test("the asks fill under the conversation box: a chip each, links where the tower is known, redrawn only when they change, hidden with none", () => {
	const net = { bases: [{ id: "wA", label: "MP Center", mark: "idle", tower: { key: "sb-tower-wa", name: "t" }, tabs: [], outposts: [], outside: [] }] } as unknown as Net;
	const box = new El("div");
	const el = box as unknown as HTMLElement;
	fillHeadAsks(el, head({ asks: [] }), net, NOW);
	assert.equal(box.hidden, true);
	fillHeadAsks(el, head({ asks: [ask(), ask({ id: "H2", workspace: "wB", label: "Beta", open: false })] }), net, NOW);
	assert.equal(box.hidden, false);
	const chips = box.querySelectorAll(".head-ask");
	assert.deepEqual(chips.map((c) => [c.tagName, c.dataset.open, c.textContent]), [["a", "true", "MP Center · 12m · open"], ["span", "false", "Beta · 12m · answered"]]);
	assert.equal(chips[0]!.getAttribute("data-route"), "w/wA/s/sb-tower-wa");
	const first = chips[0];
	fillHeadAsks(el, head({ asks: [ask(), ask({ id: "H2", workspace: "wB", label: "Beta", open: false })] }), net, NOW + 20_000);
	assert.equal(box.querySelectorAll(".head-ask")[0], first, "the same asks leave the chips as they are, so a click never lands on a replaced one");
	fillHeadAsks(el, undefined, net, NOW);
	assert.equal(box.hidden, true);
	assert.equal(box.kids.length, 0);
});

test("the header says Head tower with its state, or that the first message opens it; the title is the same in zh-TW", () => {
	assert.equal(headLine(head({ state: "absent", service: undefined })), m.head_state_absent());
	assert.equal(headLine(head({ state: "absent", service: undefined })), "not open");
	assert.equal(headLine(head({ state: "absent", service: undefined }), zh), "尚未開啟");
	assert.match(headLine(head({ mark: "idle" })), /standing by/);
	assert.equal(m.head_tower(), "Head tower");
	assert.equal(m.head_tower({}, zh), "主塔台");
	const root = new El("div"), icon = new El("use"), title = new El("span"), small = new El("small"), line = new El("p"), absent = new El("p");
	icon.className = "head-icon"; title.className = "head-title"; small.className = "head-kicker"; line.className = "head-line"; absent.className = "head-absent";
	root.append(icon, title, small, line, absent);
	fillHeadTitle(root as unknown as HTMLElement, head({ state: "absent", service: undefined }));
	assert.deepEqual([title.textContent, small.textContent, absent.hidden, absent.textContent, icon.getAttribute("href")], ["Head tower", "", false, "The head tower opens with your first message", "#i-crown"]);
	fillHeadTitle(root as unknown as HTMLElement, head({ state: "standing" }));
	assert.equal(absent.hidden, true, "the line is for the head that is not open");
});

test("the session view finds the head by its key as a tower of its own: a stand-in base that is not a base of the net, no Quit tower, and its buttons are api/head/…", () => {
	const net = { bases: [], head: head({ mark: "working", queued: [{ text: "boss: ship it", as: "followUp" }] }) } as unknown as Net;
	const hit = locate(net, "sb-head")!;
	assert.deepEqual([hit.u.key, hit.u.name, hit.u.role, hit.u.mark, hit.u.control], ["sb-head", "head tower", "tower", "working", true]);
	assert.equal(hit.base.id, "@head");
	assert.equal(hit.base.tower, null, "no +Main and no Quit tower: the stand-in has no tower of the base's kind");
	assert.deepEqual(hit.u.queued, [{ text: "boss: ship it", as: "followUp" }]);
	assert.equal(locate({ bases: [] } as unknown as Net, "sb-head"), undefined, "no head on the net");
	assert.equal(locate(net, "sb-other"), undefined);
	assert.equal(towerRoute("@head"), "head");
	assert.equal(towerRoute("wA"), "tower/wA");
	assert.equal(towerRoute("a/b"), "tower/a%2Fb");
	assert.equal(formatRoute({ view: "session", ws: "@head", key: "sb-head" }), "head");
	assert.deepEqual(parseRoute("head"), { view: "head" });
});

test("a chapter divider of the head's history is a chapter divider, not a branch summary: when the chapter began and why, in the page's language; the two other dividers read as they did", async () => {
	const { mountChat } = await import("../gui/chat.ts");
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "sb-head", name: "head tower", role: "tower", mark: "idle" as const }), link: () => undefined });
	chat.apply({ key: "sb-head", reset: true, items: [
		{ id: "chapter-1", kind: "divider", type: "chapter", at: "2026-11-01T08:00:00Z", text: "the first conversation" },
		{ id: "k1", kind: "divider", type: "compaction", tokens: 1234, text: "summary" },
		{ id: "b1", kind: "divider", type: "branch", text: "a branch" },
	] });
	const rules = root.find((el) => el.tag === "article" && el.classes.has("rule"));
	assert.equal(rules.length, 3);
	assert.match(rules[0]!.textContent, /^New chapter · .*2026.* · the first conversation$/, rules[0]!.textContent);
	assert.ok(rules[0]!.classes.has("chapter"));
	assert.doesNotMatch(rules[0]!.textContent, /branch summary/);
	assert.equal(rules[0]!.find((el) => el.tag === "details").length, 0, "a chapter marker folds nothing: its why is its line");
	assert.match(rules[1]!.textContent, /context compacted/);
	assert.match(rules[2]!.textContent, /branch summary/);
});
