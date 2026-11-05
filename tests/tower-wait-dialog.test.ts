import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The dialog of a wait the tower recorded on the boss (gui/layer.ts, gui/waitpanel.ts): the wait's words, an answer box (Handle unfolds it; what is sent goes to the tower's session input, as the comms' composer sends it, and the
// dialog closes once the tower took it), a secondary link to the tower's comms, and Dismiss (the server drops the wait from the tower's memory), and no last-transmission block, which would show the tower's old log under a question nobody asked there.

sessionGlobals();
const sent: { path: string; body: Record<string, unknown>; csrf: string }[] = [];
const MEMORY = { rev: 2, proposals: [], entries: [] }; // what the memory route answers a drop with: the memory it now holds
let reply: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: MEMORY };
const told: { key: string; action: string; body: Record<string, unknown> }[] = [];
let tellReply: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 200, body: { accepted: true, woke: true } };
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
	return mountPanels({ label: (ws) => ws, recent: async () => [], stream: () => "s1", showTerminal() {}, post: (key: string) => (action: string, body: Record<string, unknown>) => (told.push({ key, action, body }), Promise.resolve(tellReply)) });
};
beforeEach(() => {
	sent.length = 0;
	told.length = 0;
	reply = { ok: true, status: 200, body: MEMORY };
	tellReply = { ok: true, status: 200, body: { accepted: true, woke: true } };
});
const button = (label: string) => dock.all((el) => el.tagName === "button" && el.textContent === label)[0];
const cls = (name: string) => dock.all((el) => el.getAttribute("class") === name)[0];

test("a wait's dialog says what the tower waits for, offers Handle, the tower's comms and Dismiss, and keeps the old transmission out of it", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(cls("state")!.textContent, m.memory_wait_boss());
	assert.equal(cls("wait-text")!.textContent, "api-fix asks: deploy ws01?", "the words, in the answer slot where they wrap");
	assert.equal(cls("tag")!.textContent, m.tag_question());
	assert.equal(cls("intel")!.hidden, true, "no last transmission under a wait");
	const go = cls("go")!;
	assert.equal(go.textContent, m.wait_goto());
	assert.equal(go.getAttribute("href"), "w/w/s/sb-tower-w", "the link to the tower's comms, no longer the act");
	assert.ok(button(m.tower_answer()), "Handle answers here");
	assert.ok(button(m.later()), "and it can wait");
	assert.ok(button(m.wait_dismiss()), "Dismiss");
});

test("a wait's dialog puts the comms link, Later and Dismiss in one footer row, the quiet one last", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	const footer = dock.all((el) => el.tagName === "footer")[0]!;
	const row = footer.children.filter((el) => el.tagName === "a" || el.tagName === "button").map((el) => el.textContent);
	assert.deepEqual(row, [m.wait_goto(), m.later(), m.wait_dismiss()]);
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
	reply = { ok: true, status: 200, body: MEMORY };
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

const box = () => dock.all((el) => el.tagName === "textarea")[0]!;
const form = () => dock.all((el) => el.getAttribute("class") === "wait-form zen-head-form")[0]!;
const enter = () => box().bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 });

test("Handle unfolds the answer box in the dialog's slot and stays on the page: the dialog is not left for the comms", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(form().hidden, true, "folded until Handle");
	button(m.tower_answer())!.click();
	assert.equal(form().hidden, false);
	assert.equal(page.focused, box(), "the box has the focus");
	assert.equal(layer.stack.open.length, 1, "the dialog stays");
	assert.equal(button(m.tower_answer())!.hidden, true, "Handle is what is open now");
	assert.ok(button(m.send()) && button(m.send())!.hidden === false, "Send takes its place");
});

test("sending posts the words to the tower's session input as the composer does, and the dialog closes once the tower took it", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	button(m.tower_answer())!.click();
	box().value = "Use the staging token";
	enter();
	await settle();
	assert.deepEqual(told, [{ key: "sb-tower-w", action: "input", body: { text: "Use the staging token", as: "send", answers: "W2" } }]);
	assert.equal(layer.stack.open.length, 0, "taken: closed");
});

test("a refusal shows under the kept draft and the dialog stays; Send does the same as Enter", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	button(m.tower_answer())!.click();
	tellReply = { ok: false, status: 409, body: { error: "refused", reason: "The tower did not take it." } };
	box().value = "Use the staging token";
	button(m.send())!.click();
	await settle();
	assert.equal(told.length, 1);
	assert.equal(box().value, "Use the staging token", "the draft is kept");
	assert.match(dock.all((el) => el.getAttribute("class") === "wait-note zen-head-note")[0]!.textContent, /Not sent: the tower did not take it\./);
	assert.equal(layer.stack.open.length, 1);
	tellReply = { ok: true, status: 200, body: { accepted: true } };
	button(m.send())!.click();
	await settle();
	assert.equal(told.length, 2);
	assert.equal(layer.stack.open.length, 0, "the second try is taken");
});

test("an empty box, Shift+Enter, and a stream that is not live send nothing", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	button(m.tower_answer())!.click();
	enter();
	box().value = "x";
	box().bubble("keydown", { key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 });
	page.body.dataset.stale = "true";
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(box().disabled, true, "no answer while the link is down");
	await settle();
	assert.deepEqual(told, []);
});
