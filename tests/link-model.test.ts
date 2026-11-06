import assert from "node:assert/strict";
import { test } from "node:test";
import type { AllyBase, LinkAlert } from "../src/link/holder.ts";
import { alertLine, allyMark, countdown, mergeAllies, CRASH_FRESH_MS, dialogState, hasLinkNews, lastSeen, reportPeek, stateName, unitCards, unitsFor, unitWord, urgentFirst } from "../gui/linkmodel.ts";
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
	assert.deepEqual(unitsFor(units, { teams: ["t"], device: "d1", workspace: "moldplan" }).map((u) => u.unit), ["moldplan"]);
	assert.equal(unitsFor(units, { teams: ["t"], device: "d1", workspace: null }).length, 2, "a device with no workspace in its presence shows all");
	assert.equal(unitsFor(units, { teams: ["t"], device: "d2", workspace: null }).length, 0);
	// A device that sent no status lately: its last units, said to be stale, with the time it was last heard.
	const old = unitsFor([{ ...units[0]!, stale: true }], { teams: ["t"], device: "d1", workspace: "moldplan" })[0]!;
	assert.deepEqual([old.stale, old.at], [true, 1000]);
	assert.equal(unitsFor(units, { teams: ["t"], device: "d1", workspace: "moldplan" })[0]!.stale, false);
});

const ME = { teams: ["t"], device: "d1", workspace: "moldplan" as string | null };
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
	assert.deepEqual([...asksOf(link)].map(([id, list]) => [id, list.map((a) => a.data.dialogId)]), [["d1/trial11", ["A", "B"]]]);
	assert.equal(asksOf(undefined).size, 0);
	assert.equal(asksOf({ ...link, allies: [] }).size, 0, "no card, no host: the Link notices still carry it");
});

test("of a device's several cards the one that waits hosts its questions, whatever team a question came on; with no match the first", () => {
	const quiet = ally({ id: "t1/d1/docs", workspace: "docs" }), waiting = ally({ id: "t1/d1/trial11", tower: "blocked" }), tab = ally({ id: "t1/d1/ops", workspace: "ops", tabs: [{ label: "main", state: "blocked" }] }), other = ally({ id: "t2/d1/trial11", team: "t2", teamName: "mates" });
	const asks = (allies: AllyBase[], team = "t1") => [...asksOf({ allies, alerts: [ask("A", {}, team)] }).keys()];
	assert.deepEqual(asks([quiet, waiting]), ["d1/trial11"], "the tower waits");
	assert.deepEqual(asks([quiet, tab]), ["d1/ops"], "a tab waits");
	assert.deepEqual(asks([quiet, ally({ id: "t1/d1/x", workspace: "x" })]), ["d1/docs"], "none waits: the first");
	assert.deepEqual(asks([other, waiting], "t2"), ["d1/trial11"], "one card per device and workspace: both teams' bases are the one card, and it waits");
	assert.deepEqual(asks([other], "t1"), ["d1/trial11"], "a team it did not come on still hosts it when it is the device's only base");
});

// One card per device (and per workspace of it), however many teams it is in: the card names its teams, and its state is the device's.
const two = (over: Partial<AllyBase> = {}): AllyBase[] => [ally({ id: "t1/d1/trial11", ...over }), ally({ id: "t2/d1/trial11", team: "t2", teamName: "agent-tower-team", ...over })];

test("a device that is in two teams is one card that lists both, in the order the teams came; one team is a card with that one team", () => {
	const [card, ...rest] = mergeAllies(two());
	assert.equal(rest.length, 0);
	assert.equal(card!.id, "d1/trial11");
	assert.deepEqual(card!.teams, [{ team: "t1", teamName: "moldplan" }, { team: "t2", teamName: "agent-tower-team" }]);
	assert.deepEqual(mergeAllies([ally()]).map((c) => c.teams), [[{ team: "t1", teamName: "moldplan" }]]);
	assert.deepEqual(mergeAllies([]), []);
	assert.equal(mergeAllies([...two(), ally({ id: "t1/d2/x", device: "d2", workspace: "x" })]).length, 2, "another device is another card");
	assert.equal(mergeAllies([...two(), ally({ id: "t1/d1/docs", workspace: "docs" })]).length, 2, "a device's workspaces are cards of their own, as before");
	assert.equal(mergeAllies([ally(), ally()]).length, 1, "the same team twice is listed once");
	assert.deepEqual(mergeAllies([ally(), ally()])[0]!.teams.length, 1);
});

test("the merged card's presence: online when any team hears the device, the most urgent tower state, the flag of an unattended box", () => {
	const [a, b] = two();
	assert.equal(mergeAllies([{ ...a!, online: false, tower: "unknown" }, b!])[0]!.online, true, "one team's presence is enough");
	assert.equal(mergeAllies([{ ...a!, online: false }, { ...b!, online: false }])[0]!.online, false);
	assert.equal(mergeAllies([{ ...a!, tower: "idle" }, { ...b!, tower: "working" }])[0]!.tower, "working");
	assert.equal(mergeAllies([{ ...a!, tower: "working" }, { ...b!, tower: "blocked" }])[0]!.tower, "blocked", "a question that waits outranks work");
	assert.equal(mergeAllies([{ ...a!, tower: "blocked", online: false }, { ...b!, tower: "idle" }])[0]!.tower, "idle", "an offline team's last word does not outrank an online one");
	assert.equal(mergeAllies([{ ...a!, unattended: true }, b!])[0]!.unattended, true);
	assert.deepEqual(mergeAllies([{ ...a!, tabs: [] }, { ...b!, tower: "working", tabs: [{ label: "main", state: "working" }] }])[0]!.tabs, [{ label: "main", state: "working" }], "the tabs are the ones of the state that was taken");
});

test("a team that shows no workspace of the device adds its team to the device's cards and no card of its own", () => {
	const named = ally({ id: "t1/d1/trial11" }), bare = ally({ id: "t2/d1", team: "t2", teamName: "agent-tower-team", workspace: null, tower: "unknown", tabs: [] });
	const cards = mergeAllies([named, bare]);
	assert.deepEqual(cards.map((c) => c.id), ["d1/trial11"]);
	assert.deepEqual(cards[0]!.teams.map((t) => t.team), ["t1", "t2"]);
	assert.deepEqual(mergeAllies([bare]).map((c) => [c.id, c.workspace]), [["d1", null]], "with no workspace anywhere, the device's one card");
});

test("a device's unit status: each unit from its freshest row, stale per unit", () => {
	const row = (team: string, at: number, state: string, extra: object = {}) => ({ team, device: "d1", at, units: [{ unit: "moldplan", state, monitors: [], report: `from ${team}` }], ...extra });
	const both = { teams: ["t1", "t2"], device: "d1", workspace: "moldplan" as string | null };
	const pick = (rows: ReturnType<typeof row>[], who = both) => unitsFor(rows, who).map((u) => [u.state, u.at, u.stale, u.report]);
	assert.deepEqual(pick([row("t1", 1_000, "running"), row("t2", 9_000, "standing")]), [["standing", 9_000, false, "from t2"]], "the same unit: the later status wins");
	assert.deepEqual(pick([row("t2", 9_000, "standing"), row("t1", 1_000, "running")]), [["standing", 9_000, false, "from t2"]], "whatever the order");
	assert.deepEqual(pick([row("t1", 1_000, "running"), row("t2", 9_000, "standing", { stale: true })]), [["standing", 9_000, true, "from t2"]], "the freshest row's stale");
	assert.deepEqual(pick([row("t1", 9_000, "running"), row("t2", 1_000, "standing", { stale: true })]), [["running", 9_000, false, "from t1"]], "an old stale status does not hide a fresh one");
	assert.deepEqual(pick([row("t3", 9_000, "standing"), row("t1", 1_000, "running")]), [["running", 1_000, false, "from t1"]], "a status of a team the card is not in is not the card's");
	assert.deepEqual(pick([row("t1", 1_000, "running")], { ...both, teams: ["t1"] }), [["running", 1_000, false, "from t1"]]);
});

test("a crash notice of either team tells on the merged card, the latest one once; a run seen after it ends it", () => {
	const now = 10_000_000, rows = [{ team: "t1", device: "d1", at: now - 5_000, units: [{ unit: "moldplan", state: "standing", monitors: [], report: "" }] }, { team: "t2", device: "d1", at: now - 20_000, units: [{ unit: "moldplan", state: "standing", monitors: [], report: "" }] }];
	const both = { teams: ["t1", "t2"], device: "d1", workspace: "moldplan" as string | null };
	const t1 = crashNotice(now - 60_000, { text: "in t1" }), t2 = { ...crashNotice(now - 30_000, { text: "in t2" }), team: "t2", id: "notice/2" };
	const [one] = unitCards(rows, [t1, t2], both, now);
	assert.equal(unitCards(rows, [t1, t2], both, now).length, 1, "one unit, one card");
	assert.deepEqual([one!.tone, one!.crash!.text], ["crashed", "in t2"], "the latest of the two teams' notices");
	assert.equal(unitCards(rows, [t2], { ...both, teams: ["t1"] }, now)[0]!.tone, "idle", "a notice of a team the card is not in does not");
	const seen = new Map<string, number>();
	unitCards([{ ...rows[0]!, at: now - 10_000, units: [{ unit: "moldplan", state: "running", monitors: [], report: "" }] }], [], both, now - 10_000, seen);
	assert.equal(unitCards(rows, [t1], both, now, seen)[0]!.tone, "idle", "the page's memory of a run is the device's, not a team's");
});

// A box reports each team only the units of that team's project (src/link/unitstatus.ts), and presence is per team project too (AOC-F001..F003).
const unit = (name: string, state = "standing") => ({ unit: name, state, monitors: [], report: "" });
const rowOf = (team: string, at: number, ...names: string[]) => ({ team, device: "d1", at, units: names.map((n) => unit(n)) });
const mate = (team: string, workspace: string | null, over: Partial<AllyBase> = {}) => ally({ id: `${team}/d1${workspace ? `/${workspace}` : ""}`, team, teamName: team === "t1" ? "moldplan" : "agent-tower-team", workspace, ...over });
const whoOf = (c: ReturnType<typeof mergeAllies>[number]) => ({ device: c.device, workspace: c.workspace, teams: c.teams.map((t) => t.team) });

test("two teams that report different units: each workspace's card keeps its own, whichever team reported last", () => {
	const cards = mergeAllies([mate("t1", "W1"), mate("t2", "W2")]);
	assert.deepEqual(cards.map((c) => [c.id, c.teams.map((t) => t.team)]), [["d1/W1", ["t1"]], ["d1/W2", ["t2"]]], "a card is of the teams whose presence lists its workspace");
	for (const rows of [[rowOf("t1", 1_000, "W1"), rowOf("t2", 2_000, "W2")], [rowOf("t1", 3_000, "W1"), rowOf("t2", 2_000, "W2")]])
		assert.deepEqual(cards.map((c) => unitsFor(rows, whoOf(c)).map((u) => u.unit)), [["W1"], ["W2"]]);
});

test("a card with no workspace lists the union of its teams' units, one entry per unit from its freshest row, and does not flip", () => {
	const [card] = mergeAllies([mate("t1", null), mate("t2", null)]);
	const rows = (t1At: number, t2At: number) => [{ ...rowOf("t1", t1At, "A", "S"), units: [unit("A"), unit("S", "running")] }, { ...rowOf("t2", t2At, "B", "S"), units: [unit("B"), unit("S", "standing")] }];
	for (const [a, b] of [[1_000, 2_000], [3_000, 2_000]]) assert.deepEqual(unitsFor(rows(a, b), whoOf(card!)).map((u) => u.unit), ["A", "S", "B"], "the same set and order whoever reported last");
	const s = (a: number, b: number) => unitsFor(rows(a, b), whoOf(card!)).find((u) => u.unit === "S")!;
	assert.deepEqual([s(1_000, 2_000).state, s(1_000, 2_000).at], ["standing", 2_000]);
	assert.deepEqual([s(3_000, 2_000).state, s(3_000, 2_000).at], ["running", 3_000]);
	assert.equal(unitsFor([{ ...rowOf("t1", 9_000, "A"), stale: true }, rowOf("t2", 1_000, "B")], whoOf(card!)).map((u) => [u.unit, u.stale]).join(), "A,true,B,false", "stale is per unit's row");
});

test("a team with no workspace of the device is on every card of it; a team with another workspace is not", () => {
	const cards = mergeAllies([mate("t1", "W1"), mate("t2", "W2"), mate("t3", null)]);
	assert.deepEqual(cards.map((c) => c.teams.map((t) => t.team)), [["t1", "t3"], ["t2", "t3"]]);
});

test("a crash notice goes only to the cards of the team it came on", () => {
	const now = 10_000_000, cards = mergeAllies([mate("t1", "W1"), mate("t2", "W2")]);
	const rows = [{ ...rowOf("t1", now - 1_000, "W1") }, { ...rowOf("t2", now - 1_000, "W2") }];
	const n = (team: string, unitName: string) => ({ ...crashNotice(now - 60_000), team, data: { ...crashNotice(now - 60_000).data, unit: unitName } });
	assert.deepEqual(cards.map((c) => unitCards(rows, [n("t2", "W1")], whoOf(c), now).map((u) => u.tone)), [["idle"], ["idle"]], "t2's notice for a unit named W1 is not W1's card's");
	assert.deepEqual(cards.map((c) => unitCards(rows, [n("t1", "W1")], whoOf(c), now).map((u) => u.tone)), [["crashed"], ["idle"]]);
});

test("the card's label does not move with the tower state, and a team that cannot hear the device does not put its state on an online card", () => {
	const label = (a: string, b: string) => mergeAllies([mate("t1", "W", { label: "tower-01", tower: a }), mate("t2", "W", { label: "box-B", tower: b })])[0]!.label;
	assert.deepEqual([label("idle", "working"), label("working", "idle")], ["tower-01", "tower-01"]);
	assert.equal(mergeAllies([mate("t2", "W", { label: "box-B" }), mate("t1", "W", { label: "tower-01" })])[0]!.label, "tower-01", "the first team by id, not by order");
	const on = mergeAllies([mate("t1", null, { online: true, tower: "unknown", tabs: [] }), mate("t2", "W2", { online: false, tower: "blocked" })])[0]!;
	assert.deepEqual([on.online, on.tower], [true, "unknown"], "the stale blocked of the offline team is not the card's");
});

test("AOR-F001: a card whose own teams cannot hear the device shows unknown with no tabs, never another workspace's state", () => {
	const cards = mergeAllies([mate("t1", "W1", { tower: "working", tabs: [{ id: "a", title: "a-of-W1" } as never] }), mate("t2", "W2", { online: false, tower: "blocked", tabs: [{ id: "b", title: "b-of-W2" } as never] })]);
	const w2 = cards.find((c) => c.workspace === "W2")!;
	assert.deepEqual([w2.online, w2.tower, w2.tabs], [true, "unknown", []]);
	assert.equal(cards.find((c) => c.workspace === "W1")!.tower, "working");
	const dark = mergeAllies([mate("t2", "W2", { online: false, tower: "blocked" })])[0]!;
	assert.deepEqual([dark.online, dark.tower], [false, "blocked"], "a device nobody hears keeps its last state");
});

test("AOR-F002: units of a team that lists no workspace, matching none of the device's named workspaces, stay on the device's first card", () => {
	const cards = mergeAllies([mate("t1", "W1"), mate("t2", "W2"), mate("t3", null)]);
	const rows = [rowOf("t1", 3, "W1"), rowOf("t2", 3, "W2"), rowOf("t3", 3, "X", "W2")];
	assert.deepEqual(cards.map((c) => unitsFor(rows, { ...whoOf(c), spare: c.spare }).map((u) => u.unit)), [["W1", "X"], ["W2"]]);
	assert.deepEqual(unitsFor(rows, whoOf(mergeAllies([mate("t3", null)])[0]!)).map((u) => u.unit), ["X", "W2"], "no workspace anywhere: all of them");
});
