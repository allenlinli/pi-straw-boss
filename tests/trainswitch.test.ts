import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { integrationOff, promptSet, strip } from "../src/trainswitch.ts";
import { PROMPT_DIR, World } from "./fakes.ts";

// The merge-train switch (boss, 2026-11-05: "往上游修：sb 在 desk 裡不套整合員規則"): STRAW_BOSS_INTEGRATION=off, or `"integration": "off"` in config.json of the state folder, takes the integrator rules out of every prompt a session is given.

const scratch: string[] = [];
let world = new World();
afterEach(async () => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
	await world.stopAll();
	world = new World();
});
const temp = () => (scratch.push(mkdtempSync(join(tmpdir(), "sb-trainswitch-"))), scratch.at(-1)!);
const raw = (name: string) => readFileSync(join(PROMPT_DIR, `${name}.md`), "utf8").trim();
/** What an off session must never be handed: the integrator's role, its slips, and the train's vocabulary. */
const TRAIN = /integrator|car slip|merge train|\btrains?\b|pre-dev|deploy-auto|`auto`|`strict`|\bUAT\b|Light checks|Full gates/i;
const MARKS = /<!--\s*\/?(?:no-)?integration\s*-->/;

test("the switch is off for `off` in the environment or in config.json; the environment wins, and a missing or unreadable config means on", () => {
	const dir = temp();
	assert.equal(integrationOff({}, dir), false, "nothing set: on");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "off" }, dir), true);
	for (const value of ["OFF", "false", "0", "no"]) assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: value }, dir), true, value);
	for (const value of ["on", "", "1", "yes", "true"]) assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: value }, dir), false, value);
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	assert.equal(integrationOff({}, dir), true, "config.json says off");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "on" }, dir), false, "the environment wins over config.json");
	assert.equal(integrationOff({ STRAW_BOSS_INTEGRATION: "off" }, temp()), true);
	writeFileSync(join(dir, "config.json"), "{ not json");
	assert.equal(integrationOff({}, dir), false, "an unreadable config.json leaves it on");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "on", towerRuns: { enabled: true } }));
	assert.equal(integrationOff({}, dir), false);
});

test("strip: an integration block goes when off and keeps its text when on; a no-integration block the other way; markers never survive", () => {
	const text = ["a", "<!-- integration -->", "b", "<!-- /integration -->", "<!-- no-integration -->", "c", "<!-- /no-integration -->", "| row |", "<!-- integration -->| x | y |<!-- /integration -->", "d <!-- integration -->e <!-- /integration -->f <!-- no-integration -->g <!-- /no-integration -->h"].join("\n");
	assert.equal(strip(text, false), ["a", "b", "| row |", "| x | y |", "d e f h"].join("\n"));
	assert.equal(strip(text, true), ["a", "c", "| row |", "d f g h"].join("\n"));
	assert.throws(() => strip("a\n<!-- integration -->\nb", true), /unclosed|marker/i);
	assert.throws(() => strip("a <!-- /no-integration --> b", false), /unclosed|marker/i);
});

test("every prompt file closes its markers, and the files an agent reads itself carry no off-only block", () => {
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) {
		const text = readFileSync(join(PROMPT_DIR, file), "utf8");
		for (const off of [false, true]) assert.doesNotMatch(strip(text, off), MARKS, `${file} (off: ${off}) leaves a marker`);
	}
	for (const file of ["apps-config.md", "planning.md", "integrator.md"]) assert.doesNotMatch(readFileSync(join(PROMPT_DIR, file), "utf8"), /no-integration/, `${file} is read raw, so a block shown only when off would show when on`);
});

test("on: the assembled text is today's text minus the markers; the files stay where they are", () => {
	const dir = temp(), set = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env: {} });
	assert.equal(set.off, false);
	assert.equal(set.dir, PROMPT_DIR);
	for (const name of ["main", "tower", "tower-run", "member", "member-no-main", "head-run", "ally-run"]) {
		const text = set.read(name);
		assert.doesNotMatch(text, MARKS, name);
		assert.equal(text, strip(raw(name), false));
	}
	assert.match(set.read("main"), /integrator\.md/);
	assert.match(set.read("tower-run"), /car slip/);
	assert.doesNotMatch(set.read("main"), /integration is off/i);
	assert.ok(existsSync(join(PROMPT_DIR, "integrator.md")));
});

test("off: no assembled prompt names the integrator, a car slip, or the train; the files an agent reads carry none either, and integrator.md is not among them", () => {
	const dir = temp(), set = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env: { STRAW_BOSS_INTEGRATION: "off" } });
	assert.equal(set.off, true);
	assert.notEqual(set.dir, PROMPT_DIR);
	for (const name of ["main", "tower", "tower-run", "member", "member-no-main", "head-run", "ally-run"]) {
		const text = set.read(name);
		assert.doesNotMatch(text, MARKS, `${name} leaves a marker`);
		assert.doesNotMatch(text, TRAIN, `${name} names the train`);
	}
	const files = readdirSync(set.dir).sort();
	assert.ok(!files.includes("integrator.md"), "the integrator prompt is never loaded");
	assert.ok(files.includes("apps-config.md") && files.includes("planning.md"));
	for (const file of ["apps-config.md", "planning.md"]) {
		const text = readFileSync(join(set.dir, file), "utf8");
		assert.doesNotMatch(text, MARKS, file);
		assert.doesNotMatch(text, TRAIN, `${file} names the train`);
		assert.doesNotMatch(text, /`stages`|`targets`|`maxCars`|`maxWaitMin`|"deploy"/, `${file} describes a field that is ignored`);
	}
	// What apps-config still gives: the owning app and its paths.
	for (const term of ["`name`, `dir`, `match`", "`redirectTo`", "`forbidDirectCommit`", "`gitWorkflowSkill`", "`localFiles`", "`crossAppSkills`"]) assert.ok(readFileSync(join(set.dir, "apps-config.md"), "utf8").includes(term), `apps-config.md still names ${term}`);
	// The plain rules, and the answer to a slip that arrives anyway.
	const main = set.read("main");
	assert.match(main, /ignore `integration`, `stages`, `targets`, and `deploy`/);
	assert.match(main, /ask the boss before you merge to a shared branch or deploy/);
	assert.match(main, /integration is off on this computer/);
	for (const name of ["tower", "tower-run"]) assert.match(set.read(name), /`car:` block[^.]*integration is off on this computer/, name);
	// The role prompts read the same files by {{dir}}: that is the folder without the train.
	assert.equal(set.read("main").includes(PROMPT_DIR), false);
});

test("off: the copies are rewritten at each load, and a stale integrator.md in the folder is removed", () => {
	const dir = temp(), env = { STRAW_BOSS_INTEGRATION: "off" };
	const first = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env });
	writeFileSync(join(first.dir, "integrator.md"), "stale");
	writeFileSync(join(first.dir, "apps-config.md"), "stale");
	const second = promptSet({ promptDir: PROMPT_DIR, stateDir: dir, env });
	assert.equal(second.dir, first.dir);
	assert.ok(!existsSync(join(second.dir, "integrator.md")));
	assert.match(readFileSync(join(second.dir, "apps-config.md"), "utf8"), /^# Apps configuration/);
});

test("a session with the switch off is briefed without the train: main, tower, and the files the main is pointed to", async () => {
	const dir = temp();
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", env: { STRAW_BOSS_INTEGRATION: "off" }, deps: { stateDir: dir } });
	await main.start();
	assert.match(await main.promote(), /./);
	const section = (await main.run())["straw-boss"]!;
	assert.match(section, /^You are the main agent of Herdr tab/);
	assert.doesNotMatch(section, TRAIN);
	assert.doesNotMatch(section, MARKS);
	assert.match(section, /integration is off on this computer/);
	const dirOf = /\((\/[^ )]*)\/apps-config\.md\)/.exec(section)?.[1];
	assert.ok(dirOf && dirOf !== PROMPT_DIR, `the main is pointed to the folder without the train (${dirOf})`);
	assert.ok(!existsSync(join(dirOf, "integrator.md")));
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	tower.env!.STRAW_BOSS_INTEGRATION = "off";
	await tower.start();
	const towerSection = (await tower.run())["straw-boss"]!;
	assert.doesNotMatch(towerSection, TRAIN);
	assert.match(towerSection, /integration is off on this computer/);
});

test("a session with the switch on in config.json only is off too; with it set to on in the environment it is on", async () => {
	const dir = temp();
	writeFileSync(join(dir, "config.json"), JSON.stringify({ integration: "off" }));
	const off = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { stateDir: dir } });
	await off.start();
	await off.promote();
	assert.doesNotMatch((await off.run())["straw-boss"]!, TRAIN);
	const on = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", env: { STRAW_BOSS_INTEGRATION: "on" }, deps: { stateDir: dir } });
	await on.start();
	await on.promote();
	assert.match((await on.run())["straw-boss"]!, /integrator\.md/);
});

test("the train's ledger folder follows PI_CODING_AGENT_DIR, and no prompt names ~/.pi", async () => {
	const agentDir = temp();
	const main = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", env: { PI_CODING_AGENT_DIR: agentDir }, deps: { stateDir: undefined } });
	await main.start();
	await main.promote();
	const section = (await main.run())["straw-boss"]!;
	assert.ok(section.includes(`${join(agentDir, "straw-boss")}/trains`), `the main prompt names the state folder's trains folder: ${section.match(/ledgers[^.]*\./)?.[0]}`);
	assert.doesNotMatch(section, /~\/\.pi/);
	for (const file of readdirSync(PROMPT_DIR).filter((name) => name.endsWith(".md"))) assert.doesNotMatch(readFileSync(join(PROMPT_DIR, file), "utf8"), /~\/\.pi\b/, `${file} hard-codes ~/.pi`);
});
