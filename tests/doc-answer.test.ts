import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FormMessage, type FormReply, REGISTER } from "../src/bridge.ts";
import { SCOPES } from "../src/control.ts";
import { createDocs } from "../src/docs.ts";
import { createHub } from "../src/dialogs.ts";
import type { Doc } from "../src/documents.ts";
import { type Gui, startGui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Found, Ref } from "../src/net.ts";
import { plan } from "../src/operateroutes.ts";

// A Markdown document's blocks answer on the page's own request (docs/specs/2026-11-07-better-show-host.md): POST api/doc/<capability>/answer {answerId, answer, rev} reaches a v2 owner (pi-better-show) as the package's Answer,
// once per answer id, behind the page's origin and CSRF checks, and only for a Markdown document; a v1 Markdown document draws its blocks but its owner takes no answers, so the route refuses it up front. A text document's sibling images are served by the capability route (a review block's images), and only images.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-docanswer-test-")));
const bundle = join(scratch, "bundle"), dir = join(scratch, "work", "docs");
for (const d of [bundle, join(dir, "sub")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const files: Record<string, string | Buffer> = { "plan.html": "<!doctype html><html><head></head><body></body></html>", "notes.md": "# Notes", "a.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "b.png": Buffer.from([0x89, 0x50]), "style.css": "body{}", "font.woff2": Buffer.alloc(8), "sub/c.jpg": Buffer.from([0xff, 0xd8]), "notes.txt": "plain", "secret.md": "# secret" };
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
const sessionFile = join(scratch, "2026_S.jsonl");
writeFileSync(sessionFile, "");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const doc = (extra: Partial<Doc> = {}): Doc => ({ id: "html-1", path: join(dir, "plan.html"), kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true, ...extra });
const DOCS = [doc(), doc({ id: "text-1", path: join(dir, "notes.md"), kind: "text", display: "docs/notes.md" }), doc({ id: "txt-1", path: join(dir, "notes.txt"), kind: "text", display: "docs/notes.txt" })];
const accept = (m: FormMessage): FormReply | undefined => ({ version: 1, type: "form-result", bridgeId: "B", id: m.id, answerId: m.answerId, accepted: m.fields.length > 0, ...(m.fields.length ? {} : { reason: "empty" }) });
async function serve({ reply = accept }: { reply?: typeof accept } = {}) {
	const forms: FormMessage[] = [];
	const events = { emit: (ch: string, r: never) => ch === REGISTER && (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: "S", epoch: "e1" } }), publish: () => {} }), on: () => () => {} };
	const local = { deliver: () => {}, sync: () => {}, probe: () => ({ editor: "empty" as const }), commands: () => [], close: () => ({ accepted: false }), stashCheck: () => undefined, pull: () => ({ reason: "no_editor" }), form: (m: FormMessage, r: (x: FormReply) => void) => { forms.push(m); const x = reply(m); if (x) r(x); } };
	const hub = createHub({ events } as unknown as ExtensionAPI, "S", local);
	const found: Found = { key: "S", base: "wA", name: "billing-main", role: "main", file: canonical(sessionFile), pane: "wA:p1", live: true };
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: (key) => (key === "S" ? found : undefined), workspace: () => [] }, hub, dir: bundle, pollMs: 50, pingMs: 1000 });
	running.push(gui);
	hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: sessionFile, dialogs: [], closed: [], documents: DOCS });
	const relayed = hub.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }], new Map<string, Ref>([["S", found]]));
	const caps = Object.fromEntries((relayed.docsOf?.("S")?.docs ?? []).map((c) => [c.display, c.cap]));
	return { gui, forms, html: caps["docs/plan.html"]!, text: caps["docs/notes.md"]!, txt: caps["docs/notes.txt"]! };
}
type Res = { status: number; headers: IncomingMessage["headers"]; body: string };
const ask = (gui: Gui, path: string, { method = "GET", body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string | undefined> } = {}) =>
	new Promise<Res>((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const all = Object.fromEntries(Object.entries({ host: `127.0.0.1:${gui.port}`, ...(method === "POST" ? { origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data ?? "")) } : {}), ...headers }).filter(([, v]) => v !== undefined)) as Record<string, string>;
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/${path}`, method, headers: all, agent: false }, (res) => {
			const parts: Buffer[] = [];
			res.on("data", (c: Buffer) => parts.push(c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(parts).toString("latin1") }));
		});
		req.on("error", reject).end(data);
	});
const answer = (gui: Gui, cap: string, body: unknown, headers?: Record<string, string | undefined>) => ask(gui, `api/doc/${cap}/answer`, { method: "POST", body, headers });
const REV = "0123456789abcdef";
/** A page's answer body: the Answer of a form block (block 0) with `fields`, the hash of the text it drew. */
const body = (answerId: string, fields: unknown, extra: Record<string, unknown> = {}, block = 0) => ({ answerId, rev: REV, answer: { kind: "form", fields, ref: { block } }, ...extra });
const json = (r: Res) => JSON.parse(r.body) as { accepted?: boolean; error?: string; reason?: string };
const ID = "a".repeat(32);

// The owner is a v2 document's (pi-better-show): its text is read from its page server (a stand-in `fetch` here) and an answer is held to it (BSR-F003), so these tests drive `createDocs` itself with a hub stand-in.
const BLOCKS = Array.from({ length: 320 }, (_, i) => `\`\`\`suggest\n- Go ${i}\n\`\`\``).join("\n\n"), TEXT_REV = createHash("sha256").update(BLOCKS).digest("hex").slice(0, 16), CAP = "c".repeat(32);
const V2: Doc = { id: "d", v: 2, kind: "blocks", display: "docs/notes.md", reason: "r", revision: 1, onScreen: true, capability: "http://127.0.0.1:41234/t/doc/d/notes.md", assets: "http://127.0.0.1:41234/t/doc/d/" };
type Result = { accepted: boolean; reason?: string } | undefined;
function owner(reply: (fields: [string, string][]) => Result | Promise<Result> = (fields) => ({ accepted: fields.length > 0, ...(fields.length ? {} : { reason: "empty" }) })) {
	const calls: [string, [string, string][]][] = [];
	const hub = { doc: (cap: string) => (cap === CAP ? { key: "S", doc: V2 } : undefined), form: async (_cap: string, answerId: string, fields: [string, string][]) => (calls.push([answerId, fields]), reply(fields)) } as unknown as Parameters<typeof createDocs>[0];
	return { calls, docs: createDocs(hub, () => "billing", { fetch: (async () => new Response(BLOCKS)) as typeof fetch }) };
}
const v2body = (answerId: string, fields: unknown, block = 0) => body(answerId, fields, { rev: TEXT_REV }, block);

test("BSR-F005: a block's answer in a v1 Markdown document is refused up front, with the reason that its owner (pi-herdr-doc-review) takes no block answers: nothing reaches the owner and nothing is recorded", async () => {
	const { gui, forms, text } = await serve();
	const r = await answer(gui, text, body(ID, [["store", "SQLite"], ["why", "simple"]]));
	assert.equal(r.status, 409);
	assert.equal(json(r).error, "refused");
	assert.match(json(r).reason ?? "", /pi-better-show/);
	assert.doesNotMatch(json(r).reason ?? "", /no longer open/);
	assert.deepEqual(forms, []);
});

test("a block's answer reaches a v2 owner once, and the page is told it was accepted", async () => {
	const { docs, calls } = owner();
	const r = await docs.answer(CAP, v2body(ID, [["store", "SQLite"], ["why", "simple"]]));
	assert.deepEqual([r.status, r.body], [200, { accepted: true }]);
	assert.deepEqual(calls, [[ID, [["store", "SQLite"], ["why", "simple"]]]]);
});

test("one answer id is sent once: the same id again gets the first outcome and reaches the owner no more", async () => {
	const { docs, calls } = owner();
	const a = await docs.answer(CAP, v2body(ID, [["q", "1"]])), b = await docs.answer(CAP, v2body(ID, [["q", "2"]], 1));
	assert.deepEqual([a.status, b.status, b.body], [200, 200, a.body]);
	assert.equal(calls.length, 1);
	const c = await docs.answer(CAP, v2body("b".repeat(32), [["q", "3"]], 1));
	assert.equal(c.status, 200);
	assert.equal(calls.length, 2, "another answer id is another answer");
});

test("BS-F005: an answer id is not sent again for as long as its outcome is kept, whatever else was answered meanwhile", async () => {
	const { docs, calls } = owner();
	assert.equal((await docs.answer(CAP, v2body(ID, [["q", "1"]]))).status, 200);
	for (let i = 0; i < 300; i++) assert.equal((await docs.answer(CAP, v2body(`${String(i).padStart(4, "0")}${"c".repeat(28)}`, [["q", String(i)]], i + 1))).status, 200);
	const replay = await docs.answer(CAP, v2body(ID, [["q", "1"]]));
	assert.equal(replay.status, 200);
	assert.equal(calls.length, 301, "the 301 answers went once each: the first id is still remembered after 300 others");
});

test("BS-F005: an owner's failure to deliver is not kept as an outcome: the same id is tried again, and the page is told 500 meanwhile", async () => {
	let fail = true;
	const { docs, calls } = owner(() => { if (fail) throw new Error("bridge went"); return { accepted: true }; });
	const first = await docs.answer(CAP, v2body(ID, [["q", "1"]]));
	assert.equal(first.status, 500);
	fail = false;
	const second = await docs.answer(CAP, v2body(ID, [["q", "1"]]));
	assert.deepEqual([second.status, calls.length], [200, 2], "the failed send was not cached as done");
	assert.equal((await docs.answer(CAP, v2body(ID, [["q", "1"]]))).status, 200);
	assert.equal(calls.length, 2, "and a delivered one is");
});

test("what the owner refuses comes back as a refusal with its reason, and is not retried under the same id", async () => {
	const { docs, calls } = owner();
	const r = await docs.answer(CAP, v2body(ID, []));
	assert.equal(r.status, 409);
	assert.deepEqual([(r.body as { error: string }).error, /no fields/i.test((r.body as { reason: string }).reason)], ["refused", true]);
	assert.equal((await docs.answer(CAP, v2body(ID, [["q", "1"]]))).status, 409);
	assert.equal(calls.length, 1);
	const retry = await docs.answer(CAP, v2body("d".repeat(32), [["q", "1"]]));
	assert.equal(retry.status, 200, "a refusal cancels the record: the block is open again, under another answer id");
	assert.equal(calls.length, 2);
});

test("an owner that stays silent is not confirmed (504) and a document that is no longer open is 404", async () => {
	const { docs } = owner(() => undefined);
	const silent = await docs.answer(CAP, v2body(ID, [["q", "1"]]));
	assert.equal(silent.status, 504);
	assert.equal((silent.body as { error: string }).error, "not_confirmed");
	const gone = await docs.answer("f".repeat(32), v2body(ID, [["q", "1"]]));
	assert.equal(gone.status, 404);
	assert.equal((await docs.answer("not-a-capability", v2body(ID, [["q", "1"]]))).status, 404);
});

test("BS-F003: only a Markdown document takes block answers: an HTML document and a plain text one are refused before the owner is asked", async () => {
	const { gui, forms, html, txt } = await serve();
	for (const cap of [html, txt]) {
		const r = await answer(gui, cap, body(ID, [["q", "1"]]));
		assert.equal(r.status, 409);
		assert.equal(json(r).error, "refused");
	}
	assert.deepEqual(forms, []);
});

test("a body that is not an answer is refused before the owner is asked", async () => {
	const { gui, forms, text } = await serve();
	const ok = (answer: unknown, extra: object = {}) => ({ answerId: ID, rev: REV, answer, ...extra });
	const bad: unknown[] = [{}, ok(undefined), body("short", [["a", "b"]]), { answerId: ID, answer: { kind: "form", fields: [["a", "b"]], ref: { block: 0 } } }, body(ID, [["a", "b"]], { rev: "nope" }), body(ID, [["a", "b"]], { rev: undefined }), ok({ kind: "form", fields: [["a", "b"]] }), ok({ kind: "form", fields: [["a", "b"]], ref: { block: -1 } }), ok({ kind: "form", fields: [["a", "b"]], ref: { block: 100_000 } }), ok({ kind: "other", fields: [["a", "b"]], ref: { block: 0 } }), body(ID, "x"), body(ID, [["a"]]), body(ID, [["a", 1]]), body(ID, [["a", "x\u0007y"]]), body(ID, Array.from({ length: 65 }, (_, i) => [`f${i}`, "v"])), body(ID, [["a", "x".repeat(13_000)]])];
	for (const b of bad) assert.equal((await answer(gui, text, b)).status, 400, JSON.stringify(b).slice(0, 80));
	assert.deepEqual(forms, []);
	const well = await answer(gui, text, body(ID, [["a", "line\nbreak\tand tab"]]));
	assert.deepEqual([well.status, json(well).error], [409, "refused"], "a well-formed body (a line break and a tab are fine) is refused only for what the document is: v1");
});

test("the answer route takes the page's own origin, content type, and CSRF secret, as every write does", async () => {
	const { gui, forms, text } = await serve();
	const b = body(ID, [["q", "1"]]);
	assert.equal((await answer(gui, text, b, { origin: "http://evil.example" })).status, 403);
	assert.equal((await answer(gui, text, b, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await answer(gui, text, b, { "x-sb-csrf": "nope" })).status, 403);
	assert.equal((await answer(gui, text, b, { "content-type": "text/plain" })).status, 415);
	assert.deepEqual(forms, []);
});

test("BS-F007: the route answers only `doc/<capability>/answer`: any other action or none is not found, and nothing reaches the owner", async () => {
	const { gui, forms, text } = await serve();
	for (const path of [`api/doc/${text}/other`, `api/doc/${text}/answers`, `api/doc/${text}`, `api/doc/${text}/answer/extra`]) {
		const r = await ask(gui, path, { method: "POST", body: body(ID, [["q", "1"]]) });
		assert.equal(r.status, 404, path);
	}
	assert.deepEqual(forms, []);
});

test("an operate session never reaches it: the table refuses documents (decision 12)", () => {
	assert.ok(SCOPES.includes("doc"));
	const p = plan("POST", ["doc", "c".repeat(32), "answer"], body(ID, []), { box: true, has: () => true });
	assert.equal(p.ok, false);
});

test("an operate session never reads the record of answered blocks either", () => {
	const p = plan("GET", ["answered", "sess-1"], {}, { box: true, has: () => true });
	assert.equal(p.ok, false);
});

test("a text document's sibling images are served by its capability, images only, from its own folder; other files and other documents stay refused", async () => {
	const { gui, text, html, txt } = await serve();
	const img = await ask(gui, `doc/${text}/a.svg`, { headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" } });
	assert.equal(img.status, 200);
	assert.equal(img.headers["content-type"], "image/svg+xml");
	assert.match(String(img.headers["content-security-policy"]), /sandbox/);
	assert.equal((await ask(gui, `doc/${text}/b.png`)).headers["content-type"], "image/png");
	assert.equal((await ask(gui, `doc/${text}/sub/c.jpg`)).headers["content-type"], "image/jpeg");
	for (const name of ["style.css", "font.woff2", "notes.txt", "../../outside.png", "missing.png"]) assert.equal((await ask(gui, `doc/${text}/${name}`)).status, 404, `${name} is not served beside a text document`);
	assert.equal((await ask(gui, `doc/${txt}/b.png`)).status, 404, "only a Markdown document: a plain text document reads no neighbours");
	assert.equal((await ask(gui, `doc/${html}/style.css`)).status, 200, "an HTML document is served as before");
});
