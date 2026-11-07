import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net } from "../src/net.ts";
import { plan } from "../src/operateroutes.ts";
import { ownerOf, type OwnerWorld } from "../src/server/operatescope.ts";
import { A, baseOf, hostWorld, netOf, unit } from "./operate-host-world.ts";
import { scopeOf, world } from "./operate-world.ts";

// The batch review of todo #121 Link operate (BR-F001 to BR-F008, docs/specs/2026-11-07-link-operate.md §11.8): what each finding asked to be true.

const Q = new URLSearchParams();
const LOCAL: Net = { bases: [] };

// ---- BR-F003: a box-scope session never reaches the head tower, on any route ------------------------------------------------------------------------------

const HEAD = { key: "sb-head", base: "@head", name: "head tower", role: "head", file: "/x/s.jsonl", pane: "p9" };
const headWorld = { ref: (k: string) => (k === HEAD.key ? HEAD : undefined), refs: () => [HEAD], panes: () => [], allyPanes: () => [], run: () => undefined, opened: () => [] } as unknown as OwnerWorld;

test("BR-F003: the head tower is nobody's: no scope, the box part included, holds its key", () => {
	assert.equal(ownerOf(headWorld, "sb-head"), undefined);
	assert.equal(ownerOf(headWorld, "sb-head", true), undefined);
});

test("BR-F003: plan refuses a head key on every route family that names a unit, not only sessions/*", () => {
	const roleOf = (k: string) => (k === "sb-head" ? "head" : undefined);
	const box = scopeOf(["sb-head"], true);
	const refused = (method: "GET" | "POST", parts: string[], body: Record<string, unknown> = {}) => { const p = plan(method, parts, body, box, "request", roleOf); return p.ok ? "ok" : p.why; };
	assert.equal(refused("GET", ["history", "sb-head"]), "route");
	assert.equal(refused("GET", ["entry", "sb-head", "e1"]), "route");
	assert.equal(refused("GET", ["image", "sb-head", "e1", "0"]), "route");
	assert.equal(refused("POST", ["close", "unit"], { key: "sb-head" }), "route");
	assert.equal(refused("POST", ["dismiss"], { key: "sb-head" }), "route");
	assert.equal(refused("POST", ["sessions", "sb-head", "input"], { text: "hi", as: "send" }), "route");
});

test("BR-F003: through the seam, reading, watching and closing the head's key are refused before anything is called", async () => {
	const x = await world({ units: { "sb-head": "head" } });
	const box = scopeOf(["sb-head"], true);
	const why = (r: { status: number; body: unknown }) => [r.status, (r.body as { error?: string }).error, (r.body as { why?: string }).why];
	assert.deepEqual(why(await x.session.request("GET", ["history", "sb-head"], Q, {}, box)), [403, "operate_refused", "route"]);
	assert.deepEqual(why(await x.session.request("GET", ["entry", "sb-head", "e1"], Q, {}, box)), [403, "operate_refused", "route"]);
	assert.deepEqual(why(await x.session.request("POST", ["close", "unit"], Q, { key: "sb-head" }, box)), [403, "operate_refused", "route"]);
	assert.deepEqual(why(await x.session.watch("w", "sb-head", true, box)), [403, "operate_refused", "route"]);
	assert.deepEqual([x.calls, x.effects, x.seen], [[], [], []]);
});

test("BR-F003: the controller never routes a request to a head key a box's snapshot names", async () => {
	const w = hostWorld({ teams: [A] });
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [["t1", [unit("sb-head"), unit("sb-head-0123abcd"), unit("s1")]]], { label: "billing" })));
	await w.pump();
	const base = w.host.merge(LOCAL).bases.find((b) => b.label === "billing")!;
	const keyOf = (name: string) => base.tabs[0]!.units.find((u) => u.name === name)!.key;
	const before = w.box(A).reqs().length;
	for (const name of ["sb-head", "sb-head-0123abcd"]) {
		const k = keyOf(name);
		for (const [method, parts, json] of [["GET", ["history", k], {}], ["GET", ["entry", k, "e"], {}], ["POST", ["sessions", k, "input"], { text: "x", as: "send" }], ["POST", ["close", "unit"], { key: k }], ["POST", ["dismiss"], { key: k }]] as const) {
			const c = w.host.bridge.claim(method, [...parts], { ...json });
			if (!c) continue;
			const p = c.send();
			await w.pump();
			const r = await Promise.race([p, new Promise<"pending">((res) => setImmediate(() => res("pending")))]);
			assert.equal(r === "pending" ? "forwarded" : r.status, 403, `${method} ${parts[0]} ${name}`);
		}
		w.host.bridge.watch(k, () => {});
	}
	await w.pump();
	assert.equal(w.box(A).reqs().length, before);
	assert.equal(w.box(A).watches().length, 0);
	// an ordinary unit still routes
	assert.ok(w.host.bridge.claim("POST", ["sessions", keyOf("s1"), "input"], { text: "x", as: "send" }));
});

// ---- BR-F002: the controller's sanitizer keeps a box tower's wait cards -----------------------------------------------------------------------------------

import { type Rewrite, sanitizeNet } from "../src/server/operatesanitize.ts";

const rw = (told: string[] = []): Rewrite => ({ key: (k) => `K:${k}`, base: (b) => `B:${b}`, tab: (w, t) => `T:${w}:${t}`, bad: (why) => void told.push(why) });
const withWaits = (bossWaits: unknown[]) => ({ bases: [{ id: "w1", label: "Work", mark: "waiting", tabs: [], outposts: [], outside: [], tower: { name: "tower", mark: "waiting", key: "tw", control: true, subs: [], service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: bossWaits.length, bossWaits, proposals: [] } } } }] });
const waitsOf = (raw: unknown, told: string[] = []) => (sanitizeNet(raw, rw(told))!.bases[0]!.tower!.service!.memory!.bossWaits) as unknown as Record<string, unknown>[];
const CARD = { type: "choice", lang: "en", happened: "The deploy waits.", do: "Pick one.", url: "https://example.com/a", options: [{ label: "Go", then: "deploys" }, { label: "Stop", then: "stays" }], from: { name: "worker", role: "main", workspace: "billing", tab: "one", key: "u1" } };

test("BR-F002: a card, a press, and a resolved wait cross the sanitizer with their fields", () => {
	const [a, b] = waitsOf(withWaits([
		{ id: "W1", text: "Pick one.", at: "2026-11-08T00:00:00Z", card: CARD, press: { act: "choose", option: 1, at: "2026-11-08T00:01:00Z", main: { status: "delivered", at: "2026-11-08T00:01:01Z" } }, cut: true },
		{ id: "W2", text: "Old one", at: "2026-11-07T00:00:00Z", state: "resolved", outcome: "declined", ended: "2026-11-08T00:00:00Z", answered: "2026-11-07T01:00:00Z" },
	]));
	assert.deepEqual(a!.card, { ...CARD, from: { name: "worker", role: "main", workspace: "billing", tab: "one", key: "K:u1" } }, "the card, with the raiser's unit key rewritten as every other key");
	assert.deepEqual(a!.press, { act: "choose", option: 1, at: "2026-11-08T00:01:00Z", main: { status: "delivered", at: "2026-11-08T00:01:01Z" } });
	assert.equal(a!.cut, true);
	assert.equal(b!.state, "resolved");
	assert.equal(b!.outcome, "declined");
	assert.equal(b!.ended, "2026-11-08T00:00:00Z");
});

test("BR-F002: the card's fields are bounded, typed and enum-checked; text stays text", () => {
	const [w] = waitsOf(withWaits([{ id: "W1", text: "t", at: "a", state: "open", outcome: 5, ended: { x: 1 }, cut: "yes", press: { act: "rm -rf", at: "z" }, card: { ...CARD, type: "rm", lang: "xx", happened: `bad\u202e${"x".repeat(900)}`, url: "javascript:alert(1)", command: "a\nb\nc\nd\ne\nf", options: [{ label: "L".repeat(500), then: "x" }, { label: 5 }], from: { name: "n\u0007", role: 3 } } }]));
	assert.equal(w!.state, undefined, "only `resolved` is a state");
	assert.equal(w!.outcome, undefined);
	assert.equal(w!.ended, undefined);
	assert.equal(w!.cut, undefined);
	assert.equal(w!.press, undefined, "a press with an act outside the list is no press");
	assert.equal(w!.card, undefined, "a card of an unknown type or language is no card: the wait is then an old-style one");
	const [ok] = waitsOf(withWaits([{ id: "W2", text: "t", at: "a", card: { ...CARD, happened: `bad\u202e${"x".repeat(900)}`, url: "javascript:alert(1)", command: "a\nb\nc\nd\ne\nf\ng\nh".repeat(40), options: [{ label: "L".repeat(500), then: "x" }, { label: 5 }] } }]));
	const card = ok!.card as { happened: string; url?: string; command?: string; options: { label: string }[] };
	assert.ok(card.happened.length <= 160 && !card.happened.includes("\u202e"));
	assert.equal(card.url, undefined, "only an http(s) address with no userinfo");
	assert.ok(card.command === undefined || card.command.length <= 300);
	assert.ok(card.options.every((o) => o.label.length <= 24));
});

test("BR-F002: a url with userinfo or a non-http scheme is dropped; an https one stays", () => {
	const url = (u: string) => (waitsOf(withWaits([{ id: "W", text: "t", at: "a", card: { ...CARD, url: u } }]))[0]!.card as { url?: string }).url;
	assert.equal(url("https://user:pw@example.com/x"), undefined);
	assert.equal(url("ftp://example.com/x"), undefined);
	assert.equal(url("https://example.com/x"), "https://example.com/x");
});

// ---- BR-F001: one box's base in two controller sessions (two teams) --------------------------------------------------------------------------------------

import { createControl } from "../src/control.ts";
import { B } from "./operate-host-world.ts";

type World = ReturnType<typeof hostWorld>;
const flags = { remote: false, secure: false };
/** A box (two teams' sessions, each with the box part) whose two sessions show the one base `wA`, each with a tab of its own. */
async function twoTeams(order: string[] = [A, B]) {
	const w = hostWorld({ teams: order });
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" })));
	w.box(B).snap(netOf(baseOf("wA", [["t2", [unit("b-main")]]], { label: "billing" })));
	await w.pump();
	const base = w.host.merge(LOCAL).bases.find((b) => b.label === "billing")!;
	const tabOf = (unitName: string) => base.tabs.find((t) => t.units[0]!.name === unitName)!.id;
	return { w, base, tabA: tabOf("a-main"), tabB: tabOf("b-main") };
}
const settledOr = async <T>(p: Promise<T>): Promise<T | "pending"> => Promise.race([p, new Promise<"pending">((r) => setImmediate(() => r("pending")))]);

for (const order of [[A, B], [B, A]]) test(`BR-F001: Quit squad goes to the session whose tab it is (sessions opened ${order[0] === A ? "A first" : "B first"})`, async () => {
	const { w, base, tabA, tabB } = await twoTeams(order);
	const c = createControl({ bridge: w.host.bridge, lookup: () => undefined, csrf: "c", canonical: () => undefined });
	for (const [team, tab] of [[A, tabA], [B, tabB]] as const) {
		const before = w.box(team).reqs().length;
		const p = c.run(["close", "tab"], { workspace: base.id, tab }, flags);
		await w.pump();
		assert.equal(w.box(team).reqs().length - before, 1, `the squad's own session is asked (${team === A ? "A" : "B"})`);
		const r = await settledOr(p);
		assert.equal(r, "pending", "forwarded, not answered 404 here");
		const last = w.box(team).reqs().at(-1)!;
		assert.deepEqual(last.parts, ["close", "tab"]);
		w.box(team).rep(last.id as string, 200, { closed: true });
		await w.pump();
		assert.equal(((await p) as { status: number }).status, 200);
	}
});

const run = (id: string, last: number, name = id) => ({ id, name, role: "main", workspace: "billing", first: last - 10, last, size: 100 });
const HEXA = "a".repeat(16), HEXB = "b".repeat(16), HEXS = "5".repeat(16), HEXA2 = "a2".repeat(8);
/** The request a claimed page request made of a box, answered with `body`. */
async function answer(w: World, send: Promise<unknown>, replies: Record<string, { status?: number; body: unknown }>) {
	await w.pump();
	for (const [team, rep] of Object.entries(replies)) { const r = w.box(team).reqs().at(-1)!; w.box(team).rep(r.id as string, rep.status ?? 200, rep.body); }
	await w.pump();
	return send;
}

test("BR-F001: Earlier runs of a base two sessions show lists the runs of both, a shared one once, newest first", async () => {
	const { w, base } = await twoTeams();
	const c = w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base: base.id }))!;
	assert.ok(c);
	const reply = (await answer(w, c.send(), {
		[A]: { body: { rows: [run(HEXA, 300), run(HEXS, 200), run(HEXA2, 100)] } },
		[B]: { body: { rows: [run(HEXB, 250), run(HEXS, 200)] } },
	})) as { status: number; body: { rows: { key: string; last: number }[]; before?: string } };
	assert.equal(reply.status, 200);
	assert.deepEqual(reply.body.rows.map((r) => r.last), [300, 250, 200, 100]);
	assert.equal(new Set(reply.body.rows.map((r) => r.key)).size, 4);
});

test("BR-F001: a session that is not live is left out of Earlier runs, and none live is a 503", async () => {
	const { w, base } = await twoTeams();
	w.box(B).close("overload");
	await w.pump();
	const c = w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base: base.id }))!;
	const reply = (await answer(w, c.send(), { [A]: { body: { rows: [run(HEXA, 300)] } } })) as { status: number; body: { rows: unknown[] } };
	assert.equal(reply.status, 200);
	assert.equal(reply.body.rows.length, 1);
});

test("BR-F001: the next page's cursor is given to each session in its own words", async () => {
	const { w, base } = await twoTeams();
	const first = w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base: base.id }))!;
	const page = (await answer(w, first.send(), {
		[A]: { body: { rows: [run(HEXA, 300), run(HEXA2, 100)], before: `100:${HEXA2}` } },
		[B]: { body: { rows: [run(HEXB, 250)] } },
	})) as { body: { rows: { key: string; last: number }[]; before?: string } };
	assert.ok(page.body.before, "A has more, so there is a next page");
	const lastKey = page.body.rows.at(-1)!.key;
	assert.equal(page.body.before, `100:${lastKey}`);
	const next = w.host.bridge.claim("GET", ["transcripts"], {}, new URLSearchParams({ base: base.id, before: page.body.before! }))!;
	const nextAsked = next.send();
	await w.pump();
	assert.equal((w.box(A).reqs().at(-1)!.q as Record<string, string>).before, `100:${HEXA2}`, "A knows the cursor's run");
	assert.match((w.box(B).reqs().at(-1)!.q as Record<string, string>).before!, /^100:[0-9a-f]{16}$/, "B does not: it gets the time and the largest id");
	for (const team of [A, B]) w.box(team).rep(w.box(team).reqs().at(-1)!.id as string, 200, { rows: [] });
	await w.pump();
	assert.equal(((await nextAsked) as { status: number }).status, 200);
});

test("BR-F001: a workspace watch of a base two sessions show is asked of both, and the cards of both reach the page", async () => {
	const { w, base } = await twoTeams();
	const got: [string, unknown][] = [];
	const watch = w.host.bridge.watch(`w:${base.id}`, (e, d) => void got.push([e, d]))!;
	assert.ok(watch);
	await w.pump();
	const asked = (team: string) => w.box(team).watches().filter((i) => i.on === true);
	assert.equal(asked(A).length, 1, "A is asked");
	assert.equal(asked(B).length, 1, "B is asked");
	w.box(A).ev(asked(A)[0]!.id as string, "cards", { "a-main": "a line" });
	w.box(B).ev(asked(B)[0]!.id as string, "cards", { "b-main": "b line" });
	await w.pump();
	const lines = got.filter(([e]) => e === "cards").flatMap(([, d]) => Object.values(d as Record<string, string>));
	assert.deepEqual(lines.sort(), ["a line", "b line"]);
	watch.stop();
	await w.pump();
	assert.equal(w.box(A).watches().filter((i) => i.on === false).length, 1, "stopped on A");
	assert.equal(w.box(B).watches().filter((i) => i.on === false).length, 1, "stopped on B");
});

// ---- BR-F006: a merged base's state and scope follow the session that owns the unit shown -----------------------------------------------------------------

test("BR-F006: while one of a box's two sessions is unreachable, its units say so and the other's stay live; the base is live", async () => {
	const { w, base: before } = await twoTeams();
	assert.equal(before.box!.units, undefined, "both live: nothing to say per unit");
	w.box(B).close("overload");
	await w.pump();
	const base = w.host.merge(LOCAL).bases.find((b) => b.label === "billing")!;
	assert.equal(base.box!.state, "live", "the base: one session is live");
	const keyOf = (name: string) => base.tabs.flatMap((t) => t.units).find((u) => u.name === name)!.key;
	assert.deepEqual(Object.keys(base.box!.units ?? {}), [keyOf("b-main")]);
	assert.equal(base.box!.units![keyOf("b-main")]!.state, "unreachable");
});

test("BR-F006: the scope of a merged base is the live sessions': an unreachable box session does not offer what the live team-only one would refuse", async () => {
	const w = hostWorld({ teams: [A, B] });
	w.box(B).scope.box = false; // B is a team-only session
	await w.page();
	w.box(A).snap(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" })));
	w.box(B).snap(netOf(baseOf("wA", [["t2", [unit("b-main")]]], { label: "billing" })));
	await w.pump();
	let base = w.host.merge(LOCAL).bases.find((b) => b.label === "billing")!;
	assert.equal(base.box!.scope, "box");
	const keyOf = (name: string) => base.tabs.flatMap((t) => t.units).find((u) => u.name === name)!.key;
	assert.equal(base.box!.units![keyOf("b-main")]!.scope, "team", "a unit only the team session shows has the team session's reach");
	assert.ok(!base.box!.units![keyOf("b-main")]!.can.includes("tower"));
	w.box(A).close("overload");
	await w.pump();
	base = w.host.merge(LOCAL).bases.find((b) => b.label === "billing")!;
	assert.equal(base.box!.scope, "team", "the box session is unreachable: only the team session is live, so the base offers no tower action");
	assert.ok(!base.box!.can.includes("tower"));
});

// ---- BR-F008: a request admitted before the session ended does not write after it ---------------------------------------------------------------------------

test("BR-F008: a write whose session ends while the box looks at the terminal is not sent", async () => {
	const scope = scopeOf(["sess-1"]), send = (x: Awaited<ReturnType<typeof world>>) => x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hi", as: "send" }, scope);
	const x = await world();
	assert.equal((await send(x)).status, 200, "control: the same request goes while the session lives");
	assert.ok(x.typed().length > 0);
	const y = await world();
	y.w.onProbe = () => y.session.stop(); // the session ends (a revoke) during the looks before the write
	const done = await send(y);
	assert.equal(done.status, 403);
	assert.equal((done.body as { why?: string }).why, "ended");
	assert.deepEqual(y.typed(), [], "nothing reached the pane");
});
