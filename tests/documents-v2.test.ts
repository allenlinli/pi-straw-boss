import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { answerOk, cardKind, createCaps, docsOf, isBlocksDoc, listenDocs, loopbackUrl, submitAnswer, v1Fields } from "../src/documents.ts";
import type { Bus } from "../src/owners.ts";

// Document contract v2 (pi-better-show 0.1.0, its README's "Event bus, contract version 2"): `better-show:documents` and `better-show:documents-request`, entries `{id, kind blocks|html|text, display, reason, revision, onScreen, capability?, assets?}` with no
// path, and an answer on `better-show:answer` read back on `better-show:answer-result`. The v1 listener stays until pi-herdr-doc-review is archived.

const BASE = "http://127.0.0.1:41234/6f1e2d3c-4b5a-4968-8776-655443322110";
const V2 = { id: "d1", kind: "blocks", display: "docs/plan.md", reason: "Plan ready", revision: 2, onScreen: true, capability: `${BASE}/doc/d1/plan.md`, assets: `${BASE}/doc/d1/` };
const V1 = { id: "6f1e2d3c-4b5a-4968-8776-655443322110", path: "/work/docs/plan.html", kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true };
function bus() {
	const on = new Map<string, ((data: unknown) => void)[]>(), seen: [string, unknown][] = [];
	const b: Bus & { seen: typeof seen; count(): number } = {
		seen,
		emit: (channel, data) => (seen.push([channel, data]), [...(on.get(channel) ?? [])].forEach((h) => h(data))),
		on: (channel, handler) => (on.set(channel, [...(on.get(channel) ?? []), handler]), () => on.set(channel, (on.get(channel) ?? []).filter((h) => h !== handler))),
		count: () => [...on.values()].reduce((n, hs) => n + hs.length, 0),
	};
	return b;
}

test("a v2 list is listened for beside the v1 one, asked for once, and an entry has no path: its capability is a loopback URL of the owner's page server and its display is kept as given", () => {
	const b = bus(), lists: unknown[][] = [];
	b.on("better-show:documents-request", () => b.emit("better-show:documents", { version: 2, documents: [{ ...V2, path: "/etc/passwd" }] }));
	const off = listenDocs(b, (docs) => lists.push(docs));
	assert.deepEqual(b.seen.filter(([c]) => c.endsWith("-request")).map(([c, p]) => [c, p]), [["doc-review:documents-request", { version: 1 }], ["better-show:documents-request", { version: 2 }]]);
	assert.deepEqual(lists.at(-1), [{ ...V2, v: 2 }], "no `path`, whatever the payload carries; `v` says which contract it came by");
	b.emit("better-show:documents", { version: 2, documents: [{ ...V2, display: "~/notes/../plan.md", revision: 3 }] });
	assert.equal((lists.at(-1) as { display: string }[])[0]!.display, "~/notes/../plan.md", "display is shown as given, never resolved to a path");
	off();
	assert.equal(b.count(), 1, "both listeners went");
});

test("v1 and v2 lists are held apart and sent together; a list out of shape counts as none for its own version only", () => {
	const b = bus(), lists: { id: string }[][] = [];
	listenDocs(b, (docs) => lists.push(docs as { id: string }[]));
	b.emit("doc-review:documents", { version: 1, documents: [V1] });
	b.emit("better-show:documents", { version: 2, documents: [V2] });
	assert.deepEqual(lists.at(-1)!.map((d) => d.id), [V1.id, "d1"]);
	b.emit("better-show:documents", { version: 2, documents: [{ ...V2, kind: "pdf" }] });
	assert.deepEqual(lists.at(-1)!.map((d) => d.id), [V1.id], "a bad v2 list is none; the v1 documents stay");
	b.emit("doc-review:documents", { version: 1, documents: [{ ...V1, path: "relative" }] });
	assert.deepEqual(lists.at(-1), []);
	b.emit("better-show:documents", { version: 1, documents: [V2] });
	b.emit("doc-review:documents", { version: 2, documents: [V1] });
	assert.deepEqual(lists.at(-1), [], "a list on the wrong channel for its version is not heard");
	b.emit("doc-review:documents", { version: 1, documents: [{ ...V1, id: "d1" }] });
	b.emit("better-show:documents", { version: 2, documents: [V2] });
	assert.deepEqual(lists.at(-1)!.map((d) => d.id), ["d1"], "one id is one document: the later list's duplicate is dropped");
});

test("a v2 entry is checked as strictly as a v1 one, and its capability and assets only if they are the owner's own page server on this computer", () => {
	const ok = (e: Record<string, unknown>) => docsOf({ version: 1, documents: [{ ...e, v: 2 }] });
	assert.deepEqual(ok(V2), [{ ...V2, v: 2 }]);
	for (const kind of ["blocks", "html", "text"]) assert.ok(ok({ ...V2, kind }), kind);
	assert.deepEqual(ok({ id: "d2", kind: "text", display: "notes.txt", reason: "", revision: 1, onScreen: false }), [{ id: "d2", kind: "text", display: "notes.txt", reason: "", revision: 1, onScreen: false, v: 2 }], "no capability while the page server is off");
	for (const bad of [{ ...V2, path: "/etc/passwd" }, { ...V2, kind: "pdf" }, { ...V2, revision: 0 }, { ...V2, onScreen: "yes" }, { ...V2, id: "x".repeat(65) }, { ...V2, capability: "https://127.0.0.1:41234/u/doc/d1/plan.md" }, { ...V2, capability: "http://evil.example/u/doc/d1/plan.md" }, { ...V2, capability: "http://127.0.0.1:41234/u/other/d1/plan.md" }, { ...V2, capability: "http://127.0.0.1:41234/u/doc/OTHER/plan.md" }, { ...V2, capability: `${BASE}/doc/d1/plan.md?x=1` }, { ...V2, capability: `${BASE}/doc/OTHER/plan.md`, assets: undefined }, { ...V2, assets: `${BASE}/doc/OTHER/` }, { ...V2, capability: "http://user:pw@127.0.0.1:41234/u/doc/d1/plan.md" }, { ...V2, assets: "http://127.0.0.1:41234/u/doc/d1/../x/" }, { ...V2, assets: `${BASE}/doc/d1` }, { ...V2, capability: 7 }])
		assert.equal(ok(bad), undefined, JSON.stringify(bad));
	assert.equal(docsOf({ version: 1, documents: [{ ...V1, v: 2 }] }), undefined, "a v2 entry names no path; a v1 one with `v: 2` is not one");
	assert.deepEqual(docsOf({ version: 1, documents: [V1] }), [V1], "a v1 entry is as it was, with no `v`");
	assert.equal(docsOf({ version: 1, documents: [{ ...V1, kind: "blocks" }] }), undefined, "blocks is a v2 kind");
});

test("loopbackUrl: only http on this computer, a plain path, no credentials, query, or fragment", () => {
	assert.equal(loopbackUrl(`${BASE}/doc/d1/plan.md`)?.endsWith("/doc/d1/plan.md"), true);
	assert.ok(loopbackUrl("http://localhost:3000/u/doc/d1/a.md"));
	assert.ok(loopbackUrl("http://[::1]:3000/u/doc/d1/a.md"));
	for (const bad of ["http://127.0.0.2:1/u/doc/d1/a.md", "http://10.0.0.5:1/u/doc/d1/a.md", "http://127.0.0.1/u/doc/d1/a.md", "ftp://127.0.0.1:1/u/doc/d1/a.md", "http://127.0.0.1:1/u/doc/d1/a.md#x", "http://127.0.0.1:1//doc/d1/a.md", "http://127.0.0.1:1/u/doc/d1/a%2Fb.md", "http://127.0.0.1:1/u/doc/d1/a%5Cb.md", "http://127.0.0.1:1/u/doc/d1/a\\b.md", "http://127.0.0.1:99999/u/doc/d1/a.md", "not a url", `http://127.0.0.1:1/u/doc/d1/${"a".repeat(600)}`]) assert.equal(loopbackUrl(bad), undefined, bad);
});

test("a v2 document's card names what the page draws: blocks for a blocks document and for a v1 Markdown text one, text for the rest, html for a frame", () => {
	const caps = createCaps(), doc = (extra: object) => ({ id: "x", kind: "text" as const, display: "n.txt", reason: "r", revision: 1, onScreen: true, ...extra });
	const cards = caps.bind([{ key: "S", from: "F", bridgeId: "B", docs: [doc({ id: "a", path: "/w/a.md", display: "a.md" }), doc({ id: "b", path: "/w/b.txt", display: "b.txt" }), doc({ id: "c", v: 2, kind: "blocks", display: "c.md" }), doc({ id: "d", v: 2, kind: "text", display: "d.md" }), doc({ id: "e", v: 2, kind: "html", display: "e.html" }), doc({ id: "f", path: "/w/f.html", kind: "html", display: "f.html" })] }], new Set(["F\nB\na", "F\nB\nb", "F\nB\nc", "F\nB\nd", "F\nB\ne", "F\nB\nf"]));
	assert.deepEqual(cards.get("S")!.map((c) => [c.display, c.kind]), [["a.md", "blocks"], ["b.txt", "text"], ["c.md", "blocks"], ["d.md", "text"], ["e.html", "html"], ["f.html", "html"]]);
	assert.deepEqual(Object.keys(cards.get("S")![0]!).sort(), ["cap", "display", "kind", "onScreen", "reason", "revision"], "the page gets no path, capability URL, or id");
	assert.equal(cardKind({ id: "a", path: "/w/A.MARKDOWN", kind: "text", display: "A.MARKDOWN", reason: "", revision: 1, onScreen: true }), "blocks");
	assert.equal(isBlocksDoc({ id: "c", v: 2, kind: "blocks", display: "c", reason: "", revision: 1, onScreen: true }), true);
	assert.equal(isBlocksDoc({ id: "d", v: 2, kind: "text", display: "d.md", reason: "", revision: 1, onScreen: true }), false, "a v2 text document is the editor's: the package refuses its answers");
	assert.equal(isBlocksDoc({ id: "f", path: "/w/f.html", kind: "html", display: "f.html", reason: "", revision: 1, onScreen: true }), false);
});

test("an answer is checked as the owner checks it: a kind of the six, a title, at most 64 text fields under 12 KB without control characters, a block address", () => {
	const good = { kind: "form", title: "Decide", fields: [["a", "1"]], ref: { doc: "docs/plan.md", block: 4 } };
	assert.equal(answerOk(good), true);
	assert.equal(answerOk({ kind: "pick", fields: [["picked", "A"]] }), true);
	for (const bad of [null, "x", { kind: "other", fields: [] }, { kind: "form" }, { kind: "form", fields: "x" }, { kind: "form", fields: [["a"]] }, { kind: "form", fields: [["a", 1]] }, { kind: "form", fields: [["a", "x\u0007y"]] }, { kind: "form", title: 3, fields: [] }, { kind: "form", fields: Array.from({ length: 65 }, (_, i) => [`f${i}`, "v"]) }, { kind: "form", fields: [["a", "x".repeat(13_000)]] }, { kind: "form", fields: [], ref: { block: 1.5 } }, { kind: "form", fields: [], ref: { block: -1 } }, { kind: "form", fields: [], ref: { doc: 3, block: 1 } }])
		assert.equal(answerOk(bad), false, JSON.stringify(bad)?.slice(0, 60));
	assert.equal(answerOk({ kind: "form", fields: [["a", "line\nbreak\tand tab"]] }), true, "a text box's line break and a tab are fine");
});

test("a v1 owner reads a form's fields as they are, a review and page feedback under `pi-kind`, and a pick, chip, or checklist as a form that names the block", () => {
	assert.deepEqual(v1Fields({ kind: "form", title: "t", fields: [["a", "1"], ["b", "2"]] }), [["a", "1"], ["b", "2"]]);
	assert.deepEqual(v1Fields({ kind: "review", fields: [["title", "L"], ["picked", "A"]] }), [["pi-kind", "review"], ["title", "L"], ["picked", "A"]]);
	assert.deepEqual(v1Fields({ kind: "feedback", fields: [["page", "p"]] }), [["pi-kind", "feedback"], ["page", "p"]]);
	assert.deepEqual(v1Fields({ kind: "pick", title: "Store", fields: [["picked", "SQLite"]] }), [["block", 'pick "Store"'], ["picked", "SQLite"]]);
	assert.deepEqual(v1Fields({ kind: "suggest", fields: [["text", "Go"]] }), [["block", "suggest"], ["text", "Go"]]);
	assert.deepEqual(v1Fields({ kind: "checklist", title: "T", fields: [["Run tests", "checked"]] }), [["block", 'checklist "T"'], ["Run tests", "checked"]]);
	assert.deepEqual(v1Fields({ kind: "form", fields: [["pi-kind", "review"], ["a", "1"]] }), [["a", "1"]], "a block cannot pick the kind the owner reads");
});

test("an answer goes to the owner as better-show:answer {version 2, id, answerId, answer}; only the result for its document and answerId counts, once; a silent owner leaves nothing behind after 4 s", () => {
	const b = bus(), results: unknown[] = [];
	const answer = { kind: "form" as const, fields: [["q", "1"]] as [string, string][], ref: { doc: "docs/plan.md", block: 2 } };
	b.on("better-show:answer", (raw) => {
		const f = raw as { id: string; answerId: string };
		b.emit("better-show:answer-result", { version: 2, id: "other", answerId: f.answerId, accepted: true });
		b.emit("better-show:answer-result", { version: 2, id: f.id, answerId: "another", accepted: true });
		b.emit("better-show:answer-result", { version: 1, id: f.id, answerId: f.answerId, accepted: true });
		b.emit("better-show:answer-result", { version: 2, id: f.id, answerId: f.answerId, accepted: false, reason: "invalid" });
		b.emit("better-show:answer-result", { version: 2, id: f.id, answerId: f.answerId, accepted: true });
	});
	submitAnswer(b, "d1", "n".repeat(32), answer, (r) => results.push(r));
	assert.deepEqual(b.seen.find(([c]) => c === "better-show:answer")?.[1], { version: 2, id: "d1", answerId: "n".repeat(32), answer });
	assert.deepEqual(results, [{ accepted: false, reason: "invalid" }]);
	assert.equal(b.count(), 1, "its listener went with the result");
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const quiet = bus(), got: unknown[] = [];
		submitAnswer(quiet, "d1", "m".repeat(32), answer, (r) => got.push(r));
		assert.equal(quiet.count(), 1);
		mock.timers.tick(4000);
		assert.deepEqual([got, quiet.count()], [[], 0]);
	} finally {
		mock.timers.reset();
	}
});
