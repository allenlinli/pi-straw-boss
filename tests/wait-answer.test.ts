import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createControl, type ControlDeps, type Reply, type TowerPanel } from "../src/control.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import type { Found } from "../src/net.ts";
import type { Slot } from "../src/server/record.ts";
import { addWait, emptyMemory, memoryRequest, memorySection, memorySummary, readMemory, updateMemory } from "../src/server/towermemory.ts";

// The boss answers a wait the tower recorded on them (docs/specs/2026-10-26-sb-backend.md, Tower memory, Waits): the message names the wait it answers (`answers: "W3"` on the session's `input`), the server marks that wait
// `answered` once the tower took the message, the snapshot carries it (`bossWaits[].answered`) so no view raises it again, and the tower's brief says the boss replied.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-wa-")) }) as Slot;
const NOW = Date.parse("2026-11-05T08:00:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();
const seed = (slot: Slot) => {
	updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "Boss token needed to add the ACL", for: "boss" }));
	updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "api-fix to answer", for: "agent", on: { id: "main-1", name: "api-fix" } }));
	return (json: Record<string, unknown>, at = NOW) => memoryRequest(slot, "wA", at, json);
};

test("answer marks a wait for the boss answered by its id (no rev), the summary carries when, and answering again, resolving it after, and the log line all work; a wait for an agent, a missing id, and a gone wait are refused", () => {
	const slot = slotIn(), req = seed(slot);
	const lines: { event: string; fields: Record<string, unknown> }[] = [];
	const log = { line: (event: string, fields: Record<string, unknown>) => void lines.push({ event, fields }) } as never;
	const done = memoryRequest(slot, "wA", NOW + 60_000, { op: "answer", id: "W1" }, log);
	assert.equal(done.status, 200);
	const entry = (done.body.entries as { id: string; state?: string; answered?: string }[]).find((e) => e.id === "W1")!;
	assert.deepEqual([entry.state, entry.answered], ["answered", ISO(NOW + 60_000)]);
	assert.deepEqual(lines, [{ event: "tower-memory", fields: { workspace: "wA", op: "answer", by: "boss", id: "W1" } }], "no text in the log");
	assert.deepEqual(memorySummary(readMemory(slot, "wA", NOW).memory).bossWaits, [{ id: "W1", text: "Boss token needed to add the ACL", at: ISO(NOW), answered: ISO(NOW + 60_000) }], "the snapshot says it was answered, and when");
	assert.equal(memoryRequest(slot, "wA", NOW + 120_000, { op: "answer", id: "W1" }).status, 200, "answering again is the boss's second message");
	assert.equal(req({ op: "answer", id: "W2" }).status, 409, "a wait for an agent is answered by that session's message, not the boss's");
	assert.equal(req({ op: "answer", id: "W9" }).status, 409);
	assert.equal(req({ op: "answer" }).status, 409);
	assert.equal(req({ op: "answer", id: "S1" }).status, 409);
	const read = req({ op: "read" });
	assert.equal(read.status, 200);
	const resolved = req({ op: "resolve", id: "W1", rev: (read.body as { rev: number }).rev, outcome: "token added" });
	assert.equal(resolved.status, 200, "the tower resolves an answered wait as any other");
	assert.equal(req({ op: "answer", id: "W1" }).status, 409, "a resolved wait is not answered again");
});

test("an answered wait for the boss stays in the memory for a week as an open one does, and the brief tells the run that the boss replied and that it resolves or restates the wait", () => {
	const slot = slotIn(), req = seed(slot);
	req({ op: "answer", id: "W1" }, NOW + 3_600_000);
	const { text } = memorySection(readMemory(slot, "wA", NOW + 7_200_000).memory, NOW + 7_200_000);
	assert.match(text, /- \[W1\] for boss: answered by the boss at \d\d:\d\d, check their message: Boss token needed to add the ACL/);
	assert.match(text, /- \[W2\] for api-fix: api-fix to answer/);
	const aged = readMemory(slot, "wA", NOW + 8 * 86_400_000).memory;
	assert.equal(aged.entries.find((e) => e.id === "W1")!.state, "expired", "an answered wait nobody resolved expires like an open one");
});

// --- the route ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ORIGIN = "https://weis-mbp.local:8445", CSRF = "c".repeat(32);
function control(over: { memory?: TowerPanel["memory"]; event?: TowerPanel["event"] } = {}) {
	const calls: [string, ...unknown[]][] = [];
	const tower: TowerPanel = {
		has: (w) => w === "wA" || w === HEAD_KEY, live: () => false,
		event: over.event ?? (async (w, text) => (calls.push(["event", w, text]), { ok: true })),
		act: async () => ({ ok: true }),
		conversation: async () => ({ ok: true }),
		memory: over.memory ?? (async (w, json) => (calls.push(["memory", w, json]), { status: 200, body: { rev: 2 } })),
	};
	const lookup = (key: string): Found | undefined => (key === "sb-head" ? { key, base: HEAD_KEY, name: "head tower", role: "head", live: true } : key === "sb-tower-wa" ? { key, base: "wA", name: "tower", role: "tower", live: true } : undefined);
	const handle = createControl({ lookup, call: (async () => ({})) as never, csrf: CSRF, canonical: (f) => f, secret: async () => false, tower });
	const post = (parts: string[], body: unknown): Promise<Reply> => {
		const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
		return handle(req, ORIGIN, parts, false);
	};
	return { post, calls };
}
const input = (c: ReturnType<typeof control>, json: Record<string, unknown>, key = "sb-tower-wa") => c.post(["sessions", key, "input"], { text: "Use the staging token", as: "send", ...json });

test("a message that names the wait it answers is a boss event first and then the memory's `answer` of that wait; the reply says which wait was marked", async () => {
	const c = control();
	const r = await input(c, { answers: "W3" });
	assert.deepEqual([r.status, r.body], [200, { accepted: true, woke: true, answered: "W3" }]);
	assert.deepEqual(c.calls, [["event", "wA", "Use the staging token"], ["memory", "wA", { op: "answer", id: "W3" }]], "the event first: a refused one marks nothing");
	const plain = control();
	assert.deepEqual((await input(plain, {})).body, { accepted: true, woke: true }, "without `answers` the reply is as it was");
	assert.deepEqual(plain.calls, [["event", "wA", "Use the staging token"]], "and the memory is not touched");
});

test("a malformed answers is a 400 before anything is sent; a refused event marks nothing; a wait the memory no longer has is reported, not an error of the message", async () => {
	const c = control();
	for (const answers of ["W", "3", "S1", "W3 ", 3, ["W3"], "W1; drop", ""]) assert.equal((await input(c, { answers })).status, 400, JSON.stringify(answers));
	assert.deepEqual(c.calls, []);
	const refused = control({ event: async () => ({ ok: false, error: "The tower did not take it." }) });
	assert.equal((await input(refused, { answers: "W3" })).status, 409);
	assert.deepEqual(refused.calls, []);
	const gone = control({ memory: async () => ({ status: 409, body: { error: "refused", reason: "No such wait W3" } }) });
	const r = await input(gone, { answers: "W3" });
	assert.deepEqual([r.status, r.body], [200, { accepted: true, woke: true, answered: false }], "the message went; the wait was already dropped or resolved");
});

test("the head's composer takes `answers` the same way, with the head's key", async () => {
	const c = control();
	const r = await input(c, { answers: "W1" }, "sb-head");
	assert.deepEqual([r.status, r.body], [200, { accepted: true, woke: true, answered: "W1" }]);
	assert.deepEqual(c.calls, [["event", HEAD_KEY, "Use the staging token"], ["memory", HEAD_KEY, { op: "answer", id: "W1" }]]);
	assert.equal((await input(c, { answers: "x" }, "sb-head")).status, 400);
});

test("a command (/quit, /new) typed in a wait's box is refused with its own code and does nothing: it is not an answer, and the wait stays unmarked; without `answers` it is the command as ever", async () => {
	for (const key of ["sb-tower-wa", "sb-head"]) {
		const c = control();
		for (const text of ["/quit", " /new "]) {
			const r = await input(c, { text, answers: "W3" }, key);
			assert.deepEqual([r.status, (r.body as { error?: string }).error], [400, "not_an_answer"], `${key} ${text}`);
		}
		assert.deepEqual(c.calls, [], "no conversation change, no event, no memory write");
		assert.deepEqual((await input(c, { text: "/quit" }, key)).body, { accepted: true, command: "leave" }, "the plain command still works");
	}
});

test("an answered wait does not count toward the cap of 12 open waits: the boss's reply frees its place while the tower still has it to resolve", () => {
	const slot = slotIn();
	for (let i = 0; i < 12; i++) updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: `Boss decision ${i}`, for: "boss" }));
	assert.throws(() => updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "one too many", for: "boss" })), /12 open waits/);
	memoryRequest(slot, "wA", NOW, { op: "answer", id: "W1" });
	updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "one more now", for: "boss" }));
	assert.equal(readMemory(slot, "wA", NOW).memory.entries.filter((e) => e.kind === "wait").length, 13, "the answered one is still there for the tower");
	assert.throws(() => updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "and again", for: "boss" })), /12 open waits/, "the cap holds for the open ones");
});

test("both run prompts tell the run what a wait row that says `answered by the boss` asks of it", async () => {
	const { readFileSync } = await import("node:fs");
	for (const file of ["tower-run.md", "head-run.md"]) assert.match(readFileSync(new URL(`../prompts/${file}`, import.meta.url), "utf8"), /`answered by the boss`.*resolve the wait, or restate it as a new wait/s, file);
});
