import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page } from "./fake-dom.ts";

// The fake DOM's own contract, where the gui's code leans on the real one's: focus leaves a removed node, `dataset` and `data-*` are one thing, `classList` takes several tokens.

test("focus falls to the body when the focused node, or one above it, leaves the page", () => {
	const root = new El("div"), box = new El("div"), input = new El("input");
	page.body.replaceChildren(root);
	root.append(box);
	box.append(input);
	input.focus();
	assert.equal(page.activeElement, input);
	input.remove();
	assert.equal(page.activeElement, page.body, "remove()");
	box.append(input);
	input.focus();
	box.remove();
	assert.equal(page.activeElement, page.body, "an ancestor's remove()");
	root.append(box);
	input.focus();
	root.replaceChildren();
	assert.equal(page.activeElement, page.body, "replaceChildren() over an ancestor");
	root.append(box);
	input.focus();
	root.replaceChildren(new El("p"));
	assert.equal(page.activeElement, page.body, "replaceChildren() with something else");
	const other = new El("button");
	root.append(other);
	other.focus();
	input.remove();
	assert.equal(page.activeElement, other, "a node that is not the focused one's ancestor leaves the focus alone");
});

test("dataset is a view over the data-* attributes, both ways, camelCase against kebab-case", () => {
	const el = new El("div");
	el.dataset.zenAway = "";
	assert.equal(el.getAttribute("data-zen-away"), "", "dataset.x = reaches the attribute");
	assert.ok(el.matches("[data-zen-away]"), "and the selector");
	el.setAttribute("data-more", "1");
	assert.equal(el.dataset.more, "1", "setAttribute reaches the dataset");
	el.removeAttribute("data-more");
	assert.equal(el.dataset.more, undefined, "removeAttribute reaches it as well");
	el.toggleAttribute("data-dim", true);
	assert.equal(el.dataset.dim, "", "toggleAttribute on");
	el.toggleAttribute("data-dim");
	assert.equal(el.dataset.dim, undefined, "toggleAttribute off");
	delete el.dataset.zenAway;
	assert.equal(el.hasAttribute("data-zen-away"), false, "delete removes the attribute");
	el.dataset.mark = "waiting";
	assert.deepEqual(Object.entries(el.dataset), [["mark", "waiting"]]);
	assert.ok(el.dump().includes("waiting"), "dump reads it");
	el.dataset.n = 3 as never;
	assert.equal(el.dataset.n, "3", "a value is a string");
});

test("classList adds, removes, and toggles several tokens at once", () => {
	const el = new El("div");
	el.classList.add("a", "b", "c");
	assert.equal(el.className, "a b c");
	el.classList.remove("a", "c");
	assert.equal(el.className, "b");
	el.classList.add("b", "d");
	assert.equal(el.className, "b d", "a token already there is not doubled");
	assert.equal(el.classList.toggle("b"), false);
	assert.equal(el.classList.toggle("e", true), true);
	assert.equal(el.className, "d e");
});
