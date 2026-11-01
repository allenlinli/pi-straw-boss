import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_MS, createGrants, MAX_GRANTS } from "../src/answerpane.ts";
import { HerdrError } from "../src/herdr.ts";

/** A fake Herdr with a tab of panes the test grows and shrinks; `sleep` moves a clock the test owns. */
function world() {
	const w = { tab: ["p1"] as string[], terminals: new Map<string, string>([["p1", "t1"]]), t: 0, fails: false, agent: new Map<string, string>([["p1", "pi"]]), roles: new Map<string, string>(), tags: new Map<string, string>(), calls: [] as string[], onSleep: [] as (() => void)[] };
	const call = async (method: string, params: Record<string, unknown>) => {
		w.calls.push(`${method} ${params.pane_id}`);
		if (w.fails) throw new HerdrError("socket_error", "down");
		const id = String(params.pane_id);
		if (method === "pane.layout") return { layout: { panes: w.tab.map((pane_id) => ({ pane_id, rect: { width: 40 } })) } };
		if (method === "pane.get") {
			if (!w.tab.includes(id)) throw new HerdrError("pane_not_found", "no such pane");
			return { pane: { pane_id: id, agent: w.agent.get(id), ...(w.roles.has(id) || w.tags.has(id) ? { tokens: { ...(w.roles.has(id) ? { sb_role: w.roles.get(id)! } : {}), ...(w.tags.has(id) ? { sb_answer: w.tags.get(id)! } : {}) } } : {}), terminal_id: w.terminals.get(id) } };
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

test("F001: a grant never reaches a pi pane, a tower, or a pane that starts running pi later", async () => {
	const rejected = (e: { status?: number; body?: { error?: string } }) => e.status === 409 && e.body?.error === "pane_closed";
	// A subagent pane whose pi Herdr has not detected yet is granted (nothing tells it apart), and the grant ends the moment the agent shows.
	const sub = world();
	const b1 = (await sub.g.before("p1"))!;
	sub.w.tab.push("p2");
	const granted = (await sub.g.claim("s", "p1", b1))!;
	assert.equal((await sub.g.live(granted)).pane_id, "p2");
	sub.w.agent.set("p2", "pi");
	await assert.rejects(sub.g.live(granted), rejected);
	assert.equal(sub.g.get(granted.id), undefined, "the grant is gone, not just refused once");
	// A tower pane (sb_role token, no agent yet) is not claimed.
	const tower = world();
	const b2 = (await tower.g.before("p1"))!;
	tower.w.tab.push("p2");
	tower.w.roles.set("p2", "tower");
	assert.equal(await tower.g.claim("s", "p1", b2), undefined, "a pane with sb_role is never what an answer opened");
	// A granted shell pane that later runs pi, or later carries sb_role, ends the grant.
	for (const turn of [(w: ReturnType<typeof world>["w"]) => w.agent.set("p2", "claude"), (w: ReturnType<typeof world>["w"]) => w.roles.set("p2", "member")]) {
		const later = world();
		const b3 = (await later.g.before("p1"))!;
		later.w.tab.push("p2");
		const grant = (await later.g.claim("s", "p1", b3))!;
		turn(later.w);
		await assert.rejects(later.g.live(grant), rejected);
		assert.equal(later.g.get(grant.id), undefined);
	}
});

test("ATR2-F001: an owner that tags its pane (sb_answer = the answerId) is granted that pane and no other, whatever else appears in the tab and however new it is", async () => {
	const ID = "answer-id-0123456789";
	// Two new panes, one tagged: the tag decides, not the count or the order.
	const two = world();
	const b1 = (await two.g.before("p1"))!;
	two.w.tab.push("p2", "p3");
	two.w.tags.set("p3", ID);
	assert.equal((await two.g.claim("s", "p1", b1, ID))?.pane, "p3", "the untagged p2 is ignored");
	// The tag arrives after the pane (a split first, then the report).
	const late = world();
	const b2 = (await late.g.before("p1"))!;
	late.w.tab.push("p2");
	late.w.onSleep.push(() => void 0, () => late.w.tags.set("p2", ID));
	assert.equal((await late.g.claim("s", "p1", b2, ID))?.pane, "p2");
	// One new pane without the tag, or with another answer's: nothing is granted, and the timing fallback is not used.
	for (const tag of [undefined, "another-answer-0123456"]) {
		const w = world();
		const b = (await w.g.before("p1"))!;
		w.w.tab.push("p2");
		if (tag) w.w.tags.set("p2", tag);
		assert.equal(await w.g.claim("s", "p1", b, ID), undefined, `tag ${tag ?? "none"}`);
		assert.ok(w.w.t >= CLAIM_MS - 250, "it waited the window out");
	}
	// Two panes carrying the value are ambiguous; a tagged pane that runs an agent or carries sb_role is not granted; a tag on a pane that was there before the answer is not either.
	const dup = world();
	const b3 = (await dup.g.before("p1"))!;
	dup.w.tab.push("p2", "p3");
	dup.w.tags.set("p2", ID).set("p3", ID);
	assert.equal(await dup.g.claim("s", "p1", b3, ID), undefined);
	assert.ok(dup.w.t < CLAIM_MS, "and it says so at once, not after the window");
	for (const turn of [(w: ReturnType<typeof world>["w"]) => w.agent.set("p2", "pi"), (w: ReturnType<typeof world>["w"]) => w.roles.set("p2", "tower")]) {
		const w = world();
		const b = (await w.g.before("p1"))!;
		w.w.tab.push("p2");
		w.w.tags.set("p2", ID);
		turn(w.w);
		assert.equal(await w.g.claim("s", "p1", b, ID), undefined);
	}
	const old = world();
	old.w.tab.push("p2");
	old.w.tags.set("p2", ID);
	assert.equal(await old.g.claim("s", "p1", (await old.g.before("p1"))!, ID), undefined, "p2 was in the tab before the answer went out");
	// An owner that does not tag keeps the timing claim.
	const plain = world();
	const b4 = (await plain.g.before("p1"))!;
	plain.w.tab.push("p2");
	assert.equal((await plain.g.claim("s", "p1", b4))?.pane, "p2");
});
