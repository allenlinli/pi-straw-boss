import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAD_KEY } from "../src/headkey.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The work board sits on the head page only (docs/specs/2026-11-09-board-view.md, Head page): the session view carries its section, and draws it for the head's key and for no other unit.

sessionGlobals();
Object.assign(globalThis, { setTimeout: () => 0 });
Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountSession } = await import("../gui/session.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); await whenDrawn(); };

const board = [{ session: "s-1", workspace: "Alpha", tab: "api", main: "billing", state: "idle", now: "MP-1 export", items: [], updated: Date.now() - 60_000 }];
async function mounted(baseId: string, key: string, role: string) {
	const u = { key, name: "x", role, mark: "idle" as const, subs: [], control: true };
	const base = { id: baseId, label: baseId, tabs: [], outside: [u] };
	const scene = { route: { view: "session", ws: baseId, key }, net: { bases: [base], board }, cards: {}, info: { name: "x", role, state: "live" } } as never;
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ({ ok: true, status: 200, body: {} }) };
	const view = new El("div");
	page.body.replaceChildren(view);
	const session = mountSession(scene, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async () => () => {}, online: () => true, fullScreen() {}, opened() {} });
	session.open(key);
	await settle();
	return { view, draw: () => session.draw({ u: u as never, hit: { u, base } as never, mk: "idle", state: "live", name: "x" } as never) };
}

test("the head's page draws the work board; a tower's or a main's page has the section hidden", async () => {
	const head = await mounted(HEAD_KEY, "sb-head-unit", "tower");
	head.draw();
	const section = head.view.querySelector(".head-board")!;
	assert.equal(section.hidden, false);
	assert.match(section.querySelector("summary span")!.textContent, /1 line/);
	assert.equal(head.view.querySelectorAll(".board-row").length, 1);
	for (const [base, key, role] of [["wA", "tower-a", "tower"], ["wA", "main-1", "main"]]) {
		const other = await mounted(base!, key!, role!);
		other.draw();
		assert.equal(other.view.querySelector(".head-board")!.hidden, true, `${role} page`);
		assert.equal(other.view.querySelectorAll(".board-row").length, 0);
	}
});
