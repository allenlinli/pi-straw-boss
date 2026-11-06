import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAD_KEY } from "../src/headkey.ts";
import type { TowerService } from "../src/net.ts";
import { El } from "./fake-dom.ts";

// The wait panel's buttons on the card and in the comms (gui/waitpanel.ts, gui/towernotes.ts): on the head tower's page the link to "the tower's comms" is the page itself, so it is not drawn; a dismissal or an answer the server took says
// so; a stale stream says why the buttons are off.

const { fillNotices } = await import("../gui/towernotes.ts");
const { m } = await import("../gui/paraglide/messages.js");

const WAIT = { id: "W1", text: "Decide the release", at: new Date().toISOString() };
const service = (): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [WAIT], proposals: [] } });
let status = 200;
const rig = async (ws: string, key: string, here = false) => {
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }), body: { dataset: {} } });
	Object.assign(globalThis, { fetch: async () => ({ ok: status < 400, status, json: async () => (status < 400 ? { rev: 2, proposals: [], entries: [], accepted: true } : { error: "gone", reason: "No such wait" }) }) });
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, ws, service(), key, here);
	await new Promise((done) => setTimeout(done, 50));
	return { box, buttons: () => box.find((el) => el.tag === "button") as unknown as { textContent: string; onclick(): void; hidden: boolean; disabled: boolean }[], text: () => box.find((el) => el.tag === "small").map((el) => el.textContent) };
};
const settle = () => new Promise((done) => setTimeout(done, 5));

test("the head tower's page draws no link to the tower's comms, a workspace tower's page does", async () => {
	assert.equal((await rig(HEAD_KEY, "sb-head")).box.find((el) => el.tag === "a").length, 0);
	const ws = await rig("wA", "sb-tower-wa");
	assert.equal(ws.box.find((el) => el.tag === "a").length, 1);
});

test("a workspace tower's own comms page draws no link to those comms; its card elsewhere does", async () => {
	assert.equal((await rig("wA", "sb-tower-wa", true)).box.find((el) => el.tag === "a").length, 0);
	assert.equal((await rig("wA", "sb-tower-wa")).box.find((el) => el.tag === "a").length, 1);
});

test("a dismissal the server took folds the panel and says so; one it refused says why and keeps the buttons", async () => {
	status = 404;
	const bad = await rig("wB", "sb-tower-wb");
	bad.buttons().find((b) => b.textContent === m.wait_dismiss())!.onclick();
	await settle();
	assert.ok(bad.text().some((t) => t.includes("No such wait")), "the refusal is shown");
	assert.equal(bad.buttons().find((b) => b.textContent === m.wait_dismiss())!.hidden, false);
	status = 200;
	const good = await rig("wC", "sb-tower-wc");
	const dismiss = good.buttons().find((b) => b.textContent === m.wait_dismiss())!;
	dismiss.onclick();
	await settle();
	assert.ok(good.text().includes(m.wait_dismissed()), "the confirmation");
	assert.deepEqual(good.box.find((el) => el.getAttribute("class") === "tnote-flash").map((el) => el.textContent), [m.wait_dismissed()], "and it outlives the row, which the next snapshot removes");
	assert.equal(dismiss.hidden, true, "the buttons are folded away");
	assert.equal(good.box.find((el) => el.tag === "a").every((a) => (a as unknown as { hidden: boolean }).hidden), true);
});

test("with the stream stale the buttons are off and the panel says why", async () => {
	const r = await rig("wD", "sb-tower-wd");
	(document.body.dataset as Record<string, string>).stale = "true";
	fillNotices(r.box as unknown as HTMLElement, "wD", { ...service(), memory: { ...service().memory!, rev: 2 } }, "sb-tower-wd");
	await settle();
	assert.equal(r.buttons().find((b) => b.textContent === m.wait_dismiss())!.disabled, true);
	assert.ok(r.text().includes(m.wait_stream_stale()));
	delete (document.body.dataset as Record<string, string>).stale;
});
