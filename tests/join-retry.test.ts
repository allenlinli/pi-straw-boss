import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { settle, until, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const FAST = { joinRetryMs: [40] }; // longer than the 20 ms of calm that world.quiet() waits for, so a start returns while retries are pending
const SLOW = { joinRetryMs: [600_000] };
const asked = (what: string) => world.herdr.calls.filter((c) => c.join(" ").startsWith(what)).length;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes Herdr's answer to `what` (a command's leading words) fail while `down.on` is set, and counts the failures. */
function flaky(what: string) {
	const down = { on: true, failures: 0 };
	const runFor = world.herdr.runFor.bind(world.herdr);
	world.herdr.runFor = (self: string) => async (args: string[]) => {
		if (down.on && args.join(" ").startsWith(what)) {
			down.failures++;
			throw new Error(`herdr ${what} failed: timed out`);
		}
		return runFor(self)(args);
	};
	return down;
}
const joined = (a: { tokens: Record<string, string>; tools: Map<string, unknown> }) => a.tokens.sb_role === "member" && a.tools.has("boss_promote");
const said = (a: { notices: { text: string; level?: string }[] }, re: RegExp) => a.notices.filter((n) => re.test(n.text));

test("a Herdr that is slow to say where the session runs does not bar it: the check is asked again and the session joins once", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	await until(() => down.failures >= 1, "the first failed check");
	assert.deepEqual([...a.tools.keys()], [], "nothing joined yet");
	await until(() => down.failures >= 3, "two retries that fail too");
	down.on = false;
	await until(() => joined(a), "the join once Herdr answers");
	await world.quiet();
	assert.equal(world.broker.registrations.length, 1, "one join, not two");
	assert.equal(said(a, /could not tell whether this is a sub workspace/).length, 1, "one warning for the first failure, none for the retries");
	assert.equal(said(a, /could not tell/)[0]!.level, "warning");
	assert.equal(a.notices.some((n) => n.level === "error"), false, JSON.stringify(a.notices));
	assert.equal(said(a, /joined the net/).length, 1, "one line when it joined after retries");
	assert.equal(said(a, /joined the net/)[0]!.level, "info");
});

test("a Herdr that answers 'sub workspace' bars for good: the check is not asked again", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/af", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const a = world.agent({ id: "s", pane: "wS:p1", deps: FAST });
	await a.start();
	const before = asked("workspace list");
	await wait(150);
	assert.equal(asked("workspace list"), before, "no retry after a definitive answer");
	assert.deepEqual([[...a.tools.keys()], world.broker.registrations, said(a, /sub workspace/).length], [[], [], 1]);
});

test("a session still unplaced joins when the boss uses it: /boss and a subagent call ask Herdr again at once", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: SLOW });
	await a.start();
	assert.equal(down.failures, 1);
	await a.command(); // Herdr is still down: the answer is the reason, not a join
	assert.equal(down.failures, 2, "/boss asked again");
	assert.deepEqual([...a.tools.keys()], []);
	down.on = false;
	await a.toolCall("subagent"); // the call asks again, then joins and promotes
	await world.quiet();
	assert.equal(a.tokens.sb_role, "main");
	assert.equal(world.broker.registrations.length, 1, "one join");

	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", deps: SLOW });
	down.on = true;
	await b.start();
	down.on = false;
	await b.command(); // /boss joins, then takes the tab as its main
	await until(() => b.tokens.sb_role === "main", "/boss joins after Herdr answered");
	assert.equal(world.broker.registrations.filter((r) => r.id === "b").length, 1);
});

test("a join whose own look at the pane fails, before any channel exists, is retried by a timer: no event would come", async () => {
	const runFor = world.herdr.runFor.bind(world.herdr);
	let armed = false, failed = 0;
	world.herdr.runFor = (self: string) => async (args: string[]) => {
		const line = args.join(" ");
		if (line.startsWith("workspace list")) armed = true;
		if (armed && failed < 2 && line.startsWith("pane current")) {
			failed++;
			throw new Error("herdr pane current failed: timed out");
		}
		return runFor(self)(args);
	};
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	await until(() => joined(a), "the join by timer");
	assert.equal(failed, 2);
	assert.equal(world.broker.registrations.length, 1);
	assert.equal(said(a, /joined the net/).length, 1);
	assert.equal(a.notices.filter((n) => n.level === "error").length, 1, "the first failure is told once, the retries are quiet");
});

test("a join that failed for want of intercom is retried by a timer when no connection event comes", async () => {
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	await until(() => a.notices.some((n) => /not connected/.test(n.text)), "the failed join");
	world.broker.connected = true; // no `connection` event is fired
	await until(() => joined(a), "the retried join", 5000);
	assert.equal(world.broker.registrations.length, 1, "no second registration");
	assert.equal(said(a, /joined the net/).length, 1);
});

test("a shutdown ends the retries", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	await until(() => down.failures >= 2, "retries running");
	await a.stop("reload");
	await settle();
	const [failures, lists] = [down.failures, asked("workspace list")];
	await wait(150);
	assert.deepEqual([down.failures, asked("workspace list")], [failures, lists], "no ask after shutdown");
	down.on = false;
	await wait(20);
	assert.deepEqual([...a.tools.keys()], [], "and no join");
});

test("a /new that starts another session while the first still retries leaves one join and no stale retry", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	await until(() => down.failures >= 1, "the first failure");
	down.on = false;
	await a.fire("session_start", { reason: "new" });
	await until(() => joined(a), "the join of the new session");
	await world.quiet();
	await wait(120);
	assert.equal(world.broker.registrations.length, 1, "one join");
	assert.equal(said(a, /joined the net/).length, 0, "the new session never failed: no retry line");
});

test("a joined session whose Herdr server restarts publishes its tokens again at once", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: FAST });
	await a.start();
	assert.equal(a.tokens.sb_role, "member");
	world.herdr.pane("wA:p1").tokens = {};
	await world.takeover();
	await until(() => a.tokens.sb_role === "member", "the tokens after the takeover");
});
