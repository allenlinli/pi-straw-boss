import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllyCard } from "../gui/linkmodel.ts";
import type { Base, Net, RemoteBox } from "../src/net.ts";

// The remote base's model (gui/boxmodel.ts; docs/specs/2026-11-07-link-operate.md §6.4 and §8): which page actions a base lets through (`box.can`, only while live), the order of the map (local bases, remote bases, then the ally cards the remote
// bases do not fold), the words an ended base gives, and the rows of "Earlier runs" read from a box's reply. Everything a box says is untrusted: a row is kept only when its key is the controller's own form.

const { can, arrange } = await import("../gui/boxmodel.ts"), { endedKind, runRows, safeKey } = await import("../gui/boxread.ts");

const CAN = ["history", "input", "keys", "answer", "dequeue", "commands", "upload", "mirror", "dismiss", "close-unit", "close-tab"];
const box = (over: Partial<RemoteBox> = {}): RemoteBox => ({ device: "dev1", short: "a1b2c3", label: "agent-tower-01", team: "moldplan", scope: "team", can: CAN, state: "live", ...over });
const base = (id: string, over: Partial<Base> = {}): Base => ({ id, label: id, mark: "idle", tower: null, tabs: [], outposts: [], outside: [], ...over });
const ally = (device: string, over: Partial<AllyCard> = {}): AllyCard => ({ id: `${device}/ws`, team: "t", teamName: "moldplan", teams: [{ team: "t", teamName: "moldplan" }], device, short: "a1b2c3", label: "agent-tower-01", online: true, unattended: true, workspace: "Work", tower: "idle", tabs: [], ...over }) as AllyCard;

test("a local base lets every action through; a remote base only what its box lists, and only while it is live", () => {
	assert.equal(can(base("w1"), "close-unit"), true);
	assert.equal(can(undefined, "close-unit"), true, "no base (a unit the net does not place) is the local rule");
	const live = base("x1", { box: box() });
	for (const a of ["close-unit", "close-tab", "dismiss", "input"] as const) assert.equal(can(live, a), true, a);
	assert.equal(can(live, "tower"), false, "the tower's actions need the box scope's `tower` entry");
	assert.equal(can(base("x2", { box: box({ scope: "box", can: [...CAN, "tower"] }) }), "tower"), true);
	assert.equal(can(base("x3", { box: box({ can: ["dismiss"] }) }), "close-unit"), false, "an entry the box does not list is hidden");
	assert.equal(can(base("x3", { box: box({ can: ["dismiss"] }) }), "dismiss"), true);
	assert.equal(can(base("x4", { box: box({ state: "unreachable", seen: 1 }) }), "dismiss"), false, "a base that cannot be reached takes no action");
	assert.equal(can(base("x4", { box: box({ state: "unreachable", seen: 1 }) }), "input"), false, "nor does its composer");
	assert.equal(can(base("x5", { box: box({ state: "ended", why: "policy", can: CAN }) }), "dismiss"), false, "an ended base takes none even if its list is full");
});

test("the map lists local bases first, then remote ones, each group in the net's order; a remote base's id is never a local one", () => {
	const net: Net = { bases: [base("x1", { box: box() }), base("w1"), base("x2", { box: box({ state: "unreachable", seen: 5 }) }), base("w2")] };
	assert.deepEqual(arrange(net, []).bases.map((b) => b.id), ["w1", "w2", "x1", "x2"]);
});

test("a live remote base takes its box's ally card in; with no live session (unreachable, ended, none) the card stays on the map", () => {
	const cards = [ally("dev1"), ally("dev2", { workspace: "Other" }), ally("dev3")];
	const net: Net = { bases: [base("w1"), base("x1", { box: box() }), base("x2", { box: box({ device: "dev3", state: "unreachable", seen: 1 }) })] };
	const out = arrange(net, cards);
	assert.deepEqual(out.loose.map((c) => c.device), ["dev2", "dev3"], "dev1 is folded; dev2 has no remote base; dev3's is greyed, so its card stays");
	assert.deepEqual(out.under.get("x1")?.map((c) => c.device), ["dev1"]);
	assert.equal(out.under.has("x2"), false);
});

test("two bases of one box: a card goes under the base named like its workspace, else under the first", () => {
	const cards = [ally("dev1", { workspace: "Second" }), ally("dev1", { id: "dev1/x", workspace: "Gone" })];
	const net: Net = { bases: [base("x1", { label: "First", box: box() }), base("x2", { label: "Second", box: box() })] };
	const out = arrange(net, cards);
	assert.deepEqual(out.under.get("x2")?.map((c) => c.workspace), ["Second"]);
	assert.deepEqual(out.under.get("x1")?.map((c) => c.workspace), ["Gone"]);
	assert.deepEqual(out.loose, []);
});

test("an ended base says why in one of three words: the grant withdrawn, the box refusing this device, or a plain end", () => {
	assert.equal(endedKind("policy"), "revoked");
	assert.equal(endedKind("roster"), "revoked");
	for (const w of ["not-granted", "not-admin", "out-of-scope", "local-only"]) assert.equal(endedKind(w), "refused", w);
	for (const w of ["other", "bad-key", "unsupported", "seen", "stopped", "nonsense", "<img src=x onerror=alert(1)>", ""]) assert.equal(endedKind(w), "other", w);
	assert.equal(endedKind(undefined), "other");
});

test("a key is the controller's form `x` and 16 hex, and nothing else reaches a route", () => {
	assert.equal(safeKey("x0123456789abcdef"), true);
	for (const k of ["", "x0123456789abcde", "X0123456789abcdef", "x0123456789abcdeg", "x0123456789abcdef0", "../x0123456789abcdef", "x0123456789abcdef/..", "t0123456789abcdef", 5, null, undefined, {}]) assert.equal(safeKey(k), false, String(k));
});

test("the rows of Earlier runs: the box's reply read defensively, newest first as sent, a bad row dropped, a name that is not text dropped with its row", () => {
	const row = (over: Record<string, unknown> = {}) => ({ key: "x0123456789abcdef", name: "api-fix", role: "main", workspace: "Work", first: 1000, last: 5000, size: 2048, ...over });
	const out = runRows({ rows: [row(), row({ key: "bad key" }), row({ key: "x1111111111111111", name: 5 }), row({ key: "x2222222222222222", dispatcher: "ci-box" }), null, "text"], before: "5000:x2222222222222222" });
	assert.deepEqual(out.rows.map((r) => r.key), ["x0123456789abcdef", "x2222222222222222"]);
	assert.equal(out.rows[1]!.dispatcher, "ci-box");
	assert.equal(out.rows[0]!.dispatcher, undefined);
	assert.equal(out.before, "5000:x2222222222222222");
	assert.deepEqual(runRows(null), { rows: [] });
	assert.deepEqual(runRows({ rows: "no" }), { rows: [] });
	assert.deepEqual(runRows({ rows: [row()], before: 7 }), { rows: [row()].map(({ key, name, role, workspace, first, last, size }) => ({ key, name, role, workspace, first, last, size })) }, "a cursor that is not text is none");
	assert.equal(runRows({ rows: Array.from({ length: 80 }, (_, i) => row({ key: `x${String(i).padStart(16, "0")}` })) }).rows.length, 50, "at most one page of the box's 50");
});

test("BR-F006: locate answers a unit of a merged base with the base as the session that shows the unit sees it", async () => {
	const { locate } = await import("../gui/scene.ts");
	const { can } = await import("../gui/boxmodel.ts");
	const u = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs: [] });
	const net = { bases: [{ id: "w", label: "Work", mark: "idle" as const, tower: null, outposts: [], outside: [], tabs: [{ id: "t", label: "t", units: [u("xa"), u("xb")] }], box: { device: "d", short: "s", label: "box", team: "A, B", scope: "box" as const, can: ["input", "tower"], state: "live" as const, units: { xb: { state: "unreachable" as const, scope: "team" as const, can: ["input"] } } } }] };
	assert.equal(can(locate(net, "xa")?.base, "input"), true);
	assert.equal(can(locate(net, "xb")?.base, "input"), false, "the unit's own session is unreachable");
	assert.equal(locate(net, "xb")?.base.box?.scope, "team");
	assert.equal(net.bases[0]!.box.state, "live", "the net itself is not changed");
});
