import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fieldsOf } from "../src/header.ts";
import { ASK_CAP, ASK_OPEN_MS, answerAsk, openAsk, openAsks, readAsks } from "../src/server/headasks.ts";
import { headGate } from "../src/server/headgate.ts";
import { HEAD_REFUSAL } from "../src/server/head.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue } from "../src/server/towerstore.ts";
import type { Slot } from "../src/server/record.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// What may reach the head identity (docs/specs/2026-11-04-head-tower.md, Who reaches it; H2): the boss's events, answers to its own asks, and the server's notices. Everything else is refused at the gate with a receipt,
// before anything is queued or woken. The asks (headasks.ts) are the head's own: an answer is accepted only for an open ask to the workspace its sender is the tower of.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-hg-")) }) as Slot;
const T0 = Date.parse("2026-11-04T08:00:00Z");

test("asks: ids count up from H1, an ask stays open 24 hours after its last forward or answer, an answer renews it, and only the workspace it was opened for may answer", () => {
	const slot = slotIn();
	const a = openAsk(slot, T0, { workspace: "wA", label: "Alpha", first: "do the thing\nmore", relay: "boss:e1" });
	const b = openAsk(slot, T0 + 1000, { workspace: "wB", label: "Beta", first: "other" });
	assert.deepEqual([a.id, b.id], ["H1", "H2"]);
	assert.equal(a.first, "do the thing", "the first line only");
	assert.deepEqual(openAsks(slot, T0 + 2000).map((x) => x.id), ["H1", "H2"]);
	assert.equal(answerAsk(slot, T0 + 5000, { id: "H1", workspace: "wB", text: "x" }), undefined, "another workspace's ask is not answered");
	assert.equal(answerAsk(slot, T0 + 5000, { id: "H9", workspace: "wA", text: "x" }), undefined, "no such ask");
	const answered = answerAsk(slot, T0 + ASK_OPEN_MS - 1, { id: "H1", workspace: "wA", text: "landed in 4128\nline two" })!;
	assert.deepEqual(answered.answers, [{ at: T0 + ASK_OPEN_MS - 1, first: "landed in 4128" }]);
	// 24 h after the first forward the second ask is gone; the first was renewed by its answer.
	assert.deepEqual(openAsks(slot, T0 + 1000 + ASK_OPEN_MS).map((x) => x.id), ["H1"]);
	assert.equal(answerAsk(slot, T0 + 1000 + ASK_OPEN_MS, { id: "H2", workspace: "wB", text: "late" }), undefined, "an expired ask takes no answer");
	assert.deepEqual(openAsks(slot, T0 + 2 * ASK_OPEN_MS).map((x) => x.id), [], "and the first expires 24 h after its answer");
	assert.equal(readAsks(slot, T0 + 2 * ASK_OPEN_MS).find((x) => x.id === "H1")?.answers.length, 1, "an expired ask stays in the list with its answers");
});

test("asks: at most 40 are open; opening one more closes the oldest, and a forward to a workspace again renews its ask only when the head says so", () => {
	const slot = slotIn();
	for (let n = 0; n < ASK_CAP + 1; n++) openAsk(slot, T0 + n, { workspace: `w${n}`, label: `W${n}`, first: `m${n}` });
	const open = openAsks(slot, T0 + 100);
	assert.equal(open.length, ASK_CAP);
	assert.equal(open[0]!.id, "H2", "H1 was the oldest and is closed");
	assert.equal(answerAsk(slot, T0 + 100, { id: "H1", workspace: "w0", text: "late" }), undefined);
	assert.equal(answerAsk(slot, T0 + 100, { id: "H2", workspace: "w1", text: "ok" })!.id, "H2");
});

const header = (fields: string) => `[straw net ${fields}] answer text`;
const answerFrom = (ask: string, extra = "") => header(`from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=tower to="head tower (head tower of head)" reply=none in-reply-to=${ask}${extra}`);

test("the gate is a pure rule: an answer needs the in-reply-to of an open ask to the workspace the sender is the tower of; everything else says why it is refused", () => {
	const open = (workspace: string, id: string) => workspace === "wA" && id === "H1";
	const base = { senderWorkspace: "wA", isOpen: open };
	assert.deepEqual(headGate({ ...base, text: answerFrom("H1") }), { ok: true, ask: "H1", workspace: "wA" });
	assert.equal(headGate({ ...base, text: "plain text, no header" }).ok, false);
	assert.equal(headGate({ ...base, text: header("from=x id=main-1 role=main kind=broadcast scope=all to=x reply=none") }).ok, false, "a broadcast");
	assert.equal(headGate({ ...base, text: header("from=x id=sb-tower-wa role=tower kind=tower_send scope=towers to=x reply=none") }).ok, false, "a tower_send to all towers has no ask");
	assert.equal(headGate({ ...base, text: answerFrom("H7") }).ok, false, "no such ask");
	assert.equal(headGate({ ...base, senderWorkspace: "wB", text: answerFrom("H1") }).ok, false, "another workspace's tower");
	assert.equal(headGate({ ...base, senderWorkspace: undefined, text: answerFrom("H1") }).ok, false, "a sender that is the tower of no workspace (a main, a member)");
	assert.equal(headGate({ ...base, text: answerFrom("H1").replace("kind=tower_send", "kind=broadcast") }).ok, false, "only a tower_send answers");
	assert.equal(headGate({ ...base, text: `text first, then ${answerFrom("H1")}` }).ok, false, "the header is read at the very start only");
});

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	world.runTimers = { hold: 200 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	const head = await world.expose!.head.ensure();
	return { s, head, client: world.client("sb-head")! };
};
const msg = (id: string, text: string) => ({ id, content: { text } }) as never;
const refused = async (client: NonNullable<ReturnType<TowerWorld["client"]>>, from: { id: string; name?: string }, id: string, text: string) => {
	const before = client.receipts.length;
	client.incoming(from, msg(id, text));
	await until(() => client.receipts.length === before + 1, "a receipt");
	return client.receipts.at(-1)!;
};

test("each kind of message the head does not take gets a receipt `expired` with the sentence, and nothing is queued, noted, or woken; the log names the sender and no text", async () => {
	const { head, client } = await setup();
	world.herdr.commands("agent", "start");
	const cases: [string, { id: string; name?: string }, string][] = [
		["a boss_broadcast of any scope", { id: "main-1", name: "docs-main" }, header('from=docs-main id=main-1 role=main workspace=Alpha kind=broadcast scope=all to="x (session)" reply=none') + " SECRET-ONE"],
		["a tower_send to all towers", { id: "sb-tower-wa", name: "tower · Alpha" }, header('from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=towers to="x (tower)" reply=none') + " SECRET-TWO"],
		["a message with no open ask", { id: "sb-tower-wa", name: "tower · Alpha" }, answerFrom("H9") + " SECRET-THREE"],
		["a main's message that claims an ask", { id: "main-1", name: "docs-main" }, answerFrom("H1") + " SECRET-FOUR"],
		["text with no header at all", { id: "main-2", name: "x" }, "do the thing SECRET-FIVE"],
	];
	openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "x" });
	for (const [what, from, text] of cases) {
		const receipt = await refused(client, from, `m-${what.length}`, text);
		assert.equal(receipt.status, "expired", what);
		assert.equal(receipt.detail, HEAD_REFUSAL, what);
	}
	assert.deepEqual(readQueue(world.slot, head.workspace), []);
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
	const log = readFileSync(fileOf(world.slot, "log"), "utf8");
	assert.equal(log.split("\n").filter((l) => l.includes("head-refused")).length, cases.length);
	assert.match(log, /head-refused[^\n]*main-1/);
	assert.doesNotMatch(log, /SECRET-/, "no message text in the log");
	assert.equal(readAsks(world.slot, Date.now()).find((a) => a.id === "H1")?.answers.length, 0, "a refused message answers nothing");
});

test("an answer from the tower the ask was opened for is queued, recorded on the ask, receipted `queued`, held with others up to the hold, and then wakes one head run", async () => {
	const { s, head, client } = await setup();
	const wa = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it", relay: "boss:e1" });
	const wb = openAsk(world.slot, Date.now(), { workspace: "wB", label: "Beta", first: "and this" });
	const receipt = await refused(client, { id: "sb-tower-wa", name: "tower · Alpha" }, "a1", answerFrom(wa.id) + " landed");
	assert.equal(receipt.status, "queued");
	await refused(client, { id: "sb-tower-wb", name: "tower · Beta" }, "b1", answerFrom(wb.id).replace("id=sb-tower-wa", "id=sb-tower-wb") + " blocked");
	assert.equal(readQueue(world.slot, head.workspace).length, 2);
	assert.deepEqual(readQueue(world.slot, head.workspace).map((e) => e.kind), ["intercom", "intercom"]);
	assert.equal(world.pis.size, 0, "held for the other answers (the milestone hold)");
	assert.equal(readAsks(world.slot, Date.now()).find((a) => a.id === wa.id)?.answers[0]?.first, "answer text landed", "the answer is recorded by its first line, without the header");
	await until(() => world.pis.size === 1, "one head run for both answers");
	void s;
	// The text the run reads keeps the header the tower's code wrote.
	assert.equal(fieldsOf(readQueue(world.slot, head.workspace)[0]!.text)?.["in-reply-to"], "H1");
});

test("a boss event passes without an ask and wakes the head at once; the answer of an expired ask is refused", async () => {
	const { s, head, client } = await setup();
	assert.equal((await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "tell Alpha to start", present: true })).ok, true);
	await until(() => world.pis.size === 1, "the head run");
	const old = openAsk(world.slot, Date.now() - ASK_OPEN_MS - 1000, { workspace: "wA", label: "Alpha", first: "x" });
	const receipt = await refused(client, { id: "sb-tower-wa", name: "tower · Alpha" }, "late", answerFrom(old.id) + " too late");
	assert.equal(receipt.status, "expired");
});
