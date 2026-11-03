import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { selectDigest } from "../src/owners.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// How the overlay layer (gui/layer.ts) wires an alert's dialog to the answer core: the dock's dialog may answer only while the stream is live, an answer goes by the demo
// fixture's route when the page has one, and a project trust question goes by the fixture's trust route in Standard too. The panels' insides are ask.ts's and trust.ts's own tests.

sessionGlobals();
const fetched: string[] = [];
Object.assign(globalThis, {
	HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000,
	fetch: async (url: string) => (fetched.push(url), { ok: true, status: 200, json: async () => ({ outcome: "accepted" }) }),
});
const { mountPanels } = await import("../gui/layer.ts");

const SELECT = { title: "MCP: scratch wants to run echo", choices: [{ label: "Allow once" }, { label: "Deny" }] };
const pending: Pending = { callId: "c1", tool: "dialog", answer: { dialog: "m1", digest: selectDigest(SELECT), select: SELECT } };
const settle = () => new Promise((done) => setImmediate(done));
const alert = { key: "u1", ws: "w", name: "Ada", role: "main", mark: "waiting" as const, at: 1, pending };
const trust = { key: "trust:/p", ws: "", name: "p", role: "none", mark: "waiting" as const, at: 1, trust: { id: "t1", digest: "d", folder: "/p", found: [], agents: [], opening: undefined } };

let dock: El;
const calls = { posts: [] as string[], trusts: [] as unknown[], shown: [] as string[] };
const mount = () => {
	page.body.replaceChildren();
	delete page.body.dataset.stale;
	for (const id of ["dock", "work", "tiles", "tile-tabs", "alerts", "done", "done-pop", "done-list", "done-clear"]) {
		const el = new El(id === "alerts" || id === "done" || id === "done-clear" ? "button" : "div");
		el.id = id;
		page.body.append(el);
		if (id === "dock") dock = el;
		if (id === "alerts") for (const [tag, cls, ident] of [["b", "", "alert-count"], ["span", "", "alert-text"], ["span", "faces", ""]] as const) Object.assign(el.appendChild(new El(tag)), { id: ident }).setAttribute("class", cls);
	}
	Object.assign(page.body.find((el) => el.id === "done-pop")[0]!, { matches: () => false, hidePopover() {}, getClientRects: () => [] });
	return mountPanels({
		label: (ws) => ws, recent: async () => [], stream: () => "s1", showTerminal: (_ws, key) => void calls.shown.push(key),
		post: (key) => (action, body) => (calls.posts.push(`${key} ${action} ${body.dialog}`), Promise.resolve({ ok: true, status: 200, body: { outcome: "accepted" } })),
		trust: (body) => (calls.trusts.push(body), Promise.resolve({ ok: true, status: 200, body: { outcome: "accepted" } })),
	});
};
beforeEach(() => {
	fetched.length = 0;
	[calls.posts, calls.trusts, calls.shown] = [[], [], []];
});
const send = () => dock.all((el) => el.tagName === "button" && el.textContent === "Send answer")[0];
const choice = (i: number) => dock.all((el) => el.getAttribute("role") === "radio")[i]!;

test("the dock's dialog answers only while the stream is live: a stale page disables its choices, and the stream's return enables them", () => {
	const layer = mount();
	layer.alerts([alert], new Map([[alert.key, alert]]));
	layer.stack.show(alert);
	assert.deepEqual([choice(0).disabled, choice(1).disabled], [false, false]);
	page.body.dataset.stale = "true";
	layer.stack.redraw();
	assert.deepEqual([choice(0).disabled, choice(1).disabled], [true, true], "a stream that is not live");
	page.body.dataset.stale = "false";
	layer.stack.redraw();
	assert.deepEqual([choice(0).disabled, choice(1).disabled], [false, false], "and the stream's return enables them");
});

test("an answer from the dock's dialog goes by the page's fixture route when it has one, never to the server", async () => {
	const layer = mount();
	layer.alerts([alert], new Map([[alert.key, alert]]));
	layer.stack.show(alert);
	choice(0).click();
	send()!.click();
	await settle();
	assert.deepEqual([calls.posts, fetched], [["u1 answer m1"], []]);
});

test("a project trust question's dialog is disabled on a stale page before anything is answered, and the stream's return enables it", () => {
	const layer = mount();
	layer.alerts([trust as never], new Map([[trust.key, trust as never]]));
	page.body.dataset.stale = "true";
	layer.stack.show(trust as never);
	const choices = () => dock.all((el) => el.getAttribute("data-choice") !== null);
	assert.equal(choices().length, 3);
	assert.ok(choices().every((b) => b.disabled), "no trust answer while the stream is not live");
	page.body.dataset.stale = "false";
	layer.stack.redraw();
	assert.ok(choices().every((b) => !b.disabled), "and the stream's return enables them");
	page.body.dataset.stale = "true";
	layer.stack.redraw();
	assert.ok(choices().every((b) => b.disabled), "a stream that drops again disables them again");
});

test("a project trust question's dialog answers through the fixture's trust route too, never to the server", async () => {
	const layer = mount();
	layer.alerts([trust as never], new Map([[trust.key, trust as never]]));
	layer.stack.show(trust as never);
	const choices = () => dock.all((el) => el.getAttribute("data-choice") !== null);
	assert.equal(choices().length, 3);
	choices()[0]!.click();
	await settle();
	assert.deepEqual([calls.trusts.length, fetched], [1, []]);
});
