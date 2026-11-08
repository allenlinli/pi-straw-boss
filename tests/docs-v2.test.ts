import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAnswered } from "../src/answered.ts";
import { type FormMessage, type FormReply, REGISTER } from "../src/bridge.ts";
import { createHub } from "../src/dialogs.ts";
import { type Gui, startGui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Found, Ref } from "../src/net.ts";

// A v2 document (pi-better-show) has no path: the sb server fetches it from the owner's page server by the capability URL its bridge relayed (loopback only, never a redirect), serves it to the page as a v1 one is served, and takes its block
// answers as the package's `Answer`, over `better-show:answer`. What a page was told it answered is the server's record, which outlives a restart and a new capability.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-docs-v2-test-")));
const bundle = join(scratch, "bundle");
mkdirSync(bundle, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const sessionFile = join(scratch, "2026_S.jsonl");
writeFileSync(sessionFile, "");

const TOKEN = "6f1e2d3c-4b5a-4968-8776-655443322110", MD = "# Plan\n\n```suggest\n- Go\n```\n\n```suggest\n- Stop\n```\n\n```suggest\n- Wait\n```\n", RAW_HTML = `<!doctype html><html><head><script src="/${TOKEN}/assets/frame.js"></script></head><body><img src="pic.png"><form action="cgi-bin:pi-answer"><input name="choice" value="a"></form></body></html>`;
const files = new Map<string, { type: string; body: string | Buffer; status?: number; location?: string }>([
	[`/doc/d-blocks/plan.md`, { type: "text/plain; charset=utf-8", body: MD }],
	[`/doc/d-blocks/a.png`, { type: "image/png", body: Buffer.from([0x89, 0x50]) }],
	[`/doc/d-blocks/style.css`, { type: "text/css", body: "body{}" }],
	[`/doc/d-html/review.html`, { type: "text/html; charset=utf-8", body: RAW_HTML }],
	[`/doc/d-html/pic.png`, { type: "image/png", body: Buffer.from([0x89, 0x51]) }],
	[`/doc/d-html/style.css`, { type: "text/css", body: "p{}" }],
	[`/doc/d-html/app.js`, { type: "text/javascript", body: "alert(1)" }],
	[`/doc/d-text/notes.txt`, { type: "text/plain; charset=utf-8", body: "plain notes" }],
	[`/doc/d-big/big.md`, { type: "text/plain; charset=utf-8", body: "x".repeat(2 * 1024 * 1024 + 1) }],
	[`/doc/d-redirect/r.md`, { type: "text/plain", body: "", status: 302, location: `/${TOKEN}/doc/d-redirect/real.md` }],
	[`/doc/d-redirect/real.md`, { type: "text/plain", body: "# Elsewhere" }],
	[`/doc/d-down/down.md`, { type: "text/plain", body: "boom", status: 500 }],
]);
const hits: string[] = [];
const ext: Server = createServer((req, res) => {
	hits.push(`${req.headers.host} ${req.url}`);
	const path = (req.url ?? "").replace(`/${TOKEN}`, "").split("?")[0]!;
	const f = req.url?.startsWith(`/${TOKEN}/`) ? files.get(decodeURIComponent(path)) : undefined;
	if (!f) return void res.writeHead(404).end();
	res.writeHead(f.status ?? 200, { "content-type": f.type, ...(f.location ? { location: f.location } : {}) }).end(f.body);
});
await new Promise<void>((done) => ext.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${(ext.address() as AddressInfo).port}/${TOKEN}`;
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	await new Promise((done) => ext.close(done));
	rmSync(scratch, { recursive: true, force: true });
});

const entry = (id: string, kind: string, name: string, extra: object = {}) => ({ id, v: 2, kind, display: `docs/${name}`, reason: `${name} ready`, revision: 1, onScreen: true, capability: `${BASE}/doc/${id}/${name}`, assets: `${BASE}/doc/${id}/`, ...extra });
const DOCS = [entry("d-blocks", "blocks", "plan.md"), entry("d-html", "html", "review.html"), entry("d-text", "text", "notes.txt"), entry("d-big", "blocks", "big.md"), entry("d-redirect", "blocks", "r.md"), entry("d-down", "blocks", "down.md"), { id: "d-off", v: 2, kind: "blocks", display: "docs/off.md", reason: "off", revision: 1, onScreen: false }];
const accept = (m: FormMessage): FormReply | undefined => ({ version: 1, type: "form-result", bridgeId: "B", id: m.id, answerId: m.answerId, accepted: true });

async function serve({ disk = { text: undefined as string | undefined }, documents = DOCS }: { disk?: { text: string | undefined }; documents?: object[] } = {}) {
	const forms: FormMessage[] = [];
	const events = { emit: (ch: string, r: never) => ch === REGISTER && (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: "S", epoch: "e1" } }), publish: () => {} }), on: () => () => {} };
	const local = { deliver: () => {}, sync: () => {}, probe: () => ({ editor: "empty" as const }), commands: () => [], close: () => ({ accepted: false }), stashCheck: () => undefined, pull: () => ({ reason: "no_editor" }), form: (m: FormMessage, r: (x: FormReply) => void) => { forms.push(m); const x = accept(m); if (x) r(x); } };
	const hub = createHub({ events } as unknown as ExtensionAPI, "S", local);
	const found: Found = { key: "S", base: "wA", name: "billing-main", role: "main", file: canonical(sessionFile), pane: "wA:p1", live: true };
	const answered = createAnswered({ load: () => disk.text, save: (text) => void (disk.text = text) });
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: (key) => (key === "S" ? found : undefined), workspace: () => [] }, hub, dir: bundle, pollMs: 50, pingMs: 1000, answered });
	running.push(gui);
	hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: sessionFile, dialogs: [], closed: [], documents } as never);
	const relayed = hub.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }], new Map<string, Ref>([["S", found]]));
	const caps = Object.fromEntries((relayed.docsOf?.("S")?.docs ?? []).map((c) => [c.display.replace("docs/", ""), c.cap]));
	return { gui, forms, caps, cards: relayed.docsOf?.("S")?.docs ?? [] };
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
const json = (r: Res) => JSON.parse(r.body) as Record<string, unknown>;
const ID = "a".repeat(32), hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16), HASH = hashOf(MD);
const FRAME = { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" };

test("the page's cards name what to draw and hold no capability URL or path; a document with no capability is listed but cannot be read", async () => {
	const { cards, gui, caps } = await serve();
	assert.deepEqual(cards.map((c) => [c.display, c.kind]), [["docs/plan.md", "blocks"], ["docs/review.html", "html"], ["docs/notes.txt", "text"], ["docs/big.md", "blocks"], ["docs/r.md", "blocks"], ["docs/down.md", "blocks"], ["docs/off.md", "blocks"]]);
	assert.ok(!JSON.stringify(cards).includes("127.0.0.1"), "no capability URL reaches the page");
	const off = await ask(gui, `api/doc/${caps["off.md"]}`);
	assert.equal(off.status, 404);
});

test("a blocks document is read from the owner's page server by its capability: the text, its hash, and what was answered; a text document is read too", async () => {
	const { gui, caps } = await serve();
	const r = await ask(gui, `api/doc/${caps["plan.md"]}`);
	assert.equal(r.status, 200);
	assert.deepEqual(json(r), { kind: "text", display: "docs/plan.md", revision: 1, rev: HASH, text: MD, answered: { done: [], pending: [] } });
	assert.equal(json(await ask(gui, `api/doc/${caps["notes.txt"]}`)).text, "plain notes");
	assert.ok(hits.some((h) => h.endsWith(`/${TOKEN}/doc/d-blocks/plan.md`) && h.startsWith("127.0.0.1:")), "the Host header the owner's server checks is its own");
});

test("a capability is fetched with care: over 2 MB, a redirect, and an error status are no document, and nothing leaves the owner's loopback server", async () => {
	const { gui, caps } = await serve();
	for (const name of ["big.md", "r.md", "down.md"]) assert.equal((await ask(gui, `api/doc/${caps[name]}`)).status, 404, name);
	assert.ok(!hits.some((h) => h.includes("real.md")), "the redirect was not followed (its target is a good page: following it would have served it)");
});

test("an HTML document is the owner's page served as a v1 one is: its forms answer here, the owner's frame hook is gone, and its folder's pictures and style load through the owner's assets", async () => {
	const { gui, caps } = await serve();
	const page = await ask(gui, `doc/${caps["review.html"]}/`, { headers: FRAME });
	assert.equal(page.status, 200);
	assert.match(page.body, /<form action="answer\/[0-9a-f]{32}" method="get" target="_self">/);
	assert.ok(!page.body.includes("frame.js"), "a script cannot run in this frame, so the owner's hook is not sent");
	assert.match(String(page.headers["content-security-policy"]), /sandbox/);
	assert.equal((await ask(gui, `doc/${caps["review.html"]}/pic.png`)).headers["content-type"], "image/png");
	assert.equal((await ask(gui, `doc/${caps["review.html"]}/style.css`)).headers["content-type"], "text/css; charset=utf-8");
	for (const name of ["app.js", "missing.png", "..%2Fd-blocks%2Fa.png", "%2e%2e/d-blocks/a.png", "sub%2F..%2F..%2Fa.png"]) assert.equal((await ask(gui, `doc/${caps["review.html"]}/${name}`)).status, 404, name);
});

test("a blocks document's neighbours are images only, as a v1 Markdown document's are", async () => {
	const { gui, caps } = await serve();
	const img = await ask(gui, `doc/${caps["plan.md"]}/a.png`, { headers: { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" } });
	assert.equal(img.status, 200);
	assert.equal(img.headers["content-type"], "image/png");
	assert.equal((await ask(gui, `doc/${caps["plan.md"]}/style.css`)).status, 404);
	assert.equal((await ask(gui, `doc/${caps["notes.txt"]}/a.png`)).status, 404, "a text document reads no neighbours");
});

test("BSR-F007 D05, D06: a name beside a document is sent to the owner as one plain relative path: a backslash never goes, and a character that would start a query is encoded", async () => {
	const { gui, caps } = await serve();
	const before = hits.length, image = { "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" };
	assert.equal((await ask(gui, `doc/${caps["plan.md"]}/a%5Cb.png`, { headers: image })).status, 404);
	assert.deepEqual(hits.slice(before).filter((h) => h.includes("a%5Cb") || h.includes("a\\b")), [], "a backslash in a name never reaches the owner");
	assert.equal((await ask(gui, `doc/${caps["plan.md"]}/q%3Fx.png`, { headers: image })).status, 404);
	const asked = hits.slice(before).filter((h) => h.includes("q"));
	assert.deepEqual(asked.map((h) => h.split(" ")[1]), [`/${TOKEN}/doc/d-blocks/q%3Fx.png`], "the question mark is data in the name, not the start of a query");
});

test("a form of an HTML document answers over contract v2 as a form Answer, a review under its kind", async () => {
	const { gui, caps, forms } = await serve();
	const page = await ask(gui, `doc/${caps["review.html"]}/`, { headers: FRAME });
	const nonce = /answer\/([0-9a-f]{32})/.exec(page.body)![1];
	const sent = await ask(gui, `doc/${caps["review.html"]}/answer/${nonce}?choice=b`, { headers: { ...FRAME, "sec-fetch-mode": "navigate" } });
	assert.equal(sent.status, 200);
	assert.equal(forms.length, 1);
	assert.deepEqual([forms[0]!.id, forms[0]!.fields, (forms[0] as unknown as { answer: unknown }).answer], ["d-html", [["choice", "b"]], { kind: "form", fields: [["choice", "b"]] }]);
	const again = await ask(gui, `doc/${caps["review.html"]}/`, { headers: FRAME });
	const second = await ask(gui, `doc/${caps["review.html"]}/answer/${/answer\/([0-9a-f]{32})/.exec(again.body)![1]}?pi-kind=review&title=L&picked=A`, { headers: { ...FRAME, "sec-fetch-mode": "navigate" } });
	assert.equal(second.status, 200);
	assert.deepEqual((forms[1] as unknown as { answer: unknown }).answer, { kind: "review", fields: [["title", "L"], ["picked", "A"]] });
});

test("a block's answer reaches the owner as an Answer addressed to the block, and the record says so for every device: after a restart and under a new capability too", async () => {
	const disk = { text: undefined as string | undefined };
	const first = await serve({ disk });
	const answer = { kind: "suggest", fields: [["text", "Go"]], ref: { doc: "other", block: 0 } };
	const r = await ask(first.gui, `api/doc/${first.caps["plan.md"]}/answer`, { method: "POST", body: { answerId: ID, answer, rev: HASH } });
	assert.equal(r.status, 200);
	assert.deepEqual(json(r), { accepted: true });
	assert.equal(first.forms.length, 1);
	const sent = first.forms[0]! as unknown as { id: string; answerId: string; fields: unknown; answer: unknown };
	assert.deepEqual([sent.id, sent.answerId, sent.fields], ["d-blocks", ID, [["text", "Go"]]]);
	assert.deepEqual(sent.answer, { kind: "suggest", fields: [["text", "Go"]], ref: { doc: "docs/plan.md", block: 0 } }, "the address is the server's: the document's display and the block, whatever the page wrote");
	const seen = json(await ask(first.gui, `api/doc/${first.caps["plan.md"]}`)).answered as { done: [number, unknown][] };
	assert.deepEqual(seen.done, [[0, [["text", "Go"]]]]);
	const again = await serve({ disk });
	assert.notEqual(again.caps["plan.md"], first.caps["plan.md"], "a new server, a new capability");
	assert.deepEqual((json(await ask(again.gui, `api/doc/${again.caps["plan.md"]}`)).answered as { done: unknown }).done, [[0, [["text", "Go"]]]], "still answered");
	const twice = await ask(again.gui, `api/doc/${again.caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "b".repeat(32), answer, rev: HASH } });
	assert.equal(twice.status, 409);
	assert.equal(json(twice).error, "answered");
	assert.equal(again.forms.length, 0, "an answered block is not answered again, from any device");
	const other = await ask(again.gui, `api/doc/${again.caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "c".repeat(32), answer: { ...answer, ref: { block: 2 } }, rev: HASH } });
	assert.equal(other.status, 200, "another block of the same document");
	files.get("/doc/d-blocks/plan.md")!.body = `${MD}\n\`\`\`suggest\n- Later\n\`\`\`\n`; // the owner edits the document
	try {
		const edited = await ask(again.gui, `api/doc/${again.caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "d".repeat(32), answer, rev: hashOf(`${MD}\n\`\`\`suggest\n- Later\n\`\`\`\n`) } });
		assert.equal(edited.status, 200, "an edited text (another hash) opens its blocks again");
		const old = await ask(again.gui, `api/doc/${again.caps["plan.md"]}/answer`, { method: "POST", body: { answerId: "e".repeat(32), answer: { ...answer, ref: { block: 1 } }, rev: HASH } });
		assert.equal(old.status, 409, "a page that drew the text before the edit is told so");
		assert.equal(json(old).error, "stale");
		const seen = json(await ask(again.gui, `api/doc/${again.caps["plan.md"]}`)).answered as { done: [number, unknown][] };
		assert.deepEqual(seen.done.map(([i]) => i), [0], "the edited text shows only what was answered for it, not the older text's blocks");
	} finally {
		files.get("/doc/d-blocks/plan.md")!.body = MD;
	}
});

test("BSR-F003: the answer's rev must be the hash of the text the server serves now, and its block one the text has: a made-up rev, or a block that is not there, is refused with a reason before anything is recorded or sent", async () => {
	const disk = { text: undefined as string | undefined }, { gui, caps, forms } = await serve({ disk });
	const post = (answerId: string, block: number, rev: string) => ask(gui, `api/doc/${caps["plan.md"]}/answer`, { method: "POST", body: { answerId, answer: { kind: "suggest", fields: [["text", "Go"]], ref: { block } }, rev } });
	for (const rev of ["f".repeat(16), "0".repeat(16), hashOf("# Plan\n")]) {
		const r = await post("1".repeat(32), 0, rev);
		assert.deepEqual([r.status, json(r).error], [409, "stale"], rev);
		assert.match(String(json(r).reason), /changed|reload/i);
	}
	for (const block of [3, 4, 4095]) {
		const r = await post("2".repeat(32), block, HASH);
		assert.deepEqual([r.status, json(r).error], [409, "no_block"], String(block));
	}
	assert.deepEqual(forms, [], "nothing reached the owner");
	assert.equal(disk.text, undefined, "and nothing was recorded");
	assert.equal((await post("1".repeat(32), 2, HASH)).status, 200, "the last block of the text, with the same answer id the refusals used: a refusal before the send does not spend the id");
	assert.equal(forms.length, 1);
});

test("a tree counts as a block (pi-better-show 0.4.0): the suggest after it is block 1 and its answer is taken, and a block past the end is still refused", async () => {
	const text = "# Plan\n\n```tree\nrepo/\n  src/ {focus}\n    a.ts {new}\n```\n\n```suggest\n- Go\n```\n";
	files.get("/doc/d-blocks/plan.md")!.body = text;
	try {
		const disk = { text: undefined as string | undefined }, { gui, caps, forms } = await serve({ disk });
		const post = (answerId: string, block: number) => ask(gui, `api/doc/${caps["plan.md"]}/answer`, { method: "POST", body: { answerId, answer: { kind: "suggest", fields: [["text", "Go"]], ref: { block } }, rev: hashOf(text) } });
		const past = await post("1".repeat(32), 2);
		assert.deepEqual([past.status, json(past).error], [409, "no_block"], "two blocks: the tree is 0, the suggest 1");
		assert.equal((await post("3".repeat(32), 1)).status, 200, "the suggest after the tree is block 1");
		assert.equal(forms.length, 1);
	} finally {
		files.get("/doc/d-blocks/plan.md")!.body = MD;
	}
});

test("BSR-F005: a v1 Markdown document draws its blocks but its owner takes no block answers: the refusal says so up front, and says the v2 package is what takes them, not that the document is closed", async () => {
	const path = join(scratch, "v1.md");
	writeFileSync(path, "# Old\n\n```suggest\n- Go\n```\n");
	const disk = { text: undefined as string | undefined };
	const { gui, caps, forms, cards } = await serve({ disk, documents: [{ id: "6f1e2d3c-4b5a-4968-8776-655443322110", path, kind: "text", display: "docs/old.md", reason: "r", revision: 1, onScreen: true }] });
	assert.equal(cards[0]!.kind, "blocks");
	const cap = caps["old.md"]!;
	const r = await ask(gui, `api/doc/${cap}/answer`, { method: "POST", body: { answerId: ID, answer: { kind: "suggest", fields: [["text", "Go"]], ref: { block: 0 } }, rev: hashOf("# Old\n\n```suggest\n- Go\n```\n") } });
	assert.deepEqual([r.status, json(r).error], [409, "refused"]);
	assert.match(String(json(r).reason), /pi-better-show/);
	assert.doesNotMatch(String(json(r).reason), /no longer open/);
	assert.deepEqual(forms, []);
	assert.equal(disk.text, undefined, "nothing was recorded for it");
});

test("a v2 text document takes no block answers, and nothing reaches the owner", async () => {
	const { gui, caps, forms } = await serve();
	const r = await ask(gui, `api/doc/${caps["notes.txt"]}/answer`, { method: "POST", body: { answerId: ID, answer: { kind: "form", fields: [["a", "1"]], ref: { block: 0 } }, rev: HASH } });
	assert.equal(r.status, 409);
	assert.equal(json(r).error, "refused");
	assert.deepEqual(forms, []);
});
