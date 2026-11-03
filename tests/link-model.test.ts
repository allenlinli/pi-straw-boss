import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkAlert } from "../src/link/holder.ts";
import { alertLine, allyMark, countdown, dialogState, dialogStateLine, hasLinkNews, lastSeen, remoteAnswer, remoteDialog, stateName, urgentFirst } from "../gui/linkmodel.ts";
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
	assert.equal(hasLinkNews({ allies: [], alerts: [], confirms: [] }), false);
	assert.equal(hasLinkNews({ allies: [], alerts: [alert("inbox", {})], confirms: [] }), true);
});

const SELECT = { title: "Deploy?", choices: [{ label: "Yes" }, { label: "No" }] };
const QUESTIONS = [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }, { question: "Who?", multiple: true, options: [{ title: "ops" }] }];
const forwarded = (extra: LinkAlert["data"] = {}, dialog: unknown = { select: SELECT, cancel: true }) => alert("dialog", { device: "d1", dialogId: "D1", digest: "ab", owner: "rpiv", label: "ci-box", short: "abc123", answered: 0, dialog: typeof dialog === "string" ? dialog : JSON.stringify(dialog), ...extra });

test("a forwarded dialog names its device and owner, and its state reads from the holder's fields", () => {
	assert.equal(alertLine(forwarded()), "ci-box (abc123) in team moldplan asks a question (rpiv).");
	assert.deepEqual([{}, { answered: 1 }, { closed: "remote" }, { closed: "remote", answered: 1 }, { closed: "local" }, { closed: "cancel" }, { closed: "gone" }].map((d) => dialogState(forwarded(d))),
		["open", "sent", "done-other", "done-here", "done-local", "cancelled", "expired"]);
	for (const s of ["sent", "done-here", "done-other", "done-local", "cancelled", "expired"] as const) {
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
