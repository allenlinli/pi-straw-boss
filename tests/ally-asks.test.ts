import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkAlert } from "../src/link/holder.ts";
import { El, page } from "./fake-dom.ts";

// The questions an unattended device forwarded, answered on its ally base's card in Standard (gui/allyasks.ts; docs/how-it-works.md, Unattended devices: Asking back): a button under the card's rows opens the shared question panel,
// the card's waiting rows do too, and an answer goes where the Link notices and Zen's card send it. On a fake document, with the real panel.

const { mountAllyAsks } = await import("../gui/allyasks.ts");
const { m } = await import("../gui/paraglide/messages.js");

const QUESTIONS = [{ question: "Which env?", header: "Env", multiple: false, options: [{ title: "staging" }, { title: "production" }] }];
const ask = (dialogId: string, data: LinkAlert["data"] = {}): LinkAlert => ({ id: `dialog/d1/${dialogId}`, kind: "dialog", level: "warning", team: "t1", teamName: "moldplan", data: { device: "d1", dialogId, digest: "a".repeat(64), owner: "subagent - scout", dialog: JSON.stringify({ questions: QUESTIONS, cancel: true }), label: "waydosoft", short: "n2knna", answered: 0, ...data } });
const card = () => {
	const el = new El("section"), row = new El("li");
	row.className = "ally-unit";
	row.setAttribute("data-state", "blocked");
	const quiet = new El("li");
	quiet.className = "ally-unit";
	quiet.setAttribute("data-state", "working");
	el.append(row, quiet);
	page.body.replaceChildren(el);
	return { el, row, quiet };
};
const server = () => {
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	Object.assign(globalThis, { document: page, fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => ({}) }) });
	return sent;
};
const button = (el: El) => el.all((x) => x.tag === "button" && x.hasAttribute("aria-expanded"))[0]!;
const panel = (el: El) => el.all((x) => x.classes.has("ask"))[0];

test("a card with a question gets a button that says how many wait; the panel is closed until it is pressed, and pressed again it closes", () => {
	const asks = mountAllyAsks(), { el } = card();
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	assert.equal(el.dataset.asks, "1");
	assert.equal(button(el).textContent, m.ally_asks_button({ count: 1 }));
	const list = el.all((x) => x.classes.has("ally-asks-list"))[0]!;
	assert.equal(list.hidden, true, "closed");
	button(el).click();
	assert.deepEqual([list.hidden, button(el).getAttribute("aria-expanded"), el.dataset.asking !== undefined], [false, "true", true]);
	assert.ok(panel(el), "the shared question panel is in it");
	assert.ok(el.textContent.includes("Which env?") && el.textContent.includes("staging"));
	button(el).click();
	assert.deepEqual([list.hidden, button(el).getAttribute("aria-expanded")], [true, "false"]);
});

test("a row of the card that waits opens the panel too; a row that does not changes nothing", () => {
	const asks = mountAllyAsks(), { el, row, quiet } = card();
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	quiet.click();
	assert.equal(el.dataset.asking, undefined);
	row.click();
	assert.notEqual(el.dataset.asking, undefined);
	asks.fill(el as unknown as HTMLElement, []);
	row.click();
	assert.equal(el.dataset.asking, undefined, "with no question a waiting row opens nothing");
});

test("a press on a fold inside a waiting row (its report, a crash's notice) opens the fold and not the panel", () => {
	const asks = mountAllyAsks(), { el, row } = card();
	const fold = new El("details"), summary = new El("summary");
	fold.append(summary);
	row.append(fold);
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	summary.click();
	assert.equal(el.dataset.asking, undefined, "the fold's own press");
	row.click();
	assert.notEqual(el.dataset.asking, undefined, "the row's own press still opens it");
});

test("an answer in place goes to link/dialog-answer with the device, the dialog and its digest, as the Link notices and Zen send it", async () => {
	const sent = server(), asks = mountAllyAsks(), { el } = card();
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	button(el).click();
	el.all((x) => x.getAttribute("role") === "radio")[1]!.click();
	el.all((x) => x.tag === "button" && x.textContent === m.send_answer())[0]!.click();
	await new Promise((done) => setImmediate(done));
	assert.deepEqual(sent, [{ path: "api/link/dialog-answer", body: { device: "d1", dialogId: "A", digest: "a".repeat(64), answer: { answers: [{ choices: [1] }] } } }]);
});

test("a snapshot that draws the same question again keeps the panel, what was picked, and the open state; another question is another row", () => {
	const asks = mountAllyAsks(), { el } = card();
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	button(el).click();
	el.all((x) => x.getAttribute("role") === "radio")[0]!.click();
	const first = panel(el), box = el.all((x) => x.classes.has("ally-asks"))[0]!;
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	assert.equal(panel(el), first, "the same panel element");
	assert.equal(el.all((x) => x.getAttribute("role") === "radio")[0]!.getAttribute("aria-checked"), "true", "the pick stays");
	assert.equal(el.dataset.asking !== undefined, true);
	asks.fill(el as unknown as HTMLElement, [ask("A"), ask("B")]);
	assert.equal(el.dataset.asks, "2");
	assert.equal(button(el).textContent, m.ally_asks_button({ count: 2 }));
	assert.equal(el.all((x) => x.classes.has("link-alert")).length, 2);
	assert.equal(el.all((x) => x.classes.has("ally-asks"))[0], box, "one box");
});

test("when the question is gone the card has no button and no mark, and the next one starts closed", () => {
	const asks = mountAllyAsks(), { el } = card();
	asks.fill(el as unknown as HTMLElement, [ask("A")]);
	button(el).click();
	asks.fill(el as unknown as HTMLElement, []);
	assert.deepEqual([el.dataset.asks, el.dataset.asking], [undefined, undefined]);
	assert.equal(el.all((x) => x.classes.has("ally-asks"))[0]!.hidden, true);
	asks.fill(el as unknown as HTMLElement, [ask("B")]);
	assert.equal(el.all((x) => x.classes.has("ally-asks-list"))[0]!.hidden, true, "closed again");
	const other = card().el;
	asks.fill(other as unknown as HTMLElement, []);
	assert.equal(other.all((x) => x.classes.has("ally-asks")).length, 0, "a card that never had a question gets nothing");
});

test("show hands a card the questions of its own device out of the Link summary, and only that card", () => {
	const asks = mountAllyAsks(), mine = card().el, other = card().el;
	const base = { team: "t1", teamName: "moldplan", device: "d1", short: "n2knna", label: "waydosoft", online: true, tower: "blocked", tabs: [] };
	const link = { allies: [{ ...base, id: "t1/d1/trial11", workspace: "trial11" }, { ...base, id: "t1/d2/other", device: "d2", workspace: "other" }], alerts: [ask("A")], confirms: [], units: [] };
	asks.show(mine as unknown as HTMLElement, { id: "d1/trial11" }, link);
	asks.show(other as unknown as HTMLElement, { id: "d2/other" }, link);
	assert.deepEqual([mine.dataset.asks, other.dataset.asks], ["1", undefined]);
});

// The map's own path: a card the page draws for an ally base (gui/render.ts) hosts its device's question, as the real page does, where the card's id is `ally/<base id>`.
test("the map draws a question on the card of its device's base, keyed ally/<id> as the page keys it, and on no other card", async () => {
	const { allyEl, fillAlly } = await import("../gui/render.ts");
	const sent = server();
	const base = { team: "t1", teamName: "moldplan", device: "d1", short: "n2knna", label: "waydosoft", online: true, workspace: "trial11", tower: "blocked", tabs: [{ label: "main", state: "blocked" }] };
	const link = { allies: [{ ...base, id: "t1/d1/trial11" }, { ...base, id: "t1/d2/other", device: "d2", workspace: "other" }], alerts: [ask("A")], confirms: [], units: [] };
	const card = (a: (typeof link.allies)[number], id: string) => ({ ...a, id, teams: [{ team: a.team, teamName: a.teamName }] });
	const mine = allyEl(), other = allyEl();
	fillAlly(mine, card(link.allies[0]!, "ally/d1/trial11") as never, link as never);
	fillAlly(other, card(link.allies[1]!, "ally/d2/other") as never, link as never);
	await new Promise((done) => setTimeout(done, 20)); // the panel's chunk loads on the first question
	fillAlly(mine, card(link.allies[0]!, "ally/d1/trial11") as never, link as never);
	assert.deepEqual([(mine as unknown as El).dataset.asks, (other as unknown as El).dataset.asks], ["1", undefined]);
	void sent;
});

// A device in two teams is one card, and what it hosts is answered on the team the question came on: the row says which team that is.
test("a device in two teams hosts one card, the question names the team it came on, and the answer goes with that question's own digest and device", async () => {
	const { mergeAllies } = await import("../gui/linkmodel.ts");
	const sent = server();
	const base = { device: "d1", short: "n2knna", label: "waydosoft", online: true, workspace: "trial11", tower: "blocked", tabs: [] };
	const link = { allies: [{ ...base, id: "t1/d1/trial11", team: "t1", teamName: "moldplan" }, { ...base, id: "t2/d1/trial11", team: "t2", teamName: "agent-tower-team" }], alerts: [{ ...ask("B"), id: "dialog/d1/B2", team: "t2", teamName: "agent-tower-team" }], confirms: [], units: [] };
	const cards = mergeAllies(link.allies);
	assert.equal(cards.length, 1);
	const asks = mountAllyAsks(), el = card().el;
	asks.show(el as unknown as HTMLElement, cards[0]!, link);
	assert.equal(el.dataset.asks, "1", "one card, one host");
	const row = el.all((x) => x.classes.has("link-alert"))[0]!;
	assert.ok(row.dump().includes("agent-tower-team"), "the row names the team the question came on");
	assert.ok(!row.dump().includes("moldplan"), "and not the other");
	void sent;
});

test("a question prefers a card of the team it came on, and falls back to the device's other cards", async () => {
	const { asksOf } = await import("../gui/allyasks.ts");
	const base = { device: "d1", short: "n2knna", label: "waydosoft", online: true, tower: "idle", tabs: [] };
	const allies = [{ ...base, id: "t1/d1/W1", team: "t1", teamName: "moldplan", workspace: "W1" }, { ...base, id: "t2/d1/W2", team: "t2", teamName: "agent-tower-team", workspace: "W2" }];
	const dialog = (team: string) => ({ ...ask("B"), id: "dialog/d1/B", team, teamName: team });
	assert.deepEqual([...asksOf({ allies, alerts: [dialog("t2")] } as never).keys()], ["d1/W2"]);
	assert.deepEqual([...asksOf({ allies, alerts: [dialog("t1")] } as never).keys()], ["d1/W1"]);
	assert.deepEqual([...asksOf({ allies, alerts: [dialog("t9")] } as never).keys()], ["d1/W1"], "a team with no card: the device's first");
});
