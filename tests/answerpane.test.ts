import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_MS, createGrants, MAX_GRANTS } from "../src/answerpane.ts";
import { HerdrError } from "../src/herdr.ts";

/** A fake Herdr with a tab of panes the test grows and shrinks; `sleep` moves a clock the test owns. */
function world() {
	const w = { tab: ["p1"] as string[], terminals: new Map<string, string>([["p1", "t1"]]), t: 0, fails: false, agent: new Map<string, string>([["p1", "pi"]]), calls: [] as string[], onSleep: [] as (() => void)[] };
	const call = async (method: string, params: Record<string, unknown>) => {
		w.calls.push(`${method} ${params.pane_id}`);
		if (w.fails) throw new HerdrError("socket_error", "down");
		const id = String(params.pane_id);
		if (method === "pane.layout") return { layout: { panes: w.tab.map((pane_id) => ({ pane_id, rect: { width: 40 } })) } };
		if (method === "pane.get") {
			if (!w.tab.includes(id)) throw new HerdrError("pane_not_found", "no such pane");
			return { pane: { pane_id: id, agent: w.agent.get(id), terminal_id: w.terminals.get(id) } };
		}
		throw new Error(`unexpected ${method}`);
	};
	const sleep = async (ms: number) => void ((w.t += ms), w.onSleep.shift()?.());
	const g = createGrants({ call: call as never, now: () => w.t, sleep, id: (() => { let n = 0; return () => `g${++n}`; })() });
	return { w, g };
}

test("a pane that appears after the answer is granted: the tab's panes are noted first, the new one (not pi) is found within the window, and it keeps its terminal id", async () => {
	const { w, g } = world();
	const before = await g.before("p1");
	assert.deepEqual([...before!], ["p1"]);
	w.onSleep.push(() => void 0, () => (w.tab.push("p2"), w.terminals.set("p2", "t2")));
	const grant = await g.claim("sess", "p1", before!);
	assert.deepEqual(grant && { id: grant.id, session: grant.session, pane: grant.pane, terminal: grant.terminal }, { id: "g1", session: "sess", pane: "p2", terminal: "t2" });
	assert.equal(g.get("g1")?.pane, "p2");
	assert.equal(g.get("nope"), undefined);
	assert.ok(w.t < CLAIM_MS, "found before the window ended");
});

test("no new pane within the window, or two at once, or a new pane that runs pi, is no grant: nothing is guessed", async () => {
	const none = world();
	assert.equal(await none.g.claim("s", "p1", (await none.g.before("p1"))!), undefined);
	assert.ok(none.w.t >= CLAIM_MS - 250, "it waited the window out");
	const two = world();
	const b2 = (await two.g.before("p1"))!;
	two.w.tab.push("p2", "p3");
	assert.equal(await two.g.claim("s", "p1", b2), undefined, "two new panes are ambiguous");
	const pi = world();
	const b3 = (await pi.g.before("p1"))!;
	pi.w.tab.push("p2");
	pi.w.agent.set("p2", "pi");
	assert.equal(await pi.g.claim("s", "p1", b3), undefined, "a pi session is not a pane the answer opened");
	const down = world();
	down.w.fails = true;
	assert.equal(await down.g.before("p1"), undefined, "a layout that cannot be read: no snapshot, no claim");
});

test("live: the pane must still be there with its terminal; a gone pane or another terminal under the same id drops the grant", async () => {
	const { w, g } = world();
	const b = (await g.before("p1"))!;
	w.tab.push("p2");
	w.terminals.set("p2", "t2");
	const grant = (await g.claim("s", "p1", b))!;
	assert.equal((await g.live(grant)).pane_id, "p2");
	w.terminals.set("p2", "t9");
	await assert.rejects(g.live(grant), (e: { status?: number; body?: { error?: string } }) => e.status === 409 && e.body?.error === "pane_closed");
	assert.equal(g.get(grant.id), undefined);
	const again = world();
	const b2 = (await again.g.before("p1"))!;
	again.w.tab.push("p2");
	const gr = (await again.g.claim("s", "p1", b2))!;
	again.w.tab = ["p1"];
	await assert.rejects(again.g.live(gr), (e: { body?: { error?: string } }) => e.body?.error === "pane_closed");
	assert.equal(again.g.get(gr.id), undefined);
});

test("grants are capped and expire", async () => {
	const { w, g } = world();
	for (let i = 0; i < MAX_GRANTS + 2; i++) {
		const b = (await g.before("p1"))!;
		w.tab = ["p1", `q${i}`];
		await g.claim("s", "p1", b);
	}
	assert.equal(g.get("g1"), undefined, "the oldest went");
	assert.equal(g.get(`g${MAX_GRANTS + 2}`)?.pane, `q${MAX_GRANTS + 1}`);
	w.t += 7 * 3600_000;
	assert.equal(g.get(`g${MAX_GRANTS + 2}`), undefined, "after 6 h");
});
