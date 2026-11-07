import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Item } from "../src/items.ts";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// An agent's message in the comms log draws its blocks with pi-better-show's elements, whichever base shows the log (Standard, Geek, Zen, a phone, an operate base: they all mount gui/chat.ts). A submitted block is the
// boss's message to that unit through the composer's input route and its guards; the element locks once the unit took it, and the lock survives a reload.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountChat } = await import("../gui/chat.ts");
const { whenDrawn, drawing } = await import("../gui/mdbody.ts");
const { DEMO_CHAT_BLOCKS } = await import("../gui/demo-blocks.ts");
beforeEach(() => stored.clear());
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
	assert.deepEqual(sent, [["input", { text: "Go ahead", as: "send", guarded: true }]]);
	assert.deepEqual(chips!.answered, [["text", "Go ahead"]]);
	const [form] = find(root, "pbs-form");
	fire(form!, { kind: "form", title: "Ship the ledger fix", fields: [["when", "now"], ["note", "watch refunds"]], ref: { block: 0 } });
	await settle();
	assert.equal(sent[1]![1].text, "User submitted a form in the HTML review pane:\n- when: now\n- note: watch refunds", "the text the agent reads is encodeAnswer's");
	assert.deepEqual(form!.answered, [["when", "now"], ["note", "watch refunds"]]);
});

test("the lock survives a reload: the same message in a new log is locked, and under another session or entry it is not", async () => {
	const first = mount("S1");
	const root = await first.show(reply(DEMO_CHAT_BLOCKS));
	fire(find(root, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]] });
	await settle();
	assert.ok([...stored.keys()].some((k) => k.startsWith("sb-")));
	const again = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.deepEqual(find(again, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]], "locked after a reload");
	assert.equal(find(again, "pbs-form")[0]!.answered, undefined, "only the block that was answered");
	const elsewhere = await mount("S2").show(reply(DEMO_CHAT_BLOCKS));
	assert.equal(find(elsewhere, "pbs-suggest")[0]!.answered, undefined, "another session");
	const another = await mount("S1").show(reply(DEMO_CHAT_BLOCKS, "a2"));
	assert.equal(find(another, "pbs-suggest")[0]!.answered, undefined, "another entry");
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
	assert.ok(![...stored.keys()].some((k) => k.startsWith("sb-answered")), "no lock was written");
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
