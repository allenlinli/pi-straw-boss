import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import type { ProjectYard, YardCar, YardFormingRow, YardStep, YardTrainRow } from "../src/train/yardview.ts";
import { El } from "./fake-dom.ts";
import { getLocale, overwriteGetLocale } from "../gui/paraglide/runtime.js";

// Task 7 of the train workers (docs/specs/2026-11-07-train-workers.md §11.2): the page's model of the yards (gui/trains.ts, pure) and the yard it draws (gui/yard.ts). Words are read in zh-TW, the first language;
// every field of a yard is a model's own text, so the drawing must keep it text.

let locale: "zh-TW" | "en" = "zh-TW";
overwriteGetLocale(() => locale);
const T = await import("../gui/trains.ts");
const { drawProject } = await import("../gui/yard.ts");
const en = <R>(run: () => R): R => { locale = "en"; try { return run(); } finally { locale = "zh-TW"; } };
void getLocale;

const NOW = Date.parse("2026-11-08T10:00:00Z"), MIN = 60_000;
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const SHA = "a".repeat(40);
const CTX = { now: NOW, load: { now: 42, cores: 14 } };
const car = (over: Partial<YardCar> = {}): YardCar => ({ tickets: ["T-15"], branch: "fix/t-15", head: SHA, departs: "next", accepted: [{ kind: "e2e", nod: "好，上車" }, { kind: "uat" }], ...over });
const step = (id: number, kind: YardStep["kind"], status: YardStep["status"], over: Partial<YardStep> = {}): YardStep => ({ id, kind, name: kind, status, round: 1, waits: [], ...over });
const train = (code: string, over: Partial<YardTrainRow> = {}): YardTrainRow => ({ code, app: "web", state: "live", round: 1, cars: [car()], steps: [step(1, "assemble", "completed", { outcome: "passed" }), step(2, "merge", "in_progress")], ...over });
const M = "2026-11-06-m", N = "2026-11-06-n", S = "2026-11-05-k", E = "2026-11-04-a", U = "2026-11-03-b";
const project = (over: Partial<ProjectYard> = {}): ProjectYard => ({
	project: "acme", forming: [], waiting: [N], trains: [
		train(M, { key: "u-m" }),
		train(N, { key: "u-n", steps: [step(1, "full-check", "in_progress", { name: "unit", load: { max: 30, weight: 4 }, waits: [{ load: { max: 30, now: 42 } }, { lane: { app: "web", holder: M } }] })] }),
		train(S, { state: "stale" }), train(E, { state: "ended", steps: [step(1, "land", "completed", { outcome: "passed" })] }), train(U, { state: "unreadable", reason: "cannot parse", cars: [], steps: [] }),
	], ...over,
});

test("counts: live trains, how many run and wait, the trains that wait on each other, and the stalled and forming ones", () => {
	const p = project({ forming: [{ code: "2026-11-08-a", app: "web", status: "forming", cars: [car()] }] });
	assert.deepEqual(T.countsOf(p), { trains: 2, running: 1, waiting: 1, mutual: 1, stale: 1, forming: 1, departing: 0, refused: 0, ended: 1, unreadable: 1 });
	assert.equal(T.headWords(T.countsOf(p)), "2 列火車：1 運行、1 等待（互相等待 1）");
	assert.equal(T.headWords(T.countsOf(project({ waiting: [], trains: [train(M)] }))), "1 列火車：1 運行、0 等待", "no 互相等待 when none");
	assert.equal(en(() => T.headWords(T.countsOf(p))), "2 trains: 1 running, 1 waiting (waiting on each other: 1)");
	assert.equal(T.countsOf(project({ waiting: ["2026-11-01-z"] })).mutual, 0, "a code no row has is no train that waits");
});

test("the base chip: 火車 3（等待 2）, without the parentheses when none waits, stalled, forming, and the plain yard", () => {
	const c = (over: Partial<ReturnType<typeof T.countsOf>>) => ({ trains: 0, running: 0, waiting: 0, mutual: 0, stale: 0, forming: 0, departing: 0, refused: 0, ended: 0, unreadable: 0, ...over });
	assert.equal(T.chipWords(c({ trains: 3, running: 1, waiting: 2 })), "火車 3（等待 2）");
	assert.equal(T.chipWords(c({ trains: 3, running: 3 })), "火車 3");
	assert.equal(T.chipWords(c({ stale: 2 })), "火車停滯 2");
	assert.equal(T.chipWords(c({ forming: 1 })), "編組中 1");
	assert.equal(T.chipWords(c({ forming: 1, departing: 2 })), "編組中 3", "a departing train is still on the yard's way out: the chip counts it with the forming");
	assert.equal(T.chipWords(c({ refused: 1 })), "調車場", "a refused train is a finished one: no chip of its own");
	assert.equal(T.chipWords(c({ ended: 4 })), "調車場");
	assert.equal(en(() => T.chipWords(c({ trains: 3, running: 1, waiting: 2 }))), "Trains 3 (2 waiting)");
});

const forming = (code: string, status: YardFormingRow["status"]): YardFormingRow => ({ code, app: "web", status, cars: [car()] });
test("V-F001: the header counts every train of the yard by state: the stalled, forming, departing, refused and unreadable ones beside the live, so a red card never sits under a header that says zero", () => {
	const p = project({ forming: [forming("2026-11-08-a", "forming"), forming("2026-11-08-b", "departing"), forming("2026-11-08-c", "refused")] });
	assert.equal(T.othersWords(T.countsOf(p)), "停滯 1 · 編組中 1 · 出發中 1 · 被拒絕 1 · 讀不到 1");
	assert.equal(en(() => T.othersWords(T.countsOf(p))), "1 stalled · 1 forming · 1 departing · 1 refused · 1 unreadable");
	assert.equal(T.othersWords(T.countsOf(project({ trains: [train(M)], waiting: [] }))), "", "nothing else to say: nothing said");
	assert.equal(T.othersWords(T.countsOf(project({ waiting: [], trains: [train(E, { state: "ended" })] }))), "", "the ended ones have their fold");
	const only = T.projectView(project({ waiting: [], trains: [train(S, { state: "stale" })] }), CTX, () => undefined);
	assert.deepEqual([only.head, only.others], ["0 列火車：0 運行、0 等待", "停滯 1"]);
	const root = drawProject(only) as unknown as El;
	assert.equal(root.find((el) => el.classes.has("yard-others"))[0]!.textContent, "停滯 1", "the sheet's header says it");
	assert.equal((drawProject(T.projectView(project({ waiting: [], trains: [train(M)] }), CTX, () => undefined)) as unknown as El).find((el) => el.classes.has("yard-others")).length, 0, "no empty span");
});

test("load in the header: 負載 42／14 核, and its absence said", () => {
	assert.equal(T.loadWords({ now: 42, cores: 14 }), "負載 42／14 核");
	assert.equal(T.loadWords(undefined), "這個系統沒有負載讀數");
});

test("a wait in words (§7.3): load, lock with and without its holder, lane and target by the holder's short code, and a stalled or unreadable holder", () => {
	assert.equal(T.waitWords({ load: { max: 30, now: 42 } }), "等負載 ≤30（現在 42）");
	assert.equal(T.waitWords({ lock: { name: "heavy", holder: { train: "2026-11-07-d", step: 3 } } }), "等鎖 heavy（train 1107d 持有）");
	assert.equal(T.waitWords({ lock: { name: "heavy" } }), "等鎖 heavy");
	assert.equal(T.waitWords({ lane: { app: "web", holder: "2026-11-06-l" } }), "等 1106l 合併道（web）");
	assert.equal(T.waitWords({ target: { target: "target-a", holder: "2026-11-06-l" } }), "等 1106l 部署目標（target-\u2060a）");
	assert.equal(T.waitWords({ lane: { app: "web", holder: "2026-11-06-l", why: "stale" } }), "等 1106l 合併道（web）（它已停滯）");
	assert.equal(T.waitWords({ target: { target: "t", holder: "2026-11-06-l", why: "unreadable" } }), "等 1106l 部署目標（t）（它的看板讀不到）");
	assert.equal(en(() => T.waitWords({ load: { max: 30, now: 42 } })), "waiting for load ≤30 (now 42)");
});

test("the CPU a step needs: its load limit (or the per-core factor against the cores) and its weight", () => {
	assert.equal(T.needWords({ max: 30, weight: 4 }, 14), "需負載 ≤30，約 4 核");
	assert.equal(T.needWords({ perCore: 2, weight: 4 }, 14), "需負載 ≤28，約 4 核");
	assert.equal(T.needWords({ perCore: 2 }, undefined), "需負載 ≤每核 2");
	assert.equal(T.needWords({ weight: 4 }, 14), "約 4 核");
	assert.equal(T.needWords(undefined, 14), "");
});

test("the round text names the car a re-assembly removed and why; round 1 and a round that removed nothing say only the round", () => {
	assert.equal(T.roundWords(train(M, { round: 1 })), "第 1 次組裝");
	assert.equal(T.roundWords(train(M, { round: 2 })), "第 2 次組裝");
	assert.equal(T.roundWords(train(M, { round: 2, removed: [{ ticket: "T-12", why: "unit 紅" }] })), "第 2 次組裝：移除 T-12（unit 紅）");
	assert.equal(T.roundWords(train(M, { round: 3, removed: [{ ticket: "T-12", why: "unit 紅" }, { ticket: "T-13", why: "lint" }] })), "第 3 次組裝：移除 T-12（unit 紅）、T-13（lint）");
	assert.equal(en(() => T.roundWords(train(M, { round: 2, removed: [{ ticket: "T-12", why: "unit red" }] }))), "Round 2: removed T-12 (unit red)");
});

test("a car's acceptance is a chip: the kinds in words, the boss's nod in its tooltip, a kind with no quoted nod said so, and no acceptance said as such", () => {
	const chip = T.acceptedChip(car());
	assert.equal(chip.text, "已驗收：e2e、UAT");
	assert.deepEqual(chip.nods, ["e2e：好，上車", "UAT：沒有留存核可的話"], "the boss's words are lines of the page, not a tooltip");
	assert.deepEqual(T.acceptedChip(car({ accepted: [] })).nods, []);
	assert.equal(T.acceptedChip(car({ accepted: [] })).text, "免驗收");
	assert.equal(T.acceptedChip(car({ accepted: [{ kind: "smoke test" }] })).text, "已驗收：smoke test", "another kind shows as the evidence names it");
	assert.deepEqual(T.acceptedChip(car({ accepted: [], unverified: true })), { text: "驗收不明", nods: [] }, "evidence the code could not check claims nothing, and is not 免驗收 (TB-F003)");
});

test("a car the round removed shows its notice line under the train, in the page's words (TB-F004)", () => {
	const v = T.trainView(train(M, { round: 2, removed: [{ ticket: "T-12", why: "unit 紅", notice: { state: "dropped", status: "pending", attempts: 2, last: "queued" } }, { ticket: "T-13", why: "lint" }] }), CTX);
	assert.deepEqual(v.removedNotices.map((n) => [n.text, n.tone, n.detail]), [["通知中 T-12：被移出（重試 2）", "pending", "最後一次回覆：queued"]]);
});

test("a car's departure condition: alone, with another car, after and by a time; the default `next` says nothing; a clause it does not know shows as written", () => {
	assert.deepEqual(T.conditionLines(car({ departs: "alone" })), ["T-15：單獨出車"]);
	assert.deepEqual(T.conditionLines(car({ departs: "next" })), []);
	assert.deepEqual(T.conditionLines(car({ departs: "with T-9, alone" })), ["T-15：等 T-9 同車", "T-15：單獨出車"]);
	const after = T.conditionLines(car({ departs: "after 2026-11-08T12:00:00Z" }))[0]!, by = T.conditionLines(car({ departs: "by 2026-11-08T12:00:00Z" }))[0]!;
	assert.match(after, /^T-15：.+ 後才出車$/);
	assert.match(by, /^T-15：最晚 .+ 出車$/);
	assert.deepEqual(T.conditionLines(car({ departs: "when the moon is up" })), ["when the moon is up"]);
	const row: YardFormingRow = { code: "2026-11-08-a", app: "web", status: "forming", cars: [car()], departs: { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) } };
	assert.equal(T.formingWords(row, NOW), "滿 4 節或 60 分（還 23 分）");
	assert.equal(T.formingWords({ ...row, departs: { ...row.departs!, oldest: iso(90 * MIN) } }, NOW), "滿 4 節或 60 分（時間到）");
	assert.equal(T.formingWords({ ...row, departs: undefined }, NOW), undefined);
});

test("each car's notice line: told, telling with its try, reported up, and one that cannot be read said so", () => {
	const told = T.noticeLine(car({ tickets: ["T-12"], notice: { state: "landed", status: "delivered", attempts: 1, at: iso(MIN) } }))!;
	assert.deepEqual([told.text, told.tone], ["已通知 T-12：已落地", "told"]);
	const pending = T.noticeLine(car({ tickets: ["T-15"], notice: { state: "returned", status: "pending", attempts: 2, last: "queued" } }))!;
	assert.deepEqual([pending.text, pending.tone, pending.detail, pending.title], ["通知中 T-15：退回（重試 2）", "pending", "最後一次回覆：queued", undefined], "the broker's last answer is text on the card, not a tooltip");
	assert.equal(T.noticeLine(car({ notice: { state: "received", status: "pending", attempts: 0 } }))!.text, "通知中 T-15：已收件");
	assert.equal(T.noticeLine(car({ notice: { state: "received", status: "pending", attempts: 0, journal: true } }))!.text, "通知中 T-15：已收件（取自檔案紀錄）", "a notice read from the journal on disk says so (TB-F005)");
	assert.equal(T.noticeLine(car({ tickets: ["T-9"], notice: { state: "dropped", status: "escalated", attempts: 4, at: iso(MIN) } }))!.text, "已上報塔台：T-9 的送車者聯絡不上");
	const bad = T.noticeLine(car({ notice: { status: "unreadable", reason: "the car file is a link" } }))!;
	assert.deepEqual([bad.text, bad.tone], ["讀不到 T-15 的通知紀錄：the car file is a link", "unreadable"], "a reason the server gave no kind to shows as text only");
	const sized = T.noticeLine(car({ notice: { status: "unreadable", reason: "file is 70 KB, more than 64 KB", kind: "toobig" } }))!;
	assert.deepEqual([sized.text, sized.title], ["讀不到 T-15 的通知紀錄：檔案超過大小上限", "file is 70 KB, more than 64 KB"], "V-F002: a known kind is a sentence of the page, the reader's own words in the tooltip");
	assert.equal(en(() => T.noticeLine(car({ notice: { status: "unreadable", reason: "file is 70 KB, more than 64 KB", kind: "toobig" } }))!.text), "Notice of T-15 unreadable: the file is over the size limit");
	assert.equal(T.noticeLine(car({ notice: { status: "unreadable", reason: "x", kind: "from-the-future" as never } }))!.text, "讀不到 T-15 的通知紀錄：x", "a kind the page does not know shows the server's text");
	assert.equal(T.noticeLine(car()), undefined, "no notice file, nothing said");
});

test("a train's steps are pills by kind coloured by state and outcome; a step in progress that waits is waiting", () => {
	const v = T.trainView(project().trains[1]!, CTX);
	assert.deepEqual(v.pills.map((p) => [p.text, p.state]), [["全檢查 · unit", "waiting"]]);
	const w = T.trainView(train(M, { steps: [
		step(1, "assemble", "completed", { outcome: "passed" }), step(2, "review", "completed", { outcome: "failed" }), step(3, "full-check", "completed", { outcome: "void", why: "superseded", name: "lint" }),
		step(4, "merge", "completed", { outcome: "void", why: "skipped" }), step(5, "ci", "in_progress"), step(6, "deploy-verify", "pending"), step(7, "rollback", "pending"), step(8, "land", "pending"), step(9, "deploy", "pending"),
	] }), CTX);
	assert.deepEqual(w.pills.map((p) => [p.text, p.state]), [["組裝", "passed"], ["審查", "failed"], ["全檢查 · lint", "void"], ["合併", "void"], ["CI/CD", "running"], ["部署驗證", "pending"], ["回滾", "pending"], ["落地", "pending"], ["部署", "pending"]]);
	assert.equal(w.pills[2]!.title, "全檢查：作廢（被重組取代）");
	assert.equal(w.pills[4]!.title, "CI/CD：進行中");
	assert.equal(w.pills[1]!.current, false);
	assert.equal(w.pills[4]!.current, true, "the step in progress is the current one");
});

test("a train's row: the short code, app, tickets, round, the wait in words, the load it needs, and each car's lines", () => {
	const v = T.trainView(project().trains[1]!, CTX);
	assert.deepEqual([v.short, v.app, v.status, v.key], ["1106n", "web", "waiting", "u-n"]);
	assert.equal(v.round, "第 1 次組裝");
	assert.equal(v.wait, "等負載 ≤30（現在 42）、等 1106m 合併道（web）");
	assert.equal(v.need, "需負載 ≤30，約 4 核");
	assert.deepEqual(v.tickets, ["T-15"]);
	assert.equal(v.cars[0]!.accepted.text, "已驗收：e2e、UAT");
	const running = T.trainView(project().trains[0]!, CTX);
	assert.deepEqual([running.status, running.wait, running.need], ["running", "", ""]);
	assert.equal(T.trainView(project().trains[2]!, CTX).status, "stale");
	assert.equal(T.trainView(project().trains[3]!, CTX).status, "ended");
});

test("a board that cannot be read shows as such with its reason and nothing else of the train", () => {
	const v = T.trainView(project().trains[4]!, CTX);
	assert.deepEqual([v.status, v.reason, v.pills, v.cars], ["unreadable", "讀不到：cannot parse", [], []]);
	assert.equal(v.short, "1103b", "its code is still said");
	assert.equal(v.reasonTitle, undefined, "no kind, nothing to put beside the text");
});

test("V-F002: the reason of a board the server gave a kind to is a sentence of the page's language, and the reader's English stays in the tooltip", () => {
	const kinds = [["toobig", "檔案超過大小上限"], ["budget", "這次讀取的位元組額度用完了"], ["notfile", "不是一般檔案（可能是連結）"], ["notjson", "內容不是有效的 JSON"], ["io", "檔案讀取失敗"], ["misplaced", "檔案屬於別處（代號、專案或檔名對不上）"], ["shape", "格式不對"], ["failed", "讀取時出錯"]] as const;
	for (const [kind, said] of kinds) {
		const v = T.trainView(train(U, { state: "unreadable", reason: "cannot read: the board is over 64 KB", reasonKind: kind, cars: [], steps: [] }), CTX);
		assert.deepEqual([v.reason, v.reasonTitle], [`讀不到：${said}`, "cannot read: the board is over 64 KB"], kind);
		assert.doesNotMatch(v.reason!, /[a-z]{4,}/, `${kind}: no English in the zh view`);
		assert.doesNotMatch(en(() => T.trainView(train(U, { state: "unreadable", reason: "x", reasonKind: kind, cars: [], steps: [] }), CTX).reason!), /[一-鿿]/, `${kind}: no Chinese in the en view`);
	}
	const bad = T.projectView({ project: "acme", forming: [], trains: [], waiting: [], problem: "yard.json: not JSON (Unexpected token)", problemKind: "notjson" }, CTX, () => undefined);
	assert.deepEqual([bad.problem, bad.problemTitle], ["調車場讀不到：內容不是有效的 JSON", "yard.json: not JSON (Unexpected token)"]);
	const root = drawProject(bad) as unknown as El;
	assert.equal(root.find((el) => el.classes.has("yard-problem"))[0]!.getAttribute("title"), "yard.json: not JSON (Unexpected token)");
	assert.equal(root.textContent.includes("Unexpected"), false, "the reader's English is not in the page's lines");
});

test("V-F008: the departure conditions are said for the cars that wait to leave (forming, departing); a train that left says none, stalled or not", () => {
	const waits = car({ tickets: ["T-16"], departs: "with T-15" });
	const running = T.trainView(train(M, { cars: [waits] }), CTX), stalled = T.trainView(train(S, { state: "stale", cars: [waits] }), CTX);
	assert.deepEqual([running.cars[0]!.conditions, stalled.cars[0]!.conditions], [[], []]);
	const f = T.projectView(project({ forming: [{ ...forming("2026-11-08-a", "forming"), cars: [waits] }] }), CTX, () => undefined).forming[0]!;
	assert.deepEqual(f.cars[0]!.conditions, ["T-16：等 T-15 同車"], "a forming train still says it");
});

test("a unit card's note for a train: the step in progress and its wait; none when no step runs", () => {
	const net = unitsNet();
	const notes = T.trainNotes(net, CTX);
	assert.equal(notes.get("u-n"), "全檢查 · unit：等負載 ≤30（現在 42）、等 1106m 合併道（web）");
	assert.equal(notes.get("u-m"), "合併（進行中）");
	assert.equal(notes.has("u-s"), false);
	assert.equal(notes.has("main-1"), false, "a unit that is no train gets none");
});

/** A net with one base holding the integrator (a main) and the units of M and N, and the yard of acme. */
function unitsNet(over: Partial<Net> = {}): Net {
	const unit = (key: string, role: Unit["role"]): Unit => ({ id: key, key, control: true, name: key, role, mark: "working", subs: [] });
	return {
		bases: [{ id: "w1", label: "Harbor", mark: "working", tower: null, outposts: [], outside: [], tabs: [{ id: "w1:t1", label: "integ", units: [unit("main-1", "main"), unit("u-m", "train"), unit("u-n", "train")] }] }],
		yards: { projects: [project({ integrator: { key: "main-1", live: true } }), { ...project(), project: "beta", integrator: undefined, trains: [train("2026-11-06-p")] }] }, load: { now: 42, cores: 14 }, ...over,
	};
}

test("V-F005: the units of the trains that wait are told apart from those that run, so the card can say waiting and not idle", () => {
	assert.deepEqual([...T.trainWaits(unitsNet())], ["u-n"]);
	assert.deepEqual([...T.trainWaits({})], []);
});

test("the map: a project's yard hangs on the base that holds its integrator or one of its trains; one with no unit anywhere is loose; the integrator's card opens its yard", () => {
	const map = T.yardMap(unitsNet());
	assert.deepEqual([...map.byBase], [["w1", ["acme"]]]);
	assert.deepEqual(map.loose, ["beta"]);
	assert.deepEqual([...map.integrators], [["main-1", "acme"]]);
	assert.deepEqual(T.yardMap({ bases: [] }).loose, []);
	const gone = T.yardMap(unitsNet({ yards: { projects: [project({ integrator: { live: false } })] } }));
	assert.deepEqual([...gone.byBase], [["w1", ["acme"]]], "the trains' own units still place it after the integrator left");
});

test("Zen's strip counts the live trains and those that wait, nothing more", () => {
	assert.deepEqual(T.zenTrains(unitsNet()), { count: 3, waiting: 1 });
	assert.deepEqual(T.zenTrains({}), { count: 0, waiting: 0 });
	assert.deepEqual(T.zenTrains(undefined), { count: 0, waiting: 0 });
});

// ---- the drawing

const text = (el: El) => el.textContent;
test("the yard draws the header counts, the forming trains, a row per train with its pills, and the ended ones folded", () => {
	const view = T.projectView(project({ forming: [{ code: "2026-11-08-a", app: "web", status: "forming", cars: [car({ departs: "alone", notice: { state: "received", status: "delivered", attempts: 1, at: iso(MIN) } })], departs: { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) } }], integrator: { key: "main-1", live: true } }), CTX, (key) => (key ? { ws: "w1", key } : undefined));
	const root = drawProject(view) as unknown as El;
	const all = text(root);
	for (const part of ["調車場 · acme", "2 列火車：1 運行、1 等待（互相等待 1）", "負載 42／14 核", "編組中", "滿 4 節或 60 分（還 23 分）", "T-15：單獨出車", "已通知 T-15：已收件", "1106m", "1106n", "等負載 ≤30（現在 42）、等 1106m 合併道（web）", "需負載 ≤30，約 4 核", "已驗收：e2e、UAT", "已結束的火車（1）", "停滯：工作階段已不在", "讀不到：cannot parse"]) assert.ok(all.includes(part), part);
	const chip = root.find((el) => el.classes.has("yard-chip") && el.textContent === "已驗收：e2e、UAT")[0]!;
	assert.equal(chip.tag, "summary", "V-F009: the chip opens the boss's words (a disclosure a key or a tap reaches), it is not a tooltip");
	assert.equal(chip.getAttribute("title"), null);
	assert.deepEqual(chip.parent!.find((el) => el.tag === "li").map((li) => li.textContent), ["e2e：好，上車", "UAT：沒有留存核可的話"]);
	assert.equal(root.find((el) => el.classes.has("yard-chip") && el.textContent === "免驗收").every((el) => el.tag === "span"), true, "no acceptance: a plain chip");
	const pills = root.find((el) => el.classes.has("yard-pill"));
	assert.ok(pills.length >= 3);
	assert.ok(pills.every((p) => ["pending", "running", "waiting", "passed", "failed", "void"].includes(p.dataset.state ?? "")), "coloured by state through data-state");
	const rowLink = root.find((el) => el.tag === "a" && el.classes.has("yard-code") && el.textContent === "1106n")[0]!;
	assert.match(rowLink.getAttribute("data-route")!, /u-n/, "the code links to the train's comms");
});

test("V-F009: the broker's last answer is on the notice's own line, not in a tooltip", () => {
	const view = T.projectView(project({ trains: [train(M, { cars: [car({ notice: { state: "returned", status: "pending", attempts: 2, last: "queued" } })] })], waiting: [] }), CTX, () => undefined);
	const line = (drawProject(view) as unknown as El).find((el) => el.classes.has("yard-notice"))[0]!;
	assert.ok(line.textContent.includes("通知中 T-15：退回（重試 2）") && line.textContent.includes("最後一次回覆：queued"), line.textContent);
	assert.equal(line.getAttribute("title"), null);
});

test("hostile text stays text: no markup, link, route or handler comes from what a train or car wrote", () => {
	const evil = "<img src=x onerror=alert(1)>";
	const p = project({
		project: "acme", forming: [{ code: "2026-11-08-a", app: evil, status: "forming", cars: [car({ tickets: [evil], branch: evil, departs: `${evil} javascript:alert(1)`, accepted: [{ kind: evil, nod: evil }], notice: { state: "landed", status: "pending", attempts: 1, last: evil } })] }],
		trains: [train(M, { app: evil, round: 2, removed: [{ ticket: evil, why: `[x](javascript:alert(1)) ${evil}` }], cars: [car({ tickets: [evil], notice: { status: "unreadable", reason: evil } })], steps: [step(1, "merge", "in_progress", { name: evil, waits: [{ lane: { app: evil, holder: M } }, { lock: { name: evil } }] })] })],
	});
	const root = drawProject(T.projectView(p, CTX, () => undefined)) as unknown as El;
	const tags = new Set(root.find(() => true).map((el) => el.tag));
	for (const bad of ["img", "script", "iframe", "style", "svg", "object"]) assert.ok(!tags.has(bad), `no ${bad} element`);
	for (const el of root.find(() => true)) {
		for (const name of el.attrs.keys()) assert.ok(!/^on/i.test(name), `${name} is no handler`);
		if (el.tag === "a") assert.ok(!/javascript:/i.test(el.getAttribute("href") ?? ""), "no link made of the text");
	}
	const links = root.find((el) => el.tag === "a");
	assert.ok(links.every((a) => /^(w|\.)/.test(a.getAttribute("href") ?? "") || a.getAttribute("href") === null), "a link is one of the page's own routes");
	assert.ok(root.textContent.includes(evil), "the text is there, as text");
});

test("a train row without a unit has no link; with the net's unit it links to its comms by the page's route", () => {
	const view = T.projectView(project(), CTX, (key) => (key === "u-n" ? { ws: "w1", key } : undefined));
	const root = drawProject(view) as unknown as El;
	const linked = root.find((el) => el.tag === "a" && el.classes.has("yard-code"));
	assert.deepEqual(linked.map((a) => a.textContent), ["1106n"]);
	assert.match(linked[0]!.getAttribute("data-route")!, /u-n/);
	assert.ok(root.find((el) => el.classes.has("yard-code") && el.tag === "span").length >= 1, "a train with no unit is plain text");
});

test("a project with no train and no problem says so; a yard that could not be read says why; a cut reading says it was cut", () => {
	const empty = drawProject(T.projectView({ project: "acme", forming: [], trains: [], waiting: [] }, CTX, () => undefined)) as unknown as El;
	assert.ok(empty.textContent.includes("還沒有火車"));
	const bad = drawProject(T.projectView({ project: "acme", forming: [], trains: [], waiting: [], problem: "yard.json: cannot read" }, CTX, () => undefined)) as unknown as El;
	assert.ok(bad.textContent.includes("調車場讀不到：yard.json: cannot read"));
});
