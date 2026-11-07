import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import type { BossWait } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The GUI review's fixes of the wait cards (docs/specs/2026-11-07-wait-cards.md, Implementation notes 4 to 6, review round GR-F001 to F013): Open <raiser> on the head page goes to the raiser's own session, Skip's confirm takes the focus and shows
// itself, the dock's dialog is modal for presses, its badge is the card's own word, it opens on the primary, disabled buttons look disabled, a command wraps whole, and Zen offers Open <raiser>.

sessionGlobals();
const sent: { path: string; body: Record<string, unknown> }[] = [];
Object.assign(globalThis, {
	HTMLButtonElement: El, requestAnimationFrame: (run: () => void) => run(), innerWidth: 1000,
	fetch: async (path: string, init: { body: string }) => (sent.push({ path, body: JSON.parse(init.body) }), { ok: true, status: 200, json: async () => ({ rev: 2, proposals: [], entries: [] }) }),
});
Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
const { mountPanels } = await import("../gui/layer.ts");
const { fillNotices } = await import("../gui/towernotes.ts");
const { m } = await import("../gui/paraglide/messages.js");
const { cardModel } = await import("../gui/waitcardmodel.ts");
const { waitCard } = await import("../gui/waitcard.ts");
const { waitActions } = await import("../gui/asks.ts");
const { HEAD_KEY } = await import("../src/headkey.ts");

const settle = () => new Promise((done) => setTimeout(done, 20));
const AT = new Date().toISOString();
const CARD = (type: "action" | "choice" | "secret" = "action"): NonNullable<BossWait["card"]> => ({ type, lang: "en", happened: "A key expired.", do: "Open the admin page.", ...(type === "choice" ? { options: [{ label: "Tonight", then: "Now." }, { label: "Friday", then: "Later." }] } : {}), ...(type === "secret" ? { secret: { name: "key" } } : {}), from: { name: "mp3946-print", role: "main", key: "sb-main-3946" } });
const WAIT = (type: "action" | "choice" | "secret" = "action", extra: Partial<BossWait> = {}): BossWait => ({ id: "W2", text: "Open the admin page.", at: AT, card: CARD(type), ...extra });
const alertOf = (w: BossWait, ws = "w") => ({ key: `wait\u001f${ws}\u001f${w.id}`, unit: "sb-tower-w", ws, name: "tower", role: "tower", mark: "waiting" as const, note: w.text, at: 1, since: 1, wait: { id: w.id, text: w.text, entry: w } });

let dock: El, work: El;
const mount = (raiserWs?: string) => {
	page.body.replaceChildren();
	delete page.body.dataset.stale;
	for (const id of ["dock", "work", "tiles", "tile-tabs", "alerts", "done", "done-pop", "done-list", "done-clear"]) {
		const el = new El(id === "alerts" || id === "done" || id === "done-clear" ? "button" : "div");
		el.id = id;
		page.body.append(el);
		if (id === "dock") dock = el;
		if (id === "work") work = el;
		if (id === "alerts") for (const [tag, cls, ident] of [["b", "", "alert-count"], ["span", "", "alert-text"], ["span", "faces", ""]] as const) Object.assign(el.appendChild(new El(tag)), { id: ident }).setAttribute("class", cls);
	}
	Object.assign(page.body.find((el) => el.id === "done-pop")[0]!, { matches: () => false, hidePopover() {}, getClientRects: () => [] });
	return mountPanels({ label: (ws: string) => ws, recent: async () => [], stream: () => "s1", showTerminal() {}, ...(raiserWs ? { net: () => ({ bases: [{ id: raiserWs, tower: null, tabs: [], outside: [{ key: "sb-main-3946", subs: [] }] }] }) } : {}), post: () => async () => ({ ok: true, status: 200, body: { accepted: true } }) } as never);
};
beforeEach(() => {
	sent.length = 0;
	page.focused = undefined;
});
const cls = (name: string) => dock.all((el) => el.getAttribute("class") === name)[0];
const byClass = (root: El, name: string) => root.find((el) => el.classes.has(name));

// --- GR-F001: Open <raiser> on the head page --------------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F001: on the head page a wait's Open <raiser> goes to the raiser's own session, not to the head page it is on", async () => {
	const service = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [WAIT()], proposals: [] } };
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, HEAD_KEY, service as never, "sb-head", (key) => (key === "sb-main-3946" ? "wA" : undefined));
	await settle();
	(box.find((el) => el.classes.has("wc-fold"))[0] as unknown as { click(): void }).click();
	const link = box.find((el) => el.classes.has("wc-main"))[0]!;
	assert.equal(link.attrs.get("data-route"), "w/wA/s/sb-main-3946", "the raiser's workspace, found by its key");
});

test("GR-F001: with no way to find the raiser's workspace the head page offers no Open at all, never a link to itself", async () => {
	const service = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [WAIT("action", { id: "W3" })], proposals: [] } };
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, HEAD_KEY, service as never, "sb-head");
	await settle();
	(box.find((el) => el.classes.has("wc-fold"))[0] as unknown as { click(): void }).click();
	assert.equal(box.find((el) => el.classes.has("wc-main")).length, 0);
});

test("GR-F001: the head's dock dialog takes the same route; its comms link still goes to the head page", () => {
	const layer = mount("wA");
	const a = alertOf(WAIT(), HEAD_KEY);
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	layer.stack.show(a as never);
	assert.equal(dock.all((el) => el.classes.has("wc-main"))[0]!.attrs.get("data-route"), "w/wA/s/sb-main-3946");
	assert.equal(cls("go")!.getAttribute("href"), "head");
});

test("the model offers Open only when the host can name a route for this raiser", () => {
	const closed = waitCard({ host: "dialog", wait: WAIT(), actions: waitActions({ ws: "w", id: "W2", tower: "t" }, async () => ({ ok: true, status: 200, body: {} })), main: () => undefined });
	assert.equal((closed.el as unknown as El).find((el) => el.classes.has("wc-main")).length, 0);
});

// --- GR-F003: Skip's confirm --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F003: opening Skip's confirm puts the focus on the confirm button, not the optional reason box, and scrolls the confirm into view", () => {
	const card = waitCard({ host: "dialog", wait: WAIT(), actions: waitActions({ ws: "w", id: "W2", tower: "t" }, async () => ({ ok: true, status: 200, body: {} })), remote: false });
	page.body.append(card.el as never);
	const el = card.el as unknown as El, box = byClass(el, "wc-skip-box")[0]!;
	const scrolled: unknown[] = [];
	box.scrollIntoView = ((o: unknown) => void scrolled.push(o)) as never;
	byClass(el, "wc-skip")[0]!.click();
	assert.equal(page.activeElement, byClass(el, "wc-skip-yes")[0], "the focus is on Skip it");
	assert.notEqual(page.activeElement, byClass(el, "wc-skip-reason")[0], "not on the reason box (no keyboard on a phone)");
	assert.equal(scrolled.length, 1, "the confirm is scrolled into view");
});

// --- GR-F004: the dock's dialog is modal for presses --------------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F004: while a wait's dialog is on top the page behind is inert, so no row or card under it takes a press; it is live again once the dialog closes", () => {
	const layer = mount();
	const a = alertOf(WAIT());
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	assert.equal(work.hasAttribute("inert"), false, "an alert in the queue is no dialog");
	layer.stack.show(a as never);
	assert.equal(work.hasAttribute("inert"), true);
	layer.stack.close();
	assert.equal(work.hasAttribute("inert"), false);
});

test("GR-F004: a dialog that is not a wait leaves the page as it was", () => {
	const layer = mount();
	const plain = { key: "u", ws: "w", name: "agent", role: "member", mark: "waiting" as const, at: 1 };
	layer.alerts([plain as never], new Map([[plain.key, plain as never]]));
	layer.stack.show(plain as never);
	assert.equal(work.hasAttribute("inert"), false);
});

// --- GR-F007 and F008: the badge and the first focus ----------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F007: the dialog's badge is the card's own kind word", () => {
	for (const [type, word] of [["action", m.wc_tag_action()], ["choice", m.wc_tag_choice()], ["secret", m.wc_tag_secret()]] as const) {
		const layer = mount();
		const a = alertOf(WAIT(type, { id: `W-${type}` }));
		layer.alerts([a as never], new Map([[a.key, a as never]]));
		layer.stack.show(a as never);
		assert.equal(cls("tag")!.textContent, word, type);
	}
});

test("GR-F008: a wait's dialog opens with the focus on the card's primary button; a choice on its first option", () => {
	for (const [type, act] of [["action", "done"], ["secret", "secret"], ["choice", "choose"]] as const) {
		const layer = mount();
		const a = alertOf(WAIT(type, { id: `W-${type}` }));
		layer.alerts([a as never], new Map([[a.key, a as never]]));
		layer.stack.show(a as never);
		assert.equal((page.activeElement as El).dataset.act, act, type);
	}
});

test("GR-F005: the dock's Skip, which sits in the footer outside the card, goes off with the card's other buttons while the stream is down or a press is on its way", () => {
	const layer = mount();
	const a = alertOf(WAIT());
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	layer.stack.show(a as never);
	const skip = dock.all((el) => el.classes.has("wc-skip"))[0]!;
	assert.equal(skip.disabled, false);
	page.body.dataset.stale = "true";
	layer.stack.show(a as never);
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	assert.equal(skip.disabled, true, "stale: off");
});

// --- GR-F009: Open <raiser> after a press ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F009: Open <raiser> stays on after a press (it only navigates); the acts go off", () => {
	const pressedWait = WAIT("action", { press: { act: "done", at: AT } });
	const md = cardModel({ wait: pressedWait, phase: "open", remote: false, open: true, now: Date.parse(AT) });
	assert.equal(md.buttons.find((b) => b.id === "main")!.disabled, undefined);
});

// --- GR-F010: Zen --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("GR-F010: a host that takes the route itself (Zen leaves its layer for it) handles the click of Open <raiser> and the router never sees it", () => {
	const routes: unknown[] = [];
	const card = waitCard({ host: "zen", wait: WAIT(), actions: waitActions({ ws: "w", id: "W2", tower: "t" }, async () => ({ ok: true, status: 200, body: {} })), remote: false, main: (key) => ({ view: "session", ws: "wA", key }), go: (route) => void routes.push(route) });
	page.body.append(card.el as never);
	const link = byClass(card.el as unknown as El, "wc-main")[0]!;
	let prevented = false, stopped = false;
	(link.onclick as unknown as (e: object) => void)({ preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) });
	assert.deepEqual(routes, [{ view: "session", ws: "wA", key: "sb-main-3946" }]);
	assert.ok(prevented && stopped);
});

// --- the CSS ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
const rule = (sheet: string, selector: string) => sheet.split("\n").flatMap((line) => line.match(/[^{}]+\{[^{}]*\}/g) ?? []).filter((r) => r.trim().startsWith(selector));

test("GR-F002: a command wraps whole (pre-wrap, anywhere), on a phone as well, so no character hides behind a scroll", () => {
	const r = rule(css, ".wait-card .wc-cmd {").join(" ");
	assert.match(r, /white-space:\s*pre-wrap/);
	assert.match(r, /overflow-wrap:\s*anywhere/);
	assert.doesNotMatch(r, /overflow-x/);
	assert.doesNotMatch(css, /\.wait-card \.wc-cmd \{ overflow-x: auto; \}/, "the phone block does not bring the sideways scroll back");
});

test("GR-F005: disabled buttons of the card look disabled in the dock and in Zen, and the state line is green only for a press", () => {
	for (const [name, sheet, ink] of [["dock", css, "var\\(--dim\\)"], ["zen", zen, "var\\(--zen-ash\\)"]] as const) {
		const off = rule(sheet, name === "zen" ? '[data-view="zen"] .wait-card .pair-btn:disabled {' : ".wait-card .pair-btn:disabled {").join(" ");
		assert.match(off, /border:\s*1px dashed/, `${name}: an off button is flat and dashed`);
		assert.match(off, /background:\s*transparent/, name);
		assert.match(off, new RegExp(`color:\\s*${ink}`), `${name}: in the dim text colour`);
		assert.doesNotMatch(off, /opacity/, `${name}: no opacity, so its text keeps its contrast whatever the row around it does`);
	}
	assert.doesNotMatch(css, /\.wc-opt:disabled[^{]*\{[^}]*opacity/, "no rule dims a disabled option");
	assert.match(css, /\.tower-notices \.tnote \.wait-card \.pair-btn:disabled\s*\{[^}]*opacity:\s*1[;\s}]/, "the notices' own dimming of an off button does not reach the card's buttons in a row: their text keeps its contrast");
	assert.doesNotMatch(rule(css, ".wait-card .wc-state {").join(" "), /var\(--ok\)/, "the default state line is not success green");
	assert.match(css, /\.wait-card\[data-pressed="true"\] \.wc-state\s*\{[^}]*var\(--ok\)/);
	assert.match(css, /\.wait-card\[data-phase="stale"\] \.wc-state\s*\{[^}]*var\(--gold\)/);
});

test("GR-F006: the card's open, copy and raiser links read as enabled actions (the text colour)", () => {
	assert.match(css, /\.wait-card :is\(\.wc-open, \.wc-copy, \.wc-main\)\s*\{[^}]*color:\s*var\(--text\)/);
});

test("a box base's tower note card shows its URL as text only; a local base's keeps Open link", async () => {
	const withUrl = (url: string) => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [WAIT("action", { card: { ...CARD(), url } })], proposals: [] } });
	const draw = async (isBox: boolean) => {
		const box = new El("div");
		fillNotices(box as unknown as HTMLElement, "wB", withUrl("https://example.com/export") as never, "sb-tower-w", undefined, isBox);
		await settle();
		(box.find((el) => el.classes.has("wc-fold"))[0] as unknown as { click(): void } | undefined)?.click();
		return box;
	};
	const remote = await draw(true), local = await draw(false);
	assert.equal(byClass(remote, "wc-open").length, 0);
	assert.ok(byClass(remote, "wc-url").length > 0 || remote.textContent.includes("https://example.com/export"), "the URL is shown as text");
	assert.equal(remote.find((el) => el.tag === "a" && el.getAttribute("href") === "https://example.com/export").length, 0);
	assert.equal(byClass(local, "wc-open").length, 1);
});
