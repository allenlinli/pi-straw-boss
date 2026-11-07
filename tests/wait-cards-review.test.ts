import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createControl, type Reply } from "../src/control.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { runMemoryCommand, type MemoryCmdDeps } from "../src/memorycmd.ts";
import type { Slot } from "../src/server/record.ts";
import { addWait, answerBossWait, loadMemory, memoryRequest, memorySection, memorySummary, memoryTool, readMemory, updateMemory } from "../src/server/towermemory.ts";
import { checkCard, type Raiser } from "../src/server/waitcard.ts";
import { pressRequest } from "../src/server/waitpress.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The review of wait cards, tasks 1 to 3 (RV-F001 to RV-F009): each test names its finding. No test holds a realistic secret: the shapes are built from pieces when the test runs.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-rv-")) }) as Slot;
const NOW = Date.parse("2026-11-07T10:41:00Z");
const SENDER = "4f1c9a20-1111-4222-8333-444455556666";
const raiser: Raiser = { id: SENDER, name: "mp3946-print", role: "main" };
const env = (slot: Slot) => ({
	slot, workspace: "wA", run: "r1", now: () => NOW, bossEvents: () => [], session: async (q: string) => ({ id: q, name: q }), log: { line() {}, hide() {} },
	intercomEvents: () => [{ id: "e1", from: { id: SENDER, name: "mp3946-print" } }], raiser: async () => raiser, locale: () => "en" as const,
});
const base = { op: "add", kind: "wait", for: "boss", type: "action", from: SENDER, happened: "The key expired and the machine is offline.", do: "Re-authorize the machine in the admin page.", url: "https://example.org/admin", after: "The tower asks the main to test again." };
const ctx = { senders: new Set([SENDER]), restates: () => undefined };
const pdeps = (slot: Slot, sent: string[] = []) => ({ slot, now: () => NOW + 60_000, log: { line() {}, hide() {} }, locale: "en" as const, live: async () => true, send: async (to: string) => (sent.push(to), { status: "sent" }), boss: () => {} });
const lines = (patch: Record<string, unknown>, type: "action" | "choice" | "secret" = "action") => { const got = checkCard({ ...base, type, ...patch }, ctx); return got.ok ? [] : got.lines; };
const rowOf = (slot: Slot) => memorySection(loadMemory(slot, "wA").memory, NOW + 120_000).text;
// Secret shapes, built when the test runs.
const hex40 = "4d208f64d1".repeat(4);
const mixed = ["aB3dE6gH9j", "K2mN5pQ8sT", "1vW4yZ7bC0", "eF3hJ6"].join("");
const skKey = ["sk", "-", "abcdefghijklmnop", "1234"].join("");

describe("RV-F004 an action needs a non-empty url or command", () => {
	test("url '' and command '' count as absent", () => {
		assert.match(lines({ url: "" }).join("\n"), /^- url: missing\. An action says where/m);
		assert.match(lines({ url: "", command: "" }).join("\n"), /^- url: missing\./m);
		assert.match(lines({ url: undefined, command: "" }).join("\n"), /^- url: missing\./m);
		assert.deepEqual(lines({ url: "", command: "make deploy" }), [], "a command alone is where");
		assert.deepEqual(lines({ url: "https://example.org/x", command: "" }), [], "a url alone is where");
	});
	test("a url that fails does not also say missing", () => {
		const got = lines({ url: "javascript:alert(1)" });
		assert.equal(got.filter((l) => l.startsWith("- url:")).length, 1, got.join("\n"));
	});
});

describe("RV-F001 a reply in the box is not a press", () => {
	test("reply, then done: allowed; the row says the boss answered before the press, the press after", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), base);
		updateMemory(slot, "wA", NOW, (m) => answerBossWait(m, "W1", NOW + 30_000));
		assert.match(rowOf(slot), /\[W1\] for boss \(action, from mp3946-print\): answered by the boss at \d\d:\d\d, check their message: Re-authorize the machine/);
		const done = await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "done" });
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.match(rowOf(slot), /pressed I'm done at/);
		const again = await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "done" });
		assert.equal(again.status, 409);
		assert.match(String(again.body.reason), /W1 was pressed already/);
	});
	test("a choice card replied to can still be chosen", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), { ...base, type: "choice", url: undefined, after: undefined, options: [{ label: "Yes", then: "Deploy it." }, { label: "No", then: "Hold." }] });
		updateMemory(slot, "wA", NOW, (m) => answerBossWait(m, "W1", NOW));
		assert.equal((await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "choose", option: 1 })).status, 200);
	});
	test("a secret card: reply, the secret step, a second reply, then done", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), { ...base, type: "secret", url: undefined, secret: { name: "the auth key" } });
		updateMemory(slot, "wA", NOW, (m) => answerBossWait(m, "W1", NOW));
		assert.equal((await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "secret" })).status, 200);
		updateMemory(slot, "wA", NOW, (m) => answerBossWait(m, "W1", NOW + 1000));
		assert.equal((await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "secret" })).status, 409, "the secret step is taken once");
		assert.equal((await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "done" })).status, 200);
	});
});

describe("RV-F003 a declined or resolved boss wait stays in bossWaits until the sweep", () => {
	test("decline keeps it with state, outcome and ended; the count of waits and the open list do not hold it", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), base);
		await memoryTool(env(slot), { ...base, happened: "Another thing happened.", do: "Do the other thing." });
		const declined = await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "decline", reason: "not today" });
		assert.equal(declined.status, 200);
		const at = NOW + 3_600_000;
		const summary = memorySummary(readMemory(slot, "wA", at).memory, at);
		assert.equal(summary.waits, 1, "only the open one is counted");
		const w1 = summary.bossWaits.find((w) => w.id === "W1")!;
		assert.deepEqual([w1.state, w1.outcome, typeof w1.ended], ["resolved", "declined by the boss: not today", "string"]);
		assert.equal(summary.bossWaits.find((w) => w.id === "W2")!.state, undefined, "an open wait carries no state");
		const dropped = memorySummary(readMemory(slot, "wA", NOW + 25 * 3_600_000).memory, NOW + 25 * 3_600_000);
		assert.equal(dropped.bossWaits.some((w) => w.id === "W1"), false, "the 24 h sweep drops it");
	});
	test("the tower's resolve of a boss wait stays too", () => {
		const slot = slotIn();
		updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "Boss token needed", for: "boss" }));
		assert.equal(memoryRequest(slot, "wA", NOW, { op: "resolve", id: "W1", outcome: "added", rev: loadMemory(slot, "wA").memory.rev }).status, 200);
		const got = memorySummary(readMemory(slot, "wA", NOW + 60_000).memory, NOW + 60_000);
		assert.deepEqual([got.waits, got.bossWaits.map((w) => [w.id, w.state, w.outcome])], [0, [["W1", "resolved", "added"]]]);
	});
});

describe("RV-F006 the press route refuses a value", () => {
	test("value on a press is 400 and nothing changes", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), base);
		const got = await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act: "done", value: "x" });
		assert.equal(got.status, 400);
		assert.match(String(got.body.reason), /value/);
		assert.equal(loadMemory(slot, "wA").memory.entries[0]!.state, "open");
	});
});

describe("RV-F007 edit of a card wait is refused", () => {
	test("the route says a card is restated by the tower; a legacy wait still edits", async () => {
		const slot = slotIn();
		await memoryTool(env(slot), base);
		updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "Old text", for: "boss" }));
		const rev = () => loadMemory(slot, "wA").memory.rev;
		const refused = memoryRequest(slot, "wA", NOW, { op: "edit", id: "W1", text: "Something else", rev: rev() });
		assert.equal(refused.status, 409);
		assert.match(String(refused.body.reason), /card/);
		assert.match(rowOf(slot), /Re-authorize the machine/);
		assert.equal(memoryRequest(slot, "wA", NOW, { op: "edit", id: "W2", text: "New text", rev: rev() }).status, 200);
	});
});

describe("RV-F008 the secret check passes ordinary words and URLs and still refuses secrets", () => {
	const refused = (patch: Record<string, unknown>) => lines(patch).some((l) => /looks like a secret/.test(l));
	test("passes", () => {
		assert.equal(refused({ happened: "The deploy token: expired at 10:30, so the job stopped." }), false, "token: expired");
		assert.equal(refused({ happened: "The password is expired, so the login fails." }), false, "password is");
		assert.equal(refused({ happened: "The token: a1b2 is short, and the secret=x9 too." }), false, "a short value is not a secret shape");
		assert.equal(refused({ url: `https://gitlab.com/g/p/-/commit/${hex40}` }), false, "a commit SHA in a url path");
		assert.equal(refused({ url: `https://docs.google.com/document/d/${["1AbCdEfGhIj", "KlMnOpQrStUv", "WxYz0123456789"].join("")}/edit` }), false, "a Google Docs id");
	});
	test("refuses", () => {
		assert.equal(refused({ happened: `The key is ${skKey} and it is bad.` }), true);
		assert.equal(refused({ after: "token=abcdefg12345" }), true, "key=value with letters and digits");
		assert.equal(refused({ after: "password: hunter22 was set" }), true);
		assert.equal(refused({ do: `Paste ${mixed} into the page.` }), true, "a mixed run in prose");
		assert.equal(refused({ do: `Use commit ${hex40} for it.` }), true, "a long hex run in prose");
		assert.equal(refused({ url: `https://example.org/?k=${skKey}` }), true);
		assert.equal(refused({ url: `https://example.org/path?sig=${hex40}` }), true, "hex in the query");
		assert.equal(refused({ url: `https://example.org/path#${mixed}` }), true, "a mixed run in the fragment");
		assert.equal(refused({ url: `https://example.org/hook/${skKey}` }), true, "a key shape in the path");
		assert.equal(refused({ url: undefined, command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' x" }), true, "bearer");
		const pem = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
		assert.equal(refused({ command: `echo ${pem}` }), true, "a PEM header");
		assert.equal(refused({ happened: `${["ghp", "_"].join("")}${"a1B2c3D4".repeat(3)} leaked` }), true);
	});
});

describe("RV-F009 guards that survived their removal", () => {
	test("M04: a secret in an option's label or then is refused", () => {
		const choice = { type: "choice", url: undefined, after: undefined };
		const opts = (a: Record<string, string>) => lines({ ...choice, options: [a, { label: "No", then: "Hold." }] }, "choice").join("\n");
		assert.match(opts({ label: skKey, then: "Deploy it." }), /^- options: option 1 looks like a secret/m);
		assert.match(opts({ label: "Yes", then: `Use ${skKey} now.` }), /^- options: option 1 looks like a secret/m);
	});
	test("M20: a press on a wait for a session is refused, and a decline does not resolve it", async () => {
		const slot = slotIn();
		updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "api-fix to answer", for: "agent", on: { id: "main-1", name: "api-fix" } }));
		for (const act of ["decline", "done", "restate"]) {
			const got = await pressRequest(pdeps(slot), "wA", { op: "press", id: "W1", act });
			assert.equal(got.status, 409, act);
			assert.match(String(got.body.reason), /waits for a session/);
		}
		assert.equal(loadMemory(slot, "wA").memory.entries[0]!.state, "open");
	});
});

describe("RV-F005 a remote caller cannot take a secret card's first step", () => {
	const ORIGIN = "https://weis-mbp.local:8445", CSRF = "c".repeat(32);
	const post = (remote: boolean, parts = ["tower", "wA", "memory"]) => {
		const calls: Record<string, unknown>[] = [];
		const handle = createControl({
			lookup: () => undefined, csrf: CSRF, canonical: (f) => f,
			tower: { has: (w) => w === "wA" || w === HEAD_KEY, live: () => false, event: async () => ({ ok: true }), act: async () => ({ ok: true }), memory: async (_w, json) => (calls.push(json), { status: 200, body: {} }) },
		});
		return { calls, send: (json: Record<string, unknown>): Promise<Reply> => {
			const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(json))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
			return handle(req, ORIGIN, parts, remote);
		} };
	};
	test("a remote secret step is refused before it reaches the memory; other presses pass; local passes", async () => {
		const r = post(true);
		const refused = await r.send({ op: "press", id: "W1", act: "secret" });
		assert.equal(refused.status, 409);
		assert.match(JSON.stringify(refused.body), /computer/);
		assert.deepEqual(r.calls, []);
		assert.equal((await r.send({ op: "press", id: "W1", act: "done" })).status, 200, "done is not the secret step");
		assert.equal((await r.send({ op: "read" })).status, 200);
		const local = post(false);
		assert.equal((await local.send({ op: "press", id: "W1", act: "secret" })).status, 200);
		assert.equal(local.calls.length, 1);
	});
	test("the head's memory route holds the same line", async () => {
		const r = post(true, ["head", "memory", ""]);
		const refused = await r.send({ op: "press", id: "W1", act: "secret" });
		assert.equal(refused.status, 409);
		assert.deepEqual(r.calls, []);
		assert.equal((await r.send({ op: "press", id: "W1", act: "done" })).status, 200, "the head's route reaches the memory otherwise");
		const local = post(false, ["head", "memory", ""]);
		assert.equal((await local.send({ op: "press", id: "W1", act: "secret" })).status, 200);
		assert.equal(local.calls.length, 1);
	});
});

describe("RV-F002 /boss memory done on a secret card sends the secret step, then done", () => {
	const harness = async () => {
		const slot = slotIn(), sent: Record<string, unknown>[] = [], told: string[] = [];
		await memoryTool(env(slot), { ...base, type: "secret", url: undefined, secret: { name: "the auth key" } });
		const deps: MemoryCmdDeps = {
			lang: "en", interactive: true, own: "wA",
			ask: async (workspace, json) => (sent.push(json), { ok: true, ...(json.op === "press" ? await pressRequest(pdeps(slot), workspace, json) : memoryRequest(slot, workspace, NOW, json)) }),
			workspaces: async () => [{ workspace_id: "wA", label: "Alpha" }],
			tell: (text) => void told.push(text),
		};
		return { slot, sent, told, run: (args: string) => runMemoryCommand(args, deps) };
	};
	test("two presses in order, and the wait is answered", async () => {
		const h = await harness();
		await h.run("done W1");
		assert.deepEqual(h.sent.filter((j) => j.op === "press").map((j) => j.act), ["secret", "done"], h.told.join("\n"));
		assert.equal(loadMemory(h.slot, "wA").memory.entries[0]!.state, "answered");
	});
	test("when the secret step was taken already (in the GUI), done alone", async () => {
		const h = await harness();
		await pressRequest(pdeps(h.slot), "wA", { op: "press", id: "W1", act: "secret" });
		await h.run("done W1");
		assert.deepEqual(h.sent.filter((j) => j.op === "press").map((j) => j.act), ["done"]);
	});
});

// --- the world: the raiser's id and the senders of this run -------------------------------------------------------------------------------------------------------------------

describe("RV-F009 the server world", () => {
	let world: TowerWorld;
	beforeEach(() => {
		world = new TowerWorld();
		world.setFlag(true);
	});
	afterEach(() => world.close());
	type R = Record<string, unknown> & { ok: boolean; error?: string };
	const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as R);
	const msg = (id: string, text: string) => ({ id, content: { text } });
	const place = (id: string, name: string) => ({ id, name, herdrLocation: { status: "ok" as const, workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } });
	const start = async () => {
		const s = await world.start();
		await s.handle.ready;
		await ask(s, { cmd: "ensure-tower", workspace: "wA" });
		return s;
	};
	const claimNth = async (s: Running, n: number) => {
		await until(() => world.pis.size >= n, `run ${n}`);
		const id = [...world.pis.keys()][n - 1]!;
		await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
		const pi = world.pis.get(id)!;
		let got: R | undefined;
		await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
		return { id, token: String(got!.token) };
	};
	const drain = async (s: Running, token: string) => {
		for (;;) {
			const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
			if (!event) return;
			await ask(s, { cmd: "run-taken", token, id: event.id });
		}
	};
	const card = (s: Running, token: string, from: string) => ask(s, { cmd: "run-tool", token, tool: "tower_memory", args: { ...base, from } });

	test("M17: a run names only a sender of an event it took itself: another run's event is refused", async () => {
		world.sessions = [place("main-1", "docs-main"), place("main-2", "api-main")] as never;
		const s = await start();
		world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, msg("m1", "first"));
		const one = await claimNth(s, 1);
		await drain(s, one.token);
		assert.equal((await card(s, one.token, "main-1")).ok, true, "its own sender is good");
		assert.equal((await ask(s, { cmd: "run-done", token: one.token, note: "n" })).ok, true);
		world.live.delete(world.pis.get(one.id)!.pid);
		await until(() => readRun(world.slot, "wA", one.id)?.outcome, "run 1 to end");
		world.client("sb-tower-wa")!.incoming({ id: "main-2", name: "api-main" }, msg("m2", "second"));
		const two = await claimNth(s, 2);
		await drain(s, two.token);
		const other = await card(s, two.token, "main-1");
		assert.equal(other.ok, false, "main-1's event was taken by run 1");
		assert.match(JSON.stringify(other), /sent you nothing in this run/);
		assert.equal((await card(s, two.token, "main-2")).ok, true);
		// An event that waits in the queue, not taken by this run, names no sender either.
		world.sessions = [...world.sessions, place("main-3", "ui-main")] as never;
		world.client("sb-tower-wa")!.incoming({ id: "main-3", name: "ui-main" }, msg("m3", "third"));
		await until(() => readQueue(world.slot, "wA").some((e) => e.kind === "intercom" && !e.taken), "m3 to queue");
		assert.equal((await card(s, two.token, "main-3")).ok, false, "queued, not taken");
	});

	test("M26: the raiser is read by its id: a session whose name is that id is not the raiser", async () => {
		world.sessions = [place("main-9", "main-1"), place("main-1", "docs-main")] as never;
		const s = await start();
		world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, msg("m1", "first"));
		const one = await claimNth(s, 1);
		await drain(s, one.token);
		assert.equal((await card(s, one.token, "main-1")).ok, true);
		const w = loadMemory(world.slot, "wA").memory.entries[0]!;
		assert.deepEqual([w.card?.from?.id, w.card?.from?.name], ["main-1", "docs-main"]);
	});
});
