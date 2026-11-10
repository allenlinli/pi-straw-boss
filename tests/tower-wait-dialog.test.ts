import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// The dialog of a wait the tower recorded on the boss (gui/layer.ts, gui/waitpanel.ts): the wait's words, an answer box (Handle unfolds it; what is sent goes to the tower's session input, as the comms' composer sends it, and the
// dialog closes once the tower took it), a secondary link to the tower's comms, and Skip (the decline press; the wait becomes resolved in the tower's memory), and no last-transmission block, which would show the tower's old log under a question nobody asked there.

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
const has = (name: string) => dock.all((el) => el.classes.has(name))[0];
/** A tap on an act's row only picks it (the question panel's way); Send is the press (docs/specs/2026-11-10-wait-cards-tui.md, Q1). */
const pick = (label: string) => button(label)!.click();
const send = () => dock.all((el) => el.classes.has("ask-send"))[0]!;

test("a wait's dialog says what the tower waits for, offers the reply fold, the tower's comms and Skip, and keeps the old transmission out of it", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(cls("state")!.textContent, m.memory_wait_boss());
	assert.equal(has("wc-text")!.textContent, "api-fix asks: deploy ws01?", "the tower's own words (this wait has no card), in the answer slot where they wrap");
	assert.equal(cls("wc-tag")!.textContent, m.wc_tag_legacy(), "a wait from before cards is drawn as a legacy card");
	assert.equal(cls("tag")!.textContent, m.wc_tag_legacy(), "the badge is the card's own word, not QUESTION");
	assert.equal(cls("intel")!.hidden, true, "no last transmission under a wait");
	const go = cls("go")!;
	assert.equal(go.textContent, m.wait_goto());
	assert.equal(go.getAttribute("href"), "w/w/s/sb-tower-w", "the link to the tower's comms, no longer the act");
	assert.ok(button(m.wc_b_reply()), "Handle answers here");
	assert.ok(button(m.later()), "and it can wait");
	assert.ok(button(m.wc_b_skip()), "Skip");
	assert.ok(button(m.wc_b_restate()), "and the primary: ask the tower to write it as a card");
});

test("a wait's dialog is titled with the role and the place once, in the page's language, as Zen's card is: the raw English name, the header's place, and the role under the title are not drawn again", async () => {
	const { overwriteGetLocale } = await import("../gui/paraglide/runtime.js");
	try {
		for (const [locale, title] of [["en", "tower · w"], ["zh-TW", "塔台 · w"]] as const) {
			overwriteGetLocale(() => locale);
			const layer = mount();
			layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
			layer.stack.show(wait as never);
			assert.equal(dock.all((el) => el.tagName === "h3")[0]!.textContent, title, locale);
			assert.equal(cls("where")!.hidden, true, `${locale}: the place is in the title`);
			assert.equal(cls("role")!.hidden, true, `${locale}: and so is the role`);
			if (locale === "zh-TW") assert.equal(dock.all(() => true).some((el) => el.textContent === wait.name), false, "no raw English name");
		}
	} finally {
		overwriteGetLocale(() => "en");
	}
});

test("a wait's dialog puts the comms link and Later in one footer row: Skip is a row of the card now", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	const footer = dock.all((el) => el.tagName === "footer")[0]!;
	const row = footer.children.filter((el) => el.tagName === "a" || el.tagName === "button").map((el) => el.textContent);
	assert.deepEqual(row, [m.wait_goto(), m.later()]);
});

test("Skip takes two taps: picking its row unfolds the reason box, Send posts the decline press to the tower's memory route by the wait's id and closes the dialog once the server took it; a refusal says why and leaves it", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(cls("wc-skip-box")!.hidden, true);
	pick(m.wc_b_skip());
	await settle();
	assert.deepEqual(sent, [], "the first tap sends nothing");
	assert.equal(cls("wc-skip-box")!.hidden, false);
	reply = { ok: false, status: 409, body: { error: "refused", reason: "No such wait W2" } };
	send().click();
	await settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "press", id: "W2", act: "decline" }, csrf: "CSRF" }]);
	assert.match(has("ask-note")!.textContent, /no such wait W2/i);
	assert.equal(layer.stack.open.length, 1, "refused: still open");
	reply = { ok: true, status: 200, body: MEMORY };
	send().click();
	await settle();
	assert.equal(sent.length, 2);
	assert.equal(layer.stack.open.length, 0, "taken: closed");
});

test("a dialog whose wait is over says so, not that the tower left the net, and offers no Skip", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	layer.alerts([], new Map());
	assert.equal(cls("state")!.textContent, m.tower_wait_over());
	assert.equal(cls("tag")!.textContent, m.wc_tag_legacy(), "the chip does not say the tower is GONE");
	assert.equal(button(m.wc_b_skip())?.hidden ?? true, true, "nothing to skip");
	assert.ok(has("wait-card")!.textContent.includes(m.wc_ended_plain()), "the card says the tower closed it");
});

const box = () => dock.all((el) => el.classes.has("wait-box"))[0]!;
const typed = (text: string) => ((box().value = text), box().bubble("input", {}));
const enter = () => box().bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 });

test("Reply picked unfolds the answer box in the dialog's slot and stays on the page: the dialog is not left for the comms", () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(box().hidden, true, "folded until Reply is picked");
	pick(m.wc_b_reply());
	assert.equal(box().hidden, false);
	assert.equal(page.focused, box(), "the box has the focus");
	assert.equal(layer.stack.open.length, 1, "the dialog stays");
	assert.equal(button(m.wc_b_reply())!.getAttribute("aria-checked"), "true", "Reply is what is picked now");
	assert.equal(send().disabled, true, "Send waits for words");
	typed("x");
	assert.equal(send().disabled, false);
});

test("sending posts the words to the tower's session input as the composer does, and the dialog closes once the tower took it", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	pick(m.wc_b_reply());
	typed("Use the staging token");
	enter();
	await settle();
	assert.deepEqual(told, [{ key: "sb-tower-w", action: "input", body: { text: "Use the staging token", as: "send", answers: "W2" } }]);
	assert.equal(layer.stack.open.length, 0, "taken: closed");
});

test("a refusal shows under the kept draft and the dialog stays; Send does the same as Enter", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	pick(m.wc_b_reply());
	tellReply = { ok: false, status: 409, body: { error: "refused", reason: "The tower did not take it." } };
	typed("Use the staging token");
	send().click();
	await settle();
	assert.equal(told.length, 1);
	assert.equal(box().value, "Use the staging token", "the draft is kept");
	assert.match(has("ask-note")!.textContent, /Not sent: the tower did not take it\./);
	assert.equal(layer.stack.open.length, 1);
	tellReply = { ok: true, status: 200, body: { accepted: true } };
	send().click();
	await settle();
	assert.equal(told.length, 2);
	assert.equal(layer.stack.open.length, 0, "the second try is taken");
});

test("an empty box, Shift+Enter, and a stream that is not live send nothing", async () => {
	const layer = mount();
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	pick(m.wc_b_reply());
	enter();
	typed("x");
	box().bubble("keydown", { key: "Enter", shiftKey: true, isComposing: false, keyCode: 13 });
	page.body.dataset.stale = "true";
	layer.alerts([wait as never], new Map([[wait.key, wait as never]]));
	layer.stack.show(wait as never);
	assert.equal(send().disabled, true, "no answer while the link is down");
	enter();
	await settle();
	assert.deepEqual(told, []);
});

// --- a wait card (docs/specs/2026-11-07-wait-cards.md): the dialog draws the card whole, its primary presses at the memory route, the secret card stays for its second step ---------------------------------------------------------

const CARD = { type: "action" as const, lang: "en" as const, happened: "The Tailscale login key of fonstar-staging expired, so it is offline.", do: "Open the Tailscale admin page and re-authorize fonstar-staging.", url: "https://login.tailscale.com/admin/machines", after: "The tower asks the MP-3946 main to verify the print feature.", from: { name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946", key: "sb-main-3946" } };
const cardAlert = (card: typeof CARD | Record<string, unknown>, press?: Record<string, unknown>) => {
	const entry = { id: "W9", text: String((card as typeof CARD).do), at: new Date().toISOString(), card, ...(press ? { press } : {}) };
	return { ...wait, key: "wait\u001fw\u001fW9", wait: { id: "W9", text: entry.text, entry } };
};

test("a card wait's dialog draws the whole card and the footer row, and I'm done (picked, then Send) posts the press and closes the dialog", async () => {
	const layer = mount();
	const a = cardAlert(CARD);
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	layer.stack.show(a as never);
	for (const part of [CARD.happened, CARD.do, CARD.url, CARD.after, m.wc_tag_action(), m.wc_b_done(), m.wc_b_main({ name: "mp3946-print" })]) assert.ok(dock.textContent.includes(part), part);
	assert.equal(dock.all((el) => Boolean(el.getAttribute("class")?.includes("wc-clamp"))).length, 0, "the dialog shows every part whole");
	const footer = dock.all((el) => el.tagName === "footer")[0]!;
	assert.deepEqual(footer.children.filter((el) => el.tagName === "a" || el.tagName === "button").map((el) => el.textContent), [m.wait_goto(), m.later()]);
	const link = dock.all((el) => el.tagName === "a" && el.getAttribute("class") === "cmp-link wc-main")[0]!;
	assert.equal(link.getAttribute("data-route"), "w/w/s/sb-main-3946", "Open <raiser> goes to the raiser's session");
	pick(m.wc_b_done());
	assert.deepEqual(sent, [], "a pick alone presses nothing");
	send().click();
	await settle();
	assert.deepEqual(sent, [{ path: "api/tower/w/memory", body: { op: "press", id: "W9", act: "done" }, csrf: "CSRF" }]);
	assert.equal(layer.stack.open.length, 0, "taken: closed");
});

test("a head wait's dialog says the head tower in the card's words, a workspace tower's the tower (Q3)", () => {
	const layer = mount();
	const a = { ...cardAlert(CARD), ws: "@head", key: "wait\u001f@head\u001fW9", unit: "sb-head" };
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	layer.stack.show(a as never);
	assert.ok(button(m.wc_b_reply_head()), "Reply to the head tower");
	assert.equal(button(m.wc_b_reply()), undefined);
});

test("a secret card's start press leaves the dialog open; its second step says where to enter the secret, and the terminal once the raiser's secret_drop dialog is pending", async () => {
	const layer = mount();
	const secret = { ...CARD, type: "secret" as const, secret: { name: "fonstar-staging Tailscale auth key" } };
	reply = { ok: true, status: 200, body: { ...MEMORY, press: { act: "secret", at: new Date().toISOString(), secretAsked: new Date().toISOString() } } };
	const a = cardAlert(secret);
	layer.alerts([a as never], new Map([[a.key, a as never]]));
	layer.stack.show(a as never);
	pick(m.wc_b_start());
	send().click();
	await settle();
	assert.deepEqual(sent.map((s) => s.body), [{ op: "press", id: "W9", act: "secret" }]);
	assert.equal(layer.stack.open.length, 1, "the first step ends nothing");
	assert.ok(dock.textContent.includes(m.wc_secret_asked({ name: "mp3946-print", tab: "MP-3946" })));
	assert.ok(button(m.wc_b_entered()), "I've entered it takes the place of Start");
	const asked = cardAlert(secret, { act: "secret", at: new Date().toISOString(), secretAsked: new Date().toISOString() });
	const raiser = { key: "sb-main-3946", ws: "w", name: "mp3946-print", role: "main", mark: "waiting" as const, at: 1, since: 1, pending: { callId: "c1", tool: "secret_drop", why: "It waits for a secret." } };
	layer.alerts([asked as never, raiser as never], new Map([[asked.key, asked as never], [raiser.key, raiser as never]]));
	assert.ok(dock.textContent.includes(m.wc_secret_open()), "the dialog is pending in the raiser's terminal");
});

test("a paired device's secret card has no start button, and the dialog says to enter it at the computer", () => {
	Object.assign(globalThis, { location: { hash: "", href: "http://x/", origin: "http://x", hostname: "mac.tailnet.ts.net" } });
	try {
		const layer = mount();
		const a = cardAlert({ ...CARD, type: "secret", secret: { name: "key" } });
		layer.alerts([a as never], new Map([[a.key, a as never]]));
		layer.stack.show(a as never);
		assert.equal(button(m.wc_b_start()), undefined);
		assert.ok(dock.textContent.includes(m.wc_at_computer()));
	} finally {
		Object.assign(globalThis, { location: { hash: "", href: "http://x/", origin: "http://x" } });
	}
});
