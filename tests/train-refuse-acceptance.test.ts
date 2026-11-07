import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptanceWord, checkCar, checkEvidence, checkSlip } from "../src/train/accept.ts";
import { checkTodoCall, validateStep } from "../src/train/spec.ts";
import { CODE, evidence, type Json, runCheck, SHA_A, sb, slip } from "./train-fixtures.ts";

// D13 (spec §5.4): a car, slip, evidence file or step that asks the train for UAT, e2e or any acceptance is refused at once, with one word that names what was asked and says to rewrite the criteria. The refusal never becomes a step, a wait, or a weaker check.

const SUFFIX = "; rewrite its acceptance criteria and run them before loading, then send the evidence in accept:";
const exists = () => true, isAncestor = () => false;
const ev = (value: unknown, appAccept: string[] = []) => checkEvidence(JSON.stringify(value), { appAccept, head: SHA_A, exists, isAncestor });
const asked = (refusals: string[]) => refusals.filter((r) => r.startsWith("sb: the train runs no acceptance: "));

test("the word names the car, what was asked and where, and ends with the instruction", () => {
	assert.equal(acceptanceWord({ car: "T-15", what: "UAT", where: "uat: line" }), `sb: the train runs no acceptance: car T-15 asks for UAT (uat: line)${SUFFIX}`);
	assert.equal(acceptanceWord({ what: "e2e", where: "step kind" }), `sb: the train runs no acceptance: a step asks for e2e (step kind)${SUFFIX}`);
});

test("a `uat:` slip line is refused with the word, whatever it names; `uat: none` is refused as the old format", () => {
	for (const value of ["/r/checkpoints.md", "https://example.test/page", "/r/uat.json"]) {
		const refusals = checkSlip(slip({ uat: value }), { appAccept: [] });
		assert.deepEqual(asked(refusals), [acceptanceWord({ car: "T-15", what: `UAT (${value})`, where: "slip line uat:" })], value);
	}
	const none = checkSlip(slip({ uat: "none" }), { appAccept: [] });
	assert.equal(asked(none).length, 0);
	assert.match(none.join("\n"), /^sb: the slip's uat: line is gone; send accept: <evidence file> \| none/);
	assert.deepEqual(checkSlip(slip(), { appAccept: [] }), [], "the same slip without it is fine");
});

test("an `accept:` that names a checkpoints or conditions file instead of evidence is refused with the word", () => {
	for (const path of ["/r/checkpoints.json", "/r/uat-checkpoints.md", "/work/conditions.json", "/work/Conditions.yaml", "/work/checkpoint.json"]) {
		const refusals = checkSlip(slip({ accept: path }), { appAccept: [] });
		assert.deepEqual(asked(refusals), [acceptanceWord({ car: "T-15", what: `checkpoints or conditions (${path})`, where: "slip line accept:" })], path);
	}
	assert.deepEqual(checkSlip(slip({ accept: "/r/e2e-evidence.json" }), { appAccept: [] }), []);
	assert.match(checkSlip(slip({ accept: "/r/evidence.md" }), { appAccept: [] }).join("\n"), /accept: \/r\/evidence\.md is not an evidence file \(\.json\)/);
});

test("free text that asks the train for UAT, e2e or acceptance after deploy is refused in any field; a target or a light check that only names them is not", () => {
	const asks = [
		["review", "P0=0 P1=0 (/r/review.md); run UAT after deploy"],
		["light", "pass; the train runs e2e on the train before it merges"],
		["deploy", "target-a, then acceptance after deploy"],
		["lane", "normal (boss to do UAT post-deploy)"],
		["migrations", "none; 請火車在部署後跑 UAT"],
		["tickets", "T-15 (驗收由火車做)"],
		["branch", "fix/uat-after-deploy"],
		["auth", `"UAT after deploy was fine, ship it"`],
	] as const;
	for (const [field, text] of asks) {
		const refusals = checkSlip(slip({ [field]: text }), { appAccept: [] });
		assert.equal(asked(refusals).length, 1, `${field}: ${text} -> ${JSON.stringify(refusals)}`);
		assert.match(refusals[0]!, new RegExp(`\\(slip field ${field}\\)`));
	}
	for (const [field, text] of [["deploy", "uat-env"], ["light", "pass (npm run check, e2e smoke of the app, 12 passed)"], ["deploy", "staging"], ["lane", "urgent (post-deploy hotfix)"], ["deploy", "target-a, after deploy window"], ["coordinator", "sess-uat-after-deploy"], ["review", "P0=0 P1=0 (/r/review-of-evaluate.md)"], ["lane", "normal"]] as const)
		assert.deepEqual(checkSlip(slip({ [field]: text }), { appAccept: [] }), [], `${field}: ${text}`);
});

test("an evidence file that has not passed, or still has something to run, is refused with the word naming the entry", () => {
	const kinds = (e: unknown) => asked(ev(e));
	assert.equal(kinds(evidence({}, { result: "pending" })).length, 1);
	assert.equal(kinds(evidence({}, { result: "todo" })).length, 1);
	assert.equal(kinds(evidence({}, { result: undefined })).length, 1);
	assert.match(kinds(evidence({}, { result: "pending" }))[0]!, /car T-15 asks for e2e \(evidence entry 1: result pending\)/);
	for (const field of ["check", "run", "page", "checkpoints"]) {
		const refusals = kinds(evidence({}, { [field]: "to do" }));
		assert.equal(refusals.length, 1, field);
		assert.match(refusals[0]!, new RegExp(`evidence entry 1: ${field} to be done`));
	}
	assert.match(kinds({ ...evidence(), conditions: [{ flow: "checkout" }] })[0]!, /car T-15 asks for UAT conditions \(evidence file: top-level conditions, the old format\)/);
	assert.match(kinds({ ...evidence(), checkpoints: [] })[0]!, /evidence file: top-level checkpoints/);
	assert.deepEqual(kinds(evidence()), []);
	const failed = ev(evidence({}, { result: "failed" }));
	assert.deepEqual(asked(failed), [], "a failed run is not a request");
	assert.match(failed.join("\n"), /entry 1: result must be passed or accepted/);
});

test("a manifest of cars: checkCar refuses a car that carries any of it and returns each refusal for the coordinator", () => {
	const good = checkCar(slip(), JSON.stringify(evidence()), { appAccept: ["e2e"], exists, isAncestor });
	assert.deepEqual(good, []);
	const bad = checkCar(slip({ uat: "/r/checkpoints.md", accept: undefined }), undefined, { appAccept: [], exists, isAncestor });
	assert.equal(asked(bad).length, 1);
	const both = checkCar(slip({ accept: "/r/e2e-evidence.json" }), JSON.stringify(evidence({}, { result: "pending" })), { appAccept: ["e2e"], exists, isAncestor });
	assert.equal(asked(both).length, 1);
});

test("a train's todo that asks for acceptance is blocked with the word: kind e2e or uat, a name that says accept, uat or e2e, a check type of either", () => {
	const word = /^sb: the train runs no acceptance: a step asks for /;
	const first = (input: Json) => validateStep(input)[0] ?? "";
	assert.match(first(sb({ kind: "e2e" })), word);
	assert.match(first(sb({ kind: "uat" })), word);
	assert.match(first(sb({ kind: "UAT" })), word);
	assert.match(first(sb({ kind: "acceptance" })), word);
	for (const name of ["accept", "uat", "e2e", "run-e2e", "e2e_checkout", "UAT page", "accepts order", "acceptance"]) assert.match(first(sb({ name })), word, name);
	for (const name of ["unit", "evaluate", "equation", "graduate", "type-check", "lint", "build", "full suite"]) assert.deepEqual(validateStep(sb({ name })), [], name);
	for (const type of ["e2e", "uat", "acceptance"]) assert.match(first(sb({}, { check: { ...runCheck(), type } }) as Json), word, type);
	// An acceptance word, not the kind or schema refusal, comes first and alone: the call is refused at once.
	assert.equal(validateStep(sb({ kind: "uat", name: "x", spec: {} })).length, 1);
	const here = { project: "acme", app: "web", train: CODE, round: 1 };
	for (const bad of [sb({ kind: "e2e" }), sb({ kind: "uat" }), sb({ name: "accept orders" })]) {
		const refusals = checkTodoCall({ action: "create", subject: "s", metadata: { sb: bad } }, [], here);
		assert.equal(refusals.length, 1);
		assert.match(refusals[0]!, word);
	}
});

test("nothing in the refusal path produces a step, a wait or a weaker check: every refusal is a string and the inputs are untouched", () => {
	const input = { action: "create", subject: "s", metadata: { sb: sb({ kind: "uat" }) } };
	const before = JSON.stringify(input);
	const out = checkTodoCall(input, [], { project: "acme", app: "web", train: CODE, round: 1 });
	assert.ok(Array.isArray(out) && out.every((r) => typeof r === "string"));
	assert.equal(JSON.stringify(input), before);
	const slipText = slip({ uat: "/r/checkpoints.md" }), evText = JSON.stringify(evidence({}, { result: "pending" }));
	const refusals = [checkSlip(slipText, { appAccept: [] }), checkEvidence(evText, { appAccept: [], head: SHA_A, exists, isAncestor })];
	for (const r of refusals) assert.ok(r.length > 0 && r.every((x) => typeof x === "string"));
	assert.equal(JSON.stringify(JSON.parse(evText)), JSON.stringify(evidence({}, { result: "pending" })));
	assert.equal(slipText, slip({ uat: "/r/checkpoints.md" }));
});

const word = /^sb: the train runs no acceptance: a step asks for /;
const stepWord = (over: Json) => validateStep(sb(over))[0] ?? "";

test("F001: a step is read as words after NFKC, with format characters and marks stripped, case folded, and camelCase, digit and script boundaries split", () => {
	const asks = ["runE2E", "e2eTests", "UATpage", "UatPage", "uatPage", "ＵＡＴ", "U\u200bAT", "U\u2060A\ufeffT", "驗收", "验收", "unit驗收", "end-to-end", "endToEnd", "EndToEnd", "endtoend", "End_To_End", "end to end", "E-2-E", "e2e", "UAT2", "page2uat", "ＡＣＣＥＰＴ", "ACCEPT\u00ad", "acceptANCE", "accepted", "accepts", "ŪAT", "U\u0410\u0422", "run-UAT-suite", "acceptance"];
	for (const name of asks) assert.match(stepWord({ name }), word, JSON.stringify(name));
	for (const name of ["acceptable-latency", "acceptable", "evaluate", "equation", "graduate", "situation", "type-check", "full suite", "unit", "e2ee", "uatu", "accessor", "end-to-middle"]) assert.deepEqual(validateStep(sb({ name })), [], name);
	for (const type of ["ＵＡＴ", "E2E", "acceptance"]) assert.match(validateStep(sb({}, { check: { ...runCheck(), type } }))[0] ?? "", word, type);
	assert.match(stepWord({ kind: "Ｕ\u200bAT" }), word);
});

test("F002: a slip's parse fails closed and every field is read with the same words", () => {
	const base = slip();
	const refused = (text: string, pattern: RegExp) => assert.ok(checkSlip(text, { appAccept: [] }).some((r) => pattern.test(r)), `${pattern} not in ${JSON.stringify(checkSlip(text, { appAccept: [] }))}: ${text}`);
	for (const text of ["run UAT after deploying", "run e2e once deployed", "run e2e after we deploy", "acceptance post-deploy", "e2e after deployed to staging", "UAT 部署後", "e2e 上車後", "e2e at deploy", "e2e on the train", "after merge uat", "UAT after landing", "uat after the merge", "accept it once it is deployed", "U\u200bAT after deploy", "ＵＡＴ after deploy", "afterDeploy UAT", "run 驗收 after deploy", "end-to-end after deploy"])
		assert.equal(asked(checkSlip(slip({ light: text }), { appAccept: [] })).length, 1, text);
	refused(slip({ uat: undefined }) + "\nUAT: yes", /UAT \(yes\)/);
	refused(base + "\nUat: none", /uat: line is gone/);
	refused(base + "\nnotes: ok", /^sb: slip line \d+: .*notes/);
	refused(base + "\nnotes: ok\nnotes: run uat after deploy", /^sb: slip line \d+: .*notes.*twice/);
	refused(base + "\nlight: run uat after deploy", /^sb: slip line \d+: .*light.*twice/);
	assert.equal(asked(checkSlip(base + "\nlight: run uat after deploy", { appAccept: [] })).length, 1, "the repeated value is read too");
	refused(base + "\nplease run uat after deploy", /^sb: slip line \d+: .*no key/);
	assert.equal(asked(checkSlip(base + "\nplease run uat after deploy", { appAccept: [] })).length, 1);
	refused(base + '\nreview: "x | light: run uat after deploy', /^sb: slip line \d+: .*unbalanced/);
	refused(base + "\nreview: x (y | light: run uat after deploy", /^sb: slip line \d+: .*unbalanced/);
	refused(base + "\nl\u200bight: x", /^sb: slip line \d+: .*no key/);
	refused(base + "\nLight: pass", /^sb: slip line \d+: .*twice/);
	refused(base + "\nhttps://example.test/page", /^sb: slip line \d+: /);
	assert.equal(asked(checkSlip(slip({ review: "x", auth: `"ok, run uat after deploy"` }), { appAccept: [] })).length, 1);
	assert.deepEqual(checkSlip(base, { appAccept: [] }), [], "a plain slip still passes");
	assert.deepEqual(checkSlip(`  ${base.replace(/\n/g, "\n  ")}\n\n`, { appAccept: [] }), [], "indentation and blank lines are fine");
	// A known false refusal, accepted: the rule has no way to tell an e2e flake fix from a request, and a rewrite costs little.
	assert.equal(asked(checkSlip(slip({ light: "fixed e2e flake; merge after deploy freeze" }), { appAccept: [] })).length, 1);
});

test("F008, F009: evidence entries are read whole, and a padded pending result is still a request", () => {
	assert.match(ev(evidence({}, { on: { head: SHA_A, run: "later on the train" } })).join("\n"), /entry 1: on\.run is not a field/);
	for (const field of ["what", "label", "nod"]) assert.equal(asked(ev(evidence({}, { [field]: "run UAT after deploy" }))).length, 1, field);
	assert.equal(asked(ev(evidence({}, { result: " pending " }))).length, 1);
	assert.equal(asked(ev(evidence({}, { result: "\tPENDING\n" }))).length, 1);
});
