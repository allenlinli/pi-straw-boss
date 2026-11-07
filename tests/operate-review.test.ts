import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { createKeys } from "../src/keys.ts";
import type { Net } from "../src/net.ts";
import { plan, ROUTES } from "../src/operateroutes.ts";
import { sliceNet } from "../src/operateslice.ts";
import { lines, message, user } from "./sessions.ts";
import { scopeOf, unit, world } from "./operate-world.ts";

// The review round of todo #121 task 4 (docs/specs/2026-11-07-link-operate.md §6, §7): what each finding of the review (OR-F002 to OR-F012) asked to be true. OR-F001 and OR-F003 are in operate-input.test.ts, with the tests they changed.

const Q = new URLSearchParams(), scope = scopeOf(["sess-1"]);
const refusal = (r: { status: number; body: unknown }) => [r.status, (r.body as { error?: string }).error, (r.body as { why?: string }).why];

// The pad's own check, one session name per key so the rate (8 a second) never speaks.
const pad = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => undefined });
let n = 0;
const check = (key: string, operate: boolean) => pad.check(`s${n++}`, { key, stream: "s" }, true, operate) as { key?: string; status?: number; body?: { why?: string } };

test("OR-F002: under operate a chord is one of the editor's own; Ctrl+G and every other pi app action are refused with a reason", () => {
	for (const chord of ["ctrl+g", "ctrl+d", "ctrl+x", "ctrl+o", "ctrl+p", "ctrl+l", "ctrl+t", "ctrl+n", "ctrl+s", "ctrl+r", "ctrl+v", "ctrl+q", "ctrl+h", "ctrl+j", "ctrl+i", "alt+q", "alt+v", "alt+p", "alt+a", "alt+z", "alt+up"]) {
		const got = check(chord, true);
		assert.deepEqual([got.status, got.body?.why], chord === "alt+up" ? [400, undefined] : [403, "chord"], chord);
		assert.notEqual(check(chord, false).status, 403, `${chord}: a paired device's pad is as it was`);
	}
	for (const chord of ["ctrl+a", "ctrl+e", "ctrl+b", "ctrl+f", "ctrl+k", "ctrl+u", "ctrl+w", "ctrl+y", "ctrl+c", "alt+b", "alt+f", "alt+d", "alt+y", "alt+backspace", "alt+enter", "ctrl+left", "ctrl+right", "alt+left", "alt+right"]) assert.equal(check(chord, true).key, chord, chord);
});

test("OR-F002: through the seam, Ctrl+G is refused 403 and nothing reaches Herdr", async () => {
	const x = await world();
	await x.attach(scope);
	assert.deepEqual(refusal(await x.key(x.session, scope, "ctrl+g")), [403, "operate_refused", "chord"]);
	assert.deepEqual(x.typed(), []);
});

test("OR-F002: a second Ctrl+C within a second and a second Escape on an idle session leave pi's editor: refused for operate, whatever confirm comes along", async () => {
	const x = await world();
	await x.attach(scope);
	assert.equal((await x.key(x.session, scope, "ctrl+c")).status, 200, "the first one clears the editor");
	for (const confirmed of [undefined, "double-ctrl-c"]) assert.deepEqual(refusal(await x.key(x.session, scope, "ctrl+c", { confirmed })), [403, "operate_refused", "leaves-editor"]);
	assert.equal((await x.key(x.session, scope, "esc")).status, 200);
	for (const confirmed of [undefined, "double-esc"]) assert.deepEqual(refusal(await x.key(x.session, scope, "esc", { confirmed })), [403, "operate_refused", "leaves-editor"]);
	assert.deepEqual(x.typed().map(([, p]) => p.keys), [["ctrl+c"], ["esc"]], "one of each went");
});

test("OR-F002: keys, typed text and pastes go only while pi is the pane's program; another program in the foreground gets nothing", async () => {
	const x = await world();
	await x.attach(scope);
	x.w.agent = "nano"; // what Herdr reports after pi handed the terminal over
	for (const extra of [{ key: "up" }, { text: "hi" }, { paste: "hi" }]) {
		const done = await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", ...extra }, scope);
		assert.deepEqual([done.status, (done.body as { error?: string }).error], [409, "not_pi"], JSON.stringify(extra));
	}
	const input = await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hi", as: "send" }, scope);
	assert.deepEqual([input.status, (input.body as { error?: string }).error], [409, "not_pi"]);
	assert.deepEqual(x.typed(), []);
});

test("OR-F004: a watch ends when its unit leaves the scope, at rescope(); the other watch goes on", async () => {
	const x = await world(), narrow = scopeOf(["sess-1"]), wide = scopeOf(["sess-1", "other-1"]);
	await x.session.watch("a", "other-1", true, wide);
	await x.session.watch("b", "sess-1", true, wide);
	await x.wait(() => x.seen.some(([id, e]) => id === "a" && e === "history") && x.seen.some(([id]) => id === "b"));
	await x.session.rescope(narrow);
	const cut = x.seen.filter(([id]) => id === "a").length;
	assert.deepEqual(x.seen.filter(([id]) => id === "a").at(-1)![2], { key: "other-1", state: "unknown", reset: false, items: [] }, "told it ended");
	appendFileSync(x.path, lines([user("u2", "u1", "LATER-MARKER")])); // both keys name this one file
	await x.wait(() => x.seen.some(([id, , d]) => id === "b" && JSON.stringify(d).includes("LATER-MARKER")));
	assert.equal(x.seen.filter(([id]) => id === "a").length, cut, "no frame of the watch that left the scope");
});

test("OR-F004: a scope that narrows by itself (has() turns false) ends the watch at the server's next reading, with no rescope call", async () => {
	const x = await world(), allowed = new Set(["sess-1", "other-1"]), live = { box: false, has: (key: string) => allowed.has(key) };
	await x.session.watch("a", "other-1", true, live);
	await x.wait(() => x.seen.some(([id]) => id === "a"));
	allowed.delete("other-1");
	await x.wait(() => x.seen.some(([id, , d]) => id === "a" && (d as { state?: string }).state === "unknown"));
	const cut = x.seen.filter(([id]) => id === "a").length;
	appendFileSync(x.path, lines([user("u2", "u1", "AFTER-MARKER")]));
	await x.session.watch("b", "sess-1", true, scope);
	await x.wait(() => x.seen.some(([id, , d]) => id === "b" && JSON.stringify(d).includes("AFTER-MARKER")));
	assert.equal(x.seen.filter(([id]) => id === "a").length, cut);
});

test("OR-F004: a mirror ends when its unit leaves the scope: the pad has no live mirror then", async () => {
	const x = await world();
	await x.attach(scope);
	assert.equal((await x.key(x.session, scope, "up")).status, 200);
	await x.session.rescope(scopeOf(["other-1"])); // sess-1 is no longer this operator's
	const done = await x.key(x.session, scope, "up"); // asked through the old scope, to see the mirror alone
	assert.deepEqual([done.status, (done.body as { error?: string }).error], [409, "no_mirror"]);
});

test("OR-F009: a watch of a key out of scope is refused and never starts; a workspace watch shows in-scope units only", async () => {
	const x = await world();
	assert.deepEqual(refusal(await x.session.watch("w", "other-1", true, scope)), [403, "operate_refused", "out-of-scope"]);
	assert.equal((await x.session.watch("ws", "w:wA", true, scope)).status, 200);
	await x.wait(() => x.seen.some(([id, e]) => id === "ws" && e === "cards"));
	assert.deepEqual(Object.keys(x.seen.find(([id, e]) => id === "ws" && e === "cards")![2] as object), ["sess-1"], "other-1's card is another team's");
	assert.equal(x.seen.some(([id]) => id === "w"), false);
});

test("OR-F009: an upload over 2 MB is refused 413; one of 2 MB goes", async () => {
	const x = await world();
	const up = (size: number) => x.session.request("POST", ["sessions", "sess-1", "upload"], new URLSearchParams({ name: "a.txt" }), Buffer.alloc(size, 97), scope);
	assert.equal((await up(2 * 1024 * 1024 + 1)).status, 413);
	assert.equal((await up(2 * 1024 * 1024)).status, 200);
});

test("OR-F009: what a request reads goes through the scope again (`scoped().lookup`): a scope that stops holding the key after the table's check reads nothing", async () => {
	const x = await world();
	let asked = 0;
	const flipping = { box: false, has: (key: string) => key === "sess-1" && ++asked === 1 }; // the table's check (the first) passes, the registry's own look does not
	const done = await x.session.request("GET", ["history", "sess-1"], Q, {}, flipping);
	assert.equal(done.status, 404);
	assert.equal(JSON.stringify(done.body).includes("u1"), false, "and says nothing of the entries");
});

const BIG = "A".repeat(1_500_000); // 1.1 MB once decoded
const pic = (data: string) => message("u2", "u1", { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data, mimeType: "image/png" }], timestamp: 1 });
test("OR-F007: an image over 1 MB is refused 413 on the box, a small one is sent; an entry over 1 MB comes without its images, marked `picsCut`", async () => {
	const x = await world({ entries: [pic(BIG)] }), y = await world({ entries: [pic("AAAA")] });
	assert.equal((await x.session.request("GET", ["image", "sess-1", "u2", "0"], Q, {}, scope)).status, 413);
	const cut = await x.session.request("GET", ["entry", "sess-1", "u2"], Q, {}, scope), body = cut.body as { pics?: unknown; picsCut?: boolean; text?: string };
	assert.deepEqual([cut.status, body.pics, body.picsCut, body.text], [200, undefined, true, "see"]);
	const small = await y.session.request("GET", ["image", "sess-1", "u2", "0"], Q, {}, scope);
	assert.deepEqual([small.status, (small.body as { base64: string }).base64], [200, "AAAA"]);
	const entry = (await y.session.request("GET", ["entry", "sess-1", "u2"], Q, {}, scope)).body as { pics?: string[]; picsCut?: boolean };
	assert.deepEqual([entry.pics, entry.picsCut], [["data:image/png;base64,AAAA"], undefined]);
});

test("OR-F008: close/tab quits a squad only when every pane Herdr shows in the tab is a unit of the scope; a stranger pane (a shell, a pane an answer opened) refuses it", async () => {
	const x = await world();
	x.w.strangers.push({ pane_id: "wA:p9", tab_id: "t1" });
	assert.deepEqual([(await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope)).status, x.effects], [403, []]);
	x.w.strangers.length = 0;
	x.w.strangers.push({ pane_id: "wA:p9", tab_id: "t2" }); // another tab's pane is not this squad's
	assert.equal((await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope)).status, 200);
	assert.deepEqual(x.effects, [["close", "tab", { workspace: "wA", tab: "t1" }]]);
});

test("OR-F010: a body that is null, an array or a scalar is a bad request, not a crash; a Buffer body is the upload's", async () => {
	const x = await world();
	for (const body of [null, [], [1], "x", 5] as never[]) {
		for (const [method, parts] of [["POST", ["sessions", "sess-1", "input"]], ["POST", ["dismiss"]], ["GET", ["history", "sess-1"]]] as const) assert.equal((await x.session.request(method, [...parts], Q, body, scope)).status, 400, `${method} ${parts.join("/")} ${JSON.stringify(body)}`);
	}
	assert.equal(plan("POST", ["sessions", "k", "upload"], Buffer.from("x"), scopeOf(["k"])).ok, true);
	assert.deepEqual(x.calls, []);
});

test("OR-F012: a head or tower unit under sessions/* is refused by plan itself: the head always, a tower without the box part", () => {
	const roles = (key: string) => ({ h: "head", t: "tower", m: "main" })[key];
	const all = scopeOf(["h", "t", "m"]), box = scopeOf(["h", "t", "m"], true);
	for (const action of ["input", "keys", "answer", "dequeue", "commands", "upload", "mirror"]) {
		const via = action === "mirror" ? "mirror" : "request", body = action === "upload" ? Buffer.from("x") : {};
		assert.equal((plan("POST", ["sessions", "h", action], body, box, via, roles) as { why?: string }).why, "route", `head ${action}`);
		assert.equal((plan("POST", ["sessions", "t", action], body, all, via, roles) as { why?: string }).why, "out-of-scope", `tower ${action}`);
		assert.equal(plan("POST", ["sessions", "t", action], body, box, via, roles).ok, true, `tower ${action} with the box part`);
		assert.equal(plan("POST", ["sessions", "m", action], body, all, via, roles).ok, true, `main ${action}`);
	}
});

test("OR-F012: through the seam, sessions/<head key> and sessions/<tower key> are refused before anything is called", async () => {
	const x = await world();
	assert.deepEqual(refusal(await x.session.request("POST", ["sessions", "head-1", "input"], Q, { text: "hi", as: "send" }, scopeOf(["head-1"], true))), [403, "operate_refused", "route"]);
	assert.deepEqual(refusal(await x.session.request("POST", ["sessions", "tower-1", "input"], Q, { text: "hi", as: "send" }, scopeOf(["tower-1"]))), [403, "operate_refused", "out-of-scope"]);
	assert.deepEqual([x.calls, x.effects], [[], []]);
});

// The slice.
const doc = { cap: "SECRET-CAP", display: "plan.md", kind: "text" as const, reason: "the plan", revision: 2, onScreen: true };
const net = (over: Record<string, unknown> = {}): Net => ({
	bases: [{
		id: "w1", label: "work", mark: "waiting", tower: { name: "tower", mark: "waiting", key: "tw", control: true, subs: [], service: { state: "standing", queued: 0, allyRuns: [{ id: "r1", device: "d", label: "mine", startedAt: "t", key: "ally-r1" }, { id: "r2", device: "d", label: "theirs", startedAt: "t", key: "ally-r2" }], notices: [{ id: "n", level: "info", kind: "k", text: "box only", at: 1 }], parked: [{ id: "p", kind: "k", first: "t" }] } },
		tabs: [{ id: "t1", label: "a", units: [unit("a-1", { docs: [doc], docsCut: true })] }], outposts: [], outside: [unit("out", { role: "outside", mark: "waiting" })], ...over,
	}],
});
test("OR-F005: a base's mark is always recomputed from what is left: an outside unit or a tower of another scope that waits does not show through", () => {
	assert.equal(sliceNet(net(), scopeOf(["a-1"])).bases[0]!.mark, "idle", "the net's own mark and the tower's wait stay behind");
	assert.equal(sliceNet(net(), scopeOf(["a-1", "out"])).bases[0]!.mark, "waiting", "the outside unit is this scope's and waits");
	assert.equal(sliceNet(net({ tabs: [{ id: "t1", label: "a", units: [unit("a-1", { mark: "working" })] }] }), scopeOf(["a-1"])).bases[0]!.mark, "working");
});

test("OR-F006: a unit's shelf keeps the document names and `docsCut` and loses every capability: the `cap` field never crosses", () => {
	const out = sliceNet(net(), scopeOf(["a-1"])), a1 = out.bases[0]!.tabs[0]!.units[0]!;
	assert.deepEqual(a1.docs, [{ display: "plan.md", kind: "text", reason: "the plan", revision: 2, onScreen: true }]);
	assert.equal(a1.docsCut, true);
	assert.equal(JSON.stringify(out).includes("SECRET-CAP"), false);
	assert.equal(JSON.stringify(out).includes('"cap"'), false);
	const withTower = sliceNet({ bases: [{ ...net().bases[0]!, tower: { ...net().bases[0]!.tower!, docs: [doc] } }] }, scopeOf(["tw"], true));
	assert.deepEqual(withTower.bases[0]!.tower!.docs, [{ display: "plan.md", kind: "text", reason: "the plan", revision: 2, onScreen: true }]);
});

test("OR-F011: a team scope sees its own live ally runs on a stub tower that holds nothing else of the tower; another team's runs and the tower's notices stay behind", () => {
	const out = sliceNet(net(), scopeOf(["a-1", "ally-r1"])), tower = out.bases[0]!.tower!;
	assert.deepEqual(tower.service, { state: "standing", queued: 0, allyRuns: [{ id: "r1", device: "d", label: "mine", startedAt: "t", key: "ally-r1" }], notices: [], parked: [] });
	assert.deepEqual([tower.control, tower.subs, tower.mark], [false, [], "idle"]);
	assert.equal(sliceNet(net(), scopeOf(["a-1"])).bases[0]!.tower, null, "no run of its own, no tower");
	assert.equal(sliceNet(net(), scopeOf(["ally-r1"])).bases.length, 1, "a base is shown for the run alone");
});

test("the table has explicit head and tower rows, not only the default", () => {
	assert.ok(ROUTES.some((r) => r.path === "head/**" && r.cross === "refused"));
	assert.ok(ROUTES.some((r) => r.path.startsWith("tower/") && r.box));
});
