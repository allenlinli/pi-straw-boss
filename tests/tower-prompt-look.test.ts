import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { draw, type Look, lookOf, PLAIN } from "../src/towerprompt/look.ts";
import { runPrompt } from "../src/towerprompt/prompt.ts";
import type { PollAnswer, Polled, PromptSource } from "../src/towerprompt/source.ts";
import { until } from "./server-world.ts";

// How the tower prompt looks (docs/how-it-works.md, The standing pane): the screen is cleared when the prompt starts (the command the server typed is not left on it), a title with the tower glyph,
// a state line with a glyph and a colour, the hints as key rows, and a styled prompt. NO_COLOR and a pipe get no colour and no escapes; STRAW_BOSS_ASCII=1 gets no glyph outside ASCII.

const NERD = "\u{F043B}";
const STATE: PollAnswer = { label: "Alpha", state: "standing", queued: 0, leave: false };
const SGR = /\x1b\[[0-9;]*m/g;
const STARTING: Polled = { kind: "state", answer: { ...STATE, state: "waking", leave: true } };

const stops: AbortController[] = [];
afterEach(() => void stops.splice(0).forEach((c) => c.abort()));

class Source implements PromptSource {
	answers: Polled[] = [{ kind: "state", answer: STATE }];
	posted: string[] = [];
	failFresh: Error | undefined;
	failPost: Error | undefined;
	async poll(): Promise<Polled> {
		return this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
	}
	async post(text: string) {
		if (this.failPost) throw this.failPost;
		this.posted.push(text);
	}
	async fresh() {
		if (this.failFresh) throw this.failFresh;
	}
	async leave() {}
	async gone() {}
}

function open(source: PromptSource, look: Look, over: { tty?: boolean; locale?: "en" | "zh-TW" } = {}) {
	const input = new PassThrough(), output = Object.assign(new PassThrough(), over.tty === false ? {} : { isTTY: true, columns: 80, rows: 24 });
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const c = new AbortController();
	stops.push(c);
	const done = runPrompt({ workspace: "wA", source, input, output, signal: c.signal, locale: over.locale ?? "en", pollMs: 15, look });
	return { input, done, text: () => text };
}
const NERD_LOOK: Look = { color: true, ascii: false, clear: true };

test("lookOf: a terminal gets glyphs, colour, and the clear; NO_COLOR (when set and not empty) takes only the colour; STRAW_BOSS_ASCII takes the glyphs; TERM=dumb takes colour and clear", () => {
	assert.deepEqual(lookOf({}, true), { color: true, ascii: false, clear: true });
	assert.deepEqual(lookOf({ NO_COLOR: "1" }, true), { color: false, ascii: false, clear: true });
	assert.deepEqual(lookOf({ NO_COLOR: "" }, true), { color: true, ascii: false, clear: true }, "an empty NO_COLOR is not set (no-color.org)");
	assert.deepEqual(lookOf({ STRAW_BOSS_ASCII: "1" }, true), { color: true, ascii: true, clear: true });
	assert.deepEqual(lookOf({ STRAW_BOSS_ASCII: "true" }, true).ascii, true);
	assert.deepEqual(lookOf({ STRAW_BOSS_ASCII: "0" }, true).ascii, false);
	assert.deepEqual(lookOf({ TERM: "dumb" }, true), { color: false, ascii: false, clear: false });
});

test("lookOf: with no terminal (a pipe, a log) the look is plain: ASCII, no colour, no clear; STRAW_BOSS_ASCII=0 asks for the glyphs anyway", () => {
	assert.deepEqual(lookOf({}, false), PLAIN);
	assert.deepEqual(lookOf({ STRAW_BOSS_ASCII: "0" }, false), { color: false, ascii: false, clear: false });
});

test("on a terminal the screen is cleared first, then the title with the tower glyph, the state line, the key rows, and the styled prompt: the old `tower>` is gone", async () => {
	const p = open(new Source(), NERD_LOOK);
	await until(() => p.text().includes(`${NERD} ❯ `), "the styled prompt");
	const text = p.text();
	assert.ok(text.startsWith("\x1b[H\x1b[2J"), "the first thing on the pane is the clear");
	assert.equal(text.indexOf("\x1b[2J"), text.lastIndexOf("\x1b[2J"), "cleared once");
	const plain = text.replace(SGR, "");
	assert.match(plain, new RegExp(`${NERD} tower · Alpha`));
	assert.match(plain, /● standing by/);
	assert.match(plain, /⏎ +wake the tower/);
	assert.match(plain, /\/new +the next conversation is a new session/);
	assert.match(plain, /\/quit ⌃D +leave this pane to your shell/);
	assert.match(plain, /\/boss tower <message> +wake the tower from any pi session/);
	assert.ok(!plain.includes("tower> "), "the old prompt");
	assert.match(text, /\x1b\[1m[^\n]*tower · Alpha/, "the title is bold");
	assert.match(text, /\x1b\[[0-9;]*32m● ?[^\n]*standing by|\x1b\[[0-9;]*32m●/, "the calm state dot is green");
	p.input.end();
	await p.done;
});

test("the state line changes glyph and colour with the state; a change is printed as a line of its own and the title only when the label changes", async () => {
	const source = new Source();
	source.answers = [{ kind: "state", answer: STATE }, { kind: "state", answer: { ...STATE, state: "running" } }, { kind: "state", answer: { ...STATE, state: "running", queued: 2 } }, { kind: "state", answer: { ...STATE, state: "held" } }];
	const p = open(source, NERD_LOOK);
	await until(() => /held/.test(p.text()), "the held state");
	const plain = p.text().replace(SGR, "");
	assert.match(plain, /▶ running/);
	assert.match(plain, /▶ running, 2 queued/);
	assert.match(plain, /■ held/);
	assert.equal(plain.match(/tower · Alpha/g)?.length, 1, "the title is printed once");
	assert.match(p.text(), /\x1b\[[0-9;]*31m■/, "held is red");
	assert.match(p.text(), /\x1b\[3[46][0-9;]*m▶/, "running is cyan or blue");
	p.input.end();
	await p.done;
});

test("NO_COLOR: no colour or style escape at all, but the glyphs and the clear stay", async () => {
	const p = open(new Source(), { color: false, ascii: false, clear: true });
	await until(() => p.text().includes(`${NERD} ❯ `), "the prompt");
	assert.ok(!SGR.test(p.text()), "no SGR");
	assert.match(p.text(), /● standing by/);
	assert.ok(p.text().startsWith("\x1b[H\x1b[2J"));
	p.input.end();
	await p.done;
});

test("STRAW_BOSS_ASCII: nothing outside ASCII is drawn (apart from the escapes), and the prompt is `tower> `", async () => {
	const p = open(new Source(), { color: true, ascii: true, clear: true });
	await until(() => p.text().includes("tower> "), "the prompt");
	const text = p.text().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	assert.match(text, /^[\x09\x0a\x0d\x20-\x7e]*$/, JSON.stringify(text));
	assert.match(text, /# tower - Alpha/);
	assert.match(text, /o standing by/);
	assert.match(text, /Enter +wake the tower/);
	assert.match(text, /\/quit, Ctrl\+D +leave this pane to your shell/);
	p.input.end();
	await p.done;
});

test("with no terminal the output has no escape sequence at all, whatever the look says", async () => {
	const source = new Source();
	const p = open(source, NERD_LOOK, { tty: false });
	await until(() => p.text().includes(`${NERD} ❯ `), "the prompt");
	p.input.write("/new\n");
	await until(() => p.text().includes("a new session."), "the acknowledgement");
	assert.ok(!p.text().includes("\x1b"), JSON.stringify(p.text()));
	p.input.end();
	await p.done;
});

test("the lines the prompt says between its states carry a glyph and a colour of their kind: done, waiting, trouble, and a command it does not know", async () => {
	const source = new Source();
	const p = open(source, NERD_LOOK);
	await until(() => p.text().includes(`${NERD} ❯ `), "the prompt");
	p.input.write("/new\r");
	await until(() => p.text().includes("a new session."), "the /new line");
	p.input.write("/nope\r");
	await until(() => p.text().includes("is not a command here"), "the unknown command");
	source.failPost = new Error("no tower");
	p.input.write("hello\r");
	await until(() => p.text().includes("did not take it"), "the refusal");
	const text = p.text();
	assert.match(text, /\x1b\[[0-9;]*32m✓[^\n]*the next conversation with the tower is a new session\./);
	assert.match(text, /\x1b\[[0-9;]*33m\?[^\n]*\/nope is not a command here/);
	assert.match(text, /\x1b\[[0-9;]*31m✗[^\n]*the tower did not take it: no tower/);
	assert.ok(!text.replace(SGR, "").includes("tower> "), "no old prompt name in the lines either");
	p.input.end();
	await p.done;
});

test("a run that starts, the boss leaving, and a tower that is gone are said in the same look", async () => {
	const waking = new Source();
	waking.answers = [{ kind: "state", answer: STATE }, STARTING];
	const w = open(waking, NERD_LOOK);
	assert.equal(await w.done, 0);
	assert.match(w.text().replace(SGR, ""), /◐ waking the tower…/);
	const gone = new Source();
	gone.answers = [{ kind: "state", answer: STATE }, { kind: "gone" }];
	const g = open(gone, NERD_LOOK);
	assert.equal(await g.done, 0);
	assert.match(g.text().replace(SGR, ""), /! the sb server has no tower/);
	const left = new Source();
	const l = open(left, NERD_LOOK);
	await until(() => l.text().includes(`${NERD} ❯ `), "the prompt");
	l.input.write("\x04");
	assert.equal(await l.done, 0);
	assert.match(l.text().replace(SGR, ""), /↩ leaving this pane to your shell/);
});

test("a prompt that ends before it shows a state (a run is already starting) does not clear the pane", async () => {
	const source = new Source();
	source.answers = [STARTING];
	const p = open(source, NERD_LOOK);
	assert.equal(await p.done, 0);
	assert.ok(!p.text().includes("\x1b[2J"), JSON.stringify(p.text()));
});

test("Traditional Chinese keeps the layout: title, state line, key rows, with the words in zh-TW", async () => {
	const p = open(new Source(), NERD_LOOK, { locale: "zh-TW" });
	await until(() => p.text().includes(`${NERD} ❯ `), "the prompt");
	const plain = p.text().replace(SGR, "");
	assert.match(plain, new RegExp(`${NERD} 塔台 · Alpha`));
	assert.match(plain, /● 待命中/);
	assert.match(plain, /\/quit ⌃D +把這個窗格還給你的 shell/);
	p.input.end();
	await p.done;
});

test("a state named like an Object member is an unknown state, not a prototype lookup (UR-F006)", () => {
	for (const state of ["constructor", "toString", "__proto__"]) {
		const line = draw(PLAIN).state(state, "words");
		assert.ok(!line.includes("undefined"), state);
		assert.ok(line.endsWith(" words"), state);
	}
});

test("the head tower's prompt carries the crown in its title and says `head tower`, in ASCII `# head tower` and in zh-TW 主塔台; a workspace tower's title is unchanged", async () => {
	const CROWN = "\u{F01A5}";
	const headSource = () => Object.assign(new Source(), { answers: [{ kind: "state", answer: { ...STATE, label: "Head tower", head: true } }] as Polled[] });
	const nerd = open(headSource(), NERD_LOOK);
	await until(() => /head tower/.test(nerd.text()), "the head's title");
	assert.match(nerd.text().replace(SGR, ""), new RegExp(`${CROWN} head tower`));
	assert.ok(!nerd.text().replace(SGR, "").split("\n").find((line) => /head tower/.test(line))!.includes(NERD), "no radio tower in the head's title");
	nerd.input.end();
	await nerd.done;
	const ascii = open(headSource(), { color: false, ascii: true, clear: false });
	await until(() => /# head tower/.test(ascii.text()), "the ASCII title");
	ascii.input.end();
	await ascii.done;
	const zh = open(headSource(), NERD_LOOK, { locale: "zh-TW" });
	await until(() => /主塔台/.test(zh.text()), "the zh-TW title");
	assert.match(zh.text().replace(SGR, ""), new RegExp(`${CROWN} 主塔台`));
	zh.input.end();
	await zh.done;
	const tower = open(new Source(), NERD_LOOK);
	await until(() => /tower · Alpha/.test(tower.text()), "a tower's title");
	assert.match(tower.text().replace(SGR, ""), new RegExp(`${NERD} tower · Alpha`));
	tower.input.end();
	await tower.done;
});
