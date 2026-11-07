import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { HerdrRun } from "../src/herdr.ts";
import { operateSink } from "../src/link/service.ts";
import { boxesOf } from "../src/server/operatehost.ts";
import type { Base, Net, Ref, Unit } from "../src/net.ts";
import { addRoute } from "../src/server/allyroute.ts";
import { idOf } from "../src/server/operateledger.ts";
import { operateFacts, operateRecord } from "../src/server/operatewire.ts";
import type { Scope } from "../src/server/operatescope.ts";
import { slotOf } from "../src/server/record.ts";
import type { Transcripts } from "../src/watch.ts";
import { assistant, header, lines, text, user } from "./sessions.ts";
import { DEVICES } from "./link/scenario.ts";
import { A, alice, baseOf, dave, hostWorld, netOf, unit } from "./operate-host-world.ts";
import { A as TA, alice as who, settle, world } from "./operate-box-world.ts";
import { scopeOf, world as seamWorld } from "./operate-world.ts";

// The wiring of operate into the running server (todo #121, docs/specs/2026-11-07-link-operate.md §11.3 and §11.4 "wiring"): one unit test per wire, with the real-server run in tests/server-operate-wiring.test.ts. A wire that is dropped must fail
// one of these, which the mutation checks of the todo's report name.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-operate-wiring-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const TK = `t${"0123456789abcdef"}`;
const none: Transcripts = { has: () => false, lookup: () => undefined, list: async () => ({ status: 200, body: { rows: [] } }) };

// ---- the holder's one operate sink (link/service.ts) ----------------------------------------------------------------------------------------------------------------------------

test("wire 1: an attended holder's sink is the controller's, an unattended one's the box's, and a holder given neither has none", () => {
	const box = () => undefined, controller = { receive: () => undefined, status: () => [], off: () => undefined };
	assert.equal(operateSink(true, { operate: box, controller }).operate, controller.receive, "attended: the controller takes it, which lists operate/1 in the caps");
	assert.equal(operateSink(false, { operate: box, controller }).operate, box, "unattended: the box's bridge, never the controller's");
	assert.deepEqual(operateSink(true, { operate: box }), {}, "attended with no controller (a secondary server): no sink, no caps entry");
	assert.deepEqual(operateSink(false, { controller }), {}, "unattended with no box bridge: none");
	assert.deepEqual(operateSink(true, {}), {});
});

test("wire 1: the host is offered boxes only while the device is attended and a holder runs", () => {
	const holder = { list: () => [{ team: A, name: "Alpha", devices: [{ id: dave.id, short: dave.shortId, label: "ci-box", unattended: true }] }], capsFor: () => ["operate/1"] } as never;
	assert.deepEqual(boxesOf({ attended: () => true, holder }).map((b) => [b.team, b.device, b.label]), [[A, dave.id, "ci-box"]]);
	assert.deepEqual(boxesOf({ attended: () => false, holder }), [], "an unattended device has no controller end");
	assert.deepEqual(boxesOf({ attended: () => true, holder: undefined }), [], "no holder, no offers");
	assert.deepEqual(boxesOf(undefined), []);
});

// ---- the box's seam: transcripts for each session, the ledger's observer (operatebox.ts) ------------------------------------------------------------------------------------------

test("wire 3: the box gives each session's seam the transcripts of its scope, read at every call, and gives none when it has no ledger", async () => {
	const given: (() => Scope)[] = [];
	const w = world({ transcripts: (scope) => (given.push(scope), none) });
	await w.open(who, TA, "box");
	await w.run(500);
	assert.equal(given.length, 1);
	assert.equal(w.fo.sessions[0]!.transcripts, none);
	assert.deepEqual(given[0]!(), { teams: [TA], box: true });
	w.edit((p) => void p.operate.set(who.id, "team")); // the grant is lowered: the box part goes at the next look
	await w.run(500);
	assert.deepEqual(given[0]!(), { teams: [TA], box: false }, "the scope the ledger reads is the session's own, as it is now");
	const bare = world();
	await bare.open(who, TA, "box");
	assert.equal(bare.fo.sessions[0]!.transcripts, undefined);
});

test("wire 3: a transcript key is read and watched through the seam, the list is a read of the box, and any other key the registry does not know is still out of scope", async () => {
	const w = world({ transcripts: () => none });
	const c = await w.open(who, TA, "team");
	w.req(c, "h1", "GET", ["history", TK]);
	w.req(c, "e1", "GET", ["entry", TK, "e1"]);
	w.req(c, "i1", "GET", ["image", TK, "e1", "0"]);
	w.req(c, "l1", "GET", ["transcripts"], {}, { limit: "5" });
	c.sess.send({ t: "watch", id: "w1", target: TK, on: true });
	await w.run(500);
	assert.deepEqual(w.fo.sessions[0]!.requests.map((r) => r.parts), [["history", TK], ["entry", TK, "e1"], ["image", TK, "e1", "0"], ["transcripts"]], "each reached the seam, whose hub answers for the t key by the ledger's scope");
	assert.deepEqual(w.fo.sessions[0]!.watches, [["w1", TK, true]]);
	assert.deepEqual(["h1", "e1", "i1", "l1"].map((id) => w.rep(c, id)?.status), [200, 200, 200, 200]);
	assert.equal(w.logs.filter((l) => l.event === "operate-read").map((l) => l.what).join(), "history,entry,image,transcripts");
	// A key of the registry's kind that nobody owns, and a write to a transcript, are refused before the seam.
	w.req(c, "h2", "GET", ["history", "nobody"]);
	w.req(c, "p1", "POST", ["sessions", TK, "input"], { text: "hi" });
	await w.run(500);
	assert.equal(w.fo.sessions[0]!.requests.length, 4, "nothing more reached the seam");
	assert.deepEqual([w.rep(c, "h2")?.body.why, w.rep(c, "p1")?.body.why], ["out-of-scope", "out-of-scope"]);
});

test("wire 3: without transcripts a t key is an unknown key and out of scope, as before", async () => {
	const w = world();
	const c = await w.open(who, TA, "team");
	w.req(c, "h1", "GET", ["history", TK]);
	c.sess.send({ t: "watch", id: "w1", target: TK, on: true });
	await w.run(500);
	assert.equal(w.fo.sessions[0]!.requests.length, 0);
	assert.equal(w.fo.sessions[0]!.watches.length, 0);
	assert.equal(w.rep(c, "h1")?.body.why, "out-of-scope");
});

test("wire 2: the box calls the ledger's observer with each session's sliced net and the scope it was cut by, before it is sent", async () => {
	const seen: { net: Net; scope: Scope }[] = [];
	const w = world({ observe: (net, scope) => void seen.push({ net, scope }) });
	const c = await w.open(who, TA, "team");
	await w.run(500);
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0]!.scope, { teams: [TA], box: false });
	assert.deepEqual(seen[0]!.net.bases[0]!.tabs.flatMap((t) => t.units.map((u) => u.key)), ["a-main"], "the slice of the session, not the box's whole net");
	assert.equal(c.inner.filter((i) => i.t === "snap").length, 1);
});

// ---- the seam itself (operateseam.ts) -------------------------------------------------------------------------------------------------------------------------------------

test("wire 3: the seam reads and watches a transcript the ledger shows its session, lists them, ends the watch when the ledger no longer shows it, and refuses what is not a read", async () => {
	const x = await seamWorld(), shown = new Set([TK]), seen: [string, string, unknown][] = [];
	const transcripts: Transcripts = {
		has: (key) => shown.has(key),
		lookup: (key) => (shown.has(key) ? { key, base: "wA", name: "old run", role: "ally", file: x.path, live: false } : undefined),
		list: async () => ({ status: 200, body: { rows: [{ id: "0123456789abcdef" }] } }),
	};
	const s = x.operate.open((id, event, data) => void seen.push([id, event, data]), transcripts), scope = scopeOf([]);
	const history = await s.request("GET", ["history", TK], new URLSearchParams(), {}, scope);
	assert.equal(history.status, 200);
	assert.ok(Array.isArray((history.body as { items: unknown[] }).items));
	assert.deepEqual((await s.request("GET", ["transcripts"], new URLSearchParams(), {}, scope)).body, { rows: [{ id: "0123456789abcdef" }] });
	assert.equal((await s.watch("w1", TK, true, scope)).status, 200);
	await x.wait(() => seen.some(([id, e]) => id === "w1" && e === "history"));
	// The ledger stops showing it (the scope narrowed): the watch ends with the scope, and a read says nothing is there.
	shown.clear();
	await s.rescope(scope);
	assert.ok(seen.some(([id, e, d]) => id === "w1" && e === "history" && (d as { state?: string }).state === "unknown"), "the watch ended with the scope");
	assert.notEqual((await s.request("GET", ["history", TK], new URLSearchParams(), {}, scope)).status, 200);
	// A write on a transcript key is no read: the registry does not know it.
	shown.add(TK);
	assert.notEqual((await s.request("POST", ["sessions", TK, "input"], new URLSearchParams(), { text: "hi" }, scope)).status, 200);
	assert.deepEqual(x.typed(), []);
	// A session opened with no ledger answers neither.
	const bare = x.operate.open(() => undefined);
	assert.notEqual((await bare.request("GET", ["history", TK], new URLSearchParams(), {}, scope)).status, 200);
	assert.equal((await bare.request("GET", ["transcripts"], new URLSearchParams(), {}, scope)).status, 404);
});

// ---- the ledger's record on the box (operatewire.ts) -----------------------------------------------------------------------------------------------------------------------

const WS = "wA", TEAM = A;
test("wire 2: the box's observer hands the ledger the whole registry with each unit's workspace label, owner and dispatcher, and a finished subagent ends", async () => {
	const stateDir = join(scratch, "box-state"), sessions = join(scratch, "box-sessions");
	mkdirSync(sessions, { recursive: true });
	const slot = slotOf(stateDir, {}, "linux"), now = Date.now();
	const file = (id: string) => { const f = join(sessions, `2026-11-07T00-00-00-000Z_${id}.jsonl`); writeFileSync(f, lines([header(id), user("u1", null, "go"), assistant("a1", "u1", [text("done")])])); return realpathSync(f); };
	addRoute(slot, WS, { to: "s-main", device: alice.id, team: TEAM, kind: "opened", at: now, name: "s-main", label: "x", short: "x", teamName: "x" }, now);
	const refs: Ref[] = [
		{ key: "s-main", base: WS, name: "s-main", role: "main", pane: "p1", file: file("s-main") },
		{ key: "sub-1", base: WS, name: "sub 1", role: "subagent", pane: "p2", file: file("sub-1") },
		{ key: "tower-1", base: WS, name: "tower", role: "tower", pane: "pt", file: file("tower-1") },
	];
	const mainUnit: Unit = { ...unit("s-main"), subs: [{ ...unit("sub-1", { role: "subagent" }), ended: true }] };
	let net: Net = netOf(baseOf(WS, [["t1", [mainUnit]]], { label: "billing", tower: { name: "tower", mark: "idle", key: "tower-1", control: true, subs: [] } }));
	const run: HerdrRun = async () => JSON.stringify({ result: { panes: [
		{ pane_id: "p1", tab_id: "t1", workspace_id: WS, tokens: { sb_opened_by: `link:${alice.id}` } },
		{ pane_id: "p2", tab_id: "t1", workspace_id: WS },
		{ pane_id: "pt", tab_id: "t0", workspace_id: WS },
	] } });
	const gui = () => ({ api: { snapshot: async () => net } as never, refs: () => refs, lookup: (key: string) => refs.find((r) => r.key === key) as never });
	const logs: Record<string, unknown>[] = [];
	const link = () => ({ holder: { list: () => [{ devices: [{ id: alice.id, label: "agent-tower-01" }] }] }, store: { log: (e: Record<string, unknown>) => void logs.push(e) } }) as never;
	const facts = operateFacts({ slot, now: () => now, run, gui, allyPanes: () => [] });
	await facts.refresh();
	const record = operateRecord({ slot, now: () => now, gui, link, sessionDir: sessions }, facts);
	await record.observe();
	const rows = record.ledger.rows();
	assert.deepEqual(rows.map((r) => [r.name, r.team, r.device, r.workspace, r.ended === true]).sort(), [["s-main", TEAM, alice.id, "billing", false], ["sub 1", TEAM, alice.id, "billing", true], ["tower", "box", undefined, "billing", false]].sort(), "owners from the records, the dispatcher from the listing, the label of the workspace, the finished one ended");
	const ledgerFile = join(stateDir, "link", "operate-ledger.jsonl");
	assert.equal(readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).length, 4, "three first lines and the subagent's end, nothing of any content");
	// The scope's transcripts: the team's own runs are listed with the dispatcher's roster label, the box's are not, and a key out of scope is not found.
	const mine = record.transcripts(() => ({ teams: [TEAM], box: false })), listed = await mine.list(new URLSearchParams());
	assert.deepEqual((listed.body as { rows: { name: string; dispatcher?: string }[] }).rows.map((r) => [r.name, r.dispatcher]).sort(), [["s-main", "agent-tower-01"], ["sub 1", "agent-tower-01"]]);
	assert.equal(mine.has(`t${idOf(refs[2]!.file!)}`), false);
	assert.equal(mine.has(`t${idOf(refs[0]!.file!)}`), true);
	// A unit that left the registry ends at the next reading; a reading while another is in flight is covered by it.
	refs.splice(0, 1);
	net = netOf(baseOf(WS, [["t1", []]], { label: "billing" }));
	await Promise.all([record.observe(), record.observe()]);
	assert.equal(record.ledger.rows().find((r) => r.name === "s-main")?.ended, true);
	assert.deepEqual(logs, []);
});

// ---- the controller's host: transcripts of a box (operatehost.ts, operatesanitize.ts) ------------------------------------------------------------------------------------------

test("wire 4: a page's list of a box's finished runs goes to the session that shows the base, with the cursor and not the base, and its rows come back as the page's keys", async () => {
	const w = hostWorld();
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" })));
	await w.pump();
	const base = w.host.merge({ bases: [] }).bases[0]!.id;
	assert.equal(w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ limit: "5" })), undefined, "no base named: not a box's request");
	assert.equal(w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base: "x0000000000000000" })), undefined, "a base nobody shows");
	const claim = w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base, limit: "20", before: "5:0123456789abcdef" }))!;
	assert.ok(claim);
	const answer = claim.send();
	await w.pump();
	const asked = w.box().reqs().at(-1)!;
	assert.deepEqual([asked.m, asked.parts, asked.q], ["GET", ["transcripts"], { limit: "20", before: "5:0123456789abcdef" }]);
	w.box().rep(asked.id as string, 200, {
		rows: [
			{ id: "0123456789abcdef", name: "ally run", role: "ally", workspace: "billing", dispatcher: "agent-tower-01", first: 1, last: 2, size: 10 },
			{ id: "../../etc/passwd", name: "x", role: "ally", workspace: "billing", first: 1, last: 2, size: 10 },
			{ id: "fedcba9876543210", name: "main one", role: "main", workspace: "billing", first: 3, last: 4, size: 20, path: "/etc/passwd", extra: 1 },
		],
		before: "2:0123456789abcdef",
	});
	await w.pump();
	const done = await answer, body = done.body as { rows: Record<string, unknown>[]; before?: string };
	assert.equal(done.status, 200);
	assert.deepEqual(body.rows.map((r) => Object.keys(r).sort().join()), ["dispatcher,first,key,last,name,role,size,workspace", "first,key,last,name,role,size,workspace"], "a row that names no run is dropped, and a field the schema does not know is not passed on");
	assert.ok(body.rows.every((r) => /^x[0-9a-f]{16}$/.test(String(r.key))));
	assert.equal(body.before, "2:0123456789abcdef");
	// A row is read through its key like any unit of the box: history goes to the box named by `t<id>`, and the key is no key of a unit.
	const key = String(body.rows[0]!.key), read = w.host.bridge.claim("GET", ["history", key], {}, new URLSearchParams({ limit: "10" }))!;
	assert.ok(read);
	void read.send();
	await w.pump();
	assert.deepEqual(w.box().reqs().at(-1)!.parts, ["history", "t0123456789abcdef"]);
});

test("wire 4: a request for a transcript key of a session that ended is no box's", async () => {
	const w = hostWorld();
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" })));
	await w.pump();
	const base = w.host.merge({ bases: [] }).bases[0]!.id;
	assert.ok(w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base })));
	w.host.closeTeam(A);
	assert.equal(w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base })), undefined);
	assert.equal(dave.id.length > 0, true);
	await settle();
});
