import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTowerArgs, parseTowerLine, runTowerCommand, sayToTower, type TowerCmdDeps } from "../src/towercmd.ts";

// `/boss tower status | retry | parked | deliver <id> | drop <id> | leave | new` (docs/specs/2026-10-26-sb-backend.md, The boss conversation): the pi twins of the tower card's buttons and the composer's Leave and New. Each
// is one control command, the one the GUI's route reaches too; the writes need a pi with a screen.

const ROW = {
	workspace: "wA", label: "Alpha",
	service: {
		state: "running", queued: 2, run: { kind: "local", startedAt: "2026-10-28T10:00:00Z" },
		conversation: { since: "2026-10-28T10:00:00Z", resumed: true, turns: 14, idle: true, idleAt: Date.parse("2026-10-28T10:20:00Z"), idleMs: 600_000, capAt: Date.parse("2026-10-28T14:00:00Z") },
		lastRun: { endedAt: "2026-10-28T09:00:00Z", outcome: "done" }, crashes: 1,
		notices: [{ id: "n1", level: "warning", text: "An event was parked after two runs crashed with it: intercom docs" }],
		parked: [{ id: "e-9", kind: "intercom", from: "docs-main", first: "deploy ws01?" }],
		localRuns: [{ kind: "conversation", startedAt: "2026-10-28T10:00:00Z", note: "(boss quit)" }, { kind: "event", startedAt: "2026-10-28T09:30:00Z", outcome: "done", note: "routed it" }],
	},
};
function harness(over: Partial<TowerCmdDeps> = {}) {
	const told: { text: string; level: string }[] = [], sent: Record<string, unknown>[] = [];
	let answer: Record<string, unknown> = { ok: true };
	const deps: TowerCmdDeps = {
		lang: "en", own: "wA", interactive: true,
		ask: async (request) => (sent.push(request), request.cmd === "status" ? { ok: true, towers: [ROW] } : { ok: true, ...answer }),
		tell: (text, level = "info") => void told.push({ text, level }),
		...over,
	};
	return { told, sent, deps, say: (a: Record<string, unknown>) => void (answer = a), run: (line: string) => runTowerCommand(parseTowerArgs(line)!, deps), last: () => told.at(-1)! };
}

test("the words that are commands: status, retry, parked, leave, new alone, and deliver or drop with an event id; anything else is a message for the tower", () => {
	for (const op of ["status", "retry", "parked", "leave", "new"]) assert.deepEqual(parseTowerArgs(` ${op.toUpperCase()} `), { op });
	assert.deepEqual(parseTowerArgs("deliver e-9"), { op: "deliver", id: "e-9" });
	assert.deepEqual(parseTowerArgs("drop  E_1.2"), { op: "drop", id: "E_1.2" });
	for (const prompt of ["new tests for the build", "leave it to docs", "status of the deploy", "deliver", "drop e-9 now", "deliver ../x", "", "retry later"]) assert.equal(parseTowerArgs(prompt), undefined, prompt);
});

test("status says the service, the conversation, the notices, the parked events and the last runs; parked lists only the parked ones", async () => {
	const h = harness();
	await h.run("status");
	const text = h.last().text;
	assert.match(text, /^Tower \(Alpha\): running · 2 queued · run: a local run since \d\d:\d\d · last run \d\d:\d\d: done · 1 recent crash$/m);
	assert.match(text, /Boss conversation: resumed session, 14 boss turns · since \d\d:\d\d · waiting for you; ends at \d\d:\d\d if you stay quiet · hard cap \d\d:\d\d/);
	assert.match(text, /\[warning\] An event was parked after two runs crashed with it/);
	assert.match(text, /Parked events \(1\): \/boss tower deliver <id> · drop <id>\n {2}e-9 {2}intercom · docs-main: deploy ws01\?/);
	assert.match(text, /conversation · live: \(boss quit\)|conversation · live/);
	assert.match(text, /event · done: routed it/);
	await h.run("parked");
	assert.match(h.last().text, /^Parked events \(1\)/);
	assert.doesNotMatch(h.last().text, /Tower \(/);
	assert.deepEqual(h.sent.map((r) => r.cmd), ["status", "status"], "reads ask for the status only");
});

test("retry, deliver, drop, leave and new are one control command each, for this session's workspace, and say what the server said", async () => {
	const h = harness();
	await h.run("retry");
	await h.run("deliver e-9");
	await h.run("drop e-9");
	h.say({ left: true });
	await h.run("leave");
	assert.match(h.last().text, /Left the boss conversation/);
	h.say({ left: true, already: true });
	await h.run("leave");
	assert.match(h.last().text, /closing already/);
	h.say({ fresh: true, left: false });
	await h.run("new");
	assert.match(h.last().text, /^Started over: the next conversation is a new session\./);
	h.say({ fresh: true, left: true });
	await h.run("new");
	assert.match(h.last().text, /the conversation ended, and the next one is a new session/);
	assert.deepEqual(h.sent, [
		{ cmd: "tower-retry", workspace: "wA" }, { cmd: "tower-deliver", id: "e-9", workspace: "wA" }, { cmd: "tower-drop", id: "e-9", workspace: "wA" },
		{ cmd: "tower-leave", workspace: "wA" }, { cmd: "tower-leave", workspace: "wA" }, { cmd: "tower-new", workspace: "wA" }, { cmd: "tower-new", workspace: "wA" },
	]);
});

test("the server's refusal is shown as it wrote it; a pi with no screen may read but not write; a session in no workspace has no tower", async () => {
	const refusing = harness({ ask: async (request) => (request.cmd === "status" ? { ok: true, towers: [ROW] } : { ok: false, error: "No boss conversation is live in this tower." }) });
	await refusing.run("leave");
	assert.deepEqual(refusing.last(), { text: "No boss conversation is live in this tower.", level: "error" });
	await refusing.run("drop nope");
	assert.equal(refusing.last().level, "error");
	const headless = harness({ interactive: false });
	for (const line of ["retry", "deliver e-9", "drop e-9", "leave", "new"]) {
		await headless.run(line);
		assert.match(headless.last().text, /only in a pi session with a screen/, line);
	}
	assert.deepEqual(headless.sent, [], "nothing was sent");
	await headless.run("status");
	assert.match(headless.last().text, /^Tower \(Alpha\)/);
	const nowhere = harness({ own: undefined });
	await nowhere.run("status");
	assert.match(nowhere.last().text, /not in a Herdr workspace/);
	const missing = harness({ ask: async () => ({ ok: true, towers: [] }) });
	await missing.run("status");
	assert.match(missing.last().text, /No tower service for wA/);
});

test("in Traditional Chinese the words follow, and what the server sent is cleaned of control characters", async () => {
	const h = harness({ lang: "zh-TW", ask: async () => ({ ok: true, towers: [{ ...ROW, label: "Al\u001b[31mpha", service: { ...ROW.service, parked: [{ id: "e-9", kind: "intercom", first: "a\u0007b" }] } }] }) });
	await h.run("status");
	assert.match(h.last().text, /^塔台（Al\[31mpha）：執行中・2 則待處理/);
	assert.match(h.last().text, /老闆對話：接續舊工作階段，已有 14 輪/);
	assert.doesNotMatch(h.last().text, /[\u0000-\u0008\u001b]/);
});

// G4, G9: `-w <workspace id | label | head>` and `--answers W<n>` (docs/specs/2026-10-26-sb-backend.md, The boss conversation).
const WORKSPACES = [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wB", label: "Beta" }, { workspace_id: "wC", label: "Gamma" }, { workspace_id: "wD", label: "Gamma" }];
function other(over: Partial<TowerCmdDeps> = {}) {
	const asked: string[][] = [];
	let yes = true;
	const h = harness({ workspaces: async () => WORKSPACES, confirm: async (title, body) => (asked.push([title, body]), yes), ...over });
	return { ...h, asked, refuse: () => void (yes = false), at: (q: string, line: string) => runTowerCommand(parseTowerArgs(line)!, h.deps, q) };
}

test("the flags before a tower line: -w and --answers in either order, only at the front; a flag with no value, a bad wait id, or nothing after them is usage", () => {
	assert.deepEqual(parseTowerLine("status"), { rest: "status" });
	assert.deepEqual(parseTowerLine("-w Beta retry"), { workspace: "Beta", rest: "retry" });
	assert.deepEqual(parseTowerLine("--answers w3 -w head  Yes, go"), { workspace: "head", answers: "W3", rest: "Yes, go" });
	assert.deepEqual(parseTowerLine("deploy -w Beta"), { rest: "deploy -w Beta" }, "a flag later in the words is the prompt's");
	for (const bad of ["-w", "-w Beta", "--answers", "--answers W3", "--answers x1 hi", "-w a -w b hi", "--answers W1 --answers W2 hi"]) assert.deepEqual(parseTowerLine(bad), { usage: true }, bad);
});

test("-w names the tower by id or label: each write goes to that workspace after a confirm that names it, and a write at this session's own workspace asks nothing", async () => {
	const h = other();
	await h.at("wB", "retry");
	await h.at("Alpha", "deliver e-9");
	await h.at("wB", "drop e-9");
	await h.at("wB", "leave");
	await h.at("wB", "new");
	assert.deepEqual(h.sent, [
		{ cmd: "tower-retry", workspace: "wB" }, { cmd: "tower-deliver", id: "e-9", workspace: "wA" }, { cmd: "tower-drop", id: "e-9", workspace: "wB" },
		{ cmd: "tower-leave", workspace: "wB" }, { cmd: "tower-new", workspace: "wB" },
	]);
	assert.deepEqual(h.asked.map((a) => a[1]), [
		"Wake it again for the tower of Beta (wB).", "Drop a parked event for the tower of Beta (wB).",
		"Leave the boss conversation for the tower of Beta (wB).", "Start the boss conversation over for the tower of Beta (wB).",
	], "Alpha is this session's own workspace (wA): no confirm");
});

test("-w status and parked read that workspace's row, not this session's", async () => {
	const rowB = { ...ROW, workspace: "wB", label: "Beta", service: { ...ROW.service, parked: [{ id: "b-1", kind: "intercom", first: "beta event" }] } };
	const h = other({ ask: async (request) => (h.sent.push(request), { ok: true, towers: [ROW, rowB] }) });
	await h.at("Beta", "parked");
	assert.match(h.last().text, /b-1 {2}intercom: beta event/);
	await h.at("wB", "status");
	assert.match(h.last().text, /^Tower \(Beta\)/);
	assert.deepEqual(h.asked, [], "a read asks nothing");
});

test("an unknown or ambiguous workspace refuses and sends nothing; a declined confirm sends nothing", async () => {
	const h = other();
	await h.at("nope", "retry");
	assert.match(h.last().text, /No workspace matches "nope"\. Workspaces: wA \(Alpha\), wB \(Beta\)/);
	await h.at("Gamma", "retry");
	assert.match(h.last().text, /No workspace matches "Gamma"/, "two workspaces carry the label: name the id");
	h.refuse();
	await h.at("wB", "leave");
	assert.deepEqual(h.last(), { text: "Nothing was done.", level: "info" });
	assert.deepEqual(h.sent, []);
	const blind = other({ interactive: false });
	await blind.at("wB", "retry");
	assert.match(blind.last().text, /only in a pi session with a screen/);
	const noAsk = other({ confirm: undefined });
	await noAsk.at("wB", "retry");
	assert.match(noAsk.last().text, /needs the pi screen to confirm/);
	assert.deepEqual([blind.sent, noAsk.sent], [[], []]);
});

test("-w head sends the head's own control commands (head-retry, head-deliver, head-drop, head-leave, head-new) and reads the head row of the status", async () => {
	const head = { workspace: "wH", label: "Head tower", service: { state: "held", queued: 0, parked: [{ id: "h-1", kind: "intercom", first: "from alpha" }] } };
	const h = other({ ask: async (request) => (h.sent.push(request), request.cmd === "status" ? { ok: true, towers: [ROW], head } : { ok: true }) });
	for (const line of ["retry", "deliver h-1", "drop h-1", "leave", "new"]) await h.at("head", line);
	assert.deepEqual(h.sent, [{ cmd: "head-retry" }, { cmd: "head-deliver", id: "h-1" }, { cmd: "head-drop", id: "h-1" }, { cmd: "head-leave" }, { cmd: "head-new" }]);
	assert.match(h.asked[0]![1]!, /for the tower of head \(head\)/);
	await h.at("head", "parked");
	assert.match(h.last().text, /h-1 {2}intercom: from alpha/);
	await h.at("head", "status");
	assert.match(h.last().text, /^Tower \(Head tower\): held/);
});

test("a message to another tower is the boss's words as a tower-event after a confirm that names it; --answers rides along and the reply says whether the wait was marked", async () => {
	let marked: string | false = "W3";
	const h = other({ ask: async (request) => (h.sent.push(request), { ok: true, queued: "e1", ...(request.answers ? { answered: marked } : {}) }) });
	await sayToTower("Yes, deploy", "Beta", "W3", h.deps);
	assert.deepEqual(h.sent, [{ cmd: "tower-event", workspace: "wB", text: "Yes, deploy", present: true, answers: "W3" }]);
	assert.match(h.asked[0]![1]!, /Write to it as the boss for the tower of Beta \(wB\)\./);
	assert.match(h.last().text, /^Handed to the tower of Beta: .*W3 is marked answered\.$/);
	marked = false;
	await sayToTower("Yes again", "wB", "W3", h.deps);
	assert.match(h.last().text, /W3 was not marked answered/);
	await sayToTower("plain", "wB", undefined, h.deps);
	assert.equal("answers" in h.sent.at(-1)!, false);
	assert.doesNotMatch(h.last().text, /answered/);
});

test("a message at another tower: the server's refusal is shown, an unknown workspace sends nothing, a pi with no screen and a declined confirm send nothing", async () => {
	const refusing = other({ ask: async () => ({ ok: false, error: "tower-event needs a workspace and text" }) });
	await sayToTower("hi", "wB", undefined, refusing.deps);
	assert.deepEqual(refusing.last(), { text: "tower-event needs a workspace and text", level: "error" });
	const h = other();
	await sayToTower("hi", "zzz", undefined, h.deps);
	assert.match(h.last().text, /No workspace matches "zzz"/);
	h.refuse();
	await sayToTower("hi", "wB", undefined, h.deps);
	const blind = other({ interactive: false });
	await sayToTower("hi", "wB", undefined, blind.deps);
	assert.match(blind.last().text, /only in a pi session with a screen/);
	assert.deepEqual([h.sent, blind.sent], [[], []]);
});
