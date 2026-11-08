import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startGui } from "../src/gui.ts";
import { until } from "./fakes.ts";
import type { Net } from "../src/net.ts";
import { createOperateHost, REFUSED_MS } from "../src/server/operatehost.ts";
import { sanitizeNet } from "../src/server/operatesanitize.ts";
import { A, B, baseOf, dave, hostWorld, netOf, offer, unit } from "./operate-host-world.ts";

// The review of the controller's host (backlog operate-host-review.md, OHR-F001 to F014): what each finding broke, held by the world of operate-host-world.ts with its fake boxes. The combined host and box test is
// tests/server-operate-host-wire.test.ts.

const LOCAL: Net = { bases: [] };
const SNAP = () => netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" }));
const unitsOf = (net: Net) => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units));
const keyOf = (w: ReturnType<typeof hostWorld>, raw: string) => unitsOf(w.host.merge(LOCAL)).find((u) => u.name === raw)!.key;
const stateOf = (w: ReturnType<typeof hostWorld>) => w.host.merge(LOCAL).bases[0]?.box?.state;
/** An answer this end gives itself: a guard that is gone would forward the request and wait for a reply the fake clock never ends (OHR-F013). */
const here = async <T>(p: Promise<T>): Promise<T> => { const r = await settled(p); assert.notEqual(r, "pending", "answered here, not forwarded to the box"); return r as T; };
const settled = async <T>(p: Promise<T>): Promise<T | "pending"> => Promise.race([p, new Promise<"pending">((r) => setImmediate(() => r("pending")))]);
async function live(o: Parameters<typeof hostWorld>[0] = {}) {
	const w = hostWorld(o);
	await w.page();
	w.box().snap(SNAP());
	await w.pump();
	return w;
}

test("OHR-F001: the last page's stop names the box's own target, the one the watch was started with (a workspace's `w:` too)", async () => {
	const w = await live();
	const watch = w.host.bridge.watch(keyOf(w, "a-main"), () => {})!;
	await w.pump();
	watch.stop();
	await w.pump();
	assert.deepEqual(w.box().watches().map((m) => [m.target, m.on]), [["a-main", true], ["a-main", false]]);
	const ws = w.host.bridge.watch(w.host.merge(LOCAL).bases[0]!.id.replace(/^/, "w:"), () => {})!;
	await w.pump();
	ws.stop();
	await w.pump();
	assert.deepEqual(w.box().watches().slice(2).map((m) => [m.target, m.on]), [["w:wA", true], ["w:wA", false]]);
});

test("OHR-F001: a watch that moves to another session is stopped on the session that had it", async () => {
	const w = hostWorld({ teams: [A, B] });
	w.box(A).scope.box = false;
	await w.page();
	w.box(A).snap(SNAP());
	await w.pump();
	const key = keyOf(w, "a-main");
	w.host.bridge.watch(key, () => {});
	await w.pump();
	assert.deepEqual(w.box(A).watches().map((m) => m.on), [true]);
	w.box(B).snap(SNAP()); // the box scope's session shows the same unit now: it is the session to ask
	await w.pump();
	w.host.bridge.watch(key, () => {}); // another page joins: the watch is asked again
	await w.pump();
	assert.deepEqual(w.box(A).watches().map((m) => [m.target, m.on]), [["a-main", true], ["a-main", false]]);
	assert.deepEqual(w.box(B).watches().map((m) => [m.target, m.on]), [["a-main", true]]);
});

test("OHR-F002: a box that stops, is overloaded or has no GUI greys the base and reopens; it does not read as a revoked grant", async () => {
	for (const word of ["stopped", "overload", "unavailable"]) {
		const w = await live();
		w.box().close(word);
		await w.pump();
		assert.equal(stateOf(w), "unreachable", word);
		assert.equal(w.host.merge(LOCAL).bases[0]!.box!.why, undefined, word);
		await w.run(6000);
		assert.equal(w.stats.opens, 2, `${word}: reopened with the first backoff`);
	}
	for (const word of ["policy", "roster"]) {
		const w = await live();
		w.box().close(word);
		await w.pump();
		assert.deepEqual([stateOf(w), w.host.merge(LOCAL).bases[0]!.box!.why], ["ended", word]);
	}
});

test("OHR-F002: a transient refusal (unavailable, a full slot, a seen id) is retried with backoff and shows no line; a grant refusal is remembered 10 minutes", async () => {
	for (const word of ["unavailable", "operator-limit", "box-limit", "seen"]) {
		const w = hostWorld();
		w.box().policy = word;
		await w.page();
		assert.equal(w.host.merge(LOCAL).bases.length, 0, `${word}: no line`);
		await w.run(40_000);
		assert.ok(w.stats.opens >= 3 && w.stats.opens <= 8, `${word}: ${w.stats.opens} opens in 40 s (backoff, not 10 minutes)`);
		w.box().policy = "accept";
		await w.run(300_000);
		assert.equal(w.host.status()[0]!.state, "live", word);
	}
	const w = hostWorld();
	w.box().policy = "not-granted";
	await w.page();
	await w.run(REFUSED_MS - 5000);
	assert.equal(w.stats.opens, 1);
});

test("OHR-F003: after off() with a page still watching, the reopened session asks for the page's watch again", async () => {
	const w = await live();
	w.host.bridge.watch(keyOf(w, "a-main"), () => {});
	await w.pump();
	w.host.off();
	await w.pump();
	await w.run(65_000);
	w.box().snap(SNAP());
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 2);
});

test("OHR-F003: a team that stops and comes back gets the page's watch again too", async () => {
	const w = await live();
	w.host.bridge.watch(keyOf(w, "a-main"), () => {});
	await w.pump();
	w.host.closeTeam(A);
	await w.pump();
	await w.run(2000);
	w.box().snap(SNAP());
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 2);
});

test("OHR-F004: a box no longer offered ends its session, and its base leaves the map", async () => {
	const w = await live();
	assert.equal(w.host.merge(LOCAL).bases.length, 1);
	w.offers.splice(0);
	await w.run(2000);
	assert.deepEqual(w.host.status(), []);
	assert.equal(w.host.merge(LOCAL).bases.length, 0);
	await w.run(300_000);
	assert.equal(w.stats.opens, 1);
});

test("OHR-F005: a greyed base stays in the net while its reopen waits for the box, whatever else changes", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.page();
	w.box(A).snap(SNAP());
	w.box(B).snap(netOf(baseOf("wB", [["t1", [unit("b-main")]]], { label: "other" })));
	await w.pump();
	w.partition(true);
	await w.run(46_000);
	for (let i = 0; i < 30 && !w.host.status().some((s) => s.state === "opening"); i++) await w.run(1000);
	assert.ok(w.host.status().some((s) => s.state === "opening"), "a reopen is waiting");
	const labels = () => w.host.merge(LOCAL).bases.map((b) => `${b.label}:${b.box?.state}`).sort();
	const n = labels().length;
	assert.ok(n >= 1);
	for (let i = 0; i < 25; i++) { await w.run(1000); assert.equal(w.host.merge(LOCAL).bases.length, n, labels().join(",")); }
	assert.ok(labels().every((l) => l.endsWith(":unreachable")));
});

test("OHR-F008: a refused watch (the box's 429) is told to the page and asked again later, not left as a blank view; the unused limits are enforced", async () => {
	const w = await live();
	const got: [string, unknown][] = [];
	w.host.bridge.watch(keyOf(w, "a-main"), (e, d) => void got.push([e, d]));
	await w.pump();
	const id = w.box().watches().at(-1)!.id as string;
	w.box().rep(id, 429, { error: "too_many", reason: "A session watches at most 8 things." });
	await w.pump();
	const told = got.find(([e]) => e === "history");
	assert.ok(told, "the page was told");
	assert.equal((told![1] as { state: string }).state, "unknown");
	assert.equal(w.logs.filter((l) => l.event === "operate-bad-frame").length, 0);
	w.box().snap(SNAP()); // a snapshot is what asks a watch again
	await w.run(2000);
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 1, "not asked again at once");
	await w.run(15_000);
	w.box().snap(SNAP());
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 2, "asked again after the wait");
});

test("OHR-F008: accept.limits.watches caps the watches a session is asked for", async () => {
	const w = hostWorld();
	w.box().limits = { mirrors: 2, watches: 2, budget: 900 };
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a"), unit("b"), unit("c")]]], { label: "billing" })));
	await w.pump();
	const heard: string[] = [];
	for (const n of ["a", "b", "c"]) w.host.bridge.watch(keyOf(w, n), (e, d) => void heard.push(`${n}:${e}:${(d as { state?: string }).state}`));
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 2);
	assert.ok(heard.includes("c:history:unknown"), heard.join(" "));
});

test("OHR-F009: stop() is final: no tick, page or clock opens a session afterwards, and no clock is armed", async () => {
	const sent: string[] = [], armed: number[] = [], real = globalThis.setInterval;
	globalThis.setInterval = ((fn: () => void, ms?: number) => (armed.push(ms ?? 0), real(fn, ms))) as typeof setInterval;
	try {
		const host = createOperateHost({ now: Date.now, device: () => "a".repeat(26), boxes: () => [offer(A)], log: () => {}, interval: 15, send: async (_t, _d, m) => void sent.push(m.type) });
		host.page();
		await new Promise((r) => setImmediate(r)); // the microtask that ticks once
		assert.equal(armed.length, 1);
		const n = sent.filter((t) => t === "open").length;
		assert.equal(n, 1);
		const armedBefore = armed.length;
		host.stop();
		host.page();
		host.tick();
		await new Promise((r) => setImmediate(r));
		assert.equal(armed.length, armedBefore, "no interval is armed after stop()");
		assert.equal(sent.filter((t) => t === "open").length, n);
		assert.deepEqual(host.status(), []);
	} finally {
		globalThis.setInterval = real;
	}
});

test("OHR-F010: Stop's Escape is not held back by the pad's rate", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), sends = () => w.box().reqs().length;
	for (let i = 0; i < 4; i++) void w.host.bridge.claim("POST", ["sessions", key, "keys"], { key: "up" })!.send();
	await w.pump();
	assert.equal(sends(), 4);
	const fifth = w.host.bridge.claim("POST", ["sessions", key, "keys"], { key: "up" })!.send();
	assert.equal((await settled(fifth) as { status: number }).status, 429);
	void w.host.bridge.claim("POST", ["sessions", key, "keys"], { keys: ["esc"] })!.send();
	await w.pump();
	assert.equal(sends(), 5, "Stop reached the box");
	const sixth = w.host.bridge.claim("POST", ["sessions", key, "keys"], { key: "up" })!.send();
	assert.equal((await settled(sixth) as { status: number }).status, 429, "and it did not widen the pad's rate");
	await w.run(1500);
	for (let i = 0; i < 3; i++) void w.host.bridge.claim("POST", ["sessions", key, "keys"], { key: "up" })!.send();
	void w.host.bridge.claim("POST", ["sessions", key, "keys"], { keys: ["esc"] })!.send();
	const fourth = w.host.bridge.claim("POST", ["sessions", key, "keys"], { key: "down" })!.send();
	await w.pump();
	assert.equal(await settled(fourth), "pending", "forwarded to the box (a 429 would have answered at once)");
	assert.equal(w.box().reqs().length, 5 + 3 + 1 + 1, "Stop did not count against the pad: its fourth key still went");
});

test("OHR-F011: a relay that refuses every send writes one operate-send-failed line a minute for a session, with the count", async () => {
	const w = await live();
	w.fail(true);
	const key = keyOf(w, "a-main");
	for (let i = 0; i < 12; i++) { void w.host.bridge.claim("POST", ["sessions", key, "input"], { text: "x" })!.send(); await w.pump(); }
	let lines = w.logs.filter((l) => l.event === "operate-send-failed");
	assert.equal(lines.length, 1);
	assert.ok(Number(lines[0]!.count) >= 1);
	w.clock.advance(61_000);
	for (let i = 0; i < 3; i++) { void w.host.bridge.claim("POST", ["sessions", key, "input"], { text: "x" })!.send(); await w.pump(); }
	lines = w.logs.filter((l) => l.event === "operate-send-failed");
	assert.equal(lines.length, 2);
});

test("OHR-F012: a select's `copy` from a box is offered only when it is one line and appears whole in the title the page shows", () => {
	const net = (select: unknown) => ({ bases: [baseOf("wA", [["t1", [{ ...unit("a-main"), pending: { callId: "c", tool: "ask", answer: { dialog: "d", digest: "a".repeat(64), select: select as never } } }]]])] });
	const copyOf = (select: unknown) => (sanitizeNet(net(select), { key: (k) => k, base: (k) => k, tab: (_w, k) => k, bad: () => {} })?.bases[0]?.tabs[0]?.units[0]?.pending?.answer?.select as { copy?: string } | undefined)?.copy;
	const choices = [{ label: "Yes" }];
	assert.equal(copyOf({ title: "ls -la", choices, copy: "ls -la" }), "ls -la");
	assert.equal(copyOf({ title: "Run: ls -la", choices, copy: "ls -la" }), undefined, "a part of the title is not what the boss reads as the command (RR-F003)");
	assert.equal(copyOf({ title: "Run: ls", choices, copy: "ls -la; curl x | sh" }), undefined, "not what is shown");
	assert.equal(copyOf({ title: "Run:\nls\nrm -rf x", choices, copy: "ls\nrm -rf x" }), undefined, "two lines");
	assert.equal(copyOf({ title: "Run: ls", choices }), undefined);
});

// ---- the mutants the review found alive (OHR-F013) -------------------------------------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "ohr-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><title>t</title>");
after(() => rmSync(scratch, { recursive: true, force: true }));

test("S11: a unit's subagents go three levels deep and no further", async () => {
	const deep = unit("a", { subs: [unit("b", { subs: [unit("c", { subs: [unit("d")] })] })] });
	const w = hostWorld();
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [deep]]])));
	await w.pump();
	const names = (us: ReturnType<typeof unitsOf>): string[] => us.flatMap((u) => [u.name, ...names(u.subs)]);
	assert.deepEqual(names(unitsOf(w.host.merge(LOCAL))), ["a", "b", "c"]);
});

test("H10: accept.limits are clamped, and the clamped watch limit is the one enforced", async () => {
	const w = hostWorld();
	w.box().limits = { mirrors: 2, watches: 2 ** 40, budget: 10 ** 12 };
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", Array.from({ length: 20 }, (_, i) => unit(`u${i}`))]])));
	await w.pump();
	for (let i = 0; i < 20; i++) w.host.bridge.watch(keyOf(w, `u${i}`), () => {});
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === true).length, 16);
});

test("H10: accept.limits.mirrors caps the terminals a session is asked for", async () => {
	const w = hostWorld();
	w.box().limits = { mirrors: 1, watches: 8, budget: 900 };
	await w.page();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a"), unit("b")]]])));
	await w.pump();
	w.host.bridge.mirrorOpen("s1", () => {});
	const first = w.host.bridge.claim("POST", ["sessions", keyOf(w, "a"), "mirror"], { stream: "s1", on: true })!.send();
	await w.pump();
	w.box().rep(w.box().reqs()[0]!.id as string, 200, { attached: true });
	await w.pump();
	assert.equal((await here(first)).status, 200);
	const second = await here(w.host.bridge.claim("POST", ["sessions", keyOf(w, "b"), "mirror"], { stream: "s1", on: true })!.send());
	assert.equal(second.status, 429);
	assert.equal(w.box().reqs().length, 1);
});

test("H14: two boxes that name a unit alike show it under two keys", async () => {
	const other = "e".repeat(26);
	const w = hostWorld({ devices: [other] });
	await w.page();
	w.box(A, dave.id).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	w.box(A, other).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));
	await w.pump();
	const keys = w.host.merge(LOCAL).bases.flatMap((b) => b.tabs.flatMap((t) => t.units.map((u) => u.key)));
	assert.equal(keys.length, 2);
	assert.notEqual(keys[0], keys[1]);
	const claim = w.host.bridge.claim("POST", ["sessions", keys[1]!, "input"], { text: "x", as: "send" })!;
	void claim.send();
	await w.pump();
	assert.deepEqual([w.box(A, dave.id).reqs().length, w.box(A, other).reqs().length], [0, 1], "the request reaches the box that shows that key");
});

test("H17: a forwarded dialog card of another device stays when this box shows a dialog with the same id", async () => {
	const alert = (device: string) => ({ id: `dialog/${device}/d1`, kind: "dialog" as const, level: "warning" as const, team: A, teamName: "Alpha", data: { device, dialogId: "d1", digest: "a".repeat(64), owner: "o", dialog: "q", label: "x", short: "x", answered: 0 } });
	const local: Net = { ...LOCAL, link: { allies: [], alerts: [alert("f".repeat(26)), alert(dave.id)], confirms: [], units: [] } };
	const pending = { callId: "c1", tool: "ask_user", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "Allow?", choices: [{ label: "Allow" }] } } };
	const w = await live();
	w.box().snap(netOf(baseOf("wA", [["t1", [unit("a-main", { mark: "waiting", pending })]]])));
	await w.run(500); // a second snapshot within 250 ms waits for the next tick
	assert.deepEqual(w.host.merge(local).link!.alerts.map((a) => a.id), [`dialog/${"f".repeat(26)}/d1`]);
});

test("H18: an operate message for another session id is dropped before the core, so it is not even counted as a bad frame", async () => {
	const w = await live();
	const spy = { session: Buffer.alloc(16, 7), type: "close", reason: "policy" } as never;
	w.host.receive({ team: A, from: dave.id, fromAttended: false, message: spy, ts: w.clock.now(), dropped: 0 });
	assert.equal(w.host.status()[0]!.state, "live");
	assert.equal(w.logs.filter((l) => l.event === "operate-bad-frame").length, 0);
});

test("H19: a rep from another session never answers this session's request", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.page();
	w.box(A).snap(SNAP());
	w.box(B).snap(netOf(baseOf("wB", [["t1", [unit("b-main")]]])));
	await w.pump();
	const answer = w.host.bridge.claim("POST", ["sessions", keyOf(w, "a-main"), "input"], { text: "x", as: "send" })!.send();
	await w.pump();
	const id = w.box(A).reqs()[0]!.id as string;
	w.box(B).rep(id, 200, { accepted: true, woke: true, answered: false });
	await w.pump();
	assert.equal(await settled(answer), "pending", "the other box's word is not the answer");
	w.box(A).rep(id, 200, { accepted: true, woke: true, answered: false });
	await w.pump();
	assert.equal((await answer).status, 200);
});

test("H26: the keys a stream's events bring are kept up to 5000 for a session, no more", async () => {
	const w = await live();
	const ws = `w:${w.host.merge(LOCAL).bases[0]!.id}`, seen: string[] = [];
	w.host.bridge.watch(ws, (e, d) => void (e === "cards" && seen.push(...Object.keys(d as object))));
	await w.pump();
	const id = w.box().watches().at(-1)!.id as string;
	for (let n = 0; n < 30; n++) { w.box().ev(id, "cards", Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${n * 200 + i}`, "line"]))); await w.pump(); }
	assert.equal(seen.length, 6000);
	const known = (x: string) => w.host.bridge.claim("GET", ["history", x]) !== undefined;
	assert.ok(known(seen[0]!), "the first is kept");
	assert.ok(!known(seen.at(-1)!), "past 5000 a key is shown but not kept, so no request can name it");
});

test("H16: an upload over HTTP is read up to 2 MB; what is over never reaches the bridge", async () => {
	const w = hostWorld(), sizes: (number | undefined)[] = [];
	const bridge = { ...w.host.bridge, claim: (...a: Parameters<typeof w.host.bridge.claim>) => { const c = w.host.bridge.claim(...a); return c && { send: (b?: Buffer) => (sizes.push(b?.length), c.send(b)) }; } };
	const gui = await startGui({ read: async () => LOCAL, dir: join(scratch, "bundle"), pollMs: 20, operateHost: { ...w.host, bridge } });
	const stream = request(`${gui.url}events`, { headers: { host: `127.0.0.1:${gui.port}` } });
	stream.on("error", () => {}).end();
	try {
		await until(() => w.stats.opens === 1, "opened");
		await w.pump();
		w.box().snap(SNAP());
		await w.pump();
		const key = unitsOf(w.host.merge(LOCAL)).find((u) => u.name === "a-main")!.key;
		const status = await new Promise<number>((resolve, reject) => {
			const req = request(`${gui.url}api/sessions/${key}/upload`, { method: "POST", headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/octet-stream", "x-sb-csrf": gui.csrf, "x-sb-name": "big.bin" } }, (res) => (res.resume(), resolve(res.statusCode!)));
			req.on("error", reject).end(Buffer.alloc(2 * 1024 * 1024 + 10, 1));
		});
		assert.equal(status, 413);
		assert.deepEqual(sizes, []);
	} finally {
		stream.destroy();
		await gui.stop();
	}
});

test("a box in two teams whose grant is withdrawn shows the ended line on a card of each team, not on one of them (trial 121 round 2, item 9)", async () => {
	for (const word of ["policy", "roster"]) {
		const w = hostWorld({ teams: [A, B] });
		await w.page();
		w.box(A).snap(SNAP());
		w.box(B).snap(SNAP());
		await w.pump();
		w.box(A).close(word);
		w.box(B).close(word);
		await w.pump();
		const ended = w.host.merge(LOCAL).bases;
		assert.deepEqual(ended.map((b) => [b.box!.state, b.box!.why, b.box!.team]).sort(), [["ended", word, "Alpha"], ["ended", word, "Beta"]], word);
		assert.equal(new Set(ended.map((b) => b.id)).size, 2, "two cards, two ids");
		assert.deepEqual(new Set(ended.map((b) => b.box!.device)), new Set([dave.id]));
	}
});

test("one team of a box that ends while the other stays live shows no ghost: the live base is the box", async () => {
	const w = hostWorld({ teams: [A, B] });
	await w.page();
	w.box(A).snap(SNAP());
	w.box(B).snap(SNAP());
	await w.pump();
	w.box(A).close("policy");
	await w.pump();
	assert.deepEqual(w.host.merge(LOCAL).bases.map((b) => b.box!.state), ["live"]);
});
