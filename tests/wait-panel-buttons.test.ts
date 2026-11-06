import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	const said = (r: typeof good, text: string) => [...r.text(), ...r.box.find((el) => el.getAttribute("class") === "tnote-flash").map((el) => el.textContent)].filter((t) => t === text);
	assert.deepEqual(said(good, m.wait_dismissed()), [m.wait_dismissed()], "the confirmation is said once, in the flash under the rows (which outlives the row the next snapshot removes), not again in the panel");
	assert.equal(dismiss.hidden, true, "the buttons are folded away");
	assert.equal(good.box.find((el) => el.tag === "a").every((a) => (a as unknown as { hidden: boolean }).hidden), true);
});

test("an answer the server took says so once, and Handle comes back for the next one", async () => {
	status = 200;
	const r = await rig("wE", "sb-tower-wE");
	const find = (label: string) => r.buttons().find((b) => b.textContent === label)!;
	find(m.tower_answer()).onclick();
	const box = r.box.find((el) => el.tag === "textarea")[0] as unknown as { value: string };
	box.value = "ship it";
	find(m.send()).onclick();
	await settle();
	const flashes = () => r.box.find((el) => el.getAttribute("class") === "tnote-flash").map((el) => el.textContent);
	assert.deepEqual([...r.text(), ...flashes()].filter((t) => t === m.wait_sent()), [m.wait_sent()], "said once");
	assert.equal(find(m.tower_answer()).hidden, false, "Handle is back");
	assert.equal(find(m.wait_dismiss()).hidden, false, "and so is Dismiss: the wait stays on the card");
	assert.equal(box.value, "", "the box is empty");
});

test("a redraw within the flash's four seconds keeps it; the flash is a status line", async () => {
	status = 200;
	const r = await rig("wF", "sb-tower-wF");
	r.buttons().find((b) => b.textContent === m.wait_dismiss())!.onclick();
	await settle();
	fillNotices(r.box as unknown as HTMLElement, "wF", { ...service(), memory: { ...service().memory!, rev: 3, waits: 0, bossWaits: [] } }, "sb-tower-wF"); // the snapshot after the dismissal drops the row, and the box is redrawn
	assert.equal(r.box.find((el) => (el.getAttribute("class") ?? "").startsWith("tnote ")).length, 0, "the row is gone");
	const flash = r.box.find((el) => el.getAttribute("class") === "tnote-flash");
	assert.deepEqual(flash.map((el) => el.textContent), [m.wait_dismissed()], "one flash after the redraw");
	assert.equal(flash[0]!.getAttribute("role"), "status");
});

test("with the stream stale the buttons are off and the panel says why", async () => {
	const r = await rig("wD", "sb-tower-wd");
	(document.body.dataset as Record<string, string>).stale = "true";
	fillNotices(r.box as unknown as HTMLElement, "wD", { ...service(), memory: { ...service().memory!, rev: 2 } }, "sb-tower-wd");
	await settle();
	assert.equal(r.buttons().find((b) => b.textContent === m.wait_dismiss())!.disabled, true);
	assert.ok(r.text().includes(m.wait_stream_stale()));
	assert.deepEqual(r.box.find((el) => el.tag === "small" && el.textContent === m.wait_stream_stale()).map((el) => el.getAttribute("role")), ["status"], "a status, not an alert: the page banner already says offline and every card would announce it");
	delete (document.body.dataset as Record<string, string>).stale;
});

test("a panel that does not report (Zen's card, the dialog) neither folds on a dismissal nor writes the stale note", async () => {
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }), body: { dataset: {} } });
	Object.assign(globalThis, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ rev: 2, proposals: [], entries: [], accepted: true }) }) });
	const { waitPanel } = await import("../gui/waitpanel.ts");
	const { waitActions } = await import("../gui/asks.ts");
	const { answerPost } = await import("../gui/answer.ts");
	let done = 0;
	const panel = waitPanel({ actions: waitActions({ ws: "wG", id: "W1", tower: "sb-tower-wG" }, answerPost("sb-tower-wG")), reply: true, done: () => void done++ });
	const el = panel.el as unknown as El;
	panel.update(false);
	assert.deepEqual(el.find((e) => e.tag === "small" && e.textContent === m.wait_stream_stale()), [], "the stale sentence is not drawn");
	panel.update(true);
	(panel.dismiss as unknown as { onclick(): void }).onclick();
	await settle();
	assert.equal(done, 1, "the host is told");
	assert.equal(panel.dismiss.hidden, false, "the panel stays as it was");
	assert.equal((el as unknown as { dataset: Record<string, string> }).dataset.gone, undefined);
});

test("the session view (the tower's own comms, and the head page) passes `here` to the notices; the overview card and the workspace page do not", () => {
	const call = (f: string) => readFileSync(new URL(`../gui/${f}`, import.meta.url), "utf8").split("\n").find((l) => l.includes("fillNotices(") && !l.includes("import"))!;
	assert.match(call("session.ts"), /fillNotices\(notes, .*u\?\.key, true\)/, "the comms say it is the tower's own page");
	for (const f of ["render.ts", "workspace.ts"]) assert.match(call(f), /fillNotices\(.*\.key\);/, `${f} keeps the link`);
});
