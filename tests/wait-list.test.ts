import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { callControl } from "../src/server/socket.ts";
import { towerPanel } from "../src/server/towerpanel.ts";
import { HEAD_KEY } from "../src/server/towerstore.ts";
import { type Entry, iso, updateMemory } from "../src/server/towermemory.ts";
import { digestOf, waitRows } from "../src/server/waitlist.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The boss's wait cards as one read (docs/specs/2026-11-10-wait-cards-tui.md, §1; todo #144 task 1): `boss-waits` lists every tower's and the head's open cards, a run token is refused it, and the polls of a standing prompt and of a
// local or head run carry the digest of the pane's own tower (an ally run's carries none).

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const NOW = Date.now();
const FROM = { id: "main-1", name: "mp3946-print", role: "main" };
const card = (over: Record<string, unknown> = {}) => ({ type: "action", lang: "en", happened: "The key expired.", do: "Re-authorize the machine.", from: FROM, ...over });
let at = NOW;
/** A wait of the memory written as the file holds it (the card shapes a run could never write, such as an escape in a field, are what the reader must clean). */
const plant = (key: string, e: Partial<Entry> & { id: string }) =>
	updateMemory(world.slot, key, NOW, (m) => void m.entries.push({ kind: "wait", text: String(e.card?.do ?? "a wait"), by: "run", via: "run", at: iso(at++), run: "r1", for: "boss", state: "open", ...e } as Entry));
const setup = async (...towers: string[]) => {
	const s = await world.start();
	await s.handle.ready;
	for (const ws of towers) await ask(s, { cmd: "ensure-tower", workspace: ws });
	return s;
};
const listed = async (s: Running, extra: Record<string, unknown> = {}) => {
	const got = await ask(s, { cmd: "boss-waits", ...extra });
	assert.equal(got.ok, true, JSON.stringify(got));
	return got as unknown as { auto: { on: boolean }; towers: { workspace: string; label: string; head?: true; waits: { id: string; text: string; card?: { do: string }; parked?: true; state: string }[] }[] };
};

test("the list: the head first, then each tower once; open and answered waits for the boss only, newest first; a resolved, expired, or agent's wait is not there", async () => {
	const s = await setup("wA", "wB");
	await world.expose!.head.ensure();
	plant("wA", { id: "W1", card: card({ do: "first" }) as never });
	plant("wA", { id: "W2", state: "answered", answered: iso(NOW), card: card({ do: "second" }) as never });
	plant("wA", { id: "W3", state: "resolved", ended: iso(NOW) });
	plant("wA", { id: "W4", state: "expired", ended: iso(NOW) });
	plant("wA", { id: "W5", for: "agent", on: { id: "main-2", name: "other" } });
	plant("wB", { id: "W1", text: "an old free-text wait" });
	plant(HEAD_KEY, { id: "W1", card: card({ do: "head's own" }) as never });
	const all = await listed(s);
	assert.deepEqual(all.towers.map((t) => t.workspace), [HEAD_KEY, "wA", "wB"], "the head first, each tower exactly once");
	assert.equal(all.towers[0]!.head, true);
	assert.equal(all.towers[0]!.label, "head tower");
	assert.deepEqual(all.towers[1]!.waits.map((w) => [w.id, w.state, w.card?.do]), [["W2", "answered", "second"], ["W1", "open", "first"]], "newest first, open and answered only");
	assert.deepEqual(all.towers[2]!.waits.map((w) => [w.id, w.card, w.text]), [["W1", undefined, "an old free-text wait"]], "a legacy wait has no card");
	assert.equal(all.auto.on, false);
	// -w: one tower, or the head
	assert.deepEqual((await listed(s, { workspace: "wB" })).towers.map((t) => t.workspace), ["wB"]);
	assert.deepEqual((await listed(s, { workspace: "head" })).towers.map((t) => t.workspace), [HEAD_KEY]);
	const none = await ask(s, { cmd: "boss-waits", workspace: "wNone" });
	assert.equal(none.ok, false);
	assert.match(String(none.error), /stands in for no tower of workspace wNone/);
});

test("every field is cleaned again at the reader: an escape or a line break in a card's text does not reach a terminal, and a command keeps its line breaks only", async () => {
	const s = await setup("wA");
	plant("wA", { id: "W1", text: "x", card: card({ happened: "it\x1b[2J broke", do: "do\x1b]0;title\x07 this\nnow", after: "then\x1b[31m red", url: "https://x.test/\x1b[3G", command: "echo \x1b[1mhi\nnext\x9b", options: undefined, from: { id: "m\x1b1", name: "na\x1bme", role: "main" } }) as never });
	const row = (await listed(s)).towers[0]!.waits[0]! as unknown as { text: string; card: { happened: string; do: string; after: string; url: string; command: string; from: { name: string; id: string } } };
	const body = JSON.stringify(row);
	assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(body.replace(/\\n/g, "")), false, `no control character left: ${body}`);
	assert.equal(row.card.do, "do]0;title this now");
	assert.equal(row.card.command, "echo  [1mhi\nnext ", "the command keeps its line break");
	assert.equal(row.card.from.name, "name");
});

test("a wait recorded under auto mode lists with its parked flag, and the list says whether auto mode is on", async () => {
	const s = await setup("wA");
	plant("wA", { id: "W1", card: card() as never, parked: true });
	const staged = await ask(s, { cmd: "auto-on", name: "a pi", session: "sess-1", pane: "p1", pid: 42 });
	assert.equal((await ask(s, { cmd: "auto-confirm", id: (staged.pending as { id: string }).id, name: "a pi", session: "sess-1", pane: "p1", pid: 42 })).ok, true);
	const got = await listed(s);
	assert.equal(got.auto.on, true);
	assert.equal(got.towers[0]!.waits[0]!.parked, true);
});

test("a run token is refused boss-waits and tower-memory, a local and a head and an ally one alike", async () => {
	const s = await setup("wA");
	const head = await world.expose!.head.ensure();
	const tokens = [world.expose!.runs.mint("wA", { kind: "local" }), world.expose!.runs.mint("wA", { kind: "ally", device: "d1", level: "reply", team: "t1" })];
	world.expose!.head.event("go").catch(() => {});
	await until(() => world.pis.size >= 1, "the head's run");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, head.workspace, id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	tokens.push(String(got.token));
	for (const token of tokens) for (const cmd of ["boss-waits", "tower-memory"]) {
		const refused = await ask(s, { cmd, token, workspace: "wA", json: { op: "read" } });
		assert.equal(refused.ok, false, `${cmd} with a run token`);
		assert.match(String(refused.error), /token may not|run token/);
	}
	assert.equal((await ask(s, { cmd: "boss-waits" })).ok, true, "the hello secret alone is the boss's");
});

test("the standing prompt's poll carries its own tower's digest (do cut to 120, the raiser, parked, pressed, at most 12), and auto", async () => {
	const s = await setup("wA", "wB");
	plant("wA", { id: "W1", card: card({ do: "x".repeat(300) }) as never, parked: true, press: { act: "secret", at: iso(NOW), secretAsked: iso(NOW) } as never });
	plant("wA", { id: "W2", text: "legacy words" });
	plant("wB", { id: "W1", card: card({ do: "not mine" }) as never });
	const polled = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321 });
	assert.equal(polled.ok, true, JSON.stringify(polled));
	assert.equal(polled.auto, false);
	const waits = polled.waits as { id: string; type: string; do: string; from?: string; parked?: true; pressed?: string }[];
	assert.deepEqual(waits.map((w) => w.id), ["W2", "W1"], "this tower's cards only, newest first");
	assert.equal(Array.from(waits[1]!.do).length, 120);
	assert.deepEqual([waits[1]!.type, waits[1]!.from, waits[1]!.parked, waits[1]!.pressed], ["action", "mp3946-print", true, "secret"]);
	assert.deepEqual([waits[0]!.type, waits[0]!.from], ["legacy", undefined]);
});

test("the digest never carries more than the memory's cap, and the head's poll carries the head's own cards", async () => {
	const s = await setup("wA");
	const head = await world.expose!.head.ensure();
	plant(HEAD_KEY, { id: "W1", card: card({ do: "for the head" }) as never });
	const polled = await ask(s, { cmd: "prompt-poll", workspace: head.workspace, pid: 4322 });
	assert.deepEqual((polled.waits as { id: string; do: string }[]).map((w) => [w.id, w.do]), [["W1", "for the head"]]);
	const rows = Array.from({ length: 15 }, (_, i) => ({ id: `W${i + 1}`, text: "t", at: "x", state: "open" as const }));
	assert.equal(digestOf(rows, true).waits.length, 12);
	assert.equal(digestOf(rows, true).auto, true);
});

test("a local and a head run's poll carries the digest of its own tower; an ally run's carries none", async () => {
	const s = await setup("wA");
	const head = await world.expose!.head.ensure();
	plant("wA", { id: "W1", card: card({ do: "tower card" }) as never });
	plant(HEAD_KEY, { id: "W1", card: card({ do: "head card" }) as never });
	const local = world.expose!.runs.mint("wA", { kind: "local" }), ally = world.expose!.runs.mint("wA", { kind: "ally", device: "d1", level: "reply", team: "t1" });
	const l = await ask(s, { cmd: "run-poll", token: local });
	assert.equal(l.ok, true, JSON.stringify(l));
	assert.deepEqual((l.waits as { do: string }[]).map((w) => w.do), ["tower card"]);
	assert.equal(l.auto, false);
	const a = await ask(s, { cmd: "run-poll", token: ally });
	assert.equal(a.ok, true, JSON.stringify(a));
	assert.equal("waits" in a || "auto" in a, false, "an ally run's sender is not the boss: no digest");
	world.expose!.head.event("go").catch(() => {});
	await until(() => world.pis.size >= 1, "the head's run");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, head.workspace, id)?.pid, "the pid");
	const claimed = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	const h = await ask(s, { cmd: "run-poll", token: String(claimed.token) });
	assert.deepEqual((h.waits as { do: string }[]).map((w) => w.do), ["head card"]);
});

test("the reader leaves out what the head's page hides as lapsed, and reports a memory it cannot read without listing from it", async () => {
	const slot = world.slot;
	plant(HEAD_KEY, { id: "W1", card: card() as never, due: iso(NOW - 60_000) });
	plant("wA", { id: "W1", card: card() as never, due: iso(NOW - 60_000) });
	assert.equal(waitRows(slot, HEAD_KEY, NOW, true).rows.length, 0, "a lapsed head wait is hidden as the page hides it");
	assert.equal(waitRows(slot, "wA", NOW, false).rows.length, 1, "a tower's own is as listed as its page");
	mkdirSync(join(slot.dir, "tower", "wC"), { recursive: true });
	writeFileSync(join(slot.dir, "tower", "wC", "memory.json"), "{ not json");
	const broken = waitRows(slot, "wC", NOW, false);
	assert.deepEqual(broken.rows, []);
	assert.match(String(broken.problem), /unreadable/);
});

test("the tower of the pane that asks (`own`, a workspace id; the head's own Herdr workspace names the head) is listed first and marked, the rest keep their order", async () => {
	const s = await setup("wA", "wB");
	const head = await world.expose!.head.ensure();
	plant("wA", { id: "W1", card: card() as never });
	plant("wB", { id: "W1", card: card() as never });
	plant(HEAD_KEY, { id: "W1", card: card() as never });
	const order = async (own?: string) => (await listed(s, own ? { own } : {})).towers.map((t) => `${t.workspace}${(t as { own?: true }).own ? "*" : ""}`);
	assert.deepEqual(await order(), [HEAD_KEY, "wA", "wB"]);
	assert.deepEqual(await order("wB"), ["wB*", HEAD_KEY, "wA"]);
	assert.deepEqual(await order(head.workspace), [`${HEAD_KEY}*`, "wA", "wB"], "a pane in the head's workspace is the head's own");
});

test("the log of a press names the door, never the text: the control socket's via (pi when it says none or anything else), the prompt's, a run pane's, and the GUI's route", async () => {
	const s = await setup("wA");
	for (const id of ["W1", "W2", "W3", "W4", "W5", "W6"]) plant("wA", { id, card: card({ do: `SECRETTEXT ${id}` }) as never });
	const asks: [string, string | undefined][] = [["W1", undefined], ["W2", "prompt"], ["W3", "run-pane"], ["W4", "gui"], ["W5", "bogus"]];
	for (const [id, via] of asks) assert.equal((await ask(s, { cmd: "tower-memory", workspace: "wA", json: { op: "press", id, act: "done" }, ...(via ? { via } : {}) })).status, 200, id);
	assert.equal((await towerPanel(() => world.expose).memory!("wA", { op: "press", id: "W6", act: "done" })).status, 200);
	const log = readFileSync(world.record()!.log, "utf8");
	const doors = Object.fromEntries([...log.matchAll(/op=press.* id=(W\d)\b.* via=(\S+)/g)].map((m) => [m[1], m[2]]));
	assert.deepEqual(doors, { W1: "pi", W2: "prompt", W3: "run-pane", W4: "pi", W5: "pi", W6: "gui" }, "a client cannot name the GUI's door");
	assert.equal(log.includes("SECRETTEXT"), false, "never the text");
});
