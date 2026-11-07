import assert from "node:assert/strict";
import { test } from "node:test";
import { SCOPES } from "../src/control.ts";
import { plan, ROUTES, verdictOf } from "../src/operateroutes.ts";
import { scopeOf, world } from "./operate-world.ts";

// docs/specs/2026-11-07-link-operate.md §6.3: every route of the box's GUI is allowed or refused for an operate session, from ONE table (src/operateroutes.ts), and what is allowed runs the same control.ts path a paired device's request does.

const Q = new URLSearchParams();
type Verdict = "request" | "box" | "mirror" | "refused";
/** The spec's table, typed in again: the test is the second reader of §6.3. */
const SPEC: [method: "GET" | "POST", path: string, want: Verdict][] = [
	["GET", "history/k", "request"], ["GET", "transcripts", "request"], ["GET", "transcripts/x", "refused"], ["GET", "entry/k/e", "request"], ["GET", "image/k/e/0", "request"],
	["POST", "sessions/k/input", "request"], ["POST", "sessions/k/keys", "request"], ["POST", "sessions/k/answer", "request"], ["POST", "sessions/k/dequeue", "request"], ["POST", "sessions/k/commands", "request"], ["POST", "sessions/k/upload", "request"],
	["POST", "sessions/k/mirror", "mirror"], ["POST", "sessions/k/focus", "refused"],
	["POST", "dismiss", "request"], ["POST", "close/unit", "request"], ["POST", "close/tab", "request"],
	["POST", "close/base", "refused"], ["POST", "close/stash", "refused"], ["POST", "close/all", "refused"], ["POST", "close/pop", "refused"],
	["POST", "open/base", "refused"], ["POST", "open/member", "refused"], ["POST", "open/main", "refused"], ["POST", "dirs", "refused"],
	...["memory", "leave", "new", "retry", "deliver", "drop"].map((a): [ "POST", string, Verdict ] => ["POST", `tower/ws/${a}`, "box"]),
	["POST", "panes/g/mirror", "refused"], ["POST", "panes/g/keys", "refused"], ["POST", "trust/answer", "refused"],
	["POST", "link/state", "refused"], ["POST", "link/dialog-answer", "refused"], ["POST", "link/create", "refused"],
	["POST", "server/stop", "refused"], ["POST", "server/status", "refused"], ["POST", "remote/on", "refused"], ["POST", "remote/pair", "refused"], ["POST", "lan/on", "refused"], ["POST", "head/x", "refused"],
	["GET", "doc/x", "refused"], ["GET", "music", "refused"], ["GET", "lan/pending", "refused"],
	// not in the table at all: refused by default
	["POST", "sessions/k/bogus", "refused"], ["POST", "bogus", "refused"], ["GET", "bogus", "refused"], ["POST", "sessions", "refused"], ["POST", "sessions/k/input/extra", "refused"], ["GET", "history", "refused"],
];

test("§6.3: every route of the spec's table gets the verdict the spec gives it", () => {
	for (const [method, path, want] of SPEC) assert.equal(verdictOf(method, path.split("/")), want, `${method} ${path}`);
});

test("§6.3: every scope control.ts serves has a row in the table, and the table names no scope control.ts does not serve", () => {
	const named = new Set(ROUTES.filter((r) => r.method !== "STREAM").map((r) => r.path.split("/")[0]!));
	for (const scope of SCOPES) assert.ok(named.has(scope), `no row for ${scope}`);
	for (const scope of ["sessions", "panes", "remote", "server", "dirs", "open", "close", "dismiss", "trust", "link", "tower", "head", "lan"]) assert.ok(SCOPES.includes(scope), `${scope} left control.ts`);
	for (const s of named) assert.ok(SCOPES.includes(s) || ["history", "entry", "image", "transcripts", "music", "doc"].includes(s), `a row for ${s}, which nothing serves`);
});

test("§6.3: a path with an empty or odd segment never matches a row's wildcard", () => {
	for (const parts of [["sessions", "", "input"], ["sessions", "k", ""], ["tower", "", "memory"], ["close", "unit", "x"], ["dismiss", "x"]]) assert.equal(verdictOf("POST", parts), "refused", JSON.stringify(parts));
});

test("a refused route answers 403 operate_refused with a reason word, and nothing is called: not Herdr, not spawn, close, link, trust, server, remote, or the towers", async () => {
	const x = await world(), scope = scopeOf(["sess-1"], true);
	for (const [method, path, want] of SPEC) {
		if (want !== "refused") continue;
		const parts = path.split("/").map((s) => (s === "k" ? "sess-1" : s)), done = await x.session.request(method, parts, Q, {}, scope);
		assert.equal(done.status, 403, `${method} ${path}`);
		const body = done.body as { error?: string; why?: string; reason?: string };
		assert.equal(body.error, "operate_refused", `${method} ${path}`);
		assert.ok(body.why && body.reason, `${method} ${path} gives its reason`);
	}
	assert.deepEqual([x.calls, x.effects], [[], []], "no refused route reached anything behind it");
});

test("a route that goes through the stream (mirror) is no request: the stream's own entry takes it", async () => {
	const x = await world(), done = await x.session.request("POST", ["sessions", "sess-1", "mirror"], Q, { stream: "s", on: true }, scopeOf(["sess-1"]));
	assert.equal(done.status, 403);
	assert.equal((done.body as { why?: string }).why, "route");
	assert.deepEqual(x.calls, []);
});

test("a unit out of the session's scope is refused before anything runs, whatever the route (sessions, GETs, dismiss, close/unit)", async () => {
	const x = await world(), scope = scopeOf(["sess-1"]);
	const cases: ["GET" | "POST", string[], Record<string, unknown>][] = [
		["POST", ["sessions", "other-1", "input"], { text: "hi", as: "send" }], ["POST", ["sessions", "other-1", "keys"], { keys: ["esc"] }], ["POST", ["sessions", "other-1", "answer"], {}], ["POST", ["sessions", "other-1", "dequeue"], { take: "x".repeat(16) }],
		["POST", ["sessions", "other-1", "commands"], { prefix: "c" }], ["GET", ["history", "other-1"], {}], ["GET", ["entry", "other-1", "e1"], {}], ["GET", ["image", "other-1", "e1", "0"], {}],
		["POST", ["dismiss"], { key: "other-1" }], ["POST", ["close", "unit"], { key: "other-1" }], ["POST", ["sessions", "nobody", "input"], { text: "hi", as: "send" }],
	];
	for (const [method, parts, body] of cases) {
		const done = await x.session.request(method, parts, Q, body, scope);
		assert.deepEqual([done.status, (done.body as { why?: string }).why], [403, "out-of-scope"], `${method} ${parts.join("/")}`);
	}
	assert.deepEqual([x.calls, x.effects], [[], []]);
});

test("the tower routes cross with `box` scope only; without it they are the box's, not the session's", async () => {
	const x = await world();
	for (const action of ["memory", "leave", "new", "retry", "deliver", "drop"]) {
		const denied = await x.session.request("POST", ["tower", "wA", action], Q, { id: "p1", op: "read" }, scopeOf(["sess-1"], false));
		assert.deepEqual([denied.status, (denied.body as { why?: string }).why], [403, "out-of-scope"], action);
	}
	assert.equal(x.effects.length, 0);
	for (const action of ["memory", "leave", "new", "retry", "deliver", "drop"]) assert.equal((await x.session.request("POST", ["tower", "wA", action], Q, { id: "p1", op: "read" }, scopeOf([], true))).status, 200, action);
	assert.deepEqual(x.effects.map(([e]) => e), ["tower.memory", "tower.conversation", "tower.conversation", "tower.act", "tower.act", "tower.act"]);
});

test("dismiss {all: true} is refused (it would reach units of every team); dismiss {key} of a unit in scope runs, with no key it is a bad request", async () => {
	const x = await world(), scope = scopeOf(["sess-1"]);
	assert.deepEqual([(await x.session.request("POST", ["dismiss"], Q, { all: true }, scope)).status, x.effects], [403, []]);
	assert.equal((await x.session.request("POST", ["dismiss"], Q, {}, scope)).status, 400);
	assert.equal((await x.session.request("POST", ["dismiss"], Q, { key: "sess-1" }, scope)).status, 200);
	assert.deepEqual(x.effects, [["dismiss", "sess-1"]]);
});

test("close/tab: every unit in the tab must be in scope; a tab the net does not show is refused", async () => {
	const x = await world(), scope = scopeOf(["sess-1"]);
	for (const tab of ["t2", "t3", "t9"]) assert.deepEqual([(await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab }, scope)).status, x.effects.length], [403, 0], tab);
	assert.equal((await x.session.request("POST", ["close", "tab"], Q, { workspace: "wB", tab: "t1" }, scope)).status, 403, "another workspace's tab id");
	assert.equal((await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope)).status, 200);
	assert.deepEqual(x.effects, [["close", "tab", { workspace: "wA", tab: "t1" }]]);
	assert.equal((await x.session.request("POST", ["close", "unit"], Q, { key: "sess-1" }, scope)).status, 200);
});

test("plan() is pure: the verdict, the units it names, and the refusal, without a session", () => {
	const scope = scopeOf(["k"]);
	assert.deepEqual(plan("POST", ["sessions", "k", "input"], { text: "hi" }, scope), { ok: true, row: ROUTES.find((r) => r.path === "sessions/*/input")!, keys: ["k"] });
	assert.equal((plan("POST", ["sessions", "z", "input"], { text: "hi" }, scope) as { why?: string }).why, "out-of-scope");
	assert.equal((plan("POST", ["open", "main"], {}, scope) as { why?: string }).why, "route");
	assert.equal((plan("POST", ["close", "tab"], { workspace: "w", tab: "t" }, scope) as { ok: boolean; tab?: unknown }).ok, true);
});

test("the remote guards of a paired device still hold on every allowed route: a secret, a hereOnly choice, a link request's Escape-only", async () => {
	const x = await world(), scope = scopeOf(["sess-1"]), answer = (extra: Record<string, unknown>) => x.session.request("POST", ["sessions", "sess-1", "answer"], Q, { dialog: "d1", digest: "a".repeat(64), answerId: "a".repeat(16), ...extra }, scope);
	x.w.answerable = true;
	let done = await answer({ choice: 0 });
	assert.deepEqual([done.status, (done.body as { error?: string }).error], [403, "local_only"], "hereOnly: the box's here is its own console");
	x.w.choices = [{ label: "Allow", hereOnly: true }];
	done = await answer({ cancel: true });
	assert.deepEqual([done.status, (done.body as { error?: string }).error], [403, "local_only"], "cancelling an all-hereOnly dialog is refused too");
	x.w.choices = [{ label: "Allow", hereOnly: true }, { label: "Deny" }, { label: "Open a pane", next: "pane" }, { label: "Put it in my prompt", next: "terminal" }];
	done = await answer({ choice: 0, value: "s3cret" });
	assert.deepEqual([done.status, (done.body as { error?: string }).error], [403, "local_only"], "a secret `value` from no page");
	assert.equal(x.w.sent, 0, "none of them reached the bridge");
	assert.equal((await answer({ choice: 1 })).status, 200, "Deny, a choice that is not hereOnly, may be given");
	assert.equal(x.w.sent, 1);
	done = await answer({ choice: 2, answerId: "b".repeat(16) });
	assert.deepEqual([done.status, (done.body as { error?: string; why?: string }).error, (done.body as { why?: string }).why], [403, "operate_refused", "route"], "an answer that opens a pane (it runs a shell) is not given");
	assert.equal(x.w.sent, 1, "and it did not reach the bridge");
	assert.equal((await answer({ choice: 3, answerId: "c".repeat(16) })).status, 200, "one that puts a command in the prompt is");
	assert.equal(x.w.sent, 2);
	x.w.relayed = true; // a link_request is open on the session
	const input = await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hello", as: "send" }, scope);
	assert.deepEqual([input.status, (input.body as { error?: string }).error], [403, "local_only"]);
	assert.deepEqual(x.typed(), [], "nothing typed while it waits on a link request");
});
