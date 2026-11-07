import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Item } from "../src/items.ts";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// An agent's message in the comms log draws its blocks with pi-better-show's elements, whichever base shows the log (Standard, Geek, Zen, a phone, an operate base: they all mount gui/chat.ts). A submitted block is the
// boss's message to that unit through the composer's input route and its guards; the element locks once the unit took it, and the server's record (read when the log is drawn) keeps it locked after a reload and on every device.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountChat } = await import("../gui/chat.ts");
const { whenDrawn, drawing } = await import("../gui/mdbody.ts");
const { answeredHooks, forgetAnswered } = await import("../gui/answered.ts");
const { forgetLocks } = await import("../gui/blocklock.ts");
const { DEMO_CHAT_BLOCKS } = await import("../gui/demo-blocks.ts");
let record: { done: [string, number, [string, string][]][]; pending: [string, number][]; unreadable?: boolean } = { done: [], pending: [] };
let reading: (() => Promise<unknown>) | undefined;
beforeEach(() => {
	stored.clear();
	forgetLocks();
	forgetAnswered();
	record = { done: [], pending: [] };
	reading = undefined;
	answeredHooks.get = async () => (reading ? reading() : record) as never;
});
type Posted = { ok: boolean; status: number; body: Record<string, unknown> };
type Sent = [string, Record<string, unknown>];

const mount = (key: string, answer: (body: Record<string, unknown>) => Posted = () => ({ ok: true, status: 200, body: { accepted: true } })) => {
	const root = new El("div"), sent: Sent[] = [];
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async (action: string, body: Record<string, unknown>) => (sent.push([action, body]), answer(body)) };
	const chat = mountChat(root as unknown as HTMLElement, data as never, { who: () => ({ key, name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined });
	const show = async (...items: Item[]) => (chat.apply({ key, reset: true, items }), await whenDrawn(), root);
	return { root, sent, show };
};
const reply = (text: string, id = "a1"): Item => ({ id, kind: "assistant", text, model: "m" });
const fire = (el: El, answer: unknown) => {
	let refused = false;
	for (const on of el.handlers["pbs-answer"] ?? []) on({ type: "pbs-answer", detail: answer, preventDefault: () => (refused = true) });
	return refused;
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await whenDrawn(); };
type Locked = El & { answered?: unknown; data?: unknown };
const find = (root: El, tag: string) => root.find((el) => el.tagName === tag) as Locked[];

test("an agent's message with blocks draws a form, chips, and a table with their elements, compact, in the message's own body", async () => {
	const { show } = mount("S1");
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const body = root.find((el) => el.className === "md")[0]!;
	assert.deepEqual(body.find((el) => el.tagName.startsWith("pbs-")).map((el) => el.tagName), ["pbs-form", "pbs-suggest", "pbs-table"]);
	for (const el of body.find((el) => el.tagName.startsWith("pbs-"))) assert.equal(el.getAttribute("density"), "compact");
	assert.match(body.textContent, /I can ship the ledger fix today/, "the prose is still the page's own Markdown");
});

test("a message with no block never loads the block code", async () => {
	const { show } = mount("S1");
	const root = await show(reply("Just **words**.\n\n```js\nlet a = 1\n```"), { id: "u1", kind: "user", text: "```form\nquestions: []\n```" });
	assert.equal(drawing(), 0, "nothing was imported for it");
	assert.equal(root.find((el) => el.tagName.startsWith("pbs-")).length, 0);
});

test("a block's answer is the boss's message to that unit: the composer's input route, sent as a message, held to the remote guards; the element locks once the unit took it", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	assert.equal(fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } }), true);
	await settle();
	assert.deepEqual(sent, [["input", { text: "Go ahead", as: "send", guarded: true, block: { entry: "a1", index: 1, fields: [["text", "Go ahead"]] } }]], "the block names itself, so the server records that it was answered");
	assert.deepEqual(chips!.answered, [["text", "Go ahead"]]);
	const [form] = find(root, "pbs-form");
	fire(form!, { kind: "form", title: "Ship the ledger fix", fields: [["when", "now"], ["note", "watch refunds"]], ref: { block: 0 } });
	await settle();
	assert.equal(sent.length, 1, "BSR-F001: the form's names are not its labels (when/When?, now/Today): the exact text is shown first and nothing goes until Send");
	const step = root.find((el) => el.getAttribute("class") === "pbs-confirm");
	assert.equal(step.length, 1);
	assert.equal(step[0]!.find((el) => el.tagName === "pre")[0]!.textContent, "User submitted a form in the HTML review pane:\n- when: now\n- note: watch refunds");
	for (const on of step[0]!.find((el) => el.getAttribute("class") === "pbs-confirm-send")[0]!.handlers.click ?? []) on({ type: "click" });
	await settle();
	assert.equal(sent[1]![1].text, "User submitted a form in the HTML review pane:\n- when: now\n- note: watch refunds", "the text the agent reads is encodeAnswer's");
	assert.deepEqual(form!.answered, [["when", "now"], ["note", "watch refunds"]]);
});

test("the lock survives a reload and shows on every device: the server's record is read when the log is drawn, per session, entry, and block", async () => {
	const first = mount("S1");
	const root = await first.show(reply(DEMO_CHAT_BLOCKS));
	fire(find(root, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(stored.size, 0, "the page keeps nothing of its own");
	forgetLocks(); // a reload: the page's memory is gone
	forgetAnswered();
	record = { done: [["a1", 1, [["text", "Go ahead"]]]], pending: [] };
	const again = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.deepEqual(find(again, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]], "locked after a reload");
	assert.equal(find(again, "pbs-form")[0]!.answered, undefined, "only the block that was answered");
	forgetLocks();
	forgetAnswered();
	const elsewhere = await mount("S2").show(reply(DEMO_CHAT_BLOCKS, "a9"));
	assert.equal(find(elsewhere, "pbs-suggest")[0]!.answered, undefined, "another session or entry: the record names none");
});

test("the record asked for is the session's: one request, shared by every message drawn at once, and the key is the session's", async () => {
	const asked: string[] = [];
	answeredHooks.get = async (key) => (asked.push(key), record) as never;
	const { show } = mount("S 1/x");
	await show(reply(DEMO_CHAT_BLOCKS, "a1"), reply(DEMO_CHAT_BLOCKS, "a2"), reply(DEMO_CHAT_BLOCKS, "a3"));
	assert.deepEqual(asked, ["S 1/x"]);
});

test("a block the record says is on its way comes up locked and pending, one it could not read comes up open with a note, and answering still works", async () => {
	record = { done: [], pending: [["a1", 1]] };
	const pending = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.equal(pending.find((el) => el.getAttribute("class") === "pbs-block" && el.hasAttribute("inert")).length, 1);
	forgetLocks();
	forgetAnswered();
	reading = async () => { throw new Error("offline"); };
	const { show, sent } = mount("S1");
	const unsure = await show(reply(DEMO_CHAT_BLOCKS));
	assert.ok(unsure.find((el) => el.getAttribute("class") === "pbs-note").every((el) => /could not be read/i.test(el.textContent)));
	fire(find(unsure, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(find(unsure, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]]);
});

test("a record the server marks unreadable comes up open with the note, even though the request itself went through", async () => {
	record = { done: [], pending: [], unreadable: true };
	const root = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.ok(root.find((el) => el.getAttribute("class") === "pbs-note").every((el) => /could not be read/i.test(el.textContent)));
});

test("a message redrawn while its answer is on its way (a tool result, a reconnect) comes up locked, and locks with the fields when the unit has taken the message", async () => {
	let release!: (r: Posted) => void, started = false;
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ((started = true), await new Promise<Posted>((r) => (release = r))) };
	const holder = new El("div");
	const chat = mountChat(holder as unknown as HTMLElement, data as never, { who: () => ({ key: "S1", name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined });
	chat.apply({ key: "S1", reset: true, items: [reply(DEMO_CHAT_BLOCKS)] });
	await whenDrawn();
	fire(find(holder, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(started, true);
	chat.apply({ key: "S1", reset: true, items: [reply(DEMO_CHAT_BLOCKS)] }); // the redraw
	await whenDrawn();
	assert.equal(holder.find((el) => el.getAttribute("class") === "pbs-block" && el.hasAttribute("inert")).length, 1, "the new drawing of the block in flight is locked");
	release({ ok: true, status: 200, body: {} });
	await settle();
	assert.deepEqual(find(holder, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]]);
	assert.equal(holder.find((el) => el.hasAttribute("inert")).length, 0);
});

test("a unit that refuses the message leaves the block open with the server's reason under it, and nothing is kept", async () => {
	const { show, sent } = mount("S1", () => ({ ok: false, status: 403, body: { error: "local_only", reason: "A /boss send is held to the guards of a remote write." } }));
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]] });
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(chips!.answered, undefined);
	assert.match(root.find((el) => el.className === "pbs-note").map((el) => el.textContent).join(""), /remote write/);
	assert.equal(stored.size, 0, "nothing was kept");
});

test("a chip whose text is a command line is not sent: the page says so and posts nothing", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply("```suggest\n- {label: Looks fine, text: '/quit'}\n- {label: Cleanup, text: '!rm -rf ~'}\n```"));
	const [chips] = find(root, "pbs-suggest");
	fire(chips!, { kind: "suggest", fields: [["text", "/quit"]] });
	fire(chips!, { kind: "suggest", fields: [["text", "!rm -rf ~"]] });
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(chips!.answered, undefined);
	assert.ok(root.find((el) => el.className === "pbs-note")[0]!.textContent.length > 0);
});
