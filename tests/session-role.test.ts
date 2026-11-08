import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The session view marks its unit's role (`#session-view[data-role]`), so a theme can dress the chat page by role (Raven Keep's rooms, tests/raven-rooms.test.ts). The role is the unit's, or the history's when the net does not list the unit; it is
// gone while the comms open and after they close, so the page of the unit before never shows its room under the next one's.

sessionGlobals();
Object.assign(globalThis, { setTimeout: () => 0 });
Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountSession } = await import("../gui/session.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); await whenDrawn(); };

async function mounted(role: string, info?: string) {
	const u = { key: "k", name: "billing", role, mark: "idle" as const, subs: [], control: true };
	const base = { id: "w1", label: "w1", tabs: [], outside: [u] };
	const scene = { route: { view: "session", ws: "w1", key: "k" }, net: { bases: [base] }, cards: {}, info: { name: "billing", role: info ?? role, state: "live" } } as never;
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ({ ok: true, status: 200, body: {} }) };
	const view = new El("div");
	page.body.replaceChildren(view);
	const session = mountSession(scene, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async () => () => {}, online: () => true, fullScreen() {}, opened() {} });
	session.open("k");
	await settle();
	return { view, session, u, base, draw: (unit: unknown) => session.draw({ u: unit as never, hit: unit ? ({ u: unit, base } as never) : undefined, mk: "idle", state: "live", name: "billing" } as never) };
}

test("the session view carries its unit's role, from the net's unit when it lists one and from the history's header when it does not", async () => {
	for (const role of ["tower", "main", "subagent", "member", "outside"]) {
		const w = await mounted(role);
		assert.equal(w.view.dataset.role, undefined, "not before the first draw: the comms are opening");
		w.draw(w.u);
		assert.equal(w.view.dataset.role, role);
	}
	const run = await mounted("run");
	run.draw(undefined);
	assert.equal(run.view.dataset.role, "run", "an event run is no unit of the net: the history names its role");
});

test("opening another session or closing the comms takes the role away until the next draw", async () => {
	const w = await mounted("main");
	w.draw(w.u);
	assert.equal(w.view.dataset.role, "main");
	w.session.open("k2");
	assert.equal(w.view.dataset.role, undefined);
	await settle();
	w.draw({ ...w.u, role: "subagent" });
	assert.equal(w.view.dataset.role, "subagent");
	w.session.close();
	assert.equal(w.view.dataset.role, undefined);
});
