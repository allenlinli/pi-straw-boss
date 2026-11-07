import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { strip } from "../src/trainswitch.ts";
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
// 2026-11-05 (merge-train switch, src/trainswitch.ts): the budgets count the text a session gets, markers dropped, with the switch on and with it off. On, main gains the ledger folder ({{state}}/trains): 497 to 500; off it is 481.
// 2026-11-06 (seam bindings, docs/specs/2026-11-06-seam-bindings.md): with the train on, main.md carries the `## Seam bindings` block for pi-anchorloop's `integrating` and `deploying` skills, 500 to 680 (off it stays 481);
// tower.md 380 to 390 for "the integrator answers the coordinator itself" (off it stays 371). A role that has its own on-budget is listed in ON_BUDGETS.
// 2026-11-07 (wait cards, docs/specs/2026-11-07-wait-cards.md, Prompts; shortened in the GUI review, GR-F012): tower.md +31 for "the boss is not an agent: write a wait for them in plain full sentences" (off 371 to 402, on 393 to 424); main.md +20 for the `wait_card` message and `secret_drop` (off 481 to 501, on 695 to 715). Budgets = measured.
const BUDGETS: Record<string, number> = { "main.md": 501, "tower.md": 402, "member.md": 140, "member-no-main.md": 150 };
// Its review fixes (SB-F001, F003, F005: the Approval line quotes words already given and asks only when they are missing, the tower reports nothing back on a forwarded slip): main.md 680 to 700, tower.md 390 to 395, integrator.md 320 to 340 (SB-F002 and F006: the deploy gate before `Merge`, a subagent briefed for one step).
const ON_BUDGETS: Record<string, number> = { "main.md": 715, "tower.md": 424 };
const PLACEHOLDERS = new Set(["tab", "workspace", "main", "tower", "head", "dir", "state"]);
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test("every role prompt stays within its word budget", () => {
	for (const [file, budget] of Object.entries(BUDGETS)) {
		for (const off of [false, true]) {
			const count = words(strip(readFileSync(`${PROMPT_DIR}/${file}`, "utf8"), off)), limit = off ? budget : (ON_BUDGETS[file] ?? budget);
			assert.ok(count > 10 && count <= limit, `${file} has ${count} words with integration ${off ? "off" : "on"} (budget ${limit})`);
		}
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
	for (const off of [false, true]) assert.ok(words(strip(plan, off)) <= 670, `planning.md has ${words(strip(plan, off))} words with integration ${off ? "off" : "on"} (budget 670)`);
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
test("merge train: apps-config names the integration fields and points to the skill contract; the integrator follows the anchorloop skills and keeps only what is Straw Boss's", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`integration`", "`maxCars`", "`maxWaitMin`", "`base`", "`integrating`'s Project skill contract", "## Light checks", "## Load", "`why=blocked`"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	assert.match(integrator, /^# Integrator/);
	for (const term of ["`integrating` skill (merge)", "`deploying` skill (deploy, UAT)", "Seam bindings in your role prompt", "naming pi-anchorloop", "`why=blocked`", "`why=milestone`", "apps-config.md beside this file", "`<project>/<app>.json` in the `trains` folder your role prompt names", "integ <project>", "never rename again", "`coordinator` is a session id", "`reviewer` role", "`show_doc`"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(!integrator.includes("{{dir}}") && !integrator.includes("<state dir>") && !integrator.includes("reserve") && !integrator.includes("~/.pi"), "integrator.md has no placeholder, undefined path, hard-coded agent folder, or reserve");
	assert.match(readFileSync(`${PROMPT_DIR}/main.md`, "utf8"), /Record: `\{\{state\}\}\/trains\/<project>\/<app>\.json`/, "the role prompt names the ledger file");
	// The procedure (slip block, checks, departure, assembly, review, red handling, urgent lane, deploy, UAT) moved to pi-anchorloop's `integrating` and `deploying` skills (docs/specs/2026-11-06-seam-bindings.md maps every old line):
	// integrator.md went from 1200 to 289 words, and a rule that is back here is duplication.
	for (const gone of ["tested-on", "`train/<code>`", "nothing is force pushed", "`maxCars`", "fix-forward", "One train at a time per target", "a blank box means accepted", "(applied to a DB: no|<which>)"]) assert.ok(!integrator.includes(gone), `integrator.md no longer repeats ${gone}`);
	assert.ok(words(integrator) <= 340, `integrator.md has ${words(integrator)} words`);
});

// Train stages (docs/specs/2026-11-05-train-stages.md, boss form 2026-11-05): one integrator carries a train through merge, deploy, and UAT; Straw Boss names the flow, never an environment.
test("train stages: apps-config declares stages and targets, the integrator verifies and announces through the bound seams, and the docs name the stage headings", () => {
	const cfg = readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8");
	for (const term of ["`stages`", "`merge` (the default, always first)", "`uat` (only after `deploy`)", "`targets` maps a deploy target to `auto`", "only the boss sets it"]) assert.ok(cfg.includes(term), `apps-config.md names ${term}`);
	const integrator = readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8");
	for (const term of ["accepted in UAT", "no UAT page waits", "merge-triggered deploys need no `shared` call", "calls `shared` naming the target", "landed in <version>, your commit is <sha>"]) assert.ok(integrator.includes(term), `integrator.md names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8").includes("a deploy it starts names its target"));
	for (const file of ["integrator.md", "apps-config.md", "planning.md", "main.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		assert.ok(!/\b(staging|production|prod)\b/i.test(text), `${file} names no environment`);
	}
	// The docs state the same contract and drift silently otherwise (review RV-F009).
	const docs = readFileSync(new URL("../docs/how-it-works.md", import.meta.url), "utf8");
	const spec = readFileSync(new URL("../docs/specs/2026-11-05-train-stages.md", import.meta.url), "utf8");
	for (const term of ["## Deploy", "## Deploy verify", "## UAT", "`integration.stages`", "`auto` target", "Seam bindings"]) assert.ok(docs.includes(term), `how-it-works.md names ${term}`);
	for (const term of ["deploy: <targets or none> | uat: <checkpoints path or none>", "## Deploy", "## Deploy verify", "## UAT", "`auto` or `strict`"]) assert.ok(spec.includes(term), `the spec names ${term}`);
	assert.ok(readFileSync(`${PROMPT_DIR}/planning.md`, "utf8").includes("a `human` anchor is the train's UAT"));
});

test("merge train: main hands integration cars over with why shared, planning states the principle, and the tower forwards a shared merge request to the one integrator", () => {
	const main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["`integration`", "{{dir}}/integrator.md", "never merge to its base or claim a pre-dev branch, unless you are the project's integrator", "`why: shared`", "waits for the integrator's train answer", "the done report still goes to whoever asked", "paths outside the project"]) assert.ok(main.includes(term), `main.md names ${term}`);
	const plan = readFileSync(`${PROMPT_DIR}/planning.md`, "utf8");
	for (const term of ["`Light checks`", "once, by the integrator", "`integrating`'s Principle"]) assert.ok(plan.includes(term), `planning.md names ${term}`);
	for (const file of ["tower.md", "tower-run.md"]) {
		const text = readFileSync(`${PROMPT_DIR}/${file}`, "utf8");
		for (const term of ["`integration`", "integrator", "boss_open_main", "integrator.md"]) assert.ok(text.includes(term), `${file} names ${term}`);
	}
	for (const off of [false, true]) assert.ok(words(strip(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8"), off)) <= (off ? 402 : 424)); // wait cards: +31, see BUDGETS
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

// docs/specs/2026-11-06-seam-bindings.md: pi-anchorloop's `integrating` and `deploying` leave six seams open (references/seams.md) and read one `## Seam bindings` block from the session's instructions.
// The block lives in main.md, the system prompt of every main (a coordinator and the integrator alike, so a session holds one block), inside the integration markers; the tower runs no skill and holds none.
const SEAMS = ["Handoff route", "Batch owner", "Approval", "Record", "Escalation route", "Settings"];
test("seam bindings: main.md binds all six seams of pi-anchorloop's integrating skill, in one block that only the train-on prompt carries", () => {
	const raw = readFileSync(`${PROMPT_DIR}/main.md`, "utf8"), on = strip(raw, false), off = strip(raw, true);
	assert.equal(raw.match(/^## Seam bindings$/gm)?.length, 1, "main.md holds one Seam bindings heading");
	const block = on.slice(on.indexOf("## Seam bindings")), lines = block.split("\n").filter((line) => line.startsWith("- "));
	assert.deepEqual(lines.map((line) => line.slice(2, line.indexOf(":"))), SEAMS, "one line per seam, in the order of seams.md");
	for (const [seam, mechanism] of [["Handoff route", "`call_tower` `why: shared`"], ["Batch owner", "~/.herdr/worktrees/<repo>/train-<code>"], ["Approval", "the boss"], ["Record", "{{state}}/trains/<project>/<app>.json"], ["Escalation route", "`why=blocked`"], ["Settings", "apps.json `integration`"]]) {
		assert.ok(lines.find((line) => line.startsWith(`- ${seam}:`))?.includes(mechanism!), `${seam} names ${mechanism}`);
	}
	assert.ok(on.includes("`integrating` and `deploying` skills") && on.includes("naming pi-anchorloop"), "main.md names the skills and blocks without them");
	assert.ok(!off.includes("Seam bindings") && !off.includes("pi-anchorloop") && !off.includes("train-<code>"), "with the train off no binding is left");
	// The block is the last text of the integration part: nothing of the always-on text may follow it inside the markers.
	assert.match(raw, /## Seam bindings\n(?:- .*\n){6}<!-- \/integration -->/);
	// Review SB-F001/F003: the coordinator quotes words already given and asks only when they are missing (an overnight train must not stall on a question); the integrator asks for a strict target not every car's auth names.
	const approval = lines.find((line) => line.startsWith("- Approval:"))!;
	assert.ok(approval.includes("lacking them, it asks") && approval.includes("not every car's `auth` names") && !approval.includes("no car names"), "Approval asks only when the words are missing");
	// SB-F002 is fixed upstream (pi-anchorloop 2.10.1, train step 4 gates `Merge` on the deploy steps), which the README requires; SB-F006: a subagent is briefed for one step.
	assert.ok(readFileSync(`${PROMPT_DIR}/integrator.md`, "utf8").includes("never the skill"), "integrator.md keeps the skill from subagents");
	for (const readme of ["README.md", "README.zh-TW.md"]) assert.ok(readFileSync(readme, "utf8").includes("pi-anchorloop) 2.10.1"), `${readme} requires pi-anchorloop 2.10.1, whose train step 4 gates Merge on the deploy steps`);
	// SB-F004: only the headings `integrating` requires stop a departure.
	assert.ok(readFileSync(`${PROMPT_DIR}/apps-config.md`, "utf8").includes("When a required one is missing"), "apps-config.md requires only the required headings");
	for (const file of ["tower.md", "tower-run.md", "planning.md", "integrator.md", "apps-config.md"]) assert.ok(!readFileSync(`${PROMPT_DIR}/${file}`, "utf8").includes("## Seam bindings"), `${file} holds no second block`);
});

// docs/specs/2026-11-07-wait-cards.md, Prompts: a wait for the boss is a card the boss reads, not a terse line an agent reads.
test("wait cards: tower.md says the boss is not an agent, and the card's words are plain, full sentences in the language the brief names", () => {
	const tower = strip(readFileSync(`${PROMPT_DIR}/tower.md`, "utf8"), true);
	for (const term of ["The boss is not an agent: write a wait for them in plain full sentences, in the language your brief names, no shorthand, a ticket id only beside what it is."]) assert.ok(tower.includes(term), `tower.md names ${term}`);
	assert.ok(tower.indexOf("The boss is not an agent:") > tower.indexOf("caveman-style"), "after the terse line");
});

test("wait cards: tower-run.md records a boss wait as a card (fields, language, refusals, the press, legacy, no double notice), with the fonstar example, and the one-line rule is gone", () => {
	const run = readFileSync(`${PROMPT_DIR}/tower-run.md`, "utf8");
	assert.ok(!run.includes("write what they have to do in one line they can act on"), "the old one-line rule is replaced");
	for (const term of ["Record a wait for the boss as a card", "`type` (action", "choice when they pick", "secret when a session needs a secret from them", "`happened`", "`do`", "`url` or `command`", "`after`", "`options`", "`secret.name`", "never the value", "`from`", "the `[intercom from ...]` line", "or `self`", "the language the brief's Memory section names (sb's locale)", "who has not followed the work", "A refusal lists what to fix. Fix every line and call again.", "The boss pressed", "chose", "declined", "A declined wait is over: tell the raiser what happens instead", "old free-text wait", "`restates`", "Do not send the raiser the same news yourself", "fonstar-staging", "tailscale"]) assert.ok(run.toLowerCase().includes(term.toLowerCase()), `tower-run.md names ${term}`);
});

test("wait cards: head-run.md and main.md say the same in their words", () => {
	const head = readFileSync(`${PROMPT_DIR}/head-run.md`, "utf8"), main = readFileSync(`${PROMPT_DIR}/main.md`, "utf8");
	for (const term of ["as a card", "in the language your brief names", "`from` is the tower's session id", "`restates`"]) assert.ok(head.includes(term), `head-run.md names ${term}`);
	for (const term of ["A `wait_card` message is the boss's answer to your wait: act on it; it says when to call `secret_drop`."]) assert.ok(main.includes(term), `main.md names ${term}`);
});
