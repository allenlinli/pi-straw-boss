import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Net, TowerService } from "../src/net.ts";
import type { Slot } from "../src/server/record.ts";
import { addWait, emptyMemory, memoryRequest, memorySection, memorySummary, readMemory, updateMemory } from "../src/server/towermemory.ts";
import { El } from "./fake-dom.ts";

// A wait the tower records on the boss (docs/specs/2026-10-26-sb-backend.md, Tower memory, Waits): it has to reach the boss as an alert (a question in the dialog, the HUD, Zen, and a system notification), say how long it has stood and
// when it may be out of date, and be dismissed through the server, which removes it from the tower's memory. Before this, a wait was only a row on the tower card with an Answer link, so the boss saw "waits for you" about a thing nobody asked.

const { alertsOf, arrivals, rankOf } = await import("../gui/alerts.ts");
const { noticeRows } = await import("../gui/towermodel.ts");
const { fillNotices } = await import("../gui/towernotes.ts");
const { m } = await import("../gui/paraglide/messages.js");

const DAY = 86_400_000, HOUR = 3_600_000;
const NOW = Date.parse("2026-11-04T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-wait-")) }) as Slot;
const req = (slot: Slot, json: Record<string, unknown>, now = NOW) => memoryRequest(slot, "wA", now, json);

test("the boss drops a wait by its id, with no rev: the server drops it from the memory and the summary, and logs the op without the text", () => {
	const slot = slotIn();
	updateMemory(slot, "wA", NOW, (mem) => addWait(mem, NOW, "r1", { text: "Boss token needed to add the ACL", for: "boss" }));
	updateMemory(slot, "wA", NOW, (mem) => addWait(mem, NOW, "r1", { text: "api-fix to answer", for: "agent", on: { id: "main-1", name: "api-fix" } }));
	const lines: { event: string; fields: Record<string, unknown> }[] = [];
	const log = { line: (event: string, fields: Record<string, unknown>) => void lines.push({ event, fields }) } as never;
	const done = memoryRequest(slot, "wA", NOW, { op: "drop", id: "W1" }, log);
	assert.equal(done.status, 200);
	assert.deepEqual((done.body.entries as { id: string }[]).map((e) => e.id), ["W2"], "W1 is gone from the memory file's view");
	assert.deepEqual(memorySummary(readMemory(slot, "wA", NOW).memory).bossWaits, [], "the snapshot no longer carries it");
	const read = req(slot, { op: "read" });
	assert.deepEqual((read.body.entries as { id: string }[]).map((e) => e.id), ["W2"], "and from the next read");
	assert.deepEqual(lines, [{ event: "tower-memory", fields: { workspace: "wA", op: "drop", by: "boss", id: "W1" } }]);
	assert.equal(req(slot, { op: "drop", id: "W1" }).status, 409, "a wait that is gone is a refusal, not a crash");
	assert.equal(req(slot, { op: "drop", id: "S1" }).status, 409, "only a wait is dropped");
	assert.equal(req(slot, { op: "drop" }).status, 409, "an id is needed");
});

test("the brief says how long an open wait has stood once it is a day old, so the next run checks it: a wait from the same hour reads as before", () => {
	const mem = emptyMemory();
	addWait(mem, NOW - 2 * DAY - 3 * HOUR, "r1", { text: "Boss token needed to add the ACL", for: "boss" });
	addWait(mem, NOW - 10 * 60_000, "r1", { text: "api-fix asks: deploy ws01?", for: "boss" });
	const { text } = memorySection(mem, NOW);
	assert.match(text, /- \[W1\] for boss: Boss token needed to add the ACL \(open 2d 3h\)/);
	assert.match(text, /- \[W2\] for boss: api-fix asks: deploy ws01\?$/m, "a fresh wait has no age");
});

const service = (bossWaits: { id: string; text: string; at: string; answered?: string }[], rev = 4): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] } });
const OLD = { id: "W1", text: "Boss token needed to add the Tailscale ACL cloud-pub to gx10:443", at: iso(NOW - 2 * DAY) };
const FRESH = { id: "W2", text: "api-fix asks: deploy ws01?", at: iso(NOW - 20 * 60_000) };

test("a wait row says how long it has stood and that it may be out of date after a day, and offers the act and the dismiss", () => {
	const rows = noticeRows(service([OLD, FRESH]), undefined, NOW);
	assert.deepEqual(rows.map((r) => [r.id, r.actions]), [["wait-W1", ["answer", "dismiss"]], ["wait-W2", ["answer", "dismiss"]]]);
	assert.equal(rows[0]!.text, `${m.tower_waits_for_you({ text: OLD.text })} · ${m.tower_wait_age({ age: m.age_d({ n: "2" }) })} · ${m.tower_wait_stale()}`);
	assert.equal(rows[1]!.text, m.tower_waits_for_you({ text: FRESH.text }), "a fresh wait reads as before");
	assert.equal(noticeRows(service([OLD]), { locale: "zh-TW" }, NOW)[0]!.text, `等你決定：${OLD.text} · 已等 2 天 · 可能已過時`);
	assert.deepEqual([m.tower_answer({}, { locale: "zh-TW" }), m.wait_dismiss({}, { locale: "zh-TW" })], ["去處理", "略過"], "the boss-facing words");
});

// The panel's chunk (`kit`) is module state, loaded once per process by the first wait row, so this runs before the others that draw one.
test("a snapshot drawn while the panel's chunk loads is not overwritten by the older one the load captured", async () => {
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, "wA", service([FRESH]), "sb-tower-wa"); // starts the load
	fillNotices(box as unknown as HTMLElement, "wA", service([]), "sb-tower-wa"); // the wait was dismissed elsewhere: no rows
	assert.equal(box.children.length, 0, "the newer snapshot has no wait row");
	await new Promise((done) => setTimeout(done, 50));
	assert.equal(box.children.length, 0, "the load redraws the newest snapshot, not the one it started with");
	assert.equal(box.find((el) => el.tag === "textarea").length, 0);
});

test("the wait's row on the card mounts the wait panel: Handle unfolds the answer box that tells the tower, Dismiss posts the dismiss by the wait's id, and the link goes to the tower's comms", async () => {
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
	Object.assign(globalThis, { fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => (path.endsWith("/memory") ? { rev: 5, proposals: [], entries: [] } : { accepted: true, woke: true }) }) });
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, "wA", service([FRESH]), "sb-tower-wa");
	await new Promise((done) => setTimeout(done, 50)); // the panel loads with the first wait row
	const buttons = box.find((el) => el.tag === "button");
	assert.deepEqual(buttons.map((b) => b.textContent), [m.tower_answer(), m.send(), m.wait_dismiss()]);
	const [handle, send, dismiss] = buttons as unknown as { onclick(): void; hidden: boolean }[];
	assert.equal(send!.hidden, true, "Send waits for Handle");
	dismiss!.onclick();
	await new Promise((done) => setTimeout(done, 5));
	assert.deepEqual(sent, [{ path: "api/tower/wA/memory", body: { op: "drop", id: "W2" } }]);
	handle!.onclick();
	const text = box.find((el) => el.tag === "textarea")[0]!;
	text.value = "Yes, deploy";
	text.bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 });
	await new Promise((done) => setTimeout(done, 5));
	assert.deepEqual(sent.at(-1), { path: "api/sessions/sb-tower-wa/input", body: { text: "Yes, deploy", as: "send", answers: "W2" } }, "the tower's session input, as the comms' composer sends it, naming the wait it answers");
	const link = box.find((el) => el.tag === "a")[0]!;
	assert.equal(link.attrs.get("data-route"), "w/wA/s/sb-tower-wa");
	assert.equal(link.textContent, m.wait_goto());
	const again = box.find((el) => el.tag === "textarea")[0]!;
	fillNotices(box as unknown as HTMLElement, "wA", service([{ ...FRESH, at: iso(NOW - 3 * HOUR) }], 5), "sb-tower-wa"); // the row's age changed: it is redrawn
	assert.equal(box.find((el) => el.tag === "textarea")[0], again, "the panel, and a draft in it, outlives a redraw");
});

const rowRig = async (ws: string, key: string) => {
	const sent: { path: string; body: Record<string, unknown> }[] = [];
	Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
	Object.assign(globalThis, { fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => ({ accepted: true, woke: true, answered: "W2" }) }) });
	const box = new El("div"), draw = (s: TowerService) => fillNotices(box as unknown as HTMLElement, ws, s, key);
	draw(service([FRESH]));
	await new Promise((done) => setTimeout(done, 50));
	const enter = (el: El) => el.bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 });
	return { sent, box, draw, enter, handle: box.find((el) => el.tag === "button")[0]!, text: box.find((el) => el.tag === "textarea")[0]!, form: box.find((el) => el.tag === "form")[0]! };
};

test("once the tower took the words, the row clears and folds its box, so a second Enter sends nothing", async () => {
	const r = await rowRig("wB", "sb-tower-wb");
	(r.handle as unknown as { onclick(): void }).onclick();
	r.text.value = "Yes, deploy";
	r.enter(r.text);
	await new Promise((done) => setTimeout(done, 5));
	assert.equal(r.sent.length, 1);
	assert.equal(r.text.value, "", "the sent words are gone from the box");
	assert.equal(r.form.hidden, true, "and the box is folded");
	assert.equal(r.handle.hidden, false, "Handle is back");
	r.draw(service([{ ...FRESH, answered: iso(NOW) }])); // the next snapshot: answered
	r.enter(r.text);
	await new Promise((done) => setTimeout(done, 5));
	assert.equal(r.sent.length, 1, "an Enter in the folded, empty box sends nothing");
});

test("a redraw of the row (its age changed) keeps the focus in the box being typed in", async () => {
	const r = await rowRig("wC", "sb-tower-wc");
	(r.handle as unknown as { onclick(): void }).onclick();
	r.text.value = "Yes, deploy";
	r.text.focus();
	r.draw(service([{ ...FRESH, at: iso(NOW - 3 * HOUR) }]));
	assert.equal(r.box.find((el) => el.tag === "textarea")[0], r.text, "the same box");
	assert.equal(document.activeElement, r.text, "still focused");
});

const net = (waits: { id: string; text: string; at: string; answered?: string }[]): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", tower: { name: "tower · Harbor", mark: "idle", key: "t1", control: true, service: service(waits), subs: [] }, tabs: [], outposts: [], outside: [] }] });

test("a wait for the boss that is under a day old is an alert of the tower, raised once, and leaves the queue when the wait is gone; an old one raises none", () => {
	const first = alertsOf(net([OLD, FRESH]), NOW);
	const waits = [...first.values()].filter((a) => a.key.startsWith("wait\u001f"));
	assert.equal(waits.length, 1, "the day-old wait is on the card and in the memory, not an alert that buzzes at every page load");
	const [a] = waits;
	assert.deepEqual([a!.key, a!.ws, a!.unit, a!.name, a!.mark, a!.note, rankOf(a!)], ["wait\u001fw\u001fW2", "w", "t1", "tower · Harbor", "waiting", FRESH.text, 0]);
	assert.deepEqual({ ...a!.wait }, { id: "W2", text: FRESH.text });
	assert.deepEqual(arrivals(undefined, first).filter((x) => x.wait).map((x) => x.key), [a!.key], "it arrives");
	const next = alertsOf(net([OLD, FRESH]), NOW + 2000);
	assert.deepEqual(arrivals(first, next).filter((x) => x.wait), [], "and not again at the next snapshot");
	assert.equal([...alertsOf(net([OLD]), NOW + 4000).keys()].some((k) => k.startsWith("wait\u001f")), false, "dismissed or resolved: gone");
});

test("an answered wait raises no alert (the tower still has it to resolve), says on its row that the boss answered and the tower has not resolved it, and a wait that changed asks again", () => {
	const answered = { ...FRESH, answered: iso(NOW - 60_000) };
	assert.deepEqual([...alertsOf(net([answered]), NOW).keys()].filter((k) => k.startsWith("wait\u001f")), [], "no alert for any view: the dialog, the HUD, Zen, the notification, the tab icon all read this map");
	assert.deepEqual([...alertsOf(net([answered, { ...OLD, id: "W3", at: iso(NOW - 3_600_000) }]), NOW).keys()].filter((k) => k.startsWith("wait\u001f")), ["wait\u001fw\u001fW3"], "another wait still asks");
	assert.deepEqual([...alertsOf(net([{ ...FRESH, id: "W5", text: "api-fix asks: deploy ws01 to prod too?" }]), NOW).keys()].filter((k) => k.startsWith("wait\u001f")), ["wait\u001fw\u001fW5"], "a wait the tower wrote anew (a new id) asks");
	const rows = noticeRows(service([answered]), undefined, NOW);
	assert.equal(rows[0]!.text, m.tower_wait_answered({ text: FRESH.text }), "the card and the comms say so");
	assert.deepEqual(rows[0]!.actions, ["answer", "dismiss"], "and the boss may still follow up or dismiss it");
	assert.equal(noticeRows(service([answered]), { locale: "zh-TW" }, NOW)[0]!.text, `已回覆，等塔台處理：${FRESH.text}`);
	assert.deepEqual(arrivals(alertsOf(net([FRESH]), NOW), alertsOf(net([answered]), NOW + 1000)).filter((x) => x.wait), [], "answering is not an arrival");
});
