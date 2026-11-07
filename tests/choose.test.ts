import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page } from "./fake-dom.ts";
import { until } from "./fakes.ts";

// `choose` (gui/quit.ts), the page's confirm with more than one yes: a Cancel and one button per choice, in order. The remote Stop's sheet is its one user, with Stop and Interrupt and stop. The DOM is the fake one,
// with a dialog that has `showModal` (it takes no focus of its own: what the sheet asks for is what the test sees) and `close` (which queues the `close` event, as a browser does).

class Dialog extends El {
	open = false;
	showModal() {
		this.open = true;
	}
	close() {
		this.open = false;
		setTimeout(() => this.dispatchEvent({ type: "close" }), 0); // a browser queues the event as a task: the click's own answer comes first
	}
}
const make = page.createElement;
page.createElement = (tag: string) => (tag === "dialog" ? new Dialog("dialog") : make(tag));

const { choose } = await import("../gui/quit.ts");
const { m } = await import("../gui/paraglide/messages.js");

const CHOICES = [{ label: "Stop", value: "quit" }, { label: "Interrupt and stop", value: "interrupt", tone: "danger" as const }];
const sheet = () => page.body.find((el) => el instanceof Dialog)[0] as Dialog;
const buttons = () => sheet().querySelectorAll("button");

test("the sheet is Cancel first, then each choice in order, and Cancel has the focus: Enter or a stray tap does not stop a main", async () => {
	page.body.replaceChildren();
	const answer = choose("Stop docs?", CHOICES);
	assert.deepEqual(buttons().map((b) => b.textContent), [m.cancel(), "Stop", "Interrupt and stop"]);
	assert.equal(page.activeElement, buttons()[0], "Cancel is focused");
	buttons()[0]!.click();
	assert.equal(await answer, undefined);
	await until(() => page.body.find((el) => el instanceof Dialog).length === 0, "the sheet is gone");
});

test("a choice resolves its value, and the danger choice is drawn heavier than the plain one by a class of its own, not by colour alone", async () => {
	page.body.replaceChildren();
	const answer = choose("Stop docs?", CHOICES);
	const [cancel, stop, interrupt] = buttons();
	assert.ok(stop!.classes.has("sheet-yes") && interrupt!.classes.has("sheet-yes"), "both are yes buttons");
	assert.ok(interrupt!.classes.has("sheet-danger") && !stop!.classes.has("sheet-danger") && !cancel!.classes.has("sheet-danger"));
	interrupt!.click();
	assert.equal(await answer, "interrupt");
	page.body.replaceChildren();
	const plain = choose("Stop docs?", CHOICES);
	buttons()[1]!.click();
	assert.equal(await plain, "quit");
});

test("Escape (the dialog closing by itself) resolves undefined", async () => {
	page.body.replaceChildren();
	const answer = choose("Stop docs?", CHOICES);
	sheet().dispatchEvent({ type: "close" });
	assert.equal(await answer, undefined);
});

test("the question and the labels are text: markup in a box's or a main's name is not parsed", async () => {
	page.body.replaceChildren();
	const text = `Stop <img src=x onerror=alert(1)> on <b>box</b>?`;
	const answer = choose(text, [{ label: "<i>Stop</i>", value: "quit" }]);
	const p = sheet().querySelector("p")!;
	assert.equal(p.textContent, text);
	assert.deepEqual(p.kids, [text], "one text node, no elements");
	assert.equal(buttons()[1]!.textContent, "<i>Stop</i>");
	assert.equal(sheet().querySelectorAll("img").length + sheet().querySelectorAll("b").length + sheet().querySelectorAll("i").length, 0);
	buttons()[1]!.click();
	await answer;
});

test("with no choice it is a notice with Close, as before", async () => {
	page.body.replaceChildren();
	const answer = choose("Refused", []);
	assert.deepEqual(buttons().map((b) => b.textContent), [m.close()]);
	buttons()[0]!.click();
	assert.equal(await answer, undefined);
});
