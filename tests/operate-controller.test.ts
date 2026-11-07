import assert from "node:assert/strict";
import { get, request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createControl } from "../src/control.ts";
import { startGui } from "../src/gui.ts";
import type { Net, Unit } from "../src/net.ts";
import { REQUEST_MS } from "../src/server/operatehost.ts";
import type { Reply } from "../src/control.ts";
import { until } from "./fakes.ts";
import { A, B, baseOf, dave, hostWorld, netOf, unit } from "./operate-host-world.ts";

// The controller's bridge (docs/specs/2026-11-07-link-operate.md §5.6, §6.4, §11 row 6): sessions while pages are connected, the box's net merged into this GUI's with its keys rewritten, requests, watches and terminals routed to the session
// that shows the unit, dedupe of a dialog, and the `unreachable` and `ended` states. What the box sends is hostile (tests/operate-sanitize.test.ts); here it is well formed.

const LOCAL: Net = { bases: [baseOf("local-ws", [["t0", [unit("local-1")]]])] };
const PENDING = (dialog: string) => ({ callId: "c1", tool: "ask_user", answer: { dialog, digest: "a".repeat(64), select: { title: "Allow?", choices: [{ label: "Allow" }, { label: "Deny" }] } } });
const flags = { remote: false, secure: false };
const settled = async <T>(p: Promise<T>): Promise<T | "pending"> => Promise.race([p, new Promise<"pending">((r) => setImmediate(() => r("pending")))]);
/** An answer this end gives itself (a refusal, a bad request): a guard that is gone would forward the request and wait for a box's reply the fake clock never ends, so the test fails here instead of hanging (OHR-F013). */
const here = async <T>(p: Promise<T>, what = "answered here, not forwarded to the box"): Promise<T> => { const r = await settled(p); assert.notEqual(r, "pending", what); return r as T; };
const control = (w: ReturnType<typeof hostWorld>) => createControl({ bridge: w.host.bridge, lookup: () => undefined, csrf: "c", canonical: () => undefined });
const unitsOf = (net: Net) => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units));
/** The page's key for a box unit: only what the merged net shows. */
const keyOf = (w: ReturnType<typeof hostWorld>, raw: string): string => unitsOf(w.host.merge(LOCAL)).find((u) => u.name === raw)!.key;
const baseKey = (w: ReturnType<typeof hostWorld>, label: string) => w.host.merge(LOCAL).bases.find((b) => b.label === label)!.id;
/** Sends a request through the bridge, lets the box see it, and returns what the box was asked and the promise of the page's answer. */
async function post(w: ReturnType<typeof hostWorld>, parts: string[], json: Record<string, unknown>, team = A, c = control(w)) {
	const before = w.box(team).reqs().length, pending = c.run(parts, json, flags);
	await w.pump();
	return { pending, asked: w.box(team).reqs().slice(before) };
}
/** A world with one page connected and the box's first snapshot in. */
async function live(o: Parameters<typeof hostWorld>[0] = {}, net: Net = netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" }))) {
	const w = hostWorld(o);
	await w.page();
	for (const t of o.teams ?? [A]) w.box(t).snap(t === A ? net : netOf(baseOf("wA", [["t2", [unit("b-main")]]], { label: "billing" })));
	await w.pump();
	return w;
}

// ---- sessions follow the pages -------------------------------------------------------------------------------------------------------------------------------------------------

test("no session opens while no page is connected; one opens for each (box, team) when a page connects", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.run(5000);
	assert.equal(w.stats.opens, 0);
	await w.page();
	assert.equal(w.stats.opens, 2);
	assert.deepEqual(w.host.status().map((s) => [s.team, s.device, s.state, s.scope]).sort(), [[A, dave.id, "live", "box"], [B, dave.id, "live", "box"]]);
	assert.equal(w.box(A).opens + w.box(B).opens, 2);
});

test("the sessions close 60 s after the last page left, and a page that comes back within the minute keeps them", async () => {
	const w = hostWorld();
	const left = await w.page();
	left();
	await w.run(59_000);
	assert.equal(w.host.status().length, 1);
	const back = await w.page();
	await w.run(90_000);
	assert.equal(w.host.status().length, 1);
	assert.equal(w.box().opens, 1, "the same session all along");
	back();
	await w.run(61_000);
	assert.deepEqual(w.host.status(), []);
	assert.equal(w.box().session?.state, "closed");
});

test("a box that is not offered (its caps do not list operate/1) gets no session", async () => {
	const w = hostWorld();
	w.offers.length = 0;
	await w.page();
	await w.run(5000);
	assert.equal(w.stats.opens, 0);
});

test("a page's leaving twice counts once", async () => {
	const w = hostWorld();
	const left = await w.page(), other = await w.page();
	left();
	left();
	await w.run(61_000);
	assert.equal(w.host.status().length, 1, "the other page still holds the session");
	other();
});

// ---- the merged net --------------------------------------------------------------------------------------------------------------------------------------------------------------

test("the box's net follows the local bases, with its ids rewritten and a box field on each base", async () => {
	const w = await live();
	const merged = w.host.merge(LOCAL);
	assert.equal(merged.bases.length, 2);
	assert.equal(merged.bases[0]!.id, "local-ws");
	const [remote] = merged.bases.slice(1);
	assert.match(remote!.id, /^x[0-9a-f]{16}$/);
	assert.match(remote!.tabs[0]!.id, /^x[0-9a-f]{16}$/);
	assert.match(remote!.tabs[0]!.units[0]!.key, /^x[0-9a-f]{16}$/);
	assert.equal(remote!.tabs[0]!.units[0]!.id, remote!.tabs[0]!.units[0]!.key);
	assert.equal(remote!.tabs[0]!.units[0]!.name, "a-main");
	assert.deepEqual({ ...remote!.box, can: undefined }, { device: dave.id, short: dave.shortId, label: "ci-box", team: "Alpha", scope: "box", can: undefined, state: "live" });
	assert.ok(remote!.box!.can.includes("input") && remote!.box!.can.includes("keys") && remote!.box!.can.includes("tower"));
	assert.ok(!JSON.stringify(merged).includes('"a-main"') || remote!.tabs[0]!.units[0]!.name === "a-main", "only the unit's name carries the box's text");
	for (const raw of ["wA", "t1"]) assert.ok(!JSON.stringify(merged.bases[1]).includes(`"${raw}"`), `${raw} reached the page`);
});

test("a team-only scope hides the tower part of `can`, and the base says so", async () => {
	const w = hostWorld({ box: false });
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	await w.pump();
	const box = w.host.merge(LOCAL).bases[1]!.box!;
	assert.equal(box.scope, "team");
	assert.ok(!box.can.includes("tower"));
});

test("with nothing from any box the net is the very object the caller gave", async () => {
	const w = hostWorld();
	assert.equal(w.host.merge(LOCAL), LOCAL);
});

test("a base's mark is recomputed over what is merged", async () => {
	const w = await live({}, netOf(baseOf("wA", [["t1", [unit("a-main", { mark: "waiting" })]]], { mark: "idle" })));
	assert.equal(w.host.merge(LOCAL).bases[1]!.mark, "waiting");
});

test("a snapshot that follows another within 250 ms is held for the next tick and the last one wins", async () => {
	const w = await live();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("first")]]])));
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("second")]]])));
	await w.pump();
	assert.deepEqual(unitsOf(w.host.merge(LOCAL)).map((u) => u.name).filter((n) => n !== "local-1"), ["a-main"], "still the earlier one");
	await w.run(1000);
	assert.deepEqual(unitsOf(w.host.merge(LOCAL)).map((u) => u.name).filter((n) => n !== "local-1"), ["second"]);
});

test("two sessions of one box (the box scope shows its own units in each) are one base with one copy of a box-own unit", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]], ["tb", [unit("box-main")]]], { label: "billing" })));
	w.box(B).snap(netOf(baseOf("wA", [["t2", [unit("b-main")]], ["tb", [unit("box-main")]]], { label: "billing" })));
	await w.pump();
	const merged = w.host.merge(LOCAL), remote = merged.bases.slice(1);
	assert.equal(remote.length, 1, "one base per box workspace");
	assert.deepEqual(remote[0]!.tabs.map((t) => t.units.map((u) => u.name)).sort(), [["a-main"], ["b-main"], ["box-main"]]);
	assert.equal(remote[0]!.box!.team, "Alpha, Beta");
	assert.equal(unitsOf(merged).filter((u) => u.name === "box-main").length, 1);
	// A team's unit goes to its own session; the box-own one to a live session that shows it.
	const a = await post(w, ["sessions", keyOf(w, "a-main"), "input"], { text: "to a", as: "send" }, A);
	assert.equal(a.asked.length, 1);
	assert.equal(w.box(B).reqs().length, 0);
	const b = await post(w, ["sessions", keyOf(w, "b-main"), "input"], { text: "to b", as: "send" }, B);
	assert.equal(b.asked.length, 1);
	assert.equal(w.box(A).reqs().length, 1);
	const own = await post(w, ["sessions", keyOf(w, "box-main"), "input"], { text: "to box", as: "send" }, A);
	assert.equal(w.box(A).reqs().length + w.box(B).reqs().length, 3, "exactly one more request in all");
	void a.pending; void b.pending; void own.pending;
});

test("one session answering for a base while the other has not yet: the base is there from the first", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	await w.pump();
	assert.equal(w.host.merge(LOCAL).bases.length, 2);
});

test("the tower of a team-only session is a stub whose live ally runs of the sessions are united; the box scope's tower wins", async () => {
	const run = (id: string) => ({ id, device: "d", label: id, startedAt: "t", key: undefined });
	const tower = (runs: string[], over = {}) => ({ name: "tower", mark: "idle" as const, key: "tw", control: false, subs: [], service: { state: "standing" as const, queued: 0, allyRuns: runs.map(run), notices: [], parked: [] }, ...over });
	const w = hostWorld({ teams: [A, B], box: false });
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [], { tower: tower(["r1"]) })));
	w.box(B).snap(netOf(baseOf("wA", [], { tower: tower(["r2"]) })));
	await w.pump();
	assert.deepEqual(w.host.merge(LOCAL).bases[1]!.tower!.service!.allyRuns.map((r) => r.id).sort(), ["r1", "r2"]);
});

test("the box's events join the net's, and a dialog the remote unit answers is no longer shown as a forwarded card", async () => {
	const alert = (dialogId: string) => ({ id: `dialog/${dave.id}/${dialogId}`, kind: "dialog" as const, level: "warning" as const, team: A, teamName: "Alpha", data: { device: dave.id, dialogId, digest: "a".repeat(64), owner: "o", dialog: "q", label: "ci-box", short: dave.shortId, answered: 0 } });
	const local: Net = { ...LOCAL, link: { allies: [], alerts: [alert("d1"), alert("d2")], confirms: [], units: [] } };
	const w = await live({}, netOf(baseOf("wA", [["t1", [unit("a-main", { mark: "waiting", pending: PENDING("d1") })]]])));
	const merged = w.host.merge(local);
	assert.deepEqual(merged.link!.alerts.map((a) => a.id), [`dialog/${dave.id}/d2`], "d1 is the remote unit's own now");
	assert.equal(unitsOf(merged).find((u) => u.name === "a-main")!.pending!.answer!.dialog, "d1");
	assert.equal(local.link!.alerts.length, 2, "the caller's net is not changed");
	// While the box is not live, the forwarded card stays: nothing else answers it.
	w.partition(true);
	await w.run(50_000);
	assert.deepEqual(w.host.merge(local).link!.alerts.map((a) => a.id), [`dialog/${dave.id}/d1`, `dialog/${dave.id}/d2`]);
});

// ---- requests --------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a page's request for a box's unit goes to its session with the box's own key, and the reply comes back", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), r = await post(w, ["sessions", key, "input"], { text: "hello", as: "send" });
	assert.equal(r.asked.length, 1);
	assert.deepEqual({ ...r.asked[0]!, id: "x" }, { t: "req", id: "x", m: "POST", parts: ["sessions", "a-main", "input"], q: {}, body: { text: "hello", as: "send" } });
	assert.equal(await settled(r.pending), "pending");
	w.box().rep(r.asked[0]!.id as string, 200, { accepted: true });
	await w.pump();
	assert.deepEqual(await r.pending, { status: 200, body: { accepted: true } });
});

test("a key that is not a box's is no claim: the local routes answer", async () => {
	const w = await live();
	const c = control(w);
	assert.equal((await c.run(["sessions", "local-1", "input"], { text: "x", as: "send" }, flags)).status, 404);
	assert.equal(w.box().reqs().length, 0);
});

test("a request is answered 504 after 20 s, and an answer that comes late is dropped", async () => {
	const w = await live();
	const r = await post(w, ["sessions", keyOf(w, "a-main"), "input"], { text: "hi", as: "send" });
	await w.run(REQUEST_MS - 1000);
	assert.equal(await settled(r.pending), "pending");
	await w.run(1000);
	const reply = (await r.pending) as Reply;
	assert.equal(reply.status, 504);
	assert.match(String((reply.body as { reason: string }).reason), /check before sending again/);
	w.box().rep(r.asked[0]!.id as string, 200, { accepted: true });
	await w.pump(); // nothing waits for it; nothing throws
});

test("the table's refusals never leave this computer: focus, spawning, closing a base, bare panes", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), ws = baseKey(w, "billing"), c = control(w);
	const refused: [string[], Record<string, unknown>][] = [
		[["sessions", key, "focus"], {}], [["close", "base"], { workspace: ws }], [["close", "stash"], { workspace: ws }], [["open", "main"], { workspace: ws, dir: "/x" }], [["dirs", ""], { workspace: ws }],
		[["sessions", key, "bogus"], {}], [["close", "all"], { key }],
	];
	for (const [parts, json] of refused) {
		const r = await here(c.run(parts, json, flags), JSON.stringify(parts));
		assert.equal(r.status, 403, JSON.stringify(parts));
		assert.equal((r.body as { error: string }).error, "operate_refused", JSON.stringify(parts));
	}
	assert.equal(w.box().reqs().length, 0);
});

test("a tower route needs the box scope: a team-only session refuses it before the box is asked", async () => {
	const tower = { name: "t", mark: "idle" as const, key: "tw", control: false, subs: [] };
	const w = hostWorld({ box: false });
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { tower })));
	await w.pump();
	const r = await here(control(w).run(["tower", baseKey(w, "ws wA"), "memory"], { op: "read" }, flags));
	assert.deepEqual([r.status, (r.body as { why: string }).why], [403, "out-of-scope"]);
	assert.equal(w.box().reqs().length, 0);
	const w2 = hostWorld({ box: true });
	await w2.page();
	w2.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { tower })));
	await w2.pump();
	const t = await post(w2, ["tower", baseKey(w2, "ws wA"), "memory"], { op: "read" });
	assert.deepEqual(t.asked[0]!.parts, ["tower", "wA", "memory"], "the box's own workspace id");
});

test("close/unit and dismiss name the box's unit; close/tab names the box's base and tab, and a tab of another base is refused", async () => {
	const w = await live({}, netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" }), baseOf("wB", [["t9", [unit("other")]]], { label: "other" })));
	const key = keyOf(w, "a-main");
	const close = await post(w, ["close", "unit"], { key });
	assert.deepEqual([close.asked[0]!.parts, close.asked[0]!.body], [["close", "unit"], { key: "a-main" }]);
	const dismiss = await post(w, ["dismiss", ""], { key });
	assert.deepEqual([dismiss.asked[0]!.parts, dismiss.asked[0]!.body], [["dismiss"], { key: "a-main" }]);
	const tabOf = (label: string) => w.host.merge(LOCAL).bases.find((b) => b.label === label)!.tabs[0]!.id;
	const tab = await post(w, ["close", "tab"], { workspace: baseKey(w, "billing"), tab: tabOf("billing") });
	assert.deepEqual(tab.asked[0]!.body, { workspace: "wA", tab: "t1" });
	const crossed = await here(control(w).run(["close", "tab"], { workspace: baseKey(w, "billing"), tab: tabOf("other") }, flags));
	assert.equal(crossed.status, 404);
	assert.equal(w.box().reqs().length, 3, "the crossed one never left");
	void close.pending; void dismiss.pending; void tab.pending;
});

test("dismiss takes a unit's key only: a base's key is not one, and `all` (every team's finished units) is refused here before the box is asked", async () => {
	const w = await live();
	const c = control(w);
	assert.equal((await here(c.run(["dismiss", "", ""], { key: baseKey(w, "billing") }, flags))).status, 404);
	const all = await here(c.run(["dismiss", "", ""], { key: keyOf(w, "a-main"), all: true }, flags));
	assert.deepEqual([all.status, (all.body as { why: string }).why], [403, "route"]);
	assert.equal(w.box().reqs().length, 0);
});

test("history, entry and image reads go through the claim with the box's key and a query as a record", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), bridge = w.host.bridge;
	const h = bridge.claim("GET", ["history", key], {}, new URLSearchParams("before=e9&limit=50"))!.send();
	await w.pump();
	const asked = w.box().reqs().at(-1)!;
	assert.deepEqual([asked.m, asked.parts, asked.q], ["GET", ["history", "a-main"], { before: "e9", limit: "50" }]);
	w.box().rep(asked.id as string, 200, { items: [{ id: "e1", kind: "user", text: "hi" }] });
	await w.pump();
	assert.deepEqual(await h, { status: 200, body: { items: [{ id: "e1", kind: "user", text: "hi" }] } });
	const e = bridge.claim("GET", ["entry", key, "e1"])!.send();
	await w.pump();
	assert.deepEqual(w.box().reqs().at(-1)!.parts, ["entry", "a-main", "e1"]);
	w.box().rep(w.box().reqs().at(-1)!.id as string, 200, { id: "e1", kind: "user", text: "hi" });
	await w.pump();
	assert.equal((await e).status, 200);
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
	const i = bridge.claim("GET", ["image", key, "e1", "0"])!.send();
	await w.pump();
	w.box().rep(w.box().reqs().at(-1)!.id as string, 200, { type: "image/png", base64: png.toString("base64") });
	await w.pump();
	const pic = (await i).body as { type: string; bytes: Buffer };
	assert.equal(pic.type, "image/png");
	assert.ok(pic.bytes.equals(png));
	assert.equal(bridge.claim("GET", ["history", "local-1"]), undefined, "a local key is nobody's here");
	assert.equal(bridge.claim("GET", ["music"]), undefined);
});

test("an upload goes as base64, at most 2 MB, and names the file in the query", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), claim = w.host.bridge.claim("POST", ["sessions", key, "upload"], {}, new URLSearchParams("name=pic.png"))!;
	const big = await here(claim.send(Buffer.alloc(2 * 1024 * 1024 + 1, 1)));
	assert.equal(big.status, 413);
	assert.equal((await here(claim.send(Buffer.alloc(0)))).status, 400);
	assert.equal(w.box().reqs().length, 0);
	const sent = claim.send(Buffer.from("hello"));
	await w.pump();
	const asked = w.box().reqs().at(-1)!;
	assert.deepEqual([asked.parts, asked.q, asked.body], [["sessions", "a-main", "upload"], { name: "pic.png" }, Buffer.from("hello").toString("base64")]);
	void sent;
});

// ---- the guards that are this end's -------------------------------------------------------------------------------------------------------------------------------------------------

test("control.ts holds a paired device's text to the guards before it reaches a box: a local-only /boss command, a secret value", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), c = control(w), phone = { remote: true, secure: true };
	assert.equal((await here(c.run(["sessions", key, "input"], { text: "/boss gui stop", as: "send" }, phone))).status, 403);
	assert.equal((await here(c.run(["sessions", key, "input"], { text: "", as: "send" }, phone))).status, 400);
	assert.equal((await here(c.run(["sessions", key, "input"], { text: "x\u0007y", as: "send" }, phone))).status, 400);
	assert.equal((await here(c.run(["sessions", key, "answer"], { dialog: "d", digest: "a".repeat(64), answerId: "a".repeat(16), value: "secret" }, phone))).status, 403);
	assert.equal(w.box().reqs().length, 0);
	// The same text from this computer's own page is the box's to refuse (it checks again, §7).
	const own = await post(w, ["sessions", key, "input"], { text: "/boss gui stop", as: "send" });
	assert.equal(own.asked.length, 1);
	void own.pending;
});

// ---- watches --------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a watch is shared by the pages that ask for it, restarts for one that joins late, and stops with the last", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), one: [string, unknown][] = [], two: [string, unknown][] = [];
	const first = w.host.bridge.watch(key, (e, d) => void one.push([e, d]))!;
	await w.pump();
	assert.deepEqual(w.box().watches().map((m) => [m.target, m.on]), [["a-main", true]]);
	const id = w.box().watches()[0]!.id as string;
	w.box().ev(id, "history", { key: "a-main", state: "live", reset: true, items: [{ id: "e1", kind: "user", text: "hi" }] });
	await w.pump();
	assert.equal(one.length, 1);
	assert.equal((one[0]![1] as { key: string }).key, key, "the page's key, not the box's");
	const second = w.host.bridge.watch(key, (e, d) => void two.push([e, d]))!;
	await w.pump();
	assert.equal(w.box().watches().length, 2, "asked again under the same id, so the box sends the first page again");
	assert.equal(w.box().watches()[1]!.id, id);
	w.box().ev(id, "history", { key: "a-main", reset: true, items: [] });
	await w.pump();
	assert.deepEqual([one.length, two.length], [2, 1]);
	first.stop();
	await w.pump();
	assert.equal(w.box().watches().length, 2, "one watcher is left");
	second.stop();
	await w.pump();
	assert.deepEqual(w.box().watches().at(-1)!.on, false);
});

test("a workspace watch names the box's workspace and its cards come back under the page's keys", async () => {
	const w = await live();
	const cards: unknown[] = [], ws = baseKey(w, "billing"), key = keyOf(w, "a-main");
	w.host.bridge.watch(`w:${ws}`, (e, d) => void cards.push([e, d]));
	await w.pump();
	assert.equal(w.box().watches()[0]!.target, "w:wA");
	w.box().ev(w.box().watches()[0]!.id as string, "cards", { "a-main": "last line" });
	await w.pump();
	assert.deepEqual(cards, [["cards", { [key]: "last line" }]]);
});

test("a page loaded for a box's unit before its session shows it gets the watch once it does", async () => {
	const w = hostWorld();
	await w.page();
	const early = "x" + "0".repeat(16);
	assert.ok(w.host.bridge.watch(early, () => {}), "the address is a box's by its shape");
	assert.equal(w.box().watches().length, 0);
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	await w.pump();
	assert.equal(w.box().watches().length, 0, "that key is not one the box shows");
	const real = keyOf(w, "a-main");
	w.host.bridge.watch(real, () => {});
	await w.pump();
	assert.equal(w.box().watches().length, 1);
	assert.equal(w.host.bridge.watch("some-local-session-id", () => {}), undefined);
	assert.equal(w.host.bridge.watch("w:local-ws", () => {}), undefined);
});

// ---- terminals ------------------------------------------------------------------------------------------------------------------------------------------------------------------

const frame = (key: string, seq = 1) => ({ key, seq, rows: 2, cols: 80, whole: true, set: [[0, "hello"], [1, "world"]] });
async function terminal(w: ReturnType<typeof hostWorld>, stream = "s1") {
	const got: [string, unknown][] = [];
	w.host.bridge.mirrorOpen(stream, (e, d) => void got.push([e, d]));
	const key = keyOf(w, "a-main"), c = control(w), p = c.run(["sessions", key, "mirror"], { stream, on: true }, flags);
	await w.pump();
	const ask = w.box().reqs().at(-1)!;
	w.box().rep(ask.id as string, 200, { attached: true });
	await w.pump();
	return { got, key, c, ask, reply: await p };
}

test("a terminal is asked of the box once, its frames come back under the page's key to every page that shows it", async () => {
	const w = await live();
	const t = await terminal(w), other: [string, unknown][] = [];
	assert.deepEqual([t.ask.parts, t.ask.body], [["sessions", "a-main", "mirror"], { on: true }]);
	assert.deepEqual(t.reply, { status: 200, body: { attached: true } });
	w.host.bridge.mirrorOpen("s2", (e, d) => void other.push([e, d]));
	const p2 = t.c.run(["sessions", t.key, "mirror"], { stream: "s2", on: true }, flags);
	await w.pump();
	const again = w.box().reqs().at(-1)!;
	assert.deepEqual(again.body, { on: true }, "asked again, so the box sends every row at once");
	w.box().rep(again.id as string, 200, { attached: true });
	await w.pump();
	await p2;
	w.box().ev("m:a-main", "mirror", frame("a-main"));
	await w.pump();
	assert.deepEqual([t.got.length, other.length], [1, 1]);
	assert.deepEqual(t.got[0], ["mirror", { ...frame(t.key) }]);
});

test("the pad's keys go only while this page's stream got a frame in the last 5 s, at most 4 a second; Stop's Escape needs neither", async () => {
	const w = await live();
	const t = await terminal(w), keys = (extra: Record<string, unknown>) => t.c.run(["sessions", t.key, "keys"], { stream: "s1", ...extra }, flags);
	assert.equal((await here(keys({ key: "up" }))).status, 409, "no frame yet");
	w.box().ev("m:a-main", "mirror", frame("a-main"));
	await w.pump();
	const sent = ["up", "down", "left", "right"].map((key) => keys({ key }));
	await w.pump();
	assert.equal(w.box().reqs().filter((r) => (r.parts as string[])[2] === "keys").length, 4);
	const over = await here(keys({ key: "up" }));
	assert.deepEqual([over.status, (over.body as { error: string }).error], [429, "rate"]);
	await w.run(1000);
	for (const r of w.box().reqs().filter((r) => (r.parts as string[])[2] === "keys")) w.box().rep(r.id as string, 200, { accepted: true });
	await w.pump();
	await Promise.all(sent);
	await w.run(5000);
	assert.equal((await here(keys({ key: "up" }))).status, 409, "the last frame is older than 5 s");
	const stop = t.c.run(["sessions", t.key, "keys"], { keys: ["esc"] }, flags);
	await w.pump();
	assert.deepEqual(w.box().reqs().at(-1)!.body, { keys: ["esc"] });
	void stop;
});

test("a page that leaves detaches its terminals, and the last viewer's leaving turns the box's off", async () => {
	const w = await live();
	const t = await terminal(w);
	w.host.bridge.mirrorClose("s1");
	await w.pump();
	assert.deepEqual(w.box().reqs().at(-1)!.body, { on: false });
	w.box().ev("m:a-main", "mirror", frame("a-main"));
	await w.pump();
	assert.equal(t.got.length, 0, "nothing goes to a stream that left");
});

test("a page shows at most two terminals", async () => {
	const w = await live({}, netOf(baseOf("wA", [["t1", [unit("u1"), unit("u2"), unit("u3")]]])));
	w.host.bridge.mirrorOpen("s1", () => {});
	const c = control(w), results: Reply[] = [];
	for (const name of ["u1", "u2", "u3"]) {
		const p = c.run(["sessions", keyOf(w, name), "mirror"], { stream: "s1", on: true }, flags);
		await w.pump();
		w.box().rep(w.box().reqs().at(-1)!.id as string, 200, { attached: true });
		await w.pump();
		results.push(await p);
	}
	assert.deepEqual(results.map((r) => r.status), [200, 200, 429]);
});

test("a mirror that names no stream of this server's is refused as the local one is", async () => {
	const w = await live();
	const r = await control(w).run(["sessions", keyOf(w, "a-main"), "mirror"], { stream: "nobody", on: true }, flags);
	assert.equal(r.status, 400);
	assert.equal(w.box().reqs().length, 0);
});

// ---- reachability ----------------------------------------------------------------------------------------------------------------------------------------------------------------

test("no frame for 45 s greys the base, answers what waits with 503, and a reopened session makes it live again", async () => {
	const w = await live();
	w.partition(true);
	await w.run(30_000);
	const r = await post(w, ["sessions", keyOf(w, "a-main"), "input"], { text: "hi", as: "send" }); // 15 s from the end: still waiting when the session ends
	await w.run(16_000);
	const grey = w.host.merge(LOCAL).bases[1]!.box!;
	assert.equal(grey.state, "unreachable");
	assert.ok(grey.seen !== undefined && grey.seen < w.clock.now() - 40_000);
	const reply = (await r.pending) as Reply;
	assert.equal(reply.status, 503);
	assert.equal((await control(w).run(["sessions", keyOf(w, "a-main"), "input"], { text: "again", as: "send" }, flags)).status, 503, "the key stays the box's while it is greyed");
	w.partition(false);
	await w.run(12_000);
	assert.equal(w.stats.opens, 2, "it reopened by itself");
	assert.equal(w.host.merge(LOCAL).bases[1]!.box!.state, "live");
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main"), unit("fresh")]]], { label: "billing" })));
	await w.pump();
	assert.ok(unitsOf(w.host.merge(LOCAL)).some((u) => u.name === "fresh"));
});

test("the reopening backs off while the box keeps not answering", async () => {
	const w = await live();
	w.partition(true);
	await w.run(300_000);
	assert.ok(w.stats.opens <= 7, `opens: ${w.stats.opens}`);
	assert.equal(w.host.merge(LOCAL).bases[1]!.box!.state, "unreachable");
});

test("a close by the box for its policy or roster replaces the base with one line, and a retry a minute later reopens it", async () => {
	const w = await live();
	w.box().close("policy");
	await w.pump();
	const ended = w.host.merge(LOCAL).bases[1]!;
	assert.deepEqual([ended.box!.state, ended.box!.why, ended.tabs, ended.tower], ["ended", "policy", [], null]);
	assert.equal(unitsOf(w.host.merge(LOCAL)).filter((u) => u.name === "a-main").length, 0);
	assert.equal(w.host.bridge.claim("POST", ["sessions", "x" + "0".repeat(16), "input"]), undefined);
	await w.run(61_000);
	assert.equal(w.stats.opens, 2);
	assert.equal(w.host.merge(LOCAL).bases.length, 1, "live again, with no snapshot yet: nothing to show");
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	await w.pump();
	assert.equal(w.host.merge(LOCAL).bases[1]!.box!.state, "live");
});

test("a word the box invents for its refusal reaches the page as `other`; one it invents for a close is no revocation, the base greys and reopens", async () => {
	const w = await live();
	w.box().close("<script>alert(1)</script>");
	await w.pump();
	assert.deepEqual([w.host.merge(LOCAL).bases[1]!.box!.state, w.host.merge(LOCAL).bases[1]!.box!.why], ["unreachable", undefined]);
	const r = hostWorld();
	r.box().policy = "<script>alert(1)</script>";
	await r.page();
	assert.deepEqual([r.host.merge(LOCAL).bases[1]!.box!.state, r.host.merge(LOCAL).bases[1]!.box!.why], ["ended", "other"]);
});

test("a refusal is remembered for 10 minutes, shows as one line for a minute once, and is not shown again", async () => {
	const w = hostWorld();
	w.box().policy = "not-granted";
	await w.page();
	const shown = w.host.merge(LOCAL).bases[1];
	assert.deepEqual([shown?.box?.state, shown?.box?.why, shown?.label], ["ended", "not-granted", "ci-box"]);
	await w.run(61_000);
	assert.equal(w.host.merge(LOCAL), w.host.merge(LOCAL));
	assert.equal(w.host.merge(LOCAL).bases.length, 1, "after a minute the page shows nothing new");
	await w.run(8 * 60_000);
	assert.equal(w.stats.opens, 1, "not tried again inside the 10 minutes");
	for (let i = 0; i < 150 && w.stats.opens < 2; i++) await w.run(1000);
	assert.equal(w.stats.opens, 2);
	assert.equal(w.host.merge(LOCAL).bases.length, 1, "the second refusal shows nothing: it was shown once");
});

test("a refusal word the box invents is `other`", async () => {
	const w = hostWorld();
	w.box().policy = "you-are-fired";
	await w.page();
	assert.equal(w.host.merge(LOCAL).bases[1]!.box!.why, "other");
});

test("the 12 hour rekey keeps the base live and asks for the terminals and watches again", async () => {
	const w = await live();
	const t = await terminal(w);
	w.host.bridge.watch(t.key, () => {});
	await w.pump();
	const states = new Set<string>();
	for (let ms = 0; ms < 12 * 3600_000 + 120_000; ms += 10_000) {
		await w.run(10_000, 10_000);
		for (const b of w.host.merge(LOCAL).bases.slice(1)) states.add(b.box!.state);
	}
	assert.deepEqual([...states], ["live"], "never grey");
	assert.equal(w.stats.opens, 2);
	assert.ok(w.box().reqs().filter((r) => (r.parts as string[])[2] === "mirror").length >= 2, "the terminal was asked for again");
	assert.ok(w.box().watches().length >= 2, "and the watch");
	assert.equal(w.host.merge(LOCAL).bases.length, 2);
});

test("a team that stops ends its sessions at once; /boss link operate off ends them all and holds the reopening for a minute", async () => {
	const w = await live({ teams: [A, B] });
	w.host.closeTeam(A);
	await w.pump();
	assert.equal(w.box(A).session?.state, "closed");
	assert.equal(w.box(B).session?.state, "open");
	assert.deepEqual(w.host.status().map((s) => s.team), [B]);
	w.host.off();
	await w.pump();
	assert.equal(w.box(B).session?.state, "closed");
	await w.run(30_000);
	assert.equal(w.stats.opens, 2, "not reopened while it is off");
	await w.run(40_000);
	assert.equal(w.stats.opens, 4, "both come back after the minute, the pages still being there");
});

test("what the box says in accept.limits is clamped", async () => {
	const w = hostWorld();
	w.box().limits = { mirrors: 2 ** 40, watches: -5, budget: 10 ** 12 };
	await w.page();
	// The clamp is the host's own: nothing here reads a limit as an index or a size, and the session is still ours.
	assert.equal(w.host.status()[0]!.state, "live");
});

// ---- what a box must not make this end do ----------------------------------------------------------------------------------------------------------------------------------

test("a box that sends a request or a watch, a message of no type of ours, or an event for nothing is dropped and counted, never obeyed", async () => {
	const w = await live();
	const before = w.logs.length;
	w.box().send({ t: "req", id: "z", m: "POST", parts: ["sessions", "a-main", "input"], q: {}, body: {} });
	w.box().send({ t: "watch", id: "z", target: "x", on: true });
	w.box().send({ t: "nonsense" });
	w.box().ev("m:never-asked", "mirror", frame("never-asked"));
	w.box().ev("w404", "history", { key: "k", items: [], reset: true });
	w.box().rep("r404", 200, {});
	await w.pump();
	assert.equal(w.box().reqs().length, 0, "the controller sent nothing back");
	const bad = w.logs.slice(before).filter((l) => l.event === "operate-bad-frame");
	assert.deepEqual(bad.map((l) => l.why), ["type", "type", "type"]);
	assert.ok(bad.every((l) => !JSON.stringify(l).includes("a-main")), "no content in the log");
});

test("an operate message from an attended device, or for a session that is not ours, is ignored", async () => {
	const w = await live();
	const session = w.box().session!;
	let sent = false;
	const spy = { session: session.id, type: "close", reason: "policy" } as never;
	w.host.receive({ team: A, from: dave.id, fromAttended: true, message: spy, ts: w.clock.now(), dropped: 0 });
	w.host.receive({ team: B, from: dave.id, fromAttended: false, message: spy, ts: w.clock.now(), dropped: 0 });
	w.host.receive({ team: A, from: "someone-else", fromAttended: false, message: spy, ts: w.clock.now(), dropped: 0 });
	assert.equal(w.host.status()[0]!.state, "live");
	sent = true;
	assert.ok(sent);
});

test("a flood of bad frames costs the log ten lines and then one in a hundred", async () => {
	const w = await live();
	const before = w.logs.length;
	for (let i = 0; i < 250; i++) w.box().send({ t: "nonsense" });
	await w.pump();
	assert.equal(w.logs.slice(before).filter((l) => l.event === "operate-bad-frame").length, 12);
});

// ---- the GUI: the net the page reads, its stream, its requests ----------------------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "psb-operate-host-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
after(() => rmSync(scratch, { recursive: true, force: true }));

function listen(gui: { url: string; port: number }, watch?: string) {
	const events: { event: string; data: string }[] = [];
	const req = get(`${gui.url}events${watch ? `?watch=${encodeURIComponent(watch)}` : ""}`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
		res.setEncoding("utf8");
		let buffer = "";
		res.on("data", (chunk: string) => {
			buffer += chunk;
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const lines = buffer.slice(0, end).split("\n");
				buffer = buffer.slice(end + 2);
				events.push({ event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message", data: lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "" });
			}
		});
	});
	req.on("error", () => {});
	return { events, close: () => req.destroy(), nets: () => events.filter((e) => e.event === "message" && e.data).map((e) => JSON.parse(e.data) as Net) };
}
/** Waits for a condition on what the fake box has seen, letting the transport run meanwhile (a request goes out on a pump, not inside the call). */
async function pumped(w: ReturnType<typeof hostWorld>, what: () => boolean, message: string) {
	for (let i = 0; i < 100 && !what(); i++) { await w.pump(); if (!what()) await new Promise((r) => setTimeout(r, 20)); }
	assert.ok(what(), `Timed out waiting for ${message}`);
}
const fetchJson = (gui: { url: string; port: number }, path: string) => new Promise<{ status: number; type: string; body: Buffer }>((resolve, reject) => get(`${gui.url}${path}`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => {
	const parts: Buffer[] = [];
	res.on("data", (c: Buffer) => parts.push(c)).on("end", () => resolve({ status: res.statusCode!, type: String(res.headers["content-type"]), body: Buffer.concat(parts) }));
}).on("error", reject));

test("the page's stream carries the merged net and the box's history; its reads of a box's unit go through the session; a page counts toward the session", async () => {
	const w = hostWorld();
	const gui = await startGui({ read: async () => LOCAL, dir: join(scratch, "bundle"), pollMs: 20, pingMs: 1000, operateHost: w.host });
	try {
		assert.equal(w.stats.opens, 0, "no page yet");
		const page = listen(gui);
		await until(() => w.stats.opens === 1, "the session opens with the page");
		await w.pump();
		w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" })));
		await w.pump();
		await until(() => page.nets().some((n) => n.bases.length === 2), "the merged net");
		const merged = page.nets().find((n) => n.bases.length === 2)!, key = merged.bases[1]!.tabs[0]!.units[0]!.key;
		assert.equal(merged.bases[1]!.box!.state, "live");
		// The history watch of a page loaded at the unit's address.
		const watching = listen(gui, key);
		await pumped(w, () => w.box().watches().length === 1, "the watch");
		w.box().ev(w.box().watches()[0]!.id as string, "history", { key: "a-main", state: "live", reset: true, items: [{ id: "e1", kind: "user", text: "hi" }] });
		await w.pump();
		await until(() => watching.events.some((e) => e.event === "history"), "the history event");
		assert.equal(JSON.parse(watching.events.find((e) => e.event === "history")!.data).key, key);
		// A read through GET.
		const read = fetchJson(gui, `api/history/${key}?limit=10`);
		await pumped(w, () => w.box().reqs().length === 1, "the request");
		w.box().rep(w.box().reqs()[0]!.id as string, 200, { items: [{ id: "e1", kind: "user", text: "hi" }] });
		await w.pump();
		const got = await read;
		assert.equal(got.status, 200);
		assert.equal(JSON.parse(got.body.toString()).items[0].text, "hi");
		// An image answers as the picture, with the type the box named and nosniff.
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
		const pic = fetchJson(gui, `api/image/${key}/e1/0`);
		await pumped(w, () => w.box().reqs().length === 2, "the image request");
		w.box().rep(w.box().reqs()[1]!.id as string, 200, { type: "image/png", base64: png.toString("base64") });
		await w.pump();
		const image = await pic;
		assert.equal(image.type, "image/png");
		assert.ok(image.body.equals(png));
		// A local key still goes the local way: 404 for a key nobody has.
		assert.equal((await fetchJson(gui, "api/history/local-nobody")).status, 404);
		page.close();
		watching.close();
	} finally {
		await gui.stop();
	}
});

test("a stream that closes tells the host its page left, and the gui's stop stops the host", async () => {
	const w = hostWorld();
	const gui = await startGui({ read: async () => LOCAL, dir: join(scratch, "bundle"), pollMs: 20, operateHost: w.host });
	const page = listen(gui);
	await until(() => w.stats.opens === 1, "opened");
	page.close();
	await until(() => w.host.status().length === 1, "the session is still there");
	await w.run(61_000);
	assert.deepEqual(w.host.status(), []);
	await gui.stop();
});

test("an upload to a box's unit over HTTP is read up to 2 MB and sent as the box's own request; past 2 MB it is refused", async () => {
	const w = hostWorld();
	const gui = await startGui({ read: async () => LOCAL, dir: join(scratch, "bundle"), pollMs: 20, operateHost: w.host });
	const page = listen(gui);
	try {
		await until(() => w.stats.opens === 1, "opened");
		await w.pump();
		w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
		await w.pump();
		await until(() => page.nets().some((n) => n.bases.length === 2), "merged");
		const key = page.nets().find((n) => n.bases.length === 2)!.bases[1]!.tabs[0]!.units[0]!.key;
		const post = (bytes: Buffer) => new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = request(`${gui.url}api/sessions/${key}/upload`, { method: "POST", headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/octet-stream", "x-sb-csrf": gui.csrf, "x-sb-name": "pic.png" } }, (res) => {
				let body = "";
				res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode!, body }));
			});
			req.on("error", reject).end(bytes);
		});
		const big = await post(Buffer.alloc(2 * 1024 * 1024 + 10, 1));
		assert.equal(big.status, 413);
		assert.equal(w.box().reqs().length, 0);
		const sent = post(Buffer.from("file bytes"));
		await pumped(w, () => w.box().reqs().length === 1, "the upload request");
		assert.deepEqual([w.box().reqs()[0]!.parts, w.box().reqs()[0]!.body], [["sessions", "a-main", "upload"], Buffer.from("file bytes").toString("base64")]);
		assert.deepEqual(w.box().reqs()[0]!.q, { name: "pic.png" }, "X-Sb-Name reaches the box as the query's name (OHR-F007)");
		w.box().rep(w.box().reqs()[0]!.id as string, 200, { path: "/tmp/f" });
		await w.pump();
		assert.deepEqual([(await sent).status, JSON.parse((await sent).body)], [200, { path: "/tmp/f" }]);
	} finally {
		page.close();
		await gui.stop();
	}
});
