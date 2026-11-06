import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllyBase, LinkAlert } from "../src/link/holder.ts";
import { alertLine, allyMark, countdown, CRASH_FRESH_MS, dialogState, hasLinkNews, lastSeen, reportPeek, stateName, unitCards, unitsFor, unitWord, urgentFirst } from "../gui/linkmodel.ts";
import { asksOf } from "../gui/allyasks.ts";
import { dialogStateLine, remoteAnswer, remoteDialog } from "../gui/linkdialogmodel.ts";
import { m } from "../gui/paraglide/messages.js";

// What the page says about Straw Link (gui/linkmodel.ts): the notices in words, an invite's countdown, a teammate's last presence, and the marks of an ally base.

const alert = (kind: LinkAlert["kind"], data: LinkAlert["data"], level: LinkAlert["level"] = "warning"): LinkAlert => ({ id: kind, kind, level, team: "t", teamName: "moldplan", data });

test("every notice kind reads in English and in Chinese, with the teammate's words only as data", () => {
	const all: LinkAlert[] = [
		alert("join-request", { label: "bob-mac", short: "abc123", unattended: 0 }), alert("join-request", { label: "ci-box", short: "def456", unattended: 1 }),
		alert("confirm", { label: "bob-mac", short: "abc123", tool: "bash" }), alert("fork", { reason: "entry 4 is invalid" }, "error"),
		alert("mismatch", { label: "bob-mac", short: "abc123" }, "error"), alert("unreachable", { minutes: 3 }), alert("inbox", { count: 2 }, "info"), alert("held", { count: 1 }, "info"), alert("served", { count: 3 }, "info"),
	];
	const en = all.map(alertLine), zh = all.map((a) => ((l) => l)(alertLine(a)));
	assert.deepEqual(en.slice(0, 3), [
		"bob-mac (abc123) asks to join team moldplan",
		"ci-box (def456), an unattended device, asks to join team moldplan",
		"bob-mac (abc123) asks you to confirm a bash call from its tower",
	]);
	assert.equal(alertLine(alert("confirm", { label: "bob-mac", short: "abc123", tool: "bash", tower: "Delta" })), "bob-mac (abc123) asks you to confirm a bash call from its tower Delta, which acts on a message you sent");
	assert.match(alertLine(alert("served", { count: 3 }, "info")), /^3 Straw Link messages have waited more than 10 minutes in the inbox of team moldplan for an ally run\. Look at the tower's card/);
	assert.match(en[3]!, /^Team moldplan stopped: entry 4 is invalid$/);
	assert.match(en[5]!, /unreachable for 3 minutes/);
	assert.match(m.link_a_join({ label: "bob-mac", short: "abc123", team: "moldplan" }, { locale: "zh-TW" }), /bob-mac（abc123）要求加入團隊 moldplan/);
	assert.ok(zh.every((t) => t.length > 0));
	// Markup in a teammate's label stays text: the function returns a string and the page puts it in a text node.
	assert.equal(alertLine(alert("join-request", { label: "<img src=x onerror=1>", short: "abc123", unattended: 0 })), "<img src=x onerror=1> (abc123) asks to join team moldplan");
});

test("the worst notice comes first", () => {
	const sorted = urgentFirst([alert("inbox", {}, "info"), alert("unreachable", {}, "warning"), alert("fork", {}, "error")]);
	assert.deepEqual(sorted.map((a) => a.level), ["error", "warning", "info"]);
});

test("an invite counts down as m:ss and stops at 0:00", () => {
	assert.equal(countdown(10 * 60_000), "10:00");
	assert.equal(countdown(61_000), "1:01");
	assert.equal(countdown(999), "0:01");
	assert.equal(countdown(-5), "0:00");
	assert.equal(countdown(3600_000), "1:00:00");
	assert.equal(countdown(23 * 3600_000 + 54 * 60_000 + 26_000), "23:54:26");
});

test("a teammate's last presence: online, how long ago, or not seen", () => {
	assert.equal(lastSeen(null, false), "not seen yet");
	assert.equal(lastSeen(10_000, true), "online");
	assert.equal(lastSeen(5 * 60_000, false), "seen 5m ago");
	assert.equal(lastSeen(3 * 3600_000, false), "seen 3h ago");
});

test("an ally base takes its mark from the tower's state, dim while offline", () => {
	assert.equal(allyMark({ online: false, tower: "working" }), "unknown");
	assert.equal(allyMark({ online: true, tower: "working" }), "working");
	assert.equal(allyMark({ online: true, tower: "blocked" }), "waiting");
	assert.equal(allyMark({ online: true, tower: "idle" }), "idle");
	assert.equal(allyMark({ online: true, tower: "unknown" }), "unknown");
	assert.equal(stateName("blocked"), "waiting on a question");
	assert.equal(stateName("brand-new-state"), "brand-new-state");
});

test("the HUD's Link button shows only when there is a notice or a confirm", () => {
	assert.equal(hasLinkNews(undefined), false);
	assert.equal(hasLinkNews({ allies: [], alerts: [], confirms: [], units: [] }), false);
	assert.equal(hasLinkNews({ allies: [], alerts: [alert("inbox", {})], confirms: [], units: [] }), true);
});

const SELECT = { title: "Deploy?", choices: [{ label: "Yes" }, { label: "No" }] };
const QUESTIONS = [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }, { question: "Who?", multiple: true, options: [{ title: "ops" }] }];
const forwarded = (extra: LinkAlert["data"] = {}, dialog: unknown = { select: SELECT, cancel: true }) => alert("dialog", { device: "d1", dialogId: "D1", digest: "ab", owner: "rpiv", label: "ci-box", short: "abc123", answered: 0, dialog: typeof dialog === "string" ? dialog : JSON.stringify(dialog), ...extra });

test("a forwarded dialog names its device and owner, and its state reads from the holder's fields", () => {
	assert.equal(alertLine(forwarded()), "ci-box (abc123) in team moldplan asks a question (rpiv).");
	assert.deepEqual(([{}, { answered: 1 }, { closed: "remote" }, { closed: "remote", answered: 1 }, { closed: "local" }, { closed: "cancel" }, { closed: "withdrawn" }, { closed: "gone" }] as LinkAlert["data"][]).map((d) => dialogState(forwarded(d))),
		["open", "sent", "done-other", "done-here", "done-local", "cancelled", "withdrawn", "expired"]);
	for (const s of ["sent", "done-here", "done-other", "done-local", "cancelled", "withdrawn", "expired"] as const) {
		assert.ok(dialogStateLine(s).length > 0);
		assert.notEqual(m.link_dialog_sent({}, { locale: "zh-TW" }), m.link_dialog_sent());
	}
});

test("a forwarded select and a questionnaire become a panel's pending; a shape the panel cannot draw is none", () => {
	assert.deepEqual(remoteDialog(forwarded()), { callId: "D1", tool: "dialog", answer: { dialog: "D1", digest: "ab", cancel: true, select: SELECT } });
	const q = remoteDialog(forwarded({}, { questions: QUESTIONS }));
	assert.deepEqual([q?.answer?.questions?.length, q?.answer?.cancel, q?.answer?.select], [2, undefined, undefined]);
	for (const bad of ["not json", "[]", "null", {}, { select: { title: 1, choices: [] } }, { select: { title: "t", choices: [{ nolabel: 1 }] } }, { questions: [] }, { questions: [{ question: "q", options: [{ nope: 1 }] }] }]) assert.equal(remoteDialog(forwarded({}, bad)), undefined, JSON.stringify(bad));
	assert.equal(remoteDialog(alert("dialog", { dialogId: "D1" })), undefined);
});

test("the panel's answer goes to the holder as one of its three shapes, whatever else the body carries", () => {
	assert.deepEqual(remoteAnswer({ dialog: "D1", digest: "ab", answerId: "x", choice: 1 }), { choice: 1 });
	assert.deepEqual(remoteAnswer({ answers: [{ choices: [0] }], choice: undefined }), { answers: [{ choices: [0] }] });
	assert.deepEqual(remoteAnswer({ cancel: true, answerId: "x" }), { cancel: true });
});

test("a notice of an unattended device reads in words, and its units sit beside its ally bases", () => {
	assert.equal(alertLine(alert("notice", { label: "ci-box", short: "def456", what: "run-crashed", unit: "moldplan", text: "An ally run crashed: <b>x</b>" })), "ci-box (def456), unattended, in team moldplan — run-crashed, moldplan: An ally run crashed: <b>x</b>");
	const units = [{ team: "t", device: "d1", at: 1000, units: [{ unit: "moldplan", state: "running", monitors: ["a", "b"], report: "done" }, { unit: "other", state: "standing", monitors: [], report: "" }] }];
	assert.deepEqual(unitsFor(units, { team: "t", device: "d1", workspace: "moldplan" }).map((u) => u.unit), ["moldplan"]);
	assert.equal(unitsFor(units, { team: "t", device: "d1", workspace: null }).length, 2, "a device with no workspace in its presence shows all");
	assert.equal(unitsFor(units, { team: "t", device: "d2", workspace: null }).length, 0);
	// A device that sent no status lately: its last units, said to be stale, with the time it was last heard.
	const old = unitsFor([{ ...units[0]!, stale: true }], { team: "t", device: "d1", workspace: "moldplan" })[0]!;
	assert.deepEqual([old.stale, old.at], [true, 1000]);
	assert.equal(unitsFor(units, { team: "t", device: "d1", workspace: "moldplan" })[0]!.stale, false);
});

const ME = { team: "t", device: "d1", workspace: "moldplan" as string | null };
const status = (state: string, extra: object = {}) => [{ team: "t", device: "d1", at: 5_000, units: [{ unit: "moldplan", state, monitors: ["tail -f a.log", "npm run watch"], report: "# Done\nShipped." }], ...extra }];
const crashNotice = (at: number, over: Record<string, string | number> = {}) => ({ id: "notice/1", kind: "notice" as const, level: "warning" as const, team: "t", teamName: "moldplan", data: { device: "d1", label: "ci-box", short: "9f3a1c", what: "run-crashed", unit: "moldplan", text: "An ally run crashed: exit 1", at, ...over } });

test("a unit's state is said in the three words the card is for (standing by, running, crashed), and a state the page does not know as it is", () => {
	assert.deepEqual(unitWord("standing"), { tone: "idle", word: m.mark_standing() });
	assert.deepEqual(unitWord("idle"), { tone: "idle", word: m.mark_standing() });
	for (const s of ["running", "working", "waking", "commanding"]) assert.deepEqual(unitWord(s), { tone: "working", word: m.link_unit_running() }, s);
	assert.deepEqual(unitWord("blocked"), { tone: "waiting", word: m.mark_waiting() });
	assert.deepEqual(unitWord("held"), { tone: "crashed", word: m.link_unit_held() }, "held is paused after repeated crashes: trouble, in its own words");
	assert.deepEqual(unitWord("closing"), { tone: "other", word: m.tower_state_closing() });
	assert.deepEqual(unitWord("waking"), { tone: "working", word: m.link_unit_running() });
	assert.deepEqual(unitWord("reticulating"), { tone: "other", word: "reticulating" }, "a state the page does not know is shown as it is");
});

test("a unit's card carries its word, when it was heard, its monitors and its report; a stale device's units say so", () => {
	const [u] = unitCards(status("running"), [], ME, 6_000);
	assert.deepEqual([u!.unit, u!.tone, u!.word, u!.at, u!.stale, u!.monitors, u!.report, u!.crash], ["moldplan", "working", m.link_unit_running(), 5_000, false, ["tail -f a.log", "npm run watch"], "# Done\nShipped.", undefined]);
	assert.equal(unitCards(status("running", { stale: true }), [], ME, 6_000)[0]!.stale, true);
	assert.deepEqual(unitCards(undefined, [], ME, 0), []);
	assert.deepEqual(unitCards(status("running"), [], { ...ME, device: "d2" }, 0), [], "another device's units are not this card's");
});

test("a crash notice for the unit makes it read crashed while it is not running again and the crash is lately, and carries the notice's text", () => {
	const now = 10 * 60_000;
	const [u] = unitCards(status("standing"), [crashNotice(now - 4 * 60_000)], ME, now);
	assert.deepEqual([u!.tone, u!.word, u!.crash], ["crashed", m.link_unit_crashed(), { at: now - 4 * 60_000, text: "An ally run crashed: exit 1" }]);
	const trust = unitCards(status("standing"), [crashNotice(now - 4 * 60_000, { what: "trust-unanswered", text: "An ally run crashed: No trust decision for /work/p" })], ME, now)[0]!;
	assert.deepEqual([trust.tone, trust.word, trust.crash], ["waiting", m.link_unit_trust(), { at: now - 4 * 60_000, text: "An ally run crashed: No trust decision for /work/p", trust: true }], "a trust question nobody answered is not a crash: the box needs a setting, so it reads amber and says what to do");
	assert.equal(unitCards(status("running"), [crashNotice(now - 4 * 60_000, { what: "trust-unanswered" })], ME, now)[0]!.tone, "working", "and it follows the same rules as a crash");
	assert.equal(unitCards(status("standing"), [crashNotice(now - CRASH_FRESH_MS - 1, { what: "trust-unanswered" })], ME, now)[0]!.tone, "idle");
	assert.equal(unitCards(status("running"), [crashNotice(now - 4 * 60_000)], ME, now)[0]!.tone, "working", "running again: the unit is not crashed");
	assert.equal(unitCards(status("standing"), [crashNotice(now - 4 * 60_000)], ME, now)[0]!.crash!.at, now - 4 * 60_000);
	const late = 2 * CRASH_FRESH_MS;
	assert.equal(unitCards(status("standing"), [crashNotice(late - CRASH_FRESH_MS + 1)], ME, late)[0]!.tone, "crashed", "the last moment of the window: still a crash");
	assert.equal(unitCards(status("standing"), [crashNotice(late - CRASH_FRESH_MS)], ME, late)[0]!.tone, "idle", "an old crash (with a real time) says nothing of the unit now");
	assert.equal(unitCards(status("standing"), [crashNotice(late - CRASH_FRESH_MS - 1)], ME, late)[0]!.tone, "idle");
	assert.equal(unitCards(status("standing"), [crashNotice(1, { at: 0 })], ME, now)[0]!.tone, "idle", "a notice with no time (a peer's older box) is not read as a crash");
	const others = [crashNotice(now - 1000, { unit: "other" }), crashNotice(now - 1000, { device: "d2" }), { ...crashNotice(now - 1000), team: "t2" }, crashNotice(now - 1000, { what: "run-quit" }), crashNotice(now - 1000, { what: "run-timeout" })];
	others.forEach((n, i) => assert.equal(unitCards(status("standing"), [n], ME, now)[0]!.tone, "idle", `a notice of another unit, device, team or kind (${i})`));
	const later = unitCards(status("standing"), [crashNotice(now - 9 * 60_000, { text: "older" }), crashNotice(now - 2 * 60_000, { text: "newer" })], ME, now)[0]!;
	assert.equal(later.crash!.text, "newer", "the latest crash is the one told");
});

test("ALLY-F002: a unit seen running after the crash is not crashed again once it stands by; a run before the crash does not clear it", () => {
	const seen = new Map<string, number>(), t0 = 10 * 60_000, at = (when: number, state: string) => status(state).map((d) => ({ ...d, at: when }));
	const crash = crashNotice(t0);
	assert.equal(unitCards(at(t0 - 60_000, "running"), [], ME, t0 - 60_000, seen)[0]!.tone, "working", "it ran before it crashed");
	assert.equal(unitCards(at(t0 + 60_000, "standing"), [crash], ME, t0 + 60_000, seen)[0]!.tone, "crashed", "the earlier run does not clear the crash");
	assert.equal(unitCards(at(t0 + 5 * 60_000, "running"), [crash], ME, t0 + 5 * 60_000, seen)[0]!.tone, "working", "the boss re-ran it");
	const after = unitCards(at(t0 + 10 * 60_000, "standing"), [crash], ME, t0 + 10 * 60_000, seen)[0]!;
	assert.deepEqual([after.tone, after.crash], ["idle", undefined], "it ran after the crash and stands by again: the old notice says nothing of it now");
	assert.equal(unitCards(at(t0 + 10 * 60_000, "standing"), [crash, crashNotice(t0 + 8 * 60_000, { text: "again" })], ME, t0 + 10 * 60_000, seen)[0]!.crash!.text, "again", "a crash after that run counts");
	assert.equal(unitCards(at(t0 + 10 * 60_000, "standing"), [crash], { ...ME, workspace: null }, t0 + 10 * 60_000, new Map())[0]!.tone, "crashed", "with nothing seen (a reload) the 30-minute rule stands alone");
});

test("ALLY-F007: a held unit reads in its own word in the trouble colour; a closing one is said in words, not as the box sends it", () => {
	const [held] = unitCards(status("held"), [], ME, 6_000);
	assert.deepEqual([held!.tone, held!.word, held!.crash], ["crashed", m.link_unit_held(), undefined]);
	const [withNotice] = unitCards(status("held"), [crashNotice(5_000)], ME, 6_000);
	assert.deepEqual([withNotice!.tone, withNotice!.word, withNotice!.crash!.at], ["crashed", m.link_unit_held(), 5_000], "its crash notice stays behind the fold, and the word stays 'held'");
	assert.equal(unitCards(status("closing"), [], ME, 6_000)[0]!.word, m.tower_state_closing());
});

test("the folded report is its first line without Markdown marks", () => {
	assert.equal(reportPeek("## Staging deploy: v1.2\n\nDeployed **v1.2**"), "Staging deploy: v1.2");
	assert.equal(reportPeek("\n\n- Migration `0042` applied\n- next"), "Migration 0042 applied");
	assert.equal(reportPeek("```\n$ npm test\n```"), "$ npm test");
	assert.equal(reportPeek("> 1. quoted _item_"), "quoted item");
	assert.equal(reportPeek("**Deployed** to _staging_ with ~~no~~ trouble"), "Deployed to staging with no trouble", "marks that are markup go, nested and in the middle of a line");
	assert.equal(reportPeek("__Done__ *and* **_both_**"), "Done and both");
	assert.equal(reportPeek("Set ledger.rounding_mode to half_up"), "Set ledger.rounding_mode to half_up", "an identifier's underscores are its own");
	assert.equal(reportPeek("Edited ~/projects/app/src/__init__.py and ~/b"), "Edited ~/projects/app/src/__init__.py and ~/b", "a path's ~ and __ are its own");
	assert.equal(reportPeek("2 * 3 = 6 and a*b*c"), "2 * 3 = 6 and a*b*c", "a lone or intraword * is not emphasis");
	assert.equal(reportPeek("merged MP_4219 and MP_4220"), "merged MP_4219 and MP_4220");
	assert.equal(reportPeek("run `rounding_mode` and `a*b`"), "run rounding_mode and a*b", "code ticks go, what is inside stays");
	assert.equal(reportPeek("an **unclosed mark"), "an **unclosed mark");
	assert.equal(reportPeek("   "), "");
	assert.equal(reportPeek(""), "");
});

// An unattended device's question is answered on the card of its ally base (docs/how-it-works.md, Unattended devices): `asksOf` says which card hosts which questions.
const ally = (over: Partial<AllyBase> = {}): AllyBase => ({ id: "t1/d1/trial11", team: "t1", teamName: "moldplan", device: "d1", short: "n2knna", label: "waydosoft", online: true, workspace: "trial11", tower: "idle", tabs: [], ...over });
const ask = (id: string, data: LinkAlert["data"] = {}, team = "t1") => ({ ...forwarded({ dialogId: id, ...data }), id: `dialog/d1/${id}`, team });

test("a device's open and waiting questions are hosted by its ally base; a closed one, another device's, and a notice are not", () => {
	const link = { allies: [ally()], alerts: [ask("A"), ask("B", { answered: 1 }), ask("C", { closed: "remote" }), ask("D", { device: "d2" }), alert("notice", { device: "d1" })], confirms: [], units: [] };
	assert.deepEqual([...asksOf(link)].map(([id, list]) => [id, list.map((a) => a.data.dialogId)]), [["t1/d1/trial11", ["A", "B"]]]);
	assert.equal(asksOf(undefined).size, 0);
	assert.equal(asksOf({ ...link, allies: [] }).size, 0, "no card, no host: the Link notices still carry it");
});

test("of a device's several bases the one that waits hosts its questions, on the team the question came on; with no match the first", () => {
	const quiet = ally({ id: "t1/d1/docs", workspace: "docs" }), waiting = ally({ id: "t1/d1/trial11", tower: "blocked" }), tab = ally({ id: "t1/d1/ops", workspace: "ops", tabs: [{ label: "main", state: "blocked" }] }), other = ally({ id: "t2/d1/trial11", team: "t2" });
	const asks = (allies: AllyBase[], team = "t1") => [...asksOf({ allies, alerts: [ask("A", {}, team)] }).keys()];
	assert.deepEqual(asks([quiet, waiting]), ["t1/d1/trial11"], "the tower waits");
	assert.deepEqual(asks([quiet, tab]), ["t1/d1/ops"], "a tab waits");
	assert.deepEqual(asks([quiet, ally({ id: "t1/d1/x", workspace: "x" })]), ["t1/d1/docs"], "none waits: the first");
	assert.deepEqual(asks([other, waiting], "t2"), ["t2/d1/trial11"], "the team the question came on comes first, waiting or not");
	assert.deepEqual(asks([other], "t1"), ["t2/d1/trial11"], "a team it did not come on still hosts it when it is the device's only base");
});
