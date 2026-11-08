import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloser } from "../src/closer.ts";
import type { Session } from "../src/herdr.ts";

// The close buttons: every agent of a squad or base is asked to quit first, and the tab or workspace closes only once they all did.

const PANES = [
	{ pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", tokens: { sb_role: "main" } },
	{ pane_id: "wA:p2", tab_id: "wA:t1", workspace_id: "wA", tokens: { sb_role: "subagent" } },
	{ pane_id: "wA:p3", tab_id: "wA:t2", workspace_id: "wA", tokens: { sb_role: "member" } },
	{ pane_id: "wA:p7", tab_id: "wA:t7", workspace_id: "wA", tokens: { sb_role: "tower" } },
];
/** Lets every pending microtask run: the fakes below wait on no timer, so once this returns a close's background work has done all it can. */
const flush = () => new Promise<void>((done) => setImmediate(done));
const at = (id: string, paneId: string): Session => ({ id, herdrLocation: { paneId } as Session["herdrLocation"] });

/** `late`: sessions that accept the close and leave the broker's list only after the third wait, as a pi does that quits a second after it answered. `listed` says, for each forgotten session, whether the broker still listed it at that moment. */
function setup({ refuse = [] as string[], linger = [] as string[], late = [] as string[] } = {}) {
	let live = [at("a", "wA:p1"), at("kid", "wA:p2"), at("b", "wA:p3"), at("tower", "wA:p7"), at("gui", "wB:p1")], slept = 0;
	const asked: [string, boolean][] = [], ran: string[][] = [], forgot: string[] = [], listed: boolean[] = [], noted: [string, Record<string, unknown>][] = [];
	const close = createCloser({
		note: (event, facts) => void noted.push([event, facts ?? {}]),
		forget: (session) => void (forgot.push(session), listed.push(live.some((s) => s.id === session))),
		run: async (args) => (ran.push(args), args[0] === "pane" ? JSON.stringify({ result: { panes: PANES } }) : "{}"),
		sleep: async () => void (++slept >= 3 && (live = live.filter((s) => !late.includes(s.id)))),
		me: () => "gui",
		sessions: async () => live,
		ask: async (key, keepPane) => {
			asked.push([key, keepPane]);
			if (refuse.includes(key)) return { accepted: false, reason: "busy" };
			if (!linger.includes(key) && !late.includes(key)) live = live.filter((s) => s.id !== key);
			return { accepted: true };
		},
	});
	return { close, asked, ran, forgot, listed, noted, closes: () => ran.filter((a) => a[1] === "close") };
}

test("closing a squad quits its agents, keeping their panes, then closes the tab; its subagent goes with the tab", async () => {
	const s = setup();
	const r = await s.close("tab", { workspace: "wA", tab: "wA:t1" });
	assert.equal(r.status, 200);
	assert.deepEqual(s.asked, [["a", true]]);
	assert.deepEqual(s.closes(), [["tab", "close", "wA:t1"]]);
});

test("closing a base quits every agent and its tower, then closes the workspace", async () => {
	const s = setup();
	assert.equal((await s.close("base", { workspace: "wA" })).status, 200);
	assert.deepEqual(s.asked.map(([k]) => k).sort(), ["a", "b", "tower"]);
	assert.deepEqual(s.closes(), [["workspace", "close", "wA"]]);
});

test("one refusal closes nothing and names who refused", async () => {
	const s = setup({ refuse: ["b"] });
	const r = await s.close("base", { workspace: "wA" });
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Nothing was closed: .*busy/);
	assert.deepEqual(s.closes(), []);
});

test("an agent still running after the wait keeps the squad open", async () => {
	const s = setup({ linger: ["a"] });
	const r = await s.close("tab", { workspace: "wA", tab: "wA:t1" });
	assert.equal(r.status, 504);
	assert.deepEqual(s.closes(), []);
});

test("a closer without a stash check stashes nothing", async () => {
	assert.equal((await setup().close("stash", { workspace: "wA", name: "A" })).status, 404);
});

test("one unit closes its own pane; a bad request is refused", async () => {
	const s = setup();
	assert.equal((await s.close("unit", { key: "b" })).status, 200);
	assert.deepEqual(s.asked, [["b", false]]);
	assert.equal((await s.close("unit", {})).status, 400);
	assert.equal((await s.close("tab", { workspace: "wA" })).status, 400);
	assert.equal((await s.close("nope", {})).status, 404);
});

// The route of a main an ally run opened for a device goes with the main (allyroute.ts `dropOpened`): the closer tells its owner which sessions ended, once they did, and a close that did not happen tells it nothing.
test("a unit that accepts the close is forgotten by its session id; a refusal forgets nothing", async () => {
	const s = setup({ refuse: ["b"] });
	assert.equal((await s.close("unit", { key: "a" })).status, 200);
	assert.equal((await s.close("unit", { key: "b" })).status, 409);
	await flush();
	assert.deepEqual(s.forgot, ["a"]);
});

// OT-F002: a unit's close is accepted before the main has quit (closing.ts schedules the quit after the answer), so the route goes when the broker no longer lists the main, as a batch waits for the exit.
// OT2-F002: the reply does not wait for that: the operate relay gives up after 20 s and the exit wait is up to 30 s, so the wait and the forget run on after the reply.
test("a unit is forgotten once the broker no longer lists it, after the reply, not on acceptance; one that stays listed is not forgotten and the log says so", async () => {
	const s = setup({ late: ["a"] });
	assert.equal((await s.close("unit", { key: "a" })).status, 200);
	await flush();
	assert.deepEqual([s.forgot, s.listed], [["a"], [false]], "forgotten after it left the list");
	const stuck = setup({ linger: ["a"] });
	assert.equal((await stuck.close("unit", { key: "a" })).status, 200, "the close was accepted all the same");
	await flush();
	assert.deepEqual(stuck.forgot, [], "a main that still runs keeps its route");
	assert.deepEqual(stuck.noted, [["close-unit-listed", { session: "a", waitedMs: 30_000 }]]);
});

test("the reply to a unit's close comes while the main is still listed; the route goes when it has left", async () => {
	let live = [at("a", "wA:p1"), at("gui", "wB:p1")], wake!: () => void;
	const waiting = new Promise<void>((done) => (wake = done)), forgot: string[] = [], listed: boolean[] = [];
	const close = createCloser({ run: async () => "{}", sleep: () => waiting, me: () => "gui", sessions: async () => live, ask: async () => ({ accepted: true }), forget: (session) => void (forgot.push(session), listed.push(live.some((s) => s.id === session))) });
	const reply = close("unit", { key: "a" });
	const first = await Promise.race([reply, flush().then(() => "held")]);
	assert.equal(typeof first === "object" && first.status, 200, "the reply is not held for the exit");
	assert.deepEqual(forgot, [], "the main is still listed, so nothing is forgotten yet");
	live = [at("gui", "wB:p1")];
	wake();
	await flush();
	assert.deepEqual([forgot, listed], [["a"], [false]], "the route goes after the exit");
});

test("a read of the broker's list that fails after the close was accepted, or a forget that throws, is logged and does not reach the reply", async () => {
	const noted: [string, Record<string, unknown>][] = [], forgot: string[] = [];
	const deps = { run: async () => "{}", sleep: async () => {}, me: () => "gui", ask: async () => ({ accepted: true }), note: (event: string, facts?: Record<string, unknown>) => void noted.push([event, facts ?? {}]) };
	const unreadable = createCloser({ ...deps, sessions: async () => { throw new Error("the broker did not answer"); }, forget: (session) => void forgot.push(session) });
	assert.equal((await unreadable("unit", { key: "a" })).status, 200);
	await flush();
	const throwing = createCloser({ ...deps, sessions: async () => [], forget: () => { throw new Error("the route file is read-only"); } });
	assert.equal((await throwing("unit", { key: "a" })).status, 200);
	await flush();
	assert.deepEqual(forgot, []);
	assert.deepEqual(noted, [["close-unit-forget-failed", { session: "a", error: "the broker did not answer" }], ["close-unit-forget-failed", { session: "a", error: "the route file is read-only" }]]);
});

test("a squad or base that closed forgets every session it quit, and one that stayed open forgets none", async () => {
	const squad = setup();
	assert.equal((await squad.close("tab", { workspace: "wA", tab: "wA:t1" })).status, 200);
	assert.deepEqual(squad.forgot, ["a"]);
	const base = setup();
	assert.equal((await base.close("base", { workspace: "wA" })).status, 200);
	assert.deepEqual(base.forgot.sort(), ["a", "b", "tower"]);
	const refused = setup({ refuse: ["b"] });
	assert.equal((await refused.close("base", { workspace: "wA" })).status, 409);
	const slow = setup({ linger: ["a"] });
	assert.equal((await slow.close("tab", { workspace: "wA", tab: "wA:t1" })).status, 504);
	assert.deepEqual([refused.forgot, slow.forgot], [[], []]);
});

// The sb server's own tower (docs/specs/2026-10-26-sb-backend.md, The tower service) is an intercom identity standing in the base's tower pane, with no pi and no bridge: nothing can be asked to quit, and its close is the service's end.
function service({ refuse = false } = {}) {
	const ran: string[][] = [], asked: string[] = [], ended: string[] = [];
	let live = [at("a", "wA:p1"), at("sb-tower-wa", "wA:p7"), at("gui", "wB:p1")];
	const close = createCloser({
		run: async (args) => (ran.push(args), args[0] === "pane" ? JSON.stringify({ result: { panes: PANES } }) : "{}"),
		sleep: async () => {},
		me: () => "gui",
		sessions: async () => live,
		ask: async (key) => (asked.push(key), key === "sb-tower-wa" ? undefined : ((live = live.filter((s) => s.id !== key)), { accepted: true })),
		tower: { of: (key) => (key === "sb-tower-wa" ? "wA" : undefined), owns: (id) => id === "sb-tower-wa", has: () => false, end: async (workspace) => (ended.push(workspace), refuse ? { ok: false, error: "no such tower" } : { ok: true }) },
	});
	return { close, ran, asked, ended };
}

test("Quit tower on the server's tower ends its service and asks no bridge; a refusal is the server's words", async () => {
	const s = service();
	const r = await s.close("unit", { key: "sb-tower-wa" });
	assert.deepEqual([r.status, r.body], [200, { closing: true }]);
	assert.deepEqual([s.ended, s.asked], [["wA"], []]);
	const refused = service({ refuse: true });
	const no = await refused.close("unit", { key: "sb-tower-wa" });
	assert.equal(no.status, 409);
	assert.equal((no.body as { reason: string }).reason, "no such tower");
	// Any other unit still quits through its own bridge.
	const other = service();
	assert.equal((await other.close("unit", { key: "a" })).status, 200);
	assert.deepEqual([other.ended, other.asked], [[], ["a"]]);
});

test("closing a base or a squad whose tower is the server's asks only the agents with a bridge: the service identity stays out of the batch, and the workspace closes", async () => {
	const base = service();
	const r = await base.close("base", { workspace: "wA" });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(base.asked, ["a"]);
	assert.deepEqual(base.ran.filter((a) => a[1] === "close"), [["workspace", "close", "wA"]]);
	const squad = service();
	assert.equal((await squad.close("tab", { workspace: "wA", tab: "wA:t7" })).status, 200);
	assert.deepEqual(squad.asked, []);
	assert.deepEqual(squad.ran.filter((a) => a[1] === "close"), [["tab", "close", "wA:t7"]]);
});
