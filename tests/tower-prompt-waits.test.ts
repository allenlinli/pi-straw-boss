import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import type { ViewEntry } from "../src/memorycmd.ts";
import { createPick } from "../src/towerprompt/pick.ts";
import { type Locale, textsFor } from "../src/towerprompt/messages.ts";
import { runPrompt } from "../src/towerprompt/prompt.ts";
import type { PickSource, PollAnswer, Polled, PromptSource } from "../src/towerprompt/source.ts";
import type { Tower } from "../src/waitview.ts";
import { until } from "./server-world.ts";

// The tower prompt's block and its picker (docs/specs/2026-11-10-wait-cards-tui.md, §3a; todo #144 task 4): the cards that wait for the boss are shown under the state line, `/wait` takes the keyboard to press one with numbers, and only
// typed keys press: a paste, a run that starts, and a pane that cannot be marked press nothing and post nothing. A fake source and real short timers, as tests/tower-prompt.test.ts has them.

const STATE: PollAnswer = { label: "Alpha", state: "standing", queued: 0, leave: false };
const stops: AbortController[] = [];
afterEach(() => void stops.splice(0).forEach((c) => c.abort()));
const stop = () => {
	const c = new AbortController();
	stops.push(c);
	return c.signal;
};
const NOW = Date.parse("2026-11-10T10:00:00Z");

class FakePick implements PickSource {
	towers: Tower[] = [];
	auto = false;
	pressed: { workspace: string; json: Record<string, unknown> }[] = [];
	replies: { workspace: string; head?: true; text: string; answers: string }[] = [];
	reads = 0;
	opened = 0;
	closed = 0;
	refuse: Error | undefined;
	/** The mark is not open until this is released. */
	gate: Promise<void> | undefined;
	/** A press waits for this before it answers. */
	hold: Promise<void> | undefined;
	pressStatus = 200;
	pressBody: Record<string, unknown> = { press: { main: { status: "delivered" } } };
	async waits() {
		this.reads++;
		return { auto: this.auto, towers: structuredClone(this.towers) };
	}
	async press(workspace: string, json: Record<string, unknown>) {
		this.pressed.push({ workspace, json });
		await this.hold;
		return { status: this.pressStatus, body: this.pressBody };
	}
	async reply(tower: { workspace: string; head?: true }, text: string, answers: string) {
		this.replies.push({ workspace: tower.workspace, ...(tower.head ? { head: true as const } : {}), text, answers });
		return { answered: answers };
	}
	async here<T>(fn: () => Promise<T>): Promise<T> {
		await this.gate;
		if (this.refuse) throw this.refuse;
		this.opened++;
		try {
			return await fn();
		} finally {
			this.closed++;
		}
	}
}
class FakeSource implements PromptSource {
	answers: Polled[] = [{ kind: "state", answer: STATE }];
	pick: FakePick | undefined = new FakePick();
	posted: string[] = [];
	left = 0;
	gones = 0;
	async poll(): Promise<Polled> {
		return this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
	}
	async post(text: string) {
		this.posted.push(text);
	}
	async fresh() {}
	async leave() {
		this.left++;
	}
	async gone() {
		this.gones++;
	}
	/** The digest the polls carry from now on. */
	digest(waits: PollAnswer["waits"], extra: Partial<PollAnswer> = {}) {
		this.answers = [{ kind: "state", answer: { ...STATE, waits, ...extra } }];
	}
	waking() {
		this.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	}
}
const card = (id: string, over: Partial<NonNullable<ViewEntry["card"]>> = {}, extra: Partial<ViewEntry> = {}): ViewEntry => ({
	id, kind: "wait", text: `do ${id}`, at: new Date(NOW - 12 * 60_000).toISOString(), state: "open",
	card: { type: "action", lang: "en", happened: `${id} happened`, do: `do ${id}`, from: { id: "m1", name: "mp3946-print", role: "main" }, ...over }, ...extra,
});
const tower = (waits: ViewEntry[], over: Partial<Tower> = {}): Tower => ({ workspace: "wA", label: "Alpha", own: true, waits, ...over });

/** A screen that is not a terminal: nothing but the prompt's own lines. */
function screen(source: PromptSource, over: { locale?: Locale; look?: boolean } = {}) {
	const input = new PassThrough(), output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, signal: stop(), locale: over.locale ?? "en", pollMs: 15, clock: { now: () => NOW, after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as NodeJS.Timeout) } });
	return { input, done, text: () => text };
}
/** A terminal: readline edits the line and reports keys, so a bracketed paste is seen as one. */
function terminal(source: PromptSource, over: { locale?: Locale } = {}) {
	const input = new PassThrough(), output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, signal: stop(), locale: over.locale ?? "en", pollMs: 15, clock: { now: () => NOW, after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as NodeJS.Timeout) } });
	// What readline wrote to move the cursor and clear the line is not text: what is left reads as the lines do.
	return { input, done, text: () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") };
}
const ended = (done: Promise<number>) => Promise.race([done, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("the prompt did not end")), 3000).unref())]);
type Screen = ReturnType<typeof screen>;
/** The keys of a typed line: its characters, then Enter, as separate reads (a person's keys). */
const typed = async (p: Screen, line: string) => {
	for (const ch of line) p.input.write(ch);
	p.input.write("\r");
};
const count = (text: string, part: string) => text.split(part).length - 1;

test("the block of waiting cards is printed under the state line when the digest changes, once, with the tag, what you do, the raiser, and parked; five lines and a count; empty says so; no bell", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W2", type: "choice", do: "Deploy now?", from: "mp3946-print", parked: true }, { id: "W1", type: "action", do: "Re-authorize" }]);
	const p = screen(source);
	await until(() => p.text().includes("waits for you (2)"), "the block");
	const text = p.text();
	assert.ok(text.indexOf("standing by") < text.indexOf("waits for you (2)"), "under the state line");
	assert.match(text, /\? waits for you \(2\)\n {2}W2 choice · Deploy now\? · from mp3946-print · parked\n {2}W1 action · Re-authorize\n/);
	await until(() => count(p.text(), "standing by") >= 1, "a poll");
	await new Promise((r) => setTimeout(r, 80)); // several polls with the same digest
	assert.equal(count(p.text(), "waits for you (2)"), 1, "the same digest is not printed again");
	source.digest([{ id: "W1", type: "action", do: "Re-authorize" }]);
	await until(() => p.text().includes("waits for you (1)"), "the changed digest");
	source.digest(Array.from({ length: 8 }, (_, i) => ({ id: `W${i + 1}`, type: "secret", do: `card ${i + 1}` })));
	await until(() => p.text().includes("waits for you (8)"), "eight cards");
	const block = p.text().slice(p.text().indexOf("waits for you (8)"));
	assert.equal(count(block, " secret · "), 5, "at most five lines");
	assert.match(block, /3 more: \/wait/);
	source.digest([]);
	await until(() => p.text().includes(textsFor("en").waitsNone), "the empty note");
	assert.equal(p.text().includes("\x07"), false, "no bell");
	source.waking();
	assert.equal(await ended(p.done), 0);
});

test("the block speaks Traditional Chinese for a zh-TW boss, and a prompt of an older server (no digest) shows none", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W1", type: "action", do: "重新授權", from: "mp3946-print", parked: true }, ...Array.from({ length: 5 }, (_, i) => ({ id: `W${i + 2}`, type: "secret", do: `卡片 ${i + 2}` }))]);
	const p = screen(source, { locale: "zh-TW" });
	await until(() => p.text().includes("等你處理（6）"), "the block");
	assert.match(p.text(), /W1 動作 · 重新授權 · 由 mp3946-print · 已暫放/);
	assert.match(p.text(), /還有 1 張：\/wait/);
	assert.match(p.text(), /\/wait\s+處理等你的卡片/, "the hint row");
	source.waking();
	await ended(p.done);
	const old = new FakeSource();
	const q = screen(old);
	await until(() => q.text().includes("standing by"), "the state");
	assert.equal(q.text().includes("waits for you"), false);
	old.waking();
	await ended(q.done);
});

test("an escape or a control character in a card's text is not written to the terminal: the block, the list, and the card are cleaned again", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W1", type: "action", do: "fix\x1b[2J\x1b]0;x\x07 it", from: "ma\x1bin" }]);
	source.pick!.towers = [tower([card("W1", { do: "fix\x1b[2J it", happened: "bad\x1b[31m news\x07", from: { id: "m1", name: "ma\x1bin", role: "main" }, command: "echo \x1b[1mhi" })])];
	const p = screen(source);
	await until(() => p.text().includes("waits for you (1)"), "the block");
	await typed(p, "/wait");
	await until(() => p.text().includes("What happened"), "the card");
	assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(p.text()), false, JSON.stringify(p.text()));
	assert.match(p.text(), /W1 action · fix\[2J\]0;x it · from main/);
	source.waking();
	await ended(p.done);
});

test("/wait and /boss wait take the keyboard: the cards are listed (this tower's first), a number picks a card and a number its act, and the press is the server's own; the mark is held for the whole mode and the prompt comes back", async () => {
	for (const word of ["/wait", "/boss wait"]) {
		const source = new FakeSource(), pick = source.pick!;
		pick.towers = [tower([card("W1"), card("W2", { do: "Second thing" })]), { workspace: "wB", label: "Beta", waits: [card("W1", { do: "Beta thing" })] }];
		const p = terminal(source);
		await until(() => p.text().includes("tower> "), "the prompt");
		p.input.write(`${word}\r`);
		await until(() => p.text().includes("Waits for you (3)"), "the list");
		assert.equal(pick.opened, 1, "the mark opens before the cards are asked");
		assert.equal(pick.closed, 0, "and stays");
		const text = p.text();
		assert.match(text, /1\. \[Alpha\] Needs you: do W1 · from mp3946-print · 12 min ago/);
		assert.match(text, /3\. \[Beta\] Needs you: Beta thing/);
		assert.ok(text.slice(text.lastIndexOf("Waits for you (3)")).includes("wait> "), "the prompt becomes wait>");
		await typed(p as Screen, "9");
		await until(() => p.text().includes("That is not one of the numbers above."), "a number that is none");
		await typed(p as Screen, "1");
		await until(() => p.text().includes("1. I'm done"), "the card's acts");
		const card1 = p.text().slice(p.text().lastIndexOf("[Alpha] W1")).replace(/^wait> /gm, "");
		assert.match(card1, /What happened: W1 happened\nWhat you do: do W1\nRaised by: mp3946-print/);
		assert.match(card1, /1\. I'm done\n {2}2\. Skip\n {2}3\. Reply to the tower\n {2}4\. Back/, "no switch of tabs in the prompt: it has no Herdr to focus with");
		await typed(p as Screen, "1");
		await until(() => pick.pressed.length === 1, "the press");
		assert.deepEqual(pick.pressed, [{ workspace: "wA", json: { op: "press", id: "W1", act: "done" } }]);
		await until(() => p.text().includes("W1 done: mp3946-print was told."), "the result line");
		await until(() => pick.reads === 2, "the list is read again after a press");
		await typed(p as Screen, "");
		await until(() => pick.closed === 1, "an empty line at the list leaves the mode and drops the mark");
		await until(() => p.text().slice(p.text().lastIndexOf("W1 done")).includes("tower> "), "the prompt comes back");
		assert.deepEqual(source.posted, [], "nothing the boss typed in the mode was posted");
		p.input.write("\x04");
		assert.equal(await ended(p.done), 0);
	}
});

test("a choice card presses the option by its index, a legacy wait asks the tower to restate, the secret's first step and its end are the two presses; a single card skips the list and ends the mode after its press", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1", { type: "choice", do: "Deploy now?", options: [{ label: "Deploy", then: "The main deploys." }, { label: "Hold", then: "The main waits." }] })])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("2. 2) Hold — The main waits."), "the options as acts");
	assert.equal(p.text().includes("Waits for you (1)"), false, "one card: no list");
	await typed(p, "2");
	await until(() => pick.pressed.length === 1, "the press");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W1", act: "choose", option: 1 });
	await until(() => pick.closed === 1, "the mode ends after a single card's press");
	// a legacy wait
	pick.towers = [tower([{ id: "W2", kind: "wait", text: "old words", at: new Date(NOW).toISOString(), state: "open" }])];
	await typed(p, "/wait");
	await until(() => p.text().includes("Ask the tower to rewrite it as a card"), "legacy acts");
	await typed(p, "1");
	await until(() => pick.pressed.length === 2, "restate");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W2", act: "restate" });
	// a secret
	pick.towers = [tower([card("W3", { type: "secret", secret: { name: "the auth key" } })])];
	await typed(p, "/wait");
	await until(() => p.text().includes("Start entering (asks mp3946-print"), "start entering");
	await typed(p, "1");
	await until(() => pick.pressed.length === 3, "the first step");
	assert.deepEqual(pick.pressed[2]!.json, { op: "press", id: "W3", act: "secret" });
	pick.towers = [tower([card("W3", { type: "secret", secret: { name: "the auth key" } }, { press: { act: "secret", at: "x", secretAsked: "x" } })])];
	await typed(p, "/wait");
	await until(() => p.text().includes("1. I entered it"), "the end of the secret");
	await typed(p, "1");
	await until(() => pick.pressed.length === 4, "done");
	assert.deepEqual(pick.pressed[3]!.json, { op: "press", id: "W3", act: "done" });
	assert.deepEqual(source.posted, []);
	source.waking();
	await ended(p.done);
});

test("skip asks a reason line, then y/N; only a y presses, with the reason; anything else goes back to the card and presses nothing; a reply is the next line, an empty one cancels", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1")])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("2. Skip"), "the card");
	await typed(p, "2");
	await until(() => p.text().includes("Reason (optional; Enter for none):"), "the reason line");
	await typed(p, "no time this week");
	await until(() => p.text().includes("Skip this? the tower and mp3946-print will know you will not do this. (y/N)"), "the confirm");
	await typed(p, "n");
	await until(() => count(p.text(), "1. I'm done") === 2, "back to the card");
	assert.equal(pick.pressed.length, 0, "an N presses nothing");
	await typed(p, "2");
	await until(() => count(p.text(), "Reason (optional; Enter for none):") === 2, "the reason line again");
	await typed(p, "");
	await until(() => count(p.text(), "(y/N)") === 2, "the confirm after no reason");
	await typed(p, "y");
	await until(() => pick.pressed.length === 1, "the decline");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W1", act: "decline" }, "an empty reason is no reason");
	await until(() => pick.closed === 1, "the mode ended");
	// with a reason and a y
	await typed(p, "/wait");
	await until(() => count(p.text(), "2. Skip") === 3, "the card again");
	await typed(p, "2");
	await until(() => count(p.text(), "Reason (optional; Enter for none):") === 3, "the reason line a third time");
	await typed(p, "no time this week");
	await until(() => count(p.text(), "(y/N)") === 3, "the confirm with a reason");
	await typed(p, "yes");
	await until(() => pick.pressed.length === 2, "the second decline");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W1", act: "decline", reason: "no time this week" });
	// a reply
	await typed(p, "/wait");
	await until(() => count(p.text(), "3. Reply to the tower") === 4, "the card for a reply");
	await typed(p, "3");
	await until(() => p.text().includes("Reply to the tower (an empty line cancels):"), "the reply line");
	await typed(p, "on Monday, please");
	await until(() => pick.replies.length === 1, "the reply");
	assert.deepEqual(pick.replies, [{ workspace: "wA", text: "on Monday, please", answers: "W1" }]);
	assert.equal(pick.pressed.length, 2, "a reply is no press");
	assert.deepEqual(source.posted, [], "nor a post of the boss's words");
	source.waking();
	await ended(p.done);
});

test("a refusal of the server is shown with its reason and the list is read again", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	pick.pressStatus = 409;
	pick.pressBody = { error: "refused", reason: "W1 was pressed already: I'm done at 10:00" };
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	await typed(p, "1");
	await until(() => p.text().includes("1. I'm done"), "the card");
	await typed(p, "1");
	await until(() => p.text().includes("W1 was pressed already: I'm done at 10:00 (the list is read again)"), "the refusal");
	await until(() => pick.reads === 2, "read again");
	assert.equal(count(p.text(), "Waits for you (2)"), 2, "the list is drawn again");
	source.waking();
	await ended(p.done);
});

test("a paste is no pick: a bracketed paste, or lines that arrive together, end the mode with nothing pressed or posted, and the prompt says so", async () => {
	for (const paste of ["\x1b[200~1\x1b[201~\r", "\x1b[200~1\r", "1\n1\n"]) {
		const source = new FakeSource(), pick = source.pick!;
		pick.towers = [tower([card("W1"), card("W2")])];
		const p = terminal(source);
		await until(() => p.text().includes("tower> "), "the prompt");
		p.input.write("/wait\r");
		await until(() => p.text().includes("Waits for you (2)"), "the list");
		p.input.write(paste);
		await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), `the paste (${JSON.stringify(paste)})`);
		await until(() => pick.closed === 1, "the mark is dropped");
		assert.deepEqual(pick.pressed, [], JSON.stringify(paste));
		assert.deepEqual(source.posted, [], "and nothing is posted");
		await until(() => p.text().slice(p.text().lastIndexOf("a paste is not a pick")).includes("tower> "), "the prompt comes back");
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(source.posted, [], "not later either");
		p.input.write("\x04");
		await ended(p.done);
	}
});

test("a paste or a leave while the mark is still opening ends the mode for good: no list, no key is taken, the mark is dropped, and the boss's next line is a message", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1", { type: "secret", secret: { name: "KEY" } }), card("W2")])];
	let open!: () => void;
	pick.gate = new Promise<void>((resolve) => (open = resolve));
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await new Promise((r) => setTimeout(r, 40)); // the mark is being opened
	p.input.write("\x1b[200~1\x1b[201~\r");
	await new Promise((r) => setTimeout(r, 40));
	open();
	await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), "the paste");
	await until(() => pick.closed === 1, "the mark is dropped");
	await until(() => p.text().slice(p.text().lastIndexOf("a paste is not a pick")).includes("tower> "), "the prompt comes back");
	assert.equal(pick.reads, 0, "the cards are never listed");
	assert.equal(p.text().includes("Waits for you"), false);
	p.input.write("1\r");
	await until(() => source.posted.length === 1, "a digit is a message again");
	p.input.write("1\r");
	await until(() => source.posted.length === 2, "and again");
	assert.deepEqual(pick.pressed, [], "nothing is pressed without the mark");
	assert.equal(pick.opened, 1);
	assert.equal(pick.closed, 1);
	p.input.write("\x04");
	await ended(p.done);
});

test("stop while the mark is still opening: the mode stays ended, the cards are not read or listed, and the mark is dropped", async () => {
	const pick = new FakePick(), lines: string[] = [], modes: boolean[] = [];
	pick.towers = [tower([card("W1"), card("W2")])];
	let open!: () => void;
	pick.gate = new Promise<void>((resolve) => (open = resolve));
	const mode = createPick({ source: pick, locale: "en", say: (l) => void lines.push(l), mode: (on) => void modes.push(on), now: () => NOW });
	const started = mode.start();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(mode.active(), true);
	const stopped = mode.stop();
	open();
	await Promise.all([started, stopped]);
	assert.equal(mode.active(), false);
	assert.equal(pick.reads, 0);
	assert.deepEqual(lines, []);
	assert.deepEqual(modes, [true, false]);
	assert.equal(pick.closed, 1);
	await mode.line("1");
	assert.deepEqual(pick.pressed, []);
});

test("a run that starts in pick mode drops it: what is on the line is not posted, the prompt says where the cards are now, and the pane is given up; the mark is dropped", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	p.input.write("1"); // a digit on the line, not entered
	await until(() => p.text().slice(p.text().lastIndexOf("Waits for you (2)")).includes("wait> 1"), "the digit on the line");
	source.waking();
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, [], "digits typed in the mode are never posted as the boss's words");
	assert.equal(source.gones, 1);
	assert.match(p.text(), new RegExp(textsFor("en").pickWoke.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
	assert.equal(pick.closed, 1);
	// the same in Traditional Chinese
	const zh = new FakeSource();
	zh.pick!.towers = [tower([card("W1"), card("W2")])];
	const q = terminal(zh, { locale: "zh-TW" });
	await until(() => q.text().includes("待命中"), "the prompt");
	q.input.write("/wait\r");
	await until(() => q.text().includes("等你處理（2）"), "the list");
	zh.waking();
	await ended(q.done);
	assert.match(q.text(), /塔台醒了，到執行中的窗格用 \/boss wait 處理/);
});

test("a press already sent is answered first: its result line is printed before the pane is given up", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	let release!: () => void;
	pick.hold = new Promise<void>((resolve) => (release = resolve));
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	await typed(p, "1");
	await until(() => p.text().includes("1. I'm done"), "the card");
	await typed(p, "1");
	await until(() => pick.pressed.length === 1, "the press is on its way");
	source.waking(); // the press woke the tower
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(source.gones, 0, "the prompt waits for the answer of the press");
	release();
	assert.equal(await ended(p.done), 0);
	const text = p.text();
	assert.ok(text.indexOf("W1 done: mp3946-print was told.") > 0 && text.indexOf("W1 done: mp3946-print was told.") < text.indexOf(textsFor("en").pickWoke), "the result comes before the leave");
	assert.deepEqual(source.posted, []);
});

test("a pane that cannot be marked refuses the mode: nothing is read, nothing is asked, and the next /wait works once it can", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	pick.refuse = new Error("the pane could not be marked (no answer)");
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Pick mode needs this pane marked as local-only"), "the refusal");
	assert.match(p.text(), /the pane could not be marked \(no answer\)/);
	assert.equal(pick.reads, 0, "nothing was read");
	assert.deepEqual(pick.pressed, []);
	// lines typed after it are the boss's own words again, not the picker's
	p.input.write("hello\r");
	await until(() => source.posted.length === 1, "an ordinary message");
	assert.deepEqual(source.posted, ["hello"]);
	pick.refuse = undefined;
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list once it can be marked");
	p.input.write("\x04");
	await ended(p.done);
});

test("Ctrl+D in pick mode leaves the pane as ever and drops the mark; a source with no way to press says so", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	p.input.write("\x04");
	assert.equal(await ended(p.done), 0);
	assert.equal(source.left, 1);
	assert.equal(pick.closed, 1);
	assert.deepEqual(source.posted, []);
	const bare = new FakeSource();
	bare.pick = undefined;
	const q = screen(bare);
	await until(() => q.text().includes("standing by"), "the prompt");
	await typed(q, "/wait");
	await until(() => q.text().includes("cannot press cards"), "the refusal");
	assert.deepEqual(bare.posted, []);
	bare.waking();
	await ended(q.done);
});

test("auto mode: parked cards are listed and pressable, and the secret's start is not offered, with the line", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.auto = true;
	pick.towers = [tower([card("W1", { type: "secret", secret: { name: "the key" } }, { parked: true })])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Start entering is off while auto mode is on: /boss auto off first."), "the line");
	const shown = p.text().slice(p.text().lastIndexOf("[Alpha] W1"));
	assert.equal(shown.includes("Start entering ("), false, "no start of the secret");
	assert.match(shown, /1\. Skip\n {2}2\. Reply to the tower\n {2}3\. Back/);
	assert.match(shown, /Parked for your return\./);
	source.waking();
	await ended(p.done);
	// a parked plain card is pressable
	const plain = new FakeSource();
	plain.pick!.auto = true;
	plain.pick!.towers = [tower([card("W1", {}, { parked: true })])];
	const q = screen(plain);
	await until(() => q.text().includes("standing by"), "the prompt");
	await typed(q, "/wait");
	await until(() => q.text().includes("1. I'm done"), "the card");
	await typed(q, "1");
	await until(() => plain.pick!.pressed.length === 1, "pressed");
	plain.waking();
	await ended(q.done);
});

test("no cards: the mode says so and ends, with the mark dropped, and a typed digit afterwards is an ordinary message", async () => {
	const source = new FakeSource(), pick = source.pick!;
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("No wait card is open for you."), "the note");
	await until(() => pick.closed === 1, "the mark dropped");
	await typed(p, "1");
	await until(() => source.posted.length === 1, "a message");
	assert.deepEqual(source.posted, ["1"]);
	source.waking();
	await ended(p.done);
});
