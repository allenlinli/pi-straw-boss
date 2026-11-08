import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { carsDir } from "../src/train/board.ts";
import { addState, carFileName, emptyCar, type NoticeRecord } from "../src/train/cars.ts";
import { runTrain } from "../src/server/traincmds.ts";
import { parseArgs } from "../src/server/cli.ts";
import { SHA_A, SHA_B, SHA_C } from "./train-fixtures.ts";

// `cli.mjs train notices` (docs/specs/2026-11-07-train-workers.md §9.2): every car's states and notice records from the car files, read as the page reads them (the files are model-writable: validated, capped, never guessed).

const ROOT = process.env.SB_TEST_ROOT!, dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(ROOT, "tn-"))), dirs.at(-1)!);
const TRAIN = { role: "train" as const, name: "train-m", session: "sess-train-m" }, MAIN = { role: "main" as const, name: "integ", session: "sess-integ" };
const AT = "2026-11-07T08:00:00Z";

function plant(dir: string, project: string, head: string, ticket: string, states: ("received" | "landed" | "returned")[], notice?: NoticeRecord) {
	let file = emptyCar({ project, app: "web", tickets: [ticket], branch: `fix/${ticket}`, head, coordinator: "sess-coord-1" });
	for (const s of states) file = addState(file, { state: s, by: s === "received" ? TRAIN : MAIN, at: AT, fields: s === "received" ? { train: "2026-11-06-m", departs: "next" } : s === "landed" ? { version: "1.2.3", commit: SHA_B } : { reason: "tests red" } });
	const folder = carsDir(dir, project), name = carFileName("web", head);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, name), JSON.stringify(file));
	if (notice) writeFileSync(join(folder, name.replace(/\.json$/, ".notice.json")), JSON.stringify(notice));
	return join(folder, name);
}
async function notices(stateDir: string, flags: Record<string, string | true> = {}) {
	let out = "", err = "";
	const code = await runTrain({ sub: "notices", ...flags }, { out: (t) => (out += t), err: (t) => (err += t), env: {}, stateDir });
	return { code, out, err };
}

test("train notices lists every car's states with who set each, the text sent, the attempts and the delivery; --pending keeps what is not delivered nor escalated", async () => {
	const dir = state();
	plant(dir, "acme", SHA_A, "T-1", ["received", "landed"], { v: 1, states: { received: { attempts: [{ at: AT, outcome: "delivered" }], deliveredAt: AT }, landed: { attempts: [{ at: AT, outcome: "queued" }, { at: AT, outcome: "failed", answer: "x" }] } } });
	plant(dir, "acme", SHA_C, "T-2", ["received", "returned"], { v: 1, states: { received: { attempts: [], escalatedAt: AT }, returned: { attempts: [] } } });
	plant(dir, "beta", SHA_B, "T-3", ["received"]);
	const all = JSON.parse((await notices(dir, { json: true })).out) as { cars: { project: string; tickets: string[]; coordinator: string; states: { state: string; by: { role: string; session: string }; text: string; status: string; attempts: { outcome: string }[]; deliveredAt?: string; escalatedAt?: string }[] }[] };
	assert.deepEqual(all.cars.map((c) => [c.project, c.tickets[0], c.states.map((s) => [s.state, s.status])]), [
		["acme", "T-1", [["received", "delivered"], ["landed", "pending"]]], ["acme", "T-2", [["received", "escalated"], ["returned", "pending"]]], ["beta", "T-3", [["received", "pending"]]]]);
	const t1 = all.cars[0]!;
	assert.deepEqual([t1.coordinator, t1.states[0]!.by.role, t1.states[0]!.by.session, t1.states[0]!.deliveredAt], ["sess-coord-1", "train", "sess-train-m", AT]);
	assert.equal(t1.states[0]!.text, `received: your car T-1 (${SHA_A.slice(0, 12)}) rides train 1106m; it departs next`);
	assert.deepEqual(t1.states[1]!.attempts.map((a) => a.outcome), ["queued", "failed"]);
	assert.equal(all.cars[1]!.states[0]!.escalatedAt, AT);
	const pending = JSON.parse((await notices(dir, { json: true, pending: true })).out) as typeof all;
	assert.deepEqual(pending.cars.map((c) => [c.tickets[0], c.states.map((s) => s.state)]), [["T-1", ["landed"]], ["T-2", ["returned"]], ["T-3", ["received"]]]);
	const one = JSON.parse((await notices(dir, { json: true, project: "beta" })).out) as typeof all;
	assert.deepEqual(one.cars.map((c) => c.project), ["beta"]);
	const text = (await notices(dir, { pending: true })).out;
	assert.match(text, /acme T-1 .*landed.*pending/s);
	assert.ok(!text.includes("T-1 received"), text);
});

test("train notices never guesses: a car file out of shape, oversize, a link, or a cars folder that is a link shows nothing; a bad project name is a usage error", async () => {
	const dir = state();
	const good = plant(dir, "acme", SHA_A, "T-1", ["received"]);
	const folder = carsDir(dir, "acme");
	writeFileSync(join(folder, "web-bad.json"), "{not json");
	writeFileSync(join(folder, "web-big.json"), `{"v":1,"pad":"${"x".repeat(70_000)}"}`);
	symlinkSync(good, join(folder, "web-link.json"));
	writeFileSync(join(folder, "web-shape.json"), JSON.stringify({ v: 1, project: "acme", app: "web", car: { tickets: [], branch: "b", head: SHA_A }, coordinator: "c", states: [] }));
	const elsewhere = state();
	plant(elsewhere, "zzz", SHA_B, "T-9", ["received"]);
	mkdirSync(join(dir, "trainboard", "linked"), { recursive: true });
	symlinkSync(carsDir(elsewhere, "zzz"), join(dir, "trainboard", "linked", "cars"));
	const result = JSON.parse((await notices(dir, { json: true })).out) as { cars: { tickets: string[] }[] };
	assert.deepEqual(result.cars.map((c) => c.tickets[0]), ["T-1"]);
	const bad = await notices(dir, { project: "../x" });
	assert.equal(bad.code, 2);
	assert.match(bad.err, /project/);
	assert.equal((await notices(dir, { project: true })).code, 2);
});

test("train notices strips control characters from what a file says; a name over the file shape is a car file refused", async () => {
	const dir = state();
	const path = plant(dir, "acme", SHA_A, "T-1", ["received"]);
	const file = JSON.parse((await import("node:fs")).readFileSync(path, "utf8"));
	file.states[0].by.name = `evil\u001b[31m${"n".repeat(100)}`;
	writeFileSync(path, JSON.stringify(file));
	const result = (await notices(dir, { json: true })).out;
	assert.ok(!result.includes("\u001b"), "no escape byte");
	const name = (JSON.parse(result) as { cars: { states: { by: { name: string } }[] }[] }).cars[0]!.states[0]!.by.name;
	assert.equal(name, `evil [31m${"n".repeat(100)}`);
});

test("a car file whose setter name is over the shape's cap is refused whole", async () => {
	const dir = state();
	const path = plant(dir, "acme", SHA_A, "T-1", ["received"]);
	const file = JSON.parse((await import("node:fs")).readFileSync(path, "utf8"));
	file.states[0].by.name = "n".repeat(500);
	writeFileSync(path, JSON.stringify(file));
	assert.deepEqual((JSON.parse((await notices(dir, { json: true })).out) as { cars: unknown[] }).cars, []);
});

test("the CLI parses train notices with --project, --pending and --json", () => {
	assert.deepEqual(parseArgs(["train", "notices", "--project", "acme", "--pending", "--json"]).flags, { sub: "notices", project: "acme", pending: true, json: true });
});
