import assert from "node:assert/strict";
import { test } from "node:test";

// The terminal card's model (gui/cardmodel.ts, docs: terminal-card spec §5 to §7): what the card shows of a pane's rows, when a prompt is a password
// prompt and whether the field is masked, which state it is in, and when its step is over. Pure: each rule has its table here, and the card's
// DOM (termcard.ts) only asks.

const { NO_MASK, cardState, maskStep, maskToggle, secretPrompt, stepRule, tail } = await import("../gui/cardmodel.ts");
type Facts = Parameters<typeof cardState>[0];
type Event = Parameters<typeof stepRule>[1];

test("tail: the last 4 non-blank rows as plain text, trailing blanks dropped, escapes stripped, each row right-trimmed", () => {
	assert.deepEqual(tail([]), []);
	assert.deepEqual(tail(["", "   ", ""]), [], "nothing but blank rows");
	assert.deepEqual(tail(["one", "two"]), ["one", "two"], "fewer than 4");
	assert.deepEqual(tail(["1", "2", "3", "4", "5", "6"]), ["3", "4", "5", "6"], "the last 4");
	assert.deepEqual(tail(["a", "b", "", "", ""]), ["a", "b"], "trailing blank rows are not rows of the tail");
	assert.deepEqual(tail(["a", "", "b", "  ", "c", "d", "e"]), ["b", "c", "d", "e"], "blank rows between are not counted either");
	assert.deepEqual(tail(["Hit:1 http://ports.ubuntu.com   ", "\u00a0x"]), ["Hit:1 http://ports.ubuntu.com", "\u00a0x"], "right-trimmed, the left kept");
	assert.deepEqual(tail(["\x1b[1;31mred\x1b[0m plain", "\x1b[38;2;1;2;3mtrue\x1b[m"]), ["red plain", "true"], "colour escapes carry no class or style");
	assert.deepEqual(tail(["bell\x07 tab\there\x1b[2K", "\x1b[?25l\x1b[3Gcursor"]), ["bell tabhere", "cursor"], "any other escape or control is dropped");
	assert.deepEqual(tail(["\x1b[31m   \x1b[0m", "x"]), ["x"], "a row of only escapes and spaces is blank");
	assert.deepEqual(tail(["<b>not markup</b>"]), ["<b>not markup</b>"], "text stays text");
});

test("secretPrompt: the last non-blank row ends in a colon after password, passphrase, passcode, PIN, 密碼, or 口令", () => {
	const yes = [
		"[sudo] password for boss:",
		"Password:",
		"Enter passphrase for key '/Users/boss/.ssh/id_ed25519':",
		"Password for 'https://boss@github.com':",
		"請輸入密碼：",
		"Enter PIN:",
		"Enter your passcode:",
		"請輸入口令:",
		"boss@host's PASSWORD:",
		"Password: ",
		"\x1b[1m[sudo] password for boss:\x1b[0m",
		`password${"x".repeat(80)}:`,
	];
	for (const row of yes) assert.equal(secretPrompt(["Hit:1 http://x", row]), true, row);
	const no = ["password updated.", "$ echo password", "Enter command:", "Enter secret>", "Username:", "spin:", "pining:", "", `password${"x".repeat(81)}:`, "passwords are stored here", "Password: not required for this host", "the password: ok, continuing"];
	for (const row of no) assert.equal(secretPrompt(["Hit:1 http://x", row]), false, row);
	assert.equal(secretPrompt([]), false, "no rows");
	assert.equal(secretPrompt(["Password for 'https://boss@github.com':", "Enter command:"]), false, "a password prompt above the last row is not the prompt");
	assert.equal(secretPrompt(["Password:", "", "  "]), true, "blank rows below do not count");
	assert.equal(secretPrompt(["Password:", "", "  ", ""]), true, "blank rows after the prompt do not hide it");
	assert.equal(secretPrompt(["Password:", "Sorry, try again."]), false, "a prompt that is not the last non-blank row is not asked");
	assert.equal(secretPrompt(["Password:", "[sudo] password for boss:"]), true, "only the last one counts, and it matches");
	assert.equal(secretPrompt(["Some output", "$ sudo apt update", "Password updated for boss"]), false);
});

test("mask: a password prompt turns it on; it goes off by itself only when the prompt is gone and the field is empty; a hand mask sticks; typed text is never unmasked", () => {
	const step = (mask: Parameters<typeof maskStep>[0], secret: boolean, empty: boolean) => maskStep(mask, { secret, empty });
	assert.deepEqual(NO_MASK, { on: false, hand: false });
	assert.deepEqual(step(NO_MASK, true, true), { on: true, hand: false }, "a prompt turns it on");
	assert.deepEqual(step(NO_MASK, true, false), { on: true, hand: false }, "even with text already typed");
	assert.equal(step(NO_MASK, false, true), NO_MASK, "no prompt, not masked: nothing");
	assert.equal(step(NO_MASK, false, false), NO_MASK);
	const on = { on: true, hand: false };
	assert.equal(step(on, true, false), on, "still asking: stays on");
	assert.equal(step(on, true, true), on);
	assert.deepEqual(step(on, false, true), NO_MASK, "the prompt is gone and the field is empty: off by itself");
	assert.equal(step(on, false, false), on, "the prompt is gone but text is in the field: never unmasks it");
	// By hand.
	const hand = maskToggle(NO_MASK);
	assert.deepEqual(hand, { on: true, hand: true }, "pressing 遮住 masks");
	for (const [secret, empty] of [[true, true], [true, false], [false, true], [false, false]] as const) assert.equal(step(hand, secret, empty), hand, `a hand mask stays (prompt ${secret}, empty ${empty})`);
	assert.deepEqual(maskToggle(hand), { on: false, hand: true }, "pressed again it unmasks, by hand");
	const off = maskToggle(hand);
	for (const [secret, empty] of [[true, true], [true, false], [false, true], [false, false]] as const) assert.equal(step(off, secret, empty), off, `a hand unmask stays too (prompt ${secret}, empty ${empty})`);
	assert.deepEqual(maskToggle(on), { on: false, hand: true }, "the way out of a false positive");
});

const base: Facts = { kind: "pane", phase: "live", stale: false, rows: ["$ sudo apt update", "Hit:1 http://x"] };
const is = (facts: Partial<Facts>) => cardState({ ...base, ...facts });

test("cardState: each state of the table, for a pane", () => {
	assert.equal(is({}), "live");
	assert.equal(is({ phase: "connecting", rows: [] }), "connecting");
	assert.equal(is({ rows: ["[sudo] password for boss:"] }), "secret");
	assert.equal(is({ sending: true }), "sending");
	assert.equal(is({ stale: true }), "stale");
	assert.equal(is({ phase: "paused" }), "paused");
	assert.equal(is({ phase: "hidden", rows: [] }), "hidden");
	assert.equal(is({ held: "Standing by." }), "held");
	assert.equal(is({ phase: "refused" }), "refused", "an attach the server refused");
	assert.equal(is({ refused: true }), "refused", "a write the server refused");
	assert.equal(is({ ended: true }), "gone", "a pane that ended closes");
	assert.equal(is({ after: ["$ sudo apt update", "Hit:1 http://x"] }), "live", "an Enter was taken and nothing changed yet");
	assert.equal(is({ after: ["$ sudo apt update"] }), "running", "an Enter was taken and the tail changed since");
	assert.equal(is({ after: ["[sudo] password for boss:"], rows: ["[sudo] password for boss:", "Reading package lists..."] }), "running");
	assert.equal(is({ confirm: "command" }), "confirm");
	assert.equal(is({ confirm: "" }), "confirm", "a server that named no token still asks");
});

test("cardState: each state of the table, for a prompt (no tail, no password rule, no running)", () => {
	const prompt = (facts: Partial<Facts>) => cardState({ ...base, kind: "prompt", rows: [], ...facts });
	assert.equal(prompt({}), "live");
	assert.equal(prompt({ phase: "connecting" }), "connecting");
	assert.equal(prompt({ rows: ["[sudo] password for boss:"] }), "live", "the rule is for a pane's rows");
	assert.equal(prompt({ after: ["x"] }), "live", "a prompt card never runs on");
	assert.equal(prompt({ sending: true }), "sending");
	assert.equal(prompt({ confirm: "command" }), "confirm");
	assert.equal(prompt({ stale: true }), "stale");
	assert.equal(prompt({ phase: "paused" }), "paused");
	assert.equal(prompt({ phase: "hidden" }), "hidden", "a secret_drop hides the session's mirror");
	assert.equal(prompt({ held: "A tower waits." }), "held");
	assert.equal(prompt({ phase: "refused" }), "refused");
	assert.equal(prompt({ ended: true }), "ended", "the session's mirror ended: the card stays and says why");
});

test("cardState: which state wins when several facts hold", () => {
	assert.equal(is({ held: "x", ended: true, sending: true }), "held", "a tower with no run has nothing to end");
	assert.equal(is({ ended: true, sending: true, confirm: "command", phase: "refused", stale: true }), "gone");
	assert.equal(is({ sending: true, confirm: "command", phase: "refused", stale: true }), "sending", "a write on its way, even over a confirm it resends");
	assert.equal(is({ confirm: "command", phase: "refused", stale: true }), "confirm");
	assert.equal(is({ phase: "refused", stale: true, rows: ["Password:"] }), "refused");
	assert.equal(is({ phase: "paused", stale: true, rows: ["Password:"] }), "paused");
	assert.equal(is({ phase: "hidden", stale: true }), "hidden");
	assert.equal(is({ phase: "connecting", stale: true, rows: ["Password:"] }), "connecting", "no frame is not yet stale");
	assert.equal(is({ stale: true, rows: ["Password:"] }), "stale", "a stale password prompt takes no input");
	assert.equal(is({ rows: ["Password:"], after: ["old"] }), "secret", "a new password prompt after an Enter shows the masked field");
});

/** The index of the event that closes the step, or -1. */
const closesAt = (kind: Parameters<typeof stepRule>[0], events: Event[]) => events.findIndex((e) => stepRule(kind, e) === "close");
const marks = (...list: string[]): Event[] => list.map((mark) => ({ type: "mark", mark }));

test("stepRule, prompt: closes on this card's own taken Enter (directly or after a confirm), never on a mark or a refusal", () => {
	assert.equal(stepRule("prompt", { type: "taken" }), "close");
	assert.equal(closesAt("prompt", [{ type: "going" }, { type: "taken" }]), 1, "an Enter going is not taken");
	assert.equal(closesAt("prompt", [{ type: "going" }, { type: "refused", status: 409, error: "confirm" }, { type: "going" }, { type: "taken" }]), 3, "after the inline confirm");
	assert.equal(closesAt("prompt", [{ type: "going" }, { type: "refused", status: 409, error: "confirm" }, { type: "cancel" }]), -1, "取消 leaves it open");
	const never: Event[][] = [
		marks("idle", "working"), marks("working", "working"), marks("idle", "working", "done"), marks("done", "idle"), marks("working"),
		[{ type: "going" }], [{ type: "cancel" }], [{ type: "stale" }], [{ type: "paused" }], [{ type: "network" }], [{ type: "end" }],
		[{ type: "refused", status: 404 }], [{ type: "refused", status: 409, error: "pane_closed" }], [{ type: "refused", status: 429 }], [{ type: "refused", status: 409, error: "no_mirror" }],
	];
	for (const events of never) assert.equal(closesAt("prompt", events), -1, JSON.stringify(events));
	assert.equal(closesAt("prompt", [...marks("idle", "working"), { type: "taken" }]), 2, "a mark before changes nothing");
});

test("stepRule, pane: closes only when the pane is gone (an ended frame, an attach or keys refused as 404 or pane_closed), never on an Enter taken", () => {
	for (const e of [{ type: "end" }, { type: "refused", status: 404 }, { type: "refused", status: 404, error: "not_found" }, { type: "refused", status: 409, error: "pane_closed" }] as Event[]) assert.equal(stepRule("pane", e), "close", JSON.stringify(e));
	assert.equal(stepRule("pane", { type: "taken" }), "stay", "a password is followed by more prompts");
	assert.equal(closesAt("pane", [{ type: "going" }, { type: "taken" }, { type: "taken" }, { type: "taken" }]), -1);
	assert.equal(closesAt("pane", [{ type: "taken" }, { type: "end" }]), 1, "and the end after them closes");
	const never: Event[][] = [
		marks("idle", "working", "done"), [{ type: "going" }], [{ type: "cancel" }], [{ type: "stale" }], [{ type: "paused" }], [{ type: "network" }],
		[{ type: "refused", status: 429 }], [{ type: "refused", status: 409, error: "no_mirror" }], [{ type: "refused", status: 409, error: "confirm" }], [{ type: "refused", status: 403, error: "blocked" }],
	];
	for (const events of never) assert.equal(closesAt("pane", events), -1, JSON.stringify(events));
});

test("stepRule, armed: closes at the unit's first work, on nothing else", () => {
	assert.equal(closesAt("armed", marks("idle", "idle", "working", "working")), 2);
	assert.equal(closesAt("armed", marks("working")), 0);
	assert.equal(closesAt("armed", marks("idle", "done", "idle", "blocked")), -1);
	const never: Event[] = [{ type: "taken" }, { type: "going" }, { type: "end" }, { type: "cancel" }, { type: "stale" }, { type: "paused" }, { type: "network" }, { type: "refused", status: 404 }, { type: "refused", status: 409, error: "pane_closed" }];
	for (const e of never) assert.equal(stepRule("armed", e), "stay", JSON.stringify(e));
});
