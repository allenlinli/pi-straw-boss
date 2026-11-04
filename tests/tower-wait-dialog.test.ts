import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The dialog of a wait the tower recorded on the boss (gui/layer.ts, gui/waitpanel.ts): the wait's words, a link to the tower's comms (the act) and Dismiss (the server drops the wait from the tower's memory), and no
// last-transmission block, which would show the tower's old log under a question nobody asked there.

sessionGlobals();
const sent: { path: string; body: Record<string, unknown>; csrf: string }[] = [];
let reply: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: {} };
Object.assign(globalThis, {
	HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000,
	fetch: async (path: string, init: { body: string; headers: Record<string, string> }) => (sent.push({ path, body: JSON.parse(init.body), csrf: init.headers["x-sb-csrf"]! }), { ok: reply.ok, status: reply.status, json: async () => reply.body }),
});
Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
const { mountPanels } = await import("../gui/layer.ts");
const { m } = await import("../gui/paraglide/messages.js");

const settle = () => new Promise((done) => setTimeout(done, 5));
const wait = { key: "wait\u001fw\u001fW2", unit: "sb-tower-w", ws: "w", name: "tower · Harbor", role: "tower", mark: "waiting" as const, note: "api-fix asks: deploy ws01?", at: 1, since: 1, wait: { id: "W2", text: "api-fix asks: deploy ws01?" } };

let dock: El;
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
	return mountPanels({ label: (ws) => ws, recent: async () => [], stream: () => "s1", showTerminal() {}, post: () => () => Promise.resolve({ ok: true, status: 200, body: {} }) });
};
beforeEach(() => {
	sent.length = 0;
	reply = { ok: true, status: 200, body: {} };
});
const button = (label: string) => dock.all((el) => el.tagName === "button" && el.textContent === label)[0];
const cls = (name: string) => dock.all((el) => el.getAttribute("class") === name)[0];

test("a wait's dialog says what the tower waits for, offers the tower's comms and Dismiss, and keeps the old transmission out of it", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(cls("state")!.textContent, m.memory_wait_boss());
	assert.equal(cls("wait-text")!.textContent, "api-fix asks: deploy ws01?", "the words, in the answer slot where they wrap");
	assert.equal(cls("tag")!.textContent, m.tag_question());
	assert.equal(cls("intel")!.hidden, true, "no last transmission under a wait");
	const go = cls("go")!;
	assert.equal(go.textContent, m.tower_answer());
	assert.equal(go.getAttribute("href"), "w/w/s/sb-tower-w", "the act: the tower's comms");
	assert.ok(button(m.later()), "and it can wait");
	assert.ok(button(m.wait_dismiss()), "Dismiss");
});

test("a wait's dialog puts its three actions in one footer row: the act, then Later, then Dismiss as the quiet one", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	const footer = dock.all((el) => el.tagName === "footer")[0]!;
	const row = footer.children.filter((el) => el.tagName === "a" || el.tagName === "button").map((el) => el.textContent);
	assert.deepEqual(row, [m.tower_answer(), m.later(), m.wait_dismiss()]);
});

test("Dismiss posts to the tower's memory route by the wait's id and closes the dialog once the server took it; a refusal says why and leaves it", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	reply = { ok: false, status: 409, body: { error: "refused", reason: "No such wait W2" } };
	button(m.wait_dismiss())!.click();
	await settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "drop", id: "W2" }, csrf: "CSRF" }]);
	assert.match(dock.all((el) => el.getAttribute("role") === "alert").map((e) => e.textContent).join("|"), /No such wait W2/);
	assert.equal(layer.stack.open.length, 1, "refused: still open");
	reply = { ok: true, status: 200, body: {} };
	button(m.wait_dismiss())!.click();
	await settle();
	assert.equal(sent.length, 2);
	assert.equal(layer.stack.open.length, 0, "taken: closed");
});

test("a dialog whose wait is over says so, not that the tower left the net, and offers no Dismiss", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	layer.alerts([], new Map());
	assert.equal(cls("state")!.textContent, m.tower_wait_over());
	assert.equal(cls("tag")!.textContent, m.tag_question(), "the chip does not say the tower is GONE");
	assert.equal(button(m.wait_dismiss())?.disabled ?? true, true);
});
