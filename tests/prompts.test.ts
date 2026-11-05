import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PROMPT_DIR } from "./fakes.ts";

// tower.md was 150 words; the rule for opening a main for unowned work (boss_open_main: no asking the boss, what to pass, once, report a failure) took it to 180.
// main.md was 150 words; renaming itself with boss_rename when its work turns to another task took it to 170.
// 0.22.0 to 185 for planning by planning.md before the first dispatch, with the boss's confirmation; 0.31.0 kept 185 when the confirmation gave way to asking only for decisions.
// 0.32.0 added the terse caveman-style rule for text agents read to every role prompt: main 210, tower 205, member 95, member-no-main 105.
// 0.32.1 added that a brief keeps its goal, context, reasons, scope, what others own, and acceptance check, and that an unsure reader restates or asks: +45 each.
// 0.40.0 (tower comms): tower 250 to 330 for tower_list and tower_send, the header every message opens with and what to do with its recipients, reporting back once, and closing the mains it opened;
// main 255 to 290 for reporting to the tower that opened it and waiting to be closed.
// Work board: main 285 to 335 for board_set (when to write, what stays out, it is no report); tower 328 to 360 for board_read and treating remote entries as a peer's report.
// Board auto-fill: main 335 to 350 (the board fills itself from the todo list and the name; board_set overrides it, `auto: true` hands it back).
// Tower comms: tower 360 to 380 for never forwarding a main's board items or todo text to an ally (T2 review F009).
// Merge of call timing (D19) and board auto-fill: main 458 (three call_tower points beside the board line), tower 380.
// Board clearing: main 458 to 484 (clear the board before stopping when work ends or is shelved; `board_set { clear: true }`; Done-when includes it).
// 2026-11-02 (a main edited prompts itself and stalled its chain): main dispatches work independent of its chain; +14 words, 13 cut from the board and rename lines (the tool states the 16-character limit), main stays 483 of 484.
// 2026-11-04 (hand-made worktrees scattered under ~/.local/share and hung children on the trust prompt): main names the worktree root; 484 to 500.
const BUDGETS: Record<string, number> = { "main.md": 500, "tower.md": 380, "member.md": 140, "member-no-main.md": 150 };
const PLACEHOLDERS = new Set(["tab", "workspace", "main", "tower", "head", "dir"]);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test("every role prompt stays within its word budget", () => {
	for (const [file, budget] of Object.entries(BUDGETS)) {
		const count = words(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"));
		assert.ok(count > 10 && count <= budget, `${file} has ${count} words (budget ${budget})`);
	}
});

test("every role prompt writes to agents terse but keeps what flips meaning", () => {
	for (const file of Object.keys(BUDGETS)) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of ["caveman-style", "negations", "quoted decisions verbatim", "full sentences", "what others own", "acceptance check", "reasons with their cause", "restates it or asks"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
});

test("prompts use only known placeholders and are plain English", () => {
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(PLACEHOLDERS.has(name!), `${file} uses {{${name}}}`);
		assert.doesNotMatch(text, /[^\x00-\x7F]/, `${file} has non-ASCII characters`);
	}
});

test("the worker and apps-config prompts moved: apps-config ships unchanged and there is no worker prompt", () => {
	assert.ok(readdirSync(PROMPT_DIR).includes("apps-config.md"));
	assert.ok(!readdirSync(PROMPT_DIR).includes("worker.md"));
	assert.match(readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8"), /^# Apps configuration/);
});

// The main reads planning.md before its first dispatch, as it reads apps-config.md when it splits work: a reference file, not system prompt.
// The boss confirms decisions, not the plan (2026-10-21): an unclear or architecture-contradicting requirement, and merge or deploy authorizations.
test("the main plans from planning.md: graph, todos with owners and blockedBy, shared anchors, and no confirmation of the plan", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	assert.match(main, /\{\{dir\}\}\/planning\.md/);
	assert.doesNotMatch(main, /confirmation/);
	const plan = readFileSync(`${PROMPT_DIR}/planning.md`, "utf8");
	assert.match(plan, /^# Planning work/);
	for (const term of ["single-loop", "fan-out", "orchestrator-worker", "`owner`", "`blockedBy`", "share one checkpoint", "without asking the boss to confirm the plan", "contradicts the architecture"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	assert.doesNotMatch(plan, /Start only on their confirmation/);
	// 2026-11-02 audit (a coordinator offered the boss a page-local design that the app's rules forbade, and a single-loop task opened no anchor loop): +45 words, 20 cut, budget 650 to 670.
	for (const term of ["its plan is one todo whose `metadata.anchor` names its check", "read the owning app's instructions", "quote the rule that settles the design in the brief"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	assert.ok(words(plan) <= 670, `planning.md has ${words(plan)} words (budget 670)`);
});

// D18 and D19 (docs/specs/2026-10-26-sb-backend.md, Decisions): coordination goes through the tower, and a main calls it at three points only. main.md goes from 332 to about 425 words for that rule; the "who owns it" clause of `blocked` takes it to about 445.
// 2026-11-02 audit: a worker that read "ask first" in its app's rules built the thing anyway; the brief's closing line now sends that case to caller_ping. The boss_status/boss_broadcast line went (the tools describe themselves) to keep main.md within 484.
test("the main's brief closing line covers a rule that says to ask first", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	assert.ok(main.includes("or a rule you follow says to ask first, call `caller_ping` and stop"));
});

test("D19: the main calls the tower at three points only, routine progress stays on the board, and a milestone goes without a reply", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["`call_tower`", "three points only", "`milestone`", "`shared`", "`blocked`", "reply: false", "never call the tower to report", "10 minutes"]) assert.ok(main.includes(term), `main.md names ${term}`);
	assert.doesNotMatch(main, /call_tower reaches the tower \(report coordination friction there\)/);
	for (const file of ["member.md", "member-no-main.md"]) assert.match(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"), /`call_tower` and `why: blocked`/, `${file} reports friction as blocked`);
});

test("D19: the tower run reads why= from the header: milestone updates obligations, shared is answered go or wait with the owner named, blocked is routed, and nobody is asked for progress", () => {
	const run = readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8");
	for (const term of ["`why=`", "`milestone`", "`shared`", "`blocked`", "go or wait", "owner", "Never ask mains for progress", "board_read"]) assert.ok(run.includes(term), `tower-run.md names ${term}`);
});

// Merge train, phase 1 (docs/specs/2026-10-30-merge-train.md): prompt-only. Budgets are unchanged; the new text displaced other words.
test("merge train: apps-config names the integration fields and the skill headings; the integrator refuses to depart without the three required ones", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`integration`", "`maxCars`", "`maxWaitMin`", "`base`", "## Light checks", "## Train assembly", "## Full gates", "## Merge", "## Post-merge", "## Urgent lane", "## Load", "Format, lint, build, full type-check, full suites, publish"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	assert.match(integrator, /^# Integrator/);
	for (const term of ["`Light checks`, `Full gates`, or `Merge`", "`why=blocked`", "car:", "auth:", "`train/<code>`", "nothing is force pushed", "`maxCars`", "`maxWaitMin`", "`why=milestone`", "(applied to a DB: no|<which>)", "coordinator: <session id>", "apps-config.md beside this file", "~/.pi/agent/straw-boss/trains/<project>/<app>.json", "integ <project>", "never rename again", "reviewer rechecks it (delta brief)"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(!integrator.includes("{{dir}}") && !integrator.includes("<state dir>") && !integrator.includes("reserve"), "integrator.md has no placeholder, undefined path, or reserve");
	// Train stages (docs/specs/2026-11-05-train-stages.md): the deploy and UAT stages, with review RV fixes (auth per target across cars, merge waiting on deploy verify, shared for its own deploys), take integrator.md from 600 to 1000; it is read before the first departure, not in the system prompt.
	assert.ok(words(integrator) <= 1000, `integrator.md has ${words(integrator)} words`);
});

// Train stages (docs/specs/2026-11-05-train-stages.md, boss form 2026-11-05): one integrator carries a train through merge, deploy, and UAT; Straw Boss names the flow, never an environment.
test("train stages: apps-config declares stages and their headings, the slip carries deploy targets and UAT checkpoints, and the integrator verifies the running version and opens one UAT page per train", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`stages`", "`merge` (the default, always first)", "`uat` (only after `deploy`)", "## Deploy", "## Deploy verify", "## UAT", "each heading of a stage an app declares"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	for (const term of ["deploy: <targets or none> | uat: <checkpoints path or none>", "every `deploy` target", "One train at a time per target", "a green job, an accepted request, or a finished monitor is not done", "one `review` block", "once ready", "a blank box means accepted", "A comment returns its car", "accepted in UAT", "no UAT page waits", "`Deploy` and `Deploy verify`; `uat`: `UAT`", "only when every car in it has `auth` covering that target", "the next train's `Merge` waits for it too", "still calls `shared` naming the target", "merge-triggered deploys need no `shared` call", "a held car is not landed", "ask before `Merge`", "comes with a `deploy` target", "or all of its checkpoints after a revert"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8").includes("a deploy it starts names its target"));
	for (const file of ["integrator.md", "apps-config.md", "planning.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		assert.ok(!/\b(staging|production|prod)\b/i.test(text), `${file} names no environment`);
	}
	// The docs state the same contract and drift silently otherwise (review RV-F009).
	const docs = readFileSync(new URL("../docs/how-it-works.md", import.meta.url), "utf8");
	const spec = readFileSync(new URL("../docs/specs/2026-11-05-train-stages.md", import.meta.url), "utf8");
	for (const term of ["## Deploy", "## Deploy verify", "## UAT", "`integration.stages`", "every car's `auth` covers that target"]) assert.ok(docs.includes(term), `how-it-works.md names ${term}`);
	for (const term of ["deploy: <targets or none> | uat: <checkpoints path or none>", "## Deploy", "## Deploy verify", "## UAT", "every car in it has `auth` covering that target"]) assert.ok(spec.includes(term), `the spec names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/planning.md`, "utf8").includes("a `human` anchor is the train's UAT"));
});

test("merge train: main hands integration cars over with why shared, planning states the principle, and the tower forwards a shared merge request to the one integrator", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["`integration`", "{{dir}}/integrator.md", "never merge to its base or claim a pre-dev branch, unless you are the project's integrator", "`why: shared`", "waits for the integrator's train answer", "the done report still goes to whoever asked", "paths outside the project"]) assert.ok(main.includes(term), `main.md names ${term}`);
	const plan = readFileSync(`${PROMPT_DIR}/planning.md`, "utf8");
	for (const term of ["`Light checks`", "once, by the integrator", "may name exceptions"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	for (const file of ["tower.md", "tower-run.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of ["`integration`", "integrator", "boss_open_main", "integrator.md"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
	assert.ok(words(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8")) <= 380);
	assert.ok(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8").includes("finding with evidence"));
});

test("merge train: the integrator needs no shared call for its own merges, and the tower answers its shared request instead of forwarding it back", () => {
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	assert.ok(integrator.includes("Your own merges, pushes, and merge-triggered deploys need no `shared` call: the slips' auth covers them"));
	assert.ok(readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8").includes("from the integrator itself, answer go or wait"));
	assert.ok(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8").includes("the integrator's own: go/wait"));
});

// 2026-11-02: a main carried a side task itself under the single-loop rule "carry bounded work in the session" and stalled its own chain.
test("the main dispatches work independent of its chain to a subagent in parallel", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["Dispatch work independent of your chain to a subagent in parallel", "binds a single loop, not you"]) assert.ok(main.includes(term), `main.md names ${term}`);
});
