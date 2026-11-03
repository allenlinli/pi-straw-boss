import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { selectDigest } from "../src/owners.ts";
import { m } from "../gui/paraglide/messages.js";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// How the session view (gui/session.ts) hands its unit's facts to the answer core and the composer: the question panel above the composer may answer only while the unit has
// a control and the stream is live, an answer goes by the data's post (a demo fixture's route), and an ally or event run the net does not list takes its role to the composer.

sessionGlobals();
Object.assign(globalThis, { setTimeout: () => 0 }); // the session view runs no timer here
const { mountSession } = await import("../gui/session.ts");

const SELECT = { title: "MCP: scratch wants to run echo", choices: [{ label: "Allow once" }, { label: "Deny" }] };
const pending: Pending = { callId: "c1", tool: "dialog", answer: { dialog: "m1", digest: selectDigest(SELECT), select: SELECT } };
const unit = (extra: object = {}) => ({ key: "k", name: "billing", role: "session", mark: "waiting" as const, subs: [], control: true, pending, ...extra });
const settle = () => new Promise((done) => setImmediate(done));

async function mounted(u: object | undefined, info: object = { name: "billing", role: "session", state: "live" }) {
	const posts: string[] = [], online = { on: true };
	const scene = { route: { view: "session", ws: "w1", key: "k" }, net: { bases: [{ id: "w1", label: "w1", tabs: [], outside: u ? [u] : [] }] }, cards: {}, info } as never;
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async (action: string, body: Record<string, unknown>) => (posts.push(`${action} ${body.dialog}`), { ok: true, status: 200, body: { outcome: "accepted" } }) };
	const view = new El("div");
	page.body.replaceChildren(view);
	const session = mountSession(scene, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async () => () => {}, online: () => online.on, fullScreen() {}, opened() {} });
	session.open("k");
	await settle();
	await settle();
	const draw = () => session.draw({ u: u as never, hit: undefined, mk: (u as { mark?: "waiting" } | undefined)?.mark ?? "unknown", state: "live", name: "billing" } as never);
	draw();
	return { posts, online, draw, view, choices: () => view.all((el) => el.getAttribute("role") === "radio"), send: () => view.all((el) => el.tagName === "button" && el.textContent === "Send answer")[0], bar: () => view.find((el) => el.classes.has("cmp-bar"))[0]! };
}

test("the question panel answers only while the unit has a control and the stream is live", async () => {
	const w = await mounted(unit());
	assert.deepEqual(w.choices().map((c) => c.disabled), [false, false]);
	w.online.on = false;
	w.draw();
	assert.deepEqual(w.choices().map((c) => c.disabled), [true, true], "a stream that is not live");
	w.online.on = true;
	w.draw();
	assert.deepEqual(w.choices().map((c) => c.disabled), [false, false]);
	const closed = await mounted(unit({ control: false }));
	assert.deepEqual(closed.choices().map((c) => c.disabled), [true, true], "a unit without a control");
});

test("an answer from the session view goes by the data's post, the fixture's route", async () => {
	const w = await mounted(unit());
	w.choices()[0]!.click();
	w.send()!.click();
	await settle();
	assert.deepEqual(w.posts, ["answer m1"]);
});

test("an ally or event run the net does not list takes its role to the composer: it is read and never written to; a listed unit's role is not read", async () => {
	assert.equal((await mounted(undefined, { name: "Laptop", role: "ally", state: "live" })).bar().textContent, m.blocked_ally());
	assert.equal((await mounted(undefined, { name: "e1", role: "run", state: "live" })).bar().textContent, m.blocked_run());
	const listed = await mounted(unit({ pending: undefined, mark: "idle" }), { name: "billing", role: "ally", state: "live" });
	assert.equal(listed.bar().hidden, true, "a listed unit with a control keeps its composer");
});
