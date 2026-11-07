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
let netNow: unknown;
const mount = () => {
	netNow = undefined;
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
		label: (ws) => ws, net: () => netNow as never, recent: async () => [], stream: () => "s1", showTerminal: (_ws, key) => void calls.shown.push(key),
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

test("a dock dialog the page cannot answer sends the user to the unit's terminal: Show terminal asks the page to show that unit's terminal", () => {
	const layer = mount();
	const readonly = { ...alert, pending: { callId: "c4", tool: "ask_user_question", why: "Two dialogs are open." } as Pending };
	layer.alerts([readonly], new Map([[readonly.key, readonly]]));
	layer.stack.show(readonly);
	assert.equal(send(), undefined, "nothing to answer here");
	const show = dock.all((el) => el.tagName === "button" && el.textContent === "Show terminal")[0];
	assert.ok(show, "the dialog offers the terminal");
	show.click();
	assert.deepEqual(calls.shown, ["u1"], "the unit's terminal");
});

const boxNet = (state: "live" | "unreachable" | "ended" | undefined) => ({ bases: [{ id: "w", label: "Work", mark: "idle", tower: null, tabs: [{ id: "t1", label: "t", units: [{ id: "u1", key: "u1", control: true, name: "Ada", role: "main", mark: "waiting", subs: [] }] }], outposts: [], outside: [], ...(state ? { box: { device: "dev1", short: "a1b2c3", label: "agent-tower-01", team: "moldplan", scope: "team", can: ["input"], state, ...(state === "unreachable" ? { seen: 1 } : {}) } } : {}) }] });

test("the dock's dialog of a remote base's unit is off while its box is unreachable or ended, with the reason shown; a live box and a local base answer, and the next snapshot follows the box", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const layer = mount();
		netNow = boxNet(state);
		layer.alerts([alert], new Map([[alert.key, alert]]), netNow as never);
		layer.stack.show(alert);
		assert.deepEqual([choice(0).disabled, choice(1).disabled], [off, off], String(state));
		assert.equal(dock.textContent.includes(m.box_answer_blocked()), off, `${state}: the reason`);
	}
	const layer = mount();
	netNow = boxNet("live");
	layer.alerts([alert], new Map([[alert.key, alert]]), netNow as never);
	layer.stack.show(alert);
	netNow = boxNet("unreachable");
	layer.alerts([], new Map([[alert.key, alert]]), netNow as never);
	assert.deepEqual([choice(0).disabled, choice(1).disabled], [true, true], "the box went away: the open dialog follows the next snapshot");
	netNow = boxNet("live");
	layer.alerts([], new Map([[alert.key, alert]]), netNow as never);
	assert.deepEqual([choice(0).disabled, choice(1).disabled], [false, false], "and back");
	assert.ok(!dock.textContent.includes(m.box_answer_blocked()));
});
