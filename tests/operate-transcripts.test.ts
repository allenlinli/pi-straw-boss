import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canonical, openReader, readers } from "../src/history.ts";
import type { Ref } from "../src/net.ts";
import { idOf, KEEP_MS, MAX_ROWS, openLedger, type Row, type Seen, seenFrom, transcriptKey } from "../src/server/operateledger.ts";
import type { Scope } from "../src/server/operatescope.ts";
import { api, type Hub, image } from "../src/watch.ts";
import { DEVICES } from "./link/scenario.ts";
import { assistant, header, lines, text, user } from "./sessions.ts";

// The transcripts of finished runs (docs/specs/2026-11-07-link-operate.md §9): the box's ledger, `GET api/transcripts`, and `t<id>` keys read through the same `api` a live unit's history is.

const scratch = canonical(mkdtempSync(join(tmpdir(), "psb-transcripts-")))!, root = join(scratch, "sessions");
mkdirSync(root);
after(() => rmSync(scratch, { recursive: true, force: true }));

const { alice, bob } = DEVICES;
const A = "a".repeat(32), B = "b".repeat(32), DAY = 24 * 3_600_000, NOW = Date.UTC(2026, 10, 7, 12);
const Q = (q: Record<string, string> = {}) => new URLSearchParams(q);
let n = 0;
/** A session file in the session folder with one user line and one answer. */
function session(word = "go", dir = root): string {
	const file = join(dir, `2026-11-07T00-00-00-000Z_s${++n}.jsonl`);
	writeFileSync(file, lines([header(`s${n}`), user("u1", null, word), assistant("a1", "u1", [text(`done ${word}`)])]));
	return file;
}
const mine = (): string => join(mkdtempSync(join(scratch, "l-")), "link", "operate-ledger.jsonl");
const seen = (file: string, over: Partial<Seen> = {}): Seen => ({ role: "ally", name: "ally run", workspace: "billing", file, owner: { team: A }, device: alice.id, ...over });
const row = (file: string, over: Partial<Row> = {}): Row => ({ id: idOf(file), team: A, device: alice.id, role: "ally", name: "ally run", workspace: "billing", file, first: NOW - DAY, last: NOW - DAY + 1000, ...over });
const put = (ledger: string, rows: Row[]) => (mkdirSync(join(ledger, ".."), { recursive: true }), writeFileSync(ledger, rows.map((r) => `${JSON.stringify(r)}\n`).join("")));
const read = (ledger: string) => readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const open = (file: string, over: Partial<Parameters<typeof openLedger>[0]> = {}) => openLedger({ file, root, now: () => NOW, label: (d) => (d === alice.id ? "agent-tower-01" : undefined), ...over });
const reach = (teams: string[], box = false): (() => Scope) => () => ({ teams, box });
/** The hub of an operate session over a ledger, with a spy on every file a reader is made for. */
function hubOf(ledger: ReturnType<typeof openLedger>, scope: () => Scope, units: Record<string, string> = {}) {
	const acquired: string[] = [];
	const hub: Hub = { lookup: (key) => (units[key] ? { key, base: "w", name: key, role: "main", file: units[key], live: true } : undefined), workspace: () => [], readers: readers(8, (f) => (acquired.push(f), openReader(f))), transcripts: ledger.within(scope) };
	return { hub, acquired };
}
const list = async (hub: Hub, q: Record<string, string> = {}) => api(hub, ["transcripts"], Q(q));

test("scope: a team's session lists and reads its own team's runs and no other team's, the box's only with the box part", async () => {
	const fa = session("alpha"), fb = session("beta"), fx = session("boxed"), ledger = open(mine());
	ledger.observe([seen(fa, { name: "a-run" }), seen(fb, { name: "b-run", owner: { team: B }, device: bob.id }), seen(fx, { name: "box-run", owner: { box: true }, device: undefined })]);
	const names = async (scope: Scope) => ((await list(hubOf(ledger, () => scope).hub)).body as { rows: { name: string }[] }).rows.map((r) => r.name).sort();
	assert.deepEqual(await names({ teams: [A], box: false }), ["a-run"]);
	assert.deepEqual(await names({ teams: [B], box: false }), ["b-run"]);
	assert.deepEqual(await names({ teams: [A], box: true }), ["a-run", "box-run"]);
	assert.deepEqual(await names({ teams: [], box: true }), ["box-run"]);
	assert.deepEqual(await names({ teams: [A, B], box: false }), ["a-run", "b-run"]);

	const { hub } = hubOf(ledger, reach([A])), t = (f: string) => transcriptKey(idOf(f));
	assert.equal((await api(hub, ["history", t(fa)], Q())).status, 200);
	for (const f of [fb, fx]) {
		assert.equal((await api(hub, ["history", t(f)], Q())).status, 404, "another team's, and the box's: not found");
		assert.equal((await api(hub, ["entry", t(f), "u1"], Q())).status, 404);
		assert.equal(await image(hub, [t(f), "u1", "0"]), undefined);
		assert.equal(hub.transcripts!.has(t(f)), false);
	}
});

test("scope: the scope is read at every call, so a narrowed session loses a team's runs at the next request", async () => {
	const fa = session("alpha"), ledger = open(mine());
	ledger.observe([seen(fa)]);
	let scope: Scope = { teams: [A], box: false };
	const { hub } = hubOf(ledger, () => scope), key = transcriptKey(idOf(fa));
	assert.equal((await api(hub, ["history", key], Q())).status, 200);
	scope = { teams: [], box: false };
	assert.equal((await api(hub, ["history", key], Q())).status, 404);
	assert.deepEqual(((await list(hub)).body as { rows: unknown[] }).rows, []);
});

test("the list: newest first, with the fields §9 names and no path; a page's cursor goes on where it stopped", async () => {
	const files = [session("1"), session("2"), session("3"), session("4"), session("5")];
	let at = NOW;
	const ledger = open(mine(), { now: () => at });
	for (const [i, f] of files.entries()) { at = NOW - (10 - i) * 60_000; ledger.observe([seen(f, { name: `run ${i}` })]); }
	at = NOW;
	ledger.observe([]); // all end, each with the time it was last seen
	const { hub } = hubOf(ledger, reach([A])), page1 = (await list(hub, { limit: "2" })).body as { rows: Record<string, unknown>[]; before?: string };
	assert.deepEqual(page1.rows.map((r) => r.name), ["run 4", "run 3"]);
	assert.deepEqual(Object.keys(page1.rows[0]!).sort(), ["dispatcher", "first", "id", "last", "name", "role", "size", "workspace"]);
	assert.equal(page1.rows[0]!.dispatcher, "agent-tower-01");
	assert.equal(page1.rows[0]!.size, statSync(files[4]!).size);
	assert.equal(page1.rows[0]!.id, idOf(files[4]!));
	assert.ok(!JSON.stringify(page1).includes(root), "no path leaves the box");
	const page2 = (await list(hub, { limit: "2", before: page1.before! })).body as typeof page1, page3 = (await list(hub, { limit: "2", before: page2.before! })).body as typeof page1;
	assert.deepEqual(page2.rows.map((r) => r.name), ["run 2", "run 1"]);
	assert.deepEqual(page3.rows.map((r) => r.name), ["run 0"]);
	assert.equal(page3.before, undefined);
	assert.equal(((await list(hub, { limit: "abc" })).body as typeof page1).rows.length, 5, "a limit that is no number is the default");
	assert.equal(((await list(hub, { limit: "-3" })).body as typeof page1).rows.length, 1, "and one below 1 is 1, as history's");
	assert.equal((await list(hub, { before: "../etc" })).status, 400);
	assert.equal((await list(hub, { before: "9:zz" })).status, 400);
});

test("the list: rows that share a time are all listed, across a page's edge", async () => {
	const files = [session("1"), session("2"), session("3")], ledger = open(mine());
	ledger.observe(files.map((f, i) => seen(f, { name: `same ${i}` })));
	ledger.observe([]);
	const { hub } = hubOf(ledger, reach([A])), first = (await list(hub, { limit: "2" })).body as { rows: { name: string }[]; before?: string }, second = (await list(hub, { limit: "2", before: first.before! })).body as typeof first;
	assert.deepEqual([...first.rows, ...second.rows].map((r) => r.name).sort(), ["same 0", "same 1", "same 2"]);
});

test("the list: at most 50 rows a page, whatever the limit; one session file is one row however often it is seen", async () => {
	const f = session("one"), one = open(mine());
	for (let i = 0; i < 5; i++) one.observe([seen(f)]);
	assert.equal(one.rows().length, 1);
	const files = Array.from({ length: 55 }, (_, i) => session(`m${i}`)), many = open(mine());
	many.observe(files.map((file) => seen(file)));
	const { hub } = hubOf(many, reach([A])), body = (await list(hub, { limit: "999" })).body as { rows: unknown[]; before?: string };
	assert.equal(body.rows.length, 50);
	assert.ok(body.before);
	assert.equal(((await list(hub, { before: body.before! })).body as { rows: unknown[] }).rows.length, 5);
});

test("a file gone: its row is neither listed nor read, and the others still are", async () => {
	const [f1, f2] = [session("one"), session("two")], ledger = open(mine());
	ledger.observe([seen(f1, { name: "kept" }), seen(f2, { name: "gone" })]);
	const { hub } = hubOf(ledger, reach([A]));
	unlinkSync(f2);
	const rows = ((await list(hub)).body as { rows: { name: string }[] }).rows;
	assert.deepEqual(rows.map((r) => r.name), ["kept"]);
	assert.equal((await api(hub, ["history", transcriptKey(idOf(f2))], Q())).status, 404);
	assert.equal((await api(hub, ["history", transcriptKey(idOf(f1))], Q())).status, 200);
});

test("a file swapped for a link out of the session folder is not read, and neither is a row a tampered ledger points there", async () => {
	const outside = join(scratch, "elsewhere");
	mkdirSync(outside);
	const target = session("secret-plans", outside), link = join(root, "2026-11-07T00-00-00-000Z_linked.jsonl"), plain = session("plain");
	symlinkSync(target, link);
	const ledgerFile = mine();
	put(ledgerFile, [row(link, { name: "linked" }), row(target, { name: "direct" }), row(plain, { name: "plain" }), row("/etc/passwd", { name: "etc" }), row(join(root, "notes.txt"), { name: "txt" })]);
	appendFileSync(ledgerFile, `${JSON.stringify({ ...row(session("other")), id: idOf(plain), name: "id of another file" })}\n`);
	const ledger = open(ledgerFile), { hub, acquired } = hubOf(ledger, reach([A]));
	assert.deepEqual(((await list(hub)).body as { rows: { name: string }[] }).rows.map((r) => r.name), ["plain"], "a row whose id is not its file's hash is not kept either");
	for (const f of [link, target, "/etc/passwd"]) assert.equal((await api(hub, ["history", transcriptKey(idOf(f))], Q())).status, 404, f);
	assert.deepEqual(acquired, [], "no reader was made for any of them");
});

test("a path is never taken from the request: only an id the ledger holds opens a file, in any spelling", async () => {
	const inside = session("inside"), unseen = session("not in the ledger"), ledger = open(mine());
	ledger.observe([seen(inside)]);
	const { hub, acquired } = hubOf(ledger, reach([A]));
	const attempts = [
		`t${idOf(unseen)}`, // a file in the session folder, but no row of the ledger
		inside, basename(inside), `t${inside}`, `t${basename(inside)}`, `t../../${basename(inside)}`, `t${idOf(inside)}/../${idOf(inside)}`, `t${idOf(inside)}x`, `T${idOf(inside)}`, `t${idOf(inside).toUpperCase()}`, `t${idOf(inside).slice(1)}`, "t", "t0000000000000000", `t${idOf(inside)}\u0000`, "t__proto__", "tconstructor", `${transcriptKey(idOf(inside))}.jsonl`,
	];
	for (const key of attempts) {
		for (const parts of [["history", key], ["entry", key, "u1"], ["image", key, "u1", "0"]]) {
			const got = parts[0] === "image" ? await image(hub, parts.slice(1)).then((p) => (p ? { status: 200 } : { status: 404 })) : await api(hub, parts, Q({ before: inside })).catch(() => ({ status: 404 }));
			assert.equal(got.status, 404, `${parts.join("/")}`);
		}
	}
	assert.deepEqual(acquired, [], "no reader was made for a path the request spelled");
	assert.equal((await api(hub, ["history", transcriptKey(idOf(inside))], Q({ before: inside }))).status, 200, "the id the ledger holds does open it; `before` is an entry id, never a path");
	assert.deepEqual(acquired.map((f) => f), [inside], "and its file is the ledger's");
	assert.equal(((await api(hub, ["transcripts", inside], Q())).status), 404, "`transcripts` takes no key");
	assert.equal(((await api(hub, ["transcripts"], Q({ file: inside, path: inside, id: idOf(inside) }))).status), 200, "and no query field names a file");
});
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

test("reading: a transcript pages and fetches an entry through history.ts as a live unit's does", async () => {
	const f = session("hello"), ledger = open(mine());
	ledger.observe([seen(f)]);
	const { hub } = hubOf(ledger, reach([A])), key = transcriptKey(idOf(f));
	const history = (await api(hub, ["history", key], Q({ limit: "1" }))).body as { items: { id: string }[]; before?: string };
	assert.deepEqual(history.items.map((i) => i.id), ["a1"]);
	assert.ok(history.before);
	assert.deepEqual(((await api(hub, ["history", key], Q({ before: history.before!, limit: "5" }))).body as { items: { id: string }[] }).items.map((i) => i.id), ["u1"]);
	const entry = await api(hub, ["entry", key, "a1"], Q());
	assert.equal(entry.status, 200);
	assert.match(JSON.stringify(entry.body), /done hello/);
	assert.equal((await api(hub, ["entry", key, "nope"], Q())).status, 404);
});

test("reading: the page's own hub, which has no transcripts, answers neither the list nor a t key", async () => {
	const f = session("local"), ledger = open(mine());
	ledger.observe([seen(f)]);
	const { hub } = hubOf(ledger, reach([A]));
	const plain: Hub = { lookup: () => undefined, workspace: () => [], readers: hub.readers };
	assert.equal((await api(plain, ["transcripts"], Q())).status, 404);
	assert.equal((await api(plain, ["history", transcriptKey(idOf(f))], Q())).status, 404);
});

test("the ledger: a unit is written when first seen and when it ends, with no content, mode 600, and the owner it had at first", async () => {
	const f = session("x"), file = mine();
	let at = NOW;
	const ledger = open(file, { now: () => at });
	ledger.observe([seen(f, { name: "run at /home/boss/work/project" })]);
	assert.equal(read(file).length, 1);
	at += 5000;
	ledger.observe([seen(f, { owner: { team: B }, device: bob.id })]);
	assert.equal(read(file).length, 1, "seen again: nothing is written, and the owner does not change");
	// `last` is the last time the unit was seen live: the end line carries it, not the time the end was noticed.
	at += 5000;
	ledger.observe([]);
	const out = read(file);
	assert.deepEqual(out.map((r) => [r.team, r.ended ?? false, r.first, r.last]), [[A, false, NOW, NOW], [A, true, NOW, NOW + 5000]]);
	assert.equal(out[0]!.id, idOf(f));
	assert.equal(out[0]!.device, alice.id);
	assert.ok(!out[0]!.name.includes("/home/boss"), "the name is scrubbed");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(Object.keys(out[0]!).sort(), ["device", "file", "first", "id", "last", "name", "role", "team", "workspace"]);
	assert.ok(!readFileSync(file, "utf8").includes("done x"), "a transcript's text is nowhere in it");
	at += 1000;
	ledger.observe([]);
	assert.equal(read(file).length, 2, "an ended unit that stays gone is not written again");
});

test("the ledger: a unit first seen already over, and a finished subagent still on the net, are written with their end", () => {
	const [f1, f2] = [session("one"), session("two")], file = mine(), ledger = open(file);
	ledger.observe([seen(f1, { live: false }), seen(f2)]);
	ledger.observe([seen(f2, { live: false })]);
	assert.deepEqual(read(file).map((r) => [r.id === idOf(f1) ? 1 : 2, r.ended ?? false]), [[1, false], [1, true], [2, false], [2, true]]);
});

test("the ledger: a session seen again after it ended is a resumed one: it is open again, with its first time", () => {
	const f = session("again"), file = mine();
	let at = NOW;
	const ledger = open(file, { now: () => at });
	ledger.observe([seen(f)]);
	at += 1000;
	ledger.observe([]);
	at += 1000;
	ledger.observe([seen(f)]);
	const out = read(file);
	assert.deepEqual(out.map((r) => [r.first, r.last, r.ended ?? false]), [[NOW, NOW, false], [NOW, NOW, true], [NOW, NOW + 2000, false]]);
	assert.equal(open(file).rows().length, 1, "folded to one row at the next start");
	assert.equal(open(file).rows()[0]!.ended, undefined);
});

test("the ledger: the box's own units, and a unit with an owner no team id fits, are handled; a unit with no file is not written", () => {
	const f = session("own"), file = mine(), ledger = open(file);
	ledger.observe([seen(f, { owner: { box: true }, device: undefined }), { ...seen(session("nofile")), file: "" }, seen(session("odd"), { owner: { team: "../x" } })]);
	assert.deepEqual(read(file).map((r) => r.team), ["box"]);
	assert.equal(read(file)[0]!.device, undefined);
});

test("compaction at start: rows older than 30 days go, a row's lines fold into one, a torn or foreign line is dropped, and the file stays mode 600", () => {
	const [old, edge, recent, ended] = [session("old"), session("edge"), session("recent"), session("ended")], file = mine();
	put(file, [row(old, { first: NOW - 40 * DAY, last: NOW - 31 * DAY }), row(edge, { first: NOW - 40 * DAY, last: NOW - KEEP_MS }), row(recent), row(recent, { last: NOW - 1000, ended: true }), row(ended, { last: NOW - 5 * DAY, ended: true })]);
	appendFileSync(file, '{"id":"nothex","team":"a"}\nnot json\n{"id":"0000000000000001","team":"x","role":"main"}\n{"id":"' + idOf(recent) + '"');
	const ledger = open(file), kept = ledger.rows();
	assert.deepEqual(kept.map((r) => [r.id === idOf(recent) ? "recent" : r.id === idOf(edge) ? "edge" : "ended", r.ended ?? false]), [["recent", true], ["ended", true], ["edge", false]]);
	const on = read(file);
	assert.equal(on.length, 3, "one line a row, nothing foreign");
	assert.ok(on.every((r) => r.id !== idOf(old)));
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
	assert.equal(on.find((r) => r.id === idOf(recent))!.first, NOW - DAY);
});

test("compaction at start: at most 2,000 rows are kept, the newest, and a ledger already within bounds is not rewritten", () => {
	const file = mine(), f = session("shared"), rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => row(`${root}/2026_${i}.jsonl`, { first: NOW - 2 * DAY + i, last: NOW - 2 * DAY + i, ended: true }));
	put(file, [row(f, { last: NOW - 1 }), ...rows]);
	const ledger = open(file), kept = ledger.rows();
	assert.equal(kept.length, MAX_ROWS);
	assert.equal(kept[0]!.id, idOf(f), "the newest stay");
	assert.ok(!kept.some((r) => r.id === idOf(`${root}/2026_0.jsonl`)), "the oldest go");
	assert.equal(read(file).length, MAX_ROWS);
	const before = statSync(file).mtimeMs, ino = statSync(file).ino;
	open(file);
	assert.equal(statSync(file).ino, ino, "a clean ledger is not rewritten");
	assert.equal(statSync(file).mtimeMs, before);
});

test("a ledger that cannot be written does not stop the reading: the failure is reported and the rows are kept in memory", () => {
	const dir = mkdtempSync(join(scratch, "ro-")), blocker = join(dir, "link");
	writeFileSync(blocker, "a file where the folder should be");
	const errors: unknown[] = [], f = session("memory"), ledger = open(join(blocker, "operate-ledger.jsonl"), { failed: (e) => errors.push(e) });
	ledger.observe([seen(f)]);
	assert.equal(errors.length, 1);
	assert.equal(ledger.rows().length, 1);
});

test("seenFrom: the registry's units with a file and an owner, as the ledger takes them", () => {
	const f = session("reg"), refs: Ref[] = [{ key: "ally-r1", base: "w1", name: "a", role: "ally", file: f }, { key: "nofile", base: "w1", name: "b", role: "main" }, { key: "nobody", base: "w1", name: "c", role: "main", file: session("c") }];
	const out = seenFrom({ refs, workspace: (b) => `ws ${b}`, owner: (k) => (k === "nobody" ? undefined : { team: A }), device: (k) => (k === "ally-r1" ? alice.id : undefined), live: (k) => k !== "nofile" });
	assert.deepEqual(out, [{ role: "ally", name: "a", workspace: "ws w1", file: f, owner: { team: A }, device: alice.id }]);
});

// Review OL-F001..F006 (round 2).
test("OL-F001/M1: a .jsonl row swapped for a link to a file that is no .jsonl is not read, and neither is a row with no .jsonl name", () => {
	const f = session("j"), notes = join(root, "notes.txt"), ledger = open(mine());
	writeFileSync(notes, "plain");
	ledger.observe([seen(f)]);
	const t = ledger.within(reach([A])), key = transcriptKey(idOf(f));
	assert.ok(t.lookup(key));
	unlinkSync(f);
	symlinkSync(notes, f);
	assert.equal(t.lookup(key), undefined, "the real path is notes.txt");
	const plain = join(root, "plain.txt"), led = mine();
	writeFileSync(plain, "x");
	put(led, [row(plain, { last: NOW - 1 })]);
	assert.equal(open(led).within(reach([A])).lookup(transcriptKey(idOf(plain))), undefined);
});

test("OL-F001: the folder check is made on the real path too: a link to a .jsonl outside the folder is refused", () => {
	const out = mkdtempSync(join(scratch, "out-")), real = join(out, "x.jsonl"), f = session("k"), ledger = open(mine());
	writeFileSync(real, "{}\n");
	ledger.observe([seen(f)]);
	unlinkSync(f);
	symlinkSync(real, f);
	assert.equal(ledger.within(reach([A])).lookup(transcriptKey(idOf(f))), undefined);
});

test("OL-F002/M3: a ledger line whose id is not the hash of its file is dropped", () => {
	const f = session("m3"), led = mine();
	put(led, [row(f, { id: "0123456789abcdef", last: NOW - 1 })]);
	assert.deepEqual(open(led).rows(), []);
});

test("OL-F002/M6: a directory named x.jsonl is not a transcript", () => {
	const d = join(root, "dir.jsonl"), ledger = open(mine());
	mkdirSync(d);
	ledger.observe([seen(d)]);
	assert.equal(ledger.within(reach([A])).lookup(transcriptKey(idOf(d))), undefined);
});

test("OL-F002/M6: a named pipe x.jsonl (one hard link, not a regular file) is refused without blocking", { skip: process.platform === "win32" }, () => {
	const p = join(root, "pipe.jsonl"), ledger = open(mine());
	execFileSync("mkfifo", [p]);
	ledger.observe([seen(p)]);
	assert.equal(ledger.within(reach([A])).lookup(transcriptKey(idOf(p))), undefined);
});

test("OL-F002/M8: two lines of one id with different teams: the first line's owner stands on reload", () => {
	const f = session("m8"), led = mine();
	put(led, [row(f, { team: A, last: NOW - 10 }), row(f, { team: B, last: NOW - 5 })]);
	const got = open(led).rows();
	assert.equal(got.length, 1);
	assert.equal(got[0]!.team, A);
});

test("OL-F002/M11: a row recorded under a symlinked folder is served by its real path", () => {
	const real = join(root, "real-dir"), link = join(scratch, "link-dir");
	mkdirSync(real);
	symlinkSync(real, link);
	const f = session("m11", real), via = join(link, f.slice(real.length + 1)), led = mine();
	put(led, [row(via, { last: NOW - 1 })]);
	assert.equal(open(led).within(reach([A])).lookup(transcriptKey(idOf(via)))?.file, f);
});

test("OL-F003: a hard link inside the folder to a file outside it is refused (nlink above 1)", async () => {
	const out = mkdtempSync(join(scratch, "hl-")), target = join(out, "secret.jsonl"), f = join(root, `2026-11-07T00-00-00-000Z_hl${++n}.jsonl`);
	writeFileSync(target, lines([header("hl"), user("u1", null, "x")]));
	linkSync(target, f);
	const ledger = open(mine()), t = ledger.within(reach([A]));
	ledger.observe([seen(f)]);
	assert.equal(t.lookup(transcriptKey(idOf(f))), undefined);
	assert.deepEqual(((await t.list(Q())).body as { rows: unknown[] }).rows, []);
});

test("OL-F004: a session seen again after its row left the book keeps the owner the ledger recorded", () => {
	const f = session("f4"), led = mine();
	put(led, [row(f, { team: A, first: NOW - 40 * DAY, last: NOW - 40 * DAY + 1, ended: true })]);
	const ledger = open(led);
	assert.deepEqual(ledger.rows(), [], "compacted at start: older than 30 days");
	ledger.observe([seen(f, { owner: { team: B }, device: bob.id })]);
	assert.equal(ledger.rows()[0]!.team, A, "not re-owned");
	assert.ok(open(led).within(reach([A])).has(transcriptKey(idOf(f))));
	assert.ok(!open(led).within(reach([B])).has(transcriptKey(idOf(f))));
});

test("OL-F005: a t<id> key out of scope is not looked up in the registry", async () => {
	const f = session("f5"), ledger = open(mine());
	ledger.observe([seen(f, { owner: { team: B } })]);
	const key = transcriptKey(idOf(f)), { hub } = hubOf(ledger, reach([A]), { [key]: f });
	assert.equal((await api(hub, ["history", key], Q())).status, 404);
	assert.equal(await image(hub, [key, "u1", "0"]), undefined);
	const plain = hubOf(ledger, reach([A]), { other: f }).hub;
	assert.equal((await api(plain, ["history", "other"], Q())).status, 200, "other keys still fall to the registry");
});

test("an append to a ledger that already exists sets mode 600", () => {
	const f = session("mode"), led = mine();
	put(led, []);
	chmodSync(led, 0o644);
	const ledger = open(led);
	ledger.observe([seen(f)]);
	assert.equal(statSync(led).mode & 0o777, 0o600);
});
