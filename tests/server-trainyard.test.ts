import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { afterEach, test } from "node:test";
import { type Board, type BoardStep, boardPath, type CarRow, carsDir, type Writer, writeBoard, writeYard, yardPath } from "../src/train/board.ts";
import { addState, carFileName, emptyCar, type NoticeRecord } from "../src/train/cars.ts";
import type { NetLoad, ProjectYard, YardJoin } from "../src/train/yardview.ts";
import { readYards, reasonKind, trainyardSeam } from "../src/server/trainyard.ts";
import type { Net } from "../src/net.ts";
import { bundle, noLink, noTailscale } from "./gui-fakes.ts";
import { type ServerWorld, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";
import { SHA_A, SHA_B, SHA_C } from "./train-fixtures.ts";

// Task 5 of the train workers (docs/specs/2026-11-07-train-workers.md §11.1, §17): the sb server reads `<state>/trainboard/*/` on the net's read and adds `yards` to the snapshot. What the files say is the train's own words
// (the model writes them), so every read is bounded, strict and never guessed, and every field the page gets is a plain value.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-trainyard-"))), dirs.at(-1)!);
const MIN = 60_000, NOW = Date.parse("2026-11-07T10:00:00Z");
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const M = "2026-11-06-m", N = "2026-11-06-n", P = "2026-11-06-p";

const writer = (pid: number, session = `sess-${pid}`): Writer => ({ session, pane: `w1-${pid}`, pid, started: "2026-11-07T07:00:00Z" });
const LIVE = new Set([4001, 4002, 4300]);
const alive = (w: Writer) => LIVE.has(w.pid);
const LOAD: NetLoad = { now: 42, cores: 14 };
const car = (over: Partial<CarRow> = {}): CarRow => ({ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "/r/accept.json", arrived: iso(30 * MIN), accepted: ["e2e", "uat"], ...over });
const step = (id: number, kind: BoardStep["kind"], status: BoardStep["status"], over: Partial<BoardStep> = {}): BoardStep => ({ id, kind, name: `${kind} ${id}`, status, round: 1, ...over });
const board = (project: string, code: string, over: Partial<Board> = {}): Board => ({ v: 1, project, app: "web", code, writer: writer(4001), updated: iso(MIN), round: 1, cars: [car()], steps: [step(1, "assemble", "completed", { outcome: "passed" })], ...over });

const read = (stateDir: string, join: Partial<YardJoin> = {}, over: object = {}) => readYards({ stateDir, now: () => NOW, alive, ...over }, { trains: [], mains: new Set(), ...join });
const projectOf = (list: ReturnType<typeof read>, name: string): ProjectYard => list!.projects.find((p) => p.project === name)!;

/** Two projects: acme runs M (holds the web lane) and N (waits for it and for the load), beta has a forming train in its yard and a stale train that holds a target. */
function world() {
	const dir = state();
	writeBoard(dir, board("acme", M, {
		steps: [step(1, "assemble", "completed", { holds: { lane: "web" }, outcome: "passed" }), step(2, "merge", "in_progress", { holds: { lane: "web" } }), step(3, "land", "pending")],
	}));
	writeBoard(dir, board("acme", N, {
		writer: writer(4002), cars: [car({ tickets: ["T-16"], head: SHA_B, accepted: ["e2e"] })],
		steps: [step(1, "assemble", "in_progress", { holds: { lane: "web" } }), step(2, "full-check", "in_progress", { load: { max: 30, weight: 4 }, waits: [{ lock: { name: "heavy", holder: { train: M, step: 2 } } }] })],
	}));
	writeBoard(dir, board("beta", P, { writer: writer(4999), updated: iso(20 * MIN), steps: [step(1, "deploy", "in_progress", { holds: { target: "prod" } })] }));
	writeYard(dir, {
		v: 1, project: "beta", writer: writer(4300, "sess-integ-beta"), updated: iso(MIN),
		trains: [
			{ code: "2026-11-07-a", app: "web", status: "forming", cars: [car({ tickets: ["T-20"], head: SHA_C, departs: "alone", accepted: ["e2e"] })], departs: { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) } },
			{ code: P, app: "web", status: "opened", session: "sess-4999", cars: [car()] },
			{ code: "2026-11-07-b", app: "web", status: "refused", cars: [car({ tickets: ["T-21"], head: SHA_A })] },
		],
	});
	return dir;
}

// ---- the read

test("a snapshot of two projects: each project's forming trains with their cars from the yard, every train with its steps, its waits from the other trains' holds and the load, and the count of trains that wait for one another", () => {
	const dir = world(), yards = read(dir, {}, { load: LOAD })!;
	assert.deepEqual(yards.projects.map((p) => p.project), ["acme", "beta"]);
	const acme = projectOf(yards, "acme"), beta = projectOf(yards, "beta");
	assert.deepEqual(acme.trains.map((t) => [t.code, t.state, t.app, t.round]), [[M, "live", "web", 1], [N, "live", "web", 1]]);
	const m = acme.trains[0]!, n = acme.trains[1]!;
	assert.deepEqual(m.holds, { lanes: ["web"], targets: [] }, "M holds the lane from its first started step until its last");
	assert.deepEqual(m.steps.map((s) => [s.id, s.kind, s.status, s.outcome, s.waits]), [[1, "assemble", "completed", "passed", []], [2, "merge", "in_progress", undefined, []], [3, "land", "pending", undefined, []]]);
	assert.deepEqual(n.steps[0]!.waits, [{ lane: { app: "web", holder: M } }], "N's assemble waits for the lane M holds (an earlier code)");
	assert.deepEqual(n.steps[1]!.waits, [{ load: { max: 30, now: 42 } }, { lock: { name: "heavy", holder: { train: M, step: 2 } } }], "the load from the server's own reading, the lock the train recorded");
	assert.deepEqual(n.steps[1]!.load, { max: 30, weight: 4 }, "the CPU the step needs");
	assert.deepEqual(acme.waiting, [N], "互相等待: the trains with a lane or target wait on another train");
	assert.deepEqual(acme.forming, [], "no yard.json in acme");
	assert.equal(acme.integrator, undefined);
	assert.deepEqual(beta.integrator, { live: true }, "the writer of the yard runs; no unit of the net is it, so no key");
	assert.deepEqual(beta.forming.map((f) => [f.code, f.app, f.status]), [["2026-11-07-a", "web", "forming"], ["2026-11-07-b", "web", "refused"]], "an opened yard train is a running train, not a forming one");
	assert.deepEqual(beta.forming[0]!.departs, { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) });
	assert.deepEqual(beta.forming[0]!.cars.map((c) => [c.tickets, c.head, c.departs, c.accepted.map((a) => a.kind)]), [[["T-20"], SHA_C, "alone", ["e2e"]]]);
	const stale = beta.trains[0]!;
	assert.deepEqual([stale.code, stale.state, stale.writerLive], [P, "stale", false], "its writer is gone and the board is 20 minutes old");
	assert.deepEqual(stale.holds, { lanes: [], targets: ["prod"] }, "a stale train keeps what it held");
	assert.deepEqual(beta.waiting, []);
});

test("without a load reading no load wait is made up; a step that is not in progress has no waits", () => {
	const dir = world(), n = projectOf(read(dir)!, "acme").trains[1]!;
	assert.deepEqual(n.steps[1]!.waits, [{ lock: { name: "heavy", holder: { train: M, step: 2 } } }]);
	assert.deepEqual(projectOf(read(dir, {}, { load: LOAD })!, "acme").trains[0]!.steps[2]!.waits, []);
});

test("an ended train (its land step completed) shows ended and holds nothing", () => {
	const dir = state();
	writeBoard(dir, board("acme", M, { steps: [step(1, "merge", "completed", { holds: { lane: "web" }, outcome: "passed" }), step(2, "land", "completed", { outcome: "passed" })] }));
	const t = projectOf(read(dir)!, "acme").trains[0]!;
	assert.deepEqual([t.state, t.holds], ["ended", undefined]);
});

test("a gate file of an in-progress step adds the wrapper's last word; one for another train or step, or out of shape, adds nothing", () => {
	const dir = state();
	writeBoard(dir, board("acme", M, { steps: [step(1, "full-check", "in_progress", { load: { max: 30 } }), step(2, "review", "in_progress")] }));
	const gate = (over: object) => ({ v: 1, project: "acme", app: "web", train: M, step: 1, kind: "full-check", name: "unit", state: "running", since: iso(5 * MIN), updated: iso(10_000), message: "running 5m", waits: [], pid: 1, spec: "x", ...over });
	const folder = join(dir, "trainboard", "acme", M);
	writeFileSync(join(folder, "gate-1.json"), JSON.stringify(gate({})));
	writeFileSync(join(folder, "gate-2.json"), JSON.stringify(gate({ step: 1 })));
	const t = projectOf(read(dir)!, "acme").trains[0]!;
	assert.deepEqual(t.steps[0]!.gate, { state: "running", since: iso(5 * MIN), updated: iso(10_000) });
	assert.equal(t.steps[1]!.gate, undefined, "the file names another step");
	writeFileSync(join(folder, "gate-1.json"), JSON.stringify(gate({ state: "hacked", train: "2026-11-06-z" })));
	assert.equal(projectOf(read(dir)!, "acme").trains[0]!.steps[0]!.gate, undefined, "an unknown state and another train's file are no gate");
});

// ---- hostile files

test("a file that is too big, a symlink, not JSON, or in another project's folder shows as unreadable with its reason; the other trains still read", () => {
	const dir = state();
	writeBoard(dir, board("acme", M));
	for (const code of [N, P, "2026-11-06-q", "2026-11-06-r"]) mkdirSync(join(dir, "trainboard", "acme", code), { recursive: true });
	writeFileSync(boardPath(dir, "acme", N), JSON.stringify({ ...board("acme", N), pad: "x".repeat(70 * 1024) }));
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify(board("acme", P)));
	symlinkSync(join(dir, "elsewhere.json"), boardPath(dir, "acme", P));
	writeFileSync(boardPath(dir, "acme", "2026-11-06-q"), "{not json");
	writeFileSync(boardPath(dir, "acme", "2026-11-06-r"), JSON.stringify(board("other", "2026-11-06-r")));
	const trains = projectOf(read(dir)!, "acme").trains;
	assert.deepEqual(trains.map((t) => [t.code, t.state]), [[M, "live"], [N, "unreadable"], [P, "unreadable"], ["2026-11-06-q", "unreadable"], ["2026-11-06-r", "unreadable"]]);
	const why = Object.fromEntries(trains.map((t) => [t.code, t.reason]));
	assert.match(why[N]!, /more than 64 KB/);
	assert.match(why[P]!, /not a regular file/);
	assert.match(why["2026-11-06-q"]!, /not JSON/);
	assert.match(why["2026-11-06-r"]!, /project other is not the folder's acme/);
	assert.deepEqual(trains[1]!.steps, [], "an unreadable train shows no steps and no cars: nothing is guessed");
	assert.equal(trains[1]!.cars.length, 0);
});

test("V-F002: an unreadable board, a car's notice and a yard.json that fails carry a kind beside the reader's text, so the page says it in its own language", () => {
	const dir = state();
	writeBoard(dir, board("acme", M));
	for (const code of [N, P, "2026-11-06-q", "2026-11-06-r", "2026-11-06-s"]) mkdirSync(join(dir, "trainboard", "acme", code), { recursive: true });
	writeFileSync(boardPath(dir, "acme", N), JSON.stringify({ ...board("acme", N), pad: "x".repeat(70 * 1024) }));
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify(board("acme", P)));
	symlinkSync(join(dir, "elsewhere.json"), boardPath(dir, "acme", P));
	writeFileSync(boardPath(dir, "acme", "2026-11-06-q"), "{not json");
	writeFileSync(boardPath(dir, "acme", "2026-11-06-r"), JSON.stringify(board("other", "2026-11-06-r")));
	writeFileSync(boardPath(dir, "acme", "2026-11-06-s"), JSON.stringify({ ...board("acme", "2026-11-06-s"), round: "two" }));
	writeFileSync(yardPath(dir, "acme"), "{broken");
	const acme = projectOf(read(dir)!, "acme");
	assert.deepEqual(acme.trains.filter((t) => t.state === "unreadable").map((t) => [t.code.slice(-1), t.reasonKind]), [["n", "toobig"], ["p", "notfile"], ["q", "notjson"], ["r", "misplaced"], ["s", "shape"]]);
	assert.match(acme.trains.find((t) => t.code === N)!.reason!, /more than 64 KB/, "the reader's own text still goes beside the kind, for a page that shows it");
	assert.equal(acme.trains[0]!.reasonKind, undefined, "a train that reads has none");
	assert.deepEqual([acme.problemKind, acme.problem?.startsWith("yard.json: not JSON")], ["notjson", true]);
	assert.equal(projectOf(read(world()), "acme").problemKind, undefined);
	const heads = [SHA_A, SHA_B, SHA_C, "d".repeat(40)];
	const other = state();
	onBoard(other, "acme", heads);
	plantCar(other, "acme", SHA_A, { raw: "{not json" });
	plantCar(other, "acme", SHA_B, { file: { project: "zeta" } });
	plantCar(other, "acme", SHA_C, { notice: { v: 1, states: { received: { attempts: [], deliveredAt: "1" } } } });
	plantCar(other, "acme", "d".repeat(40), { file: { coordinator: "" } });
	const kinds = projectOf(read(other), "acme").trains[0]!.cars.map((c) => (c.notice?.status === "unreadable" ? c.notice.kind : undefined));
	assert.deepEqual(kinds, ["notjson", "misplaced", "shape", "shape"]);
});

test("V-F002: what a reader's reason says, as a kind: the size cap, the byte budget, a link, not JSON, an I/O failure, a file of another place, an unexpected throw, and a shape that fails", () => {
	const kind = (text: string) => reasonKind(text);
	assert.equal(kind("file is 70 KB, more than 64 KB"), "toobig");
	assert.equal(kind("file is more than 64 KB"), "toobig");
	assert.equal(kind("the byte budget of this reading is spent"), "budget");
	assert.equal(kind("not a regular file"), "notfile");
	assert.equal(kind("not JSON (Unexpected token)"), "notjson");
	assert.equal(kind("cannot read: EACCES"), "io");
	assert.equal(kind("cannot list /x/y: EMFILE"), "io");
	assert.equal(kind("project other is not the folder's acme"), "misplaced");
	assert.equal(kind("code 2026-11-06-z is not the folder's 2026-11-06-m"), "misplaced");
	assert.equal(kind("the file name is not web-abc.json"), "misplaced");
	assert.equal(kind("the car could not be read: boom"), "failed");
	assert.equal(kind("the train could not be shown: boom"), "failed");
	assert.equal(kind("yard.json: not JSON (x)"), "notjson", "the project's prefix is looked through");
	assert.equal(kind("notice file: file is more than 64 KB"), "toobig", "so is the notice file's");
	assert.equal(kind("notice record: states.evil is not a car state"), "shape");
	assert.equal(kind("cars[0].tickets must be 1 to 16 of them"), "shape", "a refusal of the validator is a shape");
	assert.equal(kind(""), "shape");
});

test("an unreadable board holds everything of its project: the others wait for it, and the page is told why", () => {
	const dir = state();
	writeBoard(dir, board("acme", N, { steps: [step(1, "merge", "in_progress", { holds: { lane: "web" } })] }));
	mkdirSync(join(dir, "trainboard", "acme", M), { recursive: true });
	writeFileSync(boardPath(dir, "acme", M), "nope");
	const acme = projectOf(read(dir)!, "acme");
	assert.deepEqual(acme.trains[1]!.steps[0]!.waits, [{ lane: { app: "web", holder: M, why: "unreadable" } }]);
	assert.deepEqual(acme.waiting, [N]);
});

test("a folder that is a symlink (a project or a train) is not followed, and no more than 64 trains are read", () => {
	const dir = state();
	writeBoard(dir, board("acme", M));
	mkdirSync(join(dir, "outside", "2026-11-06-z"), { recursive: true });
	writeFileSync(join(dir, "outside", "2026-11-06-z", "board.json"), JSON.stringify(board("acme", "2026-11-06-z")));
	symlinkSync(join(dir, "outside", "2026-11-06-z"), join(dir, "trainboard", "acme", "2026-11-06-z"));
	symlinkSync(join(dir, "outside"), join(dir, "trainboard", "linked"));
	assert.deepEqual(read(dir)!.projects.map((p) => [p.project, p.trains.map((t) => t.code)]), [["acme", [M]]]);
	for (let i = 0; i < 70; i++) writeBoard(dir, board("acme", `2026-10-${String(1 + (i % 28)).padStart(2, "0")}-${String.fromCharCode(97 + (i % 26))}${i < 26 ? "" : String.fromCharCode(97 + Math.floor(i / 26))}`));
	const many = read(dir)!;
	assert.equal(many.projects.reduce((n, p) => n + p.trains.length, 0), 64, "at most 64 trains");
	assert.equal(many.truncated, true);
});

test("a yard.json that fails shows the project's problem and no forming trains; a missing one shows none", () => {
	const dir = state();
	writeBoard(dir, board("acme", M));
	writeFileSync(yardPath(dir, "acme"), "{broken");
	const acme = projectOf(read(dir)!, "acme");
	assert.deepEqual(acme.forming, []);
	assert.match(acme.problem!, /yard\.json: not JSON/);
	assert.equal(projectOf(read(world()), "acme").problem, undefined);
});

test("what a file says is plain text for the page: controls, escapes and bidi marks go, markup stays inert text, lengths are cut; a car's head is 40 hex or the board is refused", () => {
	const dir = state();
	const evil = "fix/<img src=x onerror=alert(1)>\u202e\u001b[31m\u0007";
	writeBoard(dir, board("acme", M, {
		cars: [car({ branch: evil, tickets: ["<b>T-1</b>\u0000"], departs: `by 18:00\n${"d".repeat(250)}` })],
		steps: [step(1, "full-check", "in_progress", { name: "\u202eunit\u0007 </script>", waits: [{ lock: { name: "heavy", holder: { train: "t\u0007", step: 1 } } }] })],
	}));
	const t = projectOf(read(dir)!, "acme").trains[0]!, text = JSON.stringify(t);
	assert.equal(t.cars[0]!.branch, "fix/<img src=x onerror=alert(1)>  [31m ", "controls become spaces, the markup text stays text");
	assert.deepEqual(t.cars[0]!.tickets, ["<b>T-1</b> "]);
	assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/.test(text.replace(/\\n|\\u[0-9a-f]{4}/g, "")), "no control or bidi character is left");
	assert.ok(!t.cars[0]!.departs.includes("\n") && t.cars[0]!.departs.length <= 300);
	assert.equal(t.steps[0]!.name, " unit  </script>");
	assert.equal((t.steps[0]!.waits[0] as { lock: { holder: { train: string } } }).lock.holder.train, "t ");
	writeFileSync(boardPath(dir, "acme", M), JSON.stringify({ ...board("acme", M), cars: [{ ...car(), head: "../../etc/passwd" }] }));
	assert.equal(projectOf(read(dir)!, "acme").trains[0]!.state, "unreadable");
});

test("a state folder with no trainboard, or an empty one, gives no yards at all", () => {
	const dir = state();
	assert.equal(read(dir), undefined);
	mkdirSync(join(dir, "trainboard"));
	assert.equal(read(dir), undefined);
});

// ---- the unit key

test("a train carries the key of the unit whose pane's token names it; a unit that names another train, a writer id in a file, and a second claim do not bind", () => {
	const dir = world();
	const joined = (trains: YardJoin["trains"], mains: string[] = []): YardJoin => ({ trains, mains: new Set(mains) });
	const keyOf = (j: YardJoin, code = M) => projectOf(read(dir, j)!, "acme").trains.find((t) => t.code === code)!.key;
	assert.equal(keyOf(joined([{ key: "sess-4001", project: "acme", code: M }])), "sess-4001", "the writer's own session");
	assert.equal(keyOf(joined([{ key: "sess-new", project: "acme", code: M }])), "sess-new", "a train restarted in its pane keeps its key by the pane's token, not by the writer id in the file");
	assert.equal(keyOf(joined([{ key: "sess-4001", project: "beta", code: M }, { key: "sess-4001", project: "acme", code: N }])), undefined, "another project's or another code's unit");
	assert.equal(keyOf(joined([{ key: "sess-a", project: "acme", code: M }, { key: "sess-b", project: "acme", code: M }])), undefined, "two units claim it and neither is the file's writer");
	assert.equal(keyOf(joined([{ key: "sess-a", project: "acme", code: M }, { key: "sess-4001", project: "acme", code: M }])), "sess-4001", "two claims: the writer's");
	assert.equal(keyOf(joined([{ key: "sess-4002", project: "acme", code: N }]), N), "sess-4002");
});

test("the integrator's key is its yard's writer, only when that session is a main of the net", () => {
	const dir = world();
	const beta = (mains: string[], over: object = {}) => projectOf(read(dir, { mains: new Set(mains) }, over)!, "beta").integrator;
	assert.deepEqual(beta(["sess-integ-beta"]), { key: "sess-integ-beta", live: true });
	assert.deepEqual(beta(["someone-else"]), { live: true });
	assert.deepEqual(beta(["sess-integ-beta"], { alive: () => false }), { key: "sess-integ-beta", live: false }, "whether its process runs is told apart from whether the net has the unit");
});

// ---- the acceptance chips and the car notices

test("a car's acceptance chips come from the evidence kinds on the board, with the boss's words from the train's own copy of the evidence; an unrelated, oversize or linked copy adds nothing", () => {
	const dir = state();
	writeBoard(dir, board("acme", M, { cars: [car({ accepted: ["e2e", "uat"] }), car({ tickets: ["T-2"], head: SHA_B, accepted: ["e2e"] }), car({ tickets: ["T-3"], head: SHA_C, accepted: ["e2e"] }), car({ tickets: ["T-4"], head: "d".repeat(40), accepted: undefined })] }));
	const folder = join(dir, "trainboard", "acme", M);
	const copy = (head: string, entries: object[]) => JSON.stringify({ v: 1, car: { app: "web", tickets: ["T-15"], branch: "fix/t-15", head }, accepted: entries });
	writeFileSync(join(folder, "car-1.json"), copy(SHA_A, [{ kind: "e2e", nod: "looks right, ship it\u202e" }, { kind: "uat", nod: "fine by me" }, { kind: "other", nod: "not on the board" }]));
	// well-formed but over the 32 KB cap: only the cap leaves its words out (TY-F008)
	writeFileSync(join(folder, "car-3.json"), copy(SHA_C, [{ kind: "e2e", nod: "n".repeat(40 * 1024) }]));
	writeFileSync(join(dir, "real.json"), copy(SHA_B, [{ kind: "e2e", nod: "linked" }]));
	symlinkSync(join(dir, "real.json"), join(folder, "car-4.json"));
	const cars = projectOf(read(dir)!, "acme").trains[0]!.cars;
	assert.deepEqual(cars[0]!.accepted, [{ kind: "e2e", nod: "looks right, ship it " }, { kind: "uat", nod: "fine by me" }]);
	assert.deepEqual(cars[1]!.accepted, [{ kind: "e2e" }], "a linked copy is not read: the chip has no words");
	assert.deepEqual(cars[2]!.accepted, [{ kind: "e2e" }], "an oversize copy is not read: the chip has no words");
	assert.deepEqual(cars[3]!.accepted, [], "no kinds on the board: no chip");
});

test("a car shows its newest state and whether sb has told its coordinator: delivered, escalated, or pending with its attempts", () => {
	const dir = state(), project = "acme";
	writeBoard(dir, board(project, M, { cars: [car({ tickets: ["T-1"], head: SHA_A }), car({ tickets: ["T-2"], head: SHA_B }), car({ tickets: ["T-3"], head: SHA_C }), car({ tickets: ["T-4"], head: "d".repeat(40) })] }));
	const folder = carsDir(dir, project);
	mkdirSync(folder, { recursive: true });
	const put = (head: string, ticket: string, states: [string, Record<string, unknown>][], notice?: NoticeRecord) => {
		let file = emptyCar({ project, app: "web", tickets: [ticket], branch: "b", head, coordinator: "sess-coord-1" });
		for (const [name, fields] of states) file = addState(file, { state: name as never, fields, by: { role: "main", name: "integ", session: "sess-i" }, at: iso(MIN) });
		const name = carFileName("web", head);
		writeFileSync(join(folder, name), JSON.stringify(file));
		if (notice) writeFileSync(join(folder, name.replace(/\.json$/, ".notice.json")), JSON.stringify(notice));
	};
	put(SHA_A, "T-1", [["received", { train: M, departs: "next" }]], { v: 1, states: { received: { attempts: [{ at: iso(MIN), outcome: "delivered" }], deliveredAt: iso(MIN) } } });
	put(SHA_B, "T-2", [["returned", { reason: "no" }]], { v: 1, states: { returned: { attempts: [{ at: iso(MIN), outcome: "queued", answer: "queued" }, { at: iso(MIN), outcome: "failed", answer: "boom\u0007" }] } } });
	put(SHA_C, "T-3", [["dropped", { round: 1, reason: "unit red", evidence: "/r/unit.log" }]], { v: 1, states: { dropped: { attempts: [{ at: iso(MIN), outcome: "not-live" }], escalatedAt: iso(MIN) } } });
	const cars = projectOf(read(dir)!, project).trains[0]!.cars;
	assert.deepEqual(cars[0]!.notice, { state: "received", status: "delivered", attempts: 1, at: iso(MIN) });
	assert.deepEqual(cars[1]!.notice, { state: "returned", status: "pending", attempts: 2, last: "boom " });
	assert.deepEqual(cars[2]!.notice, { state: "dropped", status: "escalated", attempts: 1, at: iso(MIN) });
	assert.equal(cars[3]!.notice, undefined, "a car with no car file has no notice");
});

test("a cars folder that is a link tells nothing", () => {
	const dir = state(), project = "acme";
	writeBoard(dir, board(project, M));
	const folder = carsDir(dir, project);
	mkdirSync(join(dir, "elsewhere"), { recursive: true });
	let file = emptyCar({ project, app: "web", tickets: ["T-15"], branch: "b", head: SHA_A, coordinator: "c" });
	file = addState(file, { state: "returned", fields: { reason: "no" }, by: { role: "main", name: "i", session: "s" }, at: iso(MIN) });
	writeFileSync(join(dir, "elsewhere", carFileName("web", SHA_A)), JSON.stringify(file));
	symlinkSync(join(dir, "elsewhere"), folder);
	assert.equal(projectOf(read(dir)!, project).trains[0]!.cars[0]!.notice, undefined, "the cars folder is a link: not read");
});

// ---- the fix round of task 5 (TY-F001 to TY-F008)

const SETTER = { role: "main" as const, name: "integ", session: "sess-i" };
/** A car file of `project` with one `received` state, its notice file (a record, or the raw text), and the board that carries it. */
function plantCar(dir: string, project: string, head: string, over: { notice?: unknown; raw?: string; file?: object; name?: string } = {}) {
	let file = emptyCar({ project, app: "web", tickets: ["T-1"], branch: "b", head, coordinator: "sess-coord-1" });
	file = addState(file, { state: "received", fields: { train: M, departs: "next" }, by: SETTER, at: iso(MIN) });
	const folder = carsDir(dir, project), name = over.name ?? carFileName("web", head);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, name), over.raw ?? JSON.stringify({ ...file, ...over.file }));
	if (over.notice !== undefined) writeFileSync(join(folder, name.replace(/\.json$/, ".notice.json")), JSON.stringify(over.notice));
	return join(folder, name);
}
const onBoard = (dir: string, project: string, heads: string[]) => writeBoard(dir, board(project, M, { cars: heads.map((head, i) => car({ tickets: [`T-${i + 1}`], head })) }));
const at = iso(MIN);

test("TY-F001: a notice record of the wrong shape shows that car as unreadable; every other project and car still reads, nothing throws", () => {
	const hostile: [string, unknown][] = [
		["answer is a number", { v: 1, states: { received: { attempts: [{ at, outcome: "failed", answer: 7 }] } } }],
		["an attempt has no at", { v: 1, states: { received: { attempts: [{ outcome: "failed" }] } } }],
		["outcome is not one of the outcomes", { v: 1, states: { received: { attempts: [{ at, outcome: "shrug" }] } } }],
		["tower is a string", { v: 1, states: { received: { attempts: [], tower: "abcdef" } } }],
		["tower is an object with a huge length", { v: 1, states: { received: { attempts: [], tower: { length: 1e9 } } } }],
		["deliveredAt is not an ISO time", { v: 1, states: { received: { attempts: [], deliveredAt: "1" } } }],
		["a state that is not a car state", { v: 1, states: { evil: { attempts: [] } } }],
		["an answer over its cap", { v: 1, states: { received: { attempts: [{ at, outcome: "failed", answer: "a".repeat(5000) }] } } }],
	];
	for (const [label, notice] of hostile) {
		const dir = state();
		writeBoard(dir, board("beta", M));
		onBoard(dir, "acme", [SHA_A, SHA_B]);
		plantCar(dir, "acme", SHA_A, { notice });
		plantCar(dir, "acme", SHA_B, { notice: { v: 1, states: { received: { attempts: [{ at, outcome: "delivered" }], deliveredAt: at } } } });
		const seam = trainyardSeam({ env: {}, stateDir: dir, now: () => NOW, alive, load: () => ({ now: 1, cores: 2 }), platform: "linux" });
		const yards = seam.yards({ trains: [], mains: new Set() })!;
		assert.equal(yards.problems, undefined, label);
		assert.deepEqual(yards.projects.map((p) => p.project), ["acme", "beta"], `${label}: the other project is still there`);
		const cars = projectOf(yards, "acme").trains[0]!.cars;
		assert.equal(cars[0]!.notice?.status, "unreadable", label);
		assert.match((cars[0]!.notice as { reason: string }).reason, /notice/, label);
		assert.deepEqual(cars[1]!.notice, { state: "received", status: "delivered", attempts: 1, at }, `${label}: the next car reads`);
	}
});

test("TY-F002, F003: a project with hundreds of car files shows the notice of the cars on its boards; only those files are read", () => {
	const dir = state();
	const heads = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(3, "0").padEnd(40, "0")), current = "f".repeat(40);
	for (const head of heads) plantCar(dir, "acme", head);
	// a file no board names that would fail the reading if it were opened
	writeFileSync(join(carsDir(dir, "acme"), "web-zzzzzzzzzzzz.json"), "x".repeat(70_000));
	plantCar(dir, "acme", current, { notice: { v: 1, states: { received: { attempts: [{ at, outcome: "delivered" }], deliveredAt: at } } } });
	onBoard(dir, "acme", [current, heads[0]!]);
	const cars = projectOf(read(dir), "acme").trains[0]!.cars;
	assert.deepEqual(cars[0]!.notice, { state: "received", status: "delivered", attempts: 1, at }, "the current car is not cut by the count of files");
	assert.equal(cars[1]!.notice?.status, "pending");
});

test("TY-F003: a reading has a budget of bytes; a car whose file is past it shows unreadable, not guessed", () => {
	const dir = state();
	onBoard(dir, "acme", [SHA_A, SHA_B, SHA_C]);
	for (const head of [SHA_A, SHA_B, SHA_C]) plantCar(dir, "acme", head);
	const cars = projectOf(read(dir, {}, { budget: 900 }), "acme").trains[0]!.cars;
	assert.equal(cars[0]!.notice?.status, "pending");
	const last = cars.at(-1)!.notice;
	assert.equal(last?.status, "unreadable");
	assert.match((last as { reason: string }).reason, /budget/);
});

test("TY-F005: a car file that fails shows unreadable with its reason; one in another project's folder is refused; a missing one tells nothing", () => {
	const dir = state();
	const heads = [SHA_A, SHA_B, SHA_C, "d".repeat(40), "e".repeat(40), "1".repeat(40)];
	onBoard(dir, "acme", heads);
	plantCar(dir, "acme", SHA_A, { raw: "{not json" });
	plantCar(dir, "acme", SHA_B, { file: { project: "zeta" } });
	plantCar(dir, "acme", SHA_C, { file: { coordinator: "" } });
	// well-formed car file padded past 64 KB: only the size cap refuses it
	plantCar(dir, "acme", "d".repeat(40), { file: { car: { tickets: Array.from({ length: 1500 }, (_, i) => `T-${i}-${"x".repeat(50)}`), branch: "b", head: "d".repeat(40) } } });
	plantCar(dir, "acme", "e".repeat(40), { notice: { v: 1, states: { received: { attempts: [{ at, outcome: "failed", answer: "boom" }], deliveredAt: at, pad: "x".repeat(70_000) } } } });
	const notices = projectOf(read(dir), "acme").trains[0]!.cars.map((c) => c.notice);
	assert.match((notices[0] as { reason: string }).reason, /not JSON/);
	assert.match((notices[1] as { reason: string }).reason, /project zeta is not the folder's acme/);
	assert.equal(notices[2]!.status, "unreadable");
	assert.match((notices[3] as { reason: string }).reason, /more than 64 KB/);
	assert.equal(notices[4]!.status, "unreadable", "a notice file over the cap is no record, and the car does not look unsent");
	assert.equal(notices[5], undefined, "no car file at all: nothing to tell");
	assert.ok(notices.slice(0, 5).every((n) => n?.status === "unreadable"));
});

test("TY-F007: the load of the net is a whole number, so a reading that moved by a tenth is not a new snapshot", () => {
	const seam = (now: number) => trainyardSeam({ env: {}, stateDir: state(), load: () => ({ now, cores: 8 }), platform: "linux" }).load();
	assert.deepEqual(seam(41.6), { now: 42, cores: 8 });
	assert.deepEqual(seam(41.4), { now: 41, cores: 8 });
});

test("TY-F008: no more than 64 projects are read, and no more than 32 copies of the evidence; a reason that names the state folder says <state>", () => {
	const dir = state();
	for (let i = 0; i < 65; i++) writeYard(dir, { v: 1, project: `p${String(i).padStart(2, "0")}`, writer: writer(4300), updated: iso(MIN), trains: [] });
	const many = read(dir)!;
	assert.equal(many.projects.length, 64);
	assert.equal(many.truncated, true);
	const copies = state();
	const heads = Array.from({ length: 40 }, (_, i) => (i === 39 ? SHA_A : `${(i + 16).toString(16).padStart(2, "0")}`.repeat(20)));
	writeBoard(copies, board("acme", M, { cars: [car({ head: SHA_A, accepted: ["e2e"] })] }));
	const folder = join(copies, "trainboard", "acme", M);
	heads.forEach((head, i) => writeFileSync(join(folder, `car-${String(i + 1).padStart(3, "0")}.json`), JSON.stringify({ v: 1, car: { app: "web", tickets: ["T"], branch: "b", head }, accepted: [{ kind: "e2e", nod: "yes" }] })));
	assert.deepEqual(projectOf(read(copies), "acme").trains[0]!.cars[0]!.accepted, [{ kind: "e2e" }], "the 40th copy is past the 32 read");
	writeFileSync(join(folder, "car-001.json"), JSON.stringify({ v: 1, car: { app: "web", tickets: ["T"], branch: "b", head: SHA_A }, accepted: [{ kind: "e2e", nod: "yes" }] }));
	assert.deepEqual(projectOf(read(copies), "acme").trains[0]!.cars[0]!.accepted, [{ kind: "e2e", nod: "yes" }], "within the 32, it is read");
});

test("TY-F008: a project folder that cannot be listed is told with <state> in place of the path", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
	const dir = state();
	writeBoard(dir, board("acme", M));
	const locked = join(dir, "trainboard", "acme");
	chmodSync(locked, 0o000);
	try {
		const yards = read(dir)!;
		const told = (yards.problems ?? []).join("\n");
		assert.match(told, /cannot list <state>\/trainboard\/acme/);
		assert.ok(!told.includes(dir), told);
	} finally { chmodSync(locked, 0o700); }
});

// ---- the server world: the GUI of a running sb server

/** The first snapshot the server's GUI streams, as a page gets it. */
const snapshot = (w: ServerWorld) => new Promise<Net>((resolve, reject) => {
	const { port, token } = w.record()!.gui!;
	const req = get(`http://127.0.0.1:${port}/${token}/events`, (res) => {
		let buffer = "";
		res.setEncoding("utf8").on("data", (chunk: string) => {
			buffer += chunk;
			const data = buffer.split("\n\n").slice(0, -1).filter((x) => !/^event: (?!net$)/m.test(x)).map((x) => /^data: (.*)$/m.exec(x)?.[1]).find(Boolean);
			if (data) (req.destroy(), resolve(JSON.parse(data) as Net));
		});
	});
	req.on("error", reject);
});
const served = async (env: NodeJS.ProcessEnv, plant: (stateDir: string) => void) => {
	const w = new TowerWorld();
	Object.assign(w.env, env);
	plant(w.slot.stateDir);
	await w.start({ gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200, trainyard: { load: () => ({ now: 7.04, cores: 8 }), alive: () => true, now: () => NOW } } });
	await until(() => Boolean(w.record()?.gui?.port), "the GUI");
	return w;
};

test("the sb server's GUI streams the trains of the state folder with the load, and nothing when the merge train is off", async () => {
	const on = await served({}, (dir) => { writeBoard(dir, board("acme", M, { steps: [step(1, "full-check", "in_progress", { load: { max: 4 } })] })); });
	try {
		const net = await snapshot(on);
		assert.deepEqual(net.yards!.projects.map((p) => [p.project, p.trains.map((t) => [t.code, t.state, t.steps[0]!.waits])]), [["acme", [[M, "live", [{ load: { max: 4, now: 7 } }]]]]]);
		assert.deepEqual(net.load, { now: 7, cores: 8 });
	} finally { await on.close(); }
	for (const env of [{ STRAW_BOSS_INTEGRATION: "off" }, { STRAW_BOSS_DESK: "1" }]) {
		const off = await served(env, (dir) => { writeBoard(dir, board("acme", M)); });
		try {
			const net = await snapshot(off);
			assert.ok(!("yards" in net) && !("load" in net), JSON.stringify(env));
		} finally { await off.close(); }
	}
});

test("T7: a train whose round left cars out shows them as ticket and plain-text reason; a board without them shows none, and markup stays inert text", () => {
	const dir = state();
	writeBoard(dir, board("acme", M, { round: 2, removed: [{ ticket: "T-12", why: "unit red <b>3</b>\u0007\u202e" }, { ticket: "<i>T-13</i>\u0000", why: "r".repeat(600) }] }));
	writeBoard(dir, board("acme", N));
	const acme = projectOf(read(dir)!, "acme"), m = acme.trains.find((t) => t.code === M)!, n = acme.trains.find((t) => t.code === N)!;
	assert.deepEqual(m.removed![0], { ticket: "T-12", why: "unit red <b>3</b>  " });
	assert.equal(m.removed![1]!.ticket, "<i>T-13</i> ");
	assert.ok(m.removed![1]!.why.length <= 300, "the reason is cut for the page");
	assert.equal("removed" in n, false);
	writeFileSync(boardPath(dir, "acme", M), JSON.stringify({ ...board("acme", M, { round: 2 }), removed: [{ ticket: "T-12", why: "x", evidence: "/p" }] }));
	assert.equal(projectOf(read(dir)!, "acme").trains.find((t) => t.code === M)!.state, "unreadable", "a board whose removed is out of shape is refused, as any other field");
});
