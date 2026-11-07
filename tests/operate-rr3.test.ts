import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { KeybindingsManager } from "@earendil-works/pi-tui";
import { BYTES, bindingReport } from "../src/bindings.ts";
import { createControl } from "../src/control.ts";
import { piInForeground } from "../src/foreground.ts";
import { COMBOS, OPERATE_COMBOS, PAD } from "../src/keys.ts";
import { type Editor, operateKeyRefusal } from "../src/probe.ts";
import { scopeOf, world } from "./operate-world.ts";
import { assistant, call, lines, user } from "./sessions.ts";

// The re-review of 033c4358 (backlog "Re-review 033c4358"): RR3-F001 to RR3-F007.

const Q = new URLSearchParams(), scope = scopeOf(["sess-1"]), RAW = { isTTY: true, isRaw: true };
const why = (r: { status: number; body: unknown }) => [r.status, (r.body as { why?: string; error?: string }).why ?? (r.body as { error?: string }).error];
const pi = { pid: 11, name: "pi", argv0: "pi", cmdline: "pi" };
const defs = async () => ((await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href)) as { KEYBINDINGS: never }).KEYBINDINGS;
const ok = { editor: "empty", keys: [], holds: {}, raw: true } as Editor;

test("RR3-F001: helper children beside pi (claude, an MCP server, a build tool, a wrapper bash) do not take pi's hold; no pi, two pis, and no list do", () => {
	const at = (...rest: object[]) => piInForeground({ shell_pid: 10, foreground_processes: [{ pid: 10, name: "zsh" }, ...rest] });
	assert.equal(at(pi), true);
	assert.equal(at(pi, { pid: 12, name: "claude", argv0: "/x/claude-agent-sdk-darwin-arm64/claude" }, { pid: 13, name: "node", argv0: "node" }, { pid: 14, name: "bash", argv0: "bash" }), true);
	assert.equal(at(), false);
	assert.equal(at({ pid: 12, name: "nano", argv0: "nano" }), false);
	assert.equal(at(pi, { ...pi, pid: 13 }), false);
	assert.equal(piInForeground(undefined), false);
});

test("RR3-F001: Stop goes while helpers share pi's group, and a pi without raw mode (an external editor, Ctrl+Z) refuses every write, Stop included", async () => {
	const x = await world();
	await x.attach(scope);
	x.w.procs = [pi, { pid: 12, name: "claude", argv0: "claude", cmdline: "claude" }];
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { keys: ["esc"] }, scope)).status, 200);
	for (const raw of [false, undefined]) {
		const y = await world({ editor: { ...ok, raw } as Editor });
		await y.attach(scope);
		for (const [what, done] of [["stop", await y.session.request("POST", ["sessions", "sess-1", "keys"], Q, { keys: ["esc"] }, scope)], ["key", await y.key(y.session, scope, "up")], ["enter", await y.key(y.session, scope, "enter")], ["paste", await y.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", paste: "hi" }, scope)], ["input", await y.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hi", as: "send" }, scope)]] as const) assert.deepEqual(why(done), [403, "terminal"], `raw ${raw}: ${what}`);
		assert.deepEqual(y.typed(), []);
	}
});

test("RR3-F001: the dequeue's key needs the raw mode too", async () => {
	const x = await world({ editor: { ...ok, raw: false } as Editor });
	x.w.pending = true;
	const done = await x.session.request("POST", ["sessions", "sess-1", "dequeue"], Q, { take: "x".repeat(16) }, scope);
	assert.deepEqual(why(done), [403, "terminal"]);
	assert.deepEqual(x.typed(), []);
	const y = await world({ editor: ok });
	y.w.pending = true;
	assert.equal((await y.session.request("POST", ["sessions", "sess-1", "dequeue"], Q, { take: "x".repeat(16) }, scope)).status, 200);
	assert.ok(y.typed().length > 0);
});

test("RR3-F001: the bridge's report says raw only for a TTY in raw mode", async () => {
	const m = new KeybindingsManager(await defs(), {}) as never;
	assert.equal(bindingReport(m, RAW)?.raw, true);
	for (const stdin of [{ isTTY: true, isRaw: false }, { isTTY: true }, { isRaw: true }, {}]) assert.equal(bindingReport(m, stdin)?.raw, false, JSON.stringify(stdin));
});

test("RR3-F002: a binding is compared by the bytes the pad sends, so pi's other spellings (esc, return, ctrl+m, ctrl+i, alt+return, alt+left) name the same key", async () => {
	for (const [alias, pad] of [["esc", "esc"], ["escape", "esc"], ["ctrl+[", "esc"], ["return", "enter"], ["enter", "enter"], ["ctrl+m", "enter"], ["ctrl+i", "tab"], ["alt+return", "alt+enter"], ["alt+left", "alt+b"], ["alt+left", "alt+left"], ["alt+b", "alt+left"]] as const) {
		const report = bindingReport(new KeybindingsManager(await defs(), { "app.editor.external": alias }) as never, RAW)!;
		assert.ok(report.keys.includes(pad), `${alias} holds ${pad}: ${JSON.stringify(report.keys)}`);
		assert.equal(operateKeyRefusal({ editor: "empty", ...report }, pad)?.why, "binding", `${alias} / ${pad}`);
	}
	// end to end: Escape with the external editor on `return` for Enter, as the box would report it
	const x = await world({ editor: { ...ok, keys: ["enter"] } as Editor });
	await x.attach(scope);
	assert.equal((await x.key(x.session, scope, "enter")).status, 403);
});

test("RR3-F002: the byte table covers every key an operate session can send, and only keys the pad knows", () => {
	const sendable = [...PAD, "delete", "alt+enter", "alt+backspace", ...["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y"].map((l) => `ctrl+${l}`), ...[..."abcdefghijklmnopqrstuvwxyz"].map((l) => `alt+${l}`), "ctrl+left", "ctrl+right", "alt+left", "alt+right"].filter((k) => k === "delete" || PAD.includes(k) || OPERATE_COMBOS.test(k));
	for (const key of sendable) assert.ok(BYTES[key], `${key} has bytes`);
	for (const key of Object.keys(BYTES)) assert.ok(PAD.includes(key) || key === "delete" || COMBOS.test(key), `${key} is a key of the pad`);
});

test("RR3-F003: submit, follow-up, clear and interrupt on a pad key whose guard is not written for them are refused; on their own keys they pass", async () => {
	for (const id of ["tui.input.submit", "app.message.followUp", "app.clear", "app.interrupt"]) {
		const report = bindingReport(new KeybindingsManager(await defs(), { [id]: ["tab"] }) as never, RAW)!;
		assert.equal(operateKeyRefusal({ editor: "empty", ...report }, "tab")?.why, "binding", id);
		assert.equal(report.keys.includes("tab"), false, id);
	}
	const stock = bindingReport(new KeybindingsManager(await defs(), {}) as never, RAW)!;
	for (const key of ["enter", "alt+enter", "ctrl+c", "esc", "tab", "up"]) assert.equal(operateKeyRefusal({ editor: "empty", ...stock }, key), undefined, key);
	// the guards of the others only: a user who moves clear to Enter gets Enter refused
	const moved = bindingReport(new KeybindingsManager(await defs(), { "app.clear": ["enter"], "tui.input.submit": ["tab"] }) as never, RAW)!;
	assert.equal(operateKeyRefusal({ editor: "empty", ...moved }, "enter")?.why, "binding");
	// and through the seam, twice at once as in the review
	const x = await world({ editor: { ...ok, holds: { clear: ["tab"] } } as Editor });
	await x.attach(scope);
	assert.deepEqual(why(await x.key(x.session, scope, "tab")), [403, "binding"]);
	assert.deepEqual(x.typed(), []);
});

test("RR3-F004: a key id in keybindings.json that pi does not define (an extension's shortcut) is a foreign binding", async () => {
	const report = bindingReport(new KeybindingsManager(await defs(), { "mcp.panel.open": "tab" } as never) as never, RAW)!;
	assert.ok(report.keys.includes("tab"));
	assert.equal(operateKeyRefusal({ editor: "empty", ...report }, "tab")?.why, "binding");
	assert.equal(operateKeyRefusal({ editor: "empty", ...report }, "up"), undefined);
});

test("RR3-F005: the foreground is looked at inside the control job, right before each write: a program that opens during the editor probe stops the Enter", async () => {
	const x = await world();
	await x.attach(scope);
	x.w.onProbe = () => void (x.w.procs = [{ pid: 12, name: "nano", argv0: "nano", cmdline: "nano" }]);
	assert.deepEqual(why(await x.key(x.session, scope, "enter")), [403, "foreground"]);
	assert.deepEqual(x.typed(), []);
	// the same for the key pad's other keys, whose probe is first
	const y = await world();
	await y.attach(scope);
	y.w.onProbe = () => void (y.w.procs = [{ pid: 12, name: "nano", argv0: "nano", cmdline: "nano" }]);
	assert.deepEqual(why(await y.key(y.session, scope, "up")), [403, "foreground"]);
	assert.deepEqual(y.typed(), []);
});

test("RR3-F005: control.run refuses an operate write when the flags carry no foreground look at all", async () => {
	const answers = { has: () => false, replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), commands: async () => undefined, target: async () => undefined, probe: async () => ok, pull: async () => ({ pending: false }) };
	const found = { key: "sess-1", base: "wA", name: "b", role: "main", file: "/s/f.jsonl", pane: "wA:p1", live: true };
	const calls: string[] = [];
	const call = async (method: string) => (calls.push(method), method === "pane.get" ? { pane: { pane_id: "wA:p1", agent: "pi", agent_status: "idle", agent_session: { value: "/s/f.jsonl" } } } : {});
	const run = createControl({ lookup: () => found, call, csrf: "c".repeat(32), canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers: answers as never }).run;
	assert.deepEqual(why(await run(["sessions", "sess-1", "keys"], { keys: ["esc"] }, { remote: true, secure: true, operate: true })), [403, "foreground"]);
	assert.deepEqual(calls.filter((m) => m !== "pane.get"), []);
});

// RR3-F006: guards the review's mutants left alive.
test("RR3-F006 (M2): Enter's own binding is checked: a key list naming Enter refuses it", async () => {
	const x = await world({ editor: { ...ok, keys: ["enter"] } as Editor });
	await x.attach(scope);
	assert.deepEqual(why(await x.key(x.session, scope, "enter")), [403, "binding"]);
	assert.deepEqual(x.typed(), []);
});

test("RR3-F006 (M16): the dequeue key is refused while something other than pi holds the pane", async () => {
	const x = await world();
	x.w.pending = true;
	x.w.procs = [{ pid: 12, name: "nano", argv0: "nano", cmdline: "nano" }];
	assert.deepEqual(why(await x.session.request("POST", ["sessions", "sess-1", "dequeue"], Q, { take: "x".repeat(16) }, scope)), [403, "foreground"]);
	assert.deepEqual(x.typed(), []);
});

test("RR3-F006 (M23): a mirror whose unit leaves the scope is detached, not only refused", async () => {
	const x = await world();
	await x.attach(scope);
	await x.session.rescope(scopeOf(["other-1"]));
	await new Promise((r) => setTimeout(r, 400));
	const n = x.seen.filter(([id]) => id === "m:sess-1").length;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(x.seen.filter(([id]) => id === "m:sess-1").length, n, "frames keep coming");
	assert.deepEqual(why(await x.key(x.session, scope, "up")).slice(0, 1), [409], "and the stream is gone for the page's keys too");
});

test("RR3-F006 (M25): a secret that opens while a non-Enter key's binding probe runs stops the key", async () => {
	const x = await world({ editor: ok });
	await x.attach(scope);
	x.w.onProbe = () => appendFileSync(x.path, lines([assistant("s1", "u1", [call("c1", "secret_drop", { label: "token" })])])); // the call a secret_drop leaves in the session file, as the probe runs
	const done = await x.key(x.session, scope, "up");
	assert.deepEqual(why(done), [409, "blocked"]);
	assert.deepEqual(x.typed(), []);
});

// RR3-F007
test("RR3-F007: two watches asked together under one id leave one, which rescope reaches", async () => {
	const x = await world(), wide = scopeOf(["sess-1", "other-1"]);
	const a = x.session.watch("a", "sess-1", true, wide), b = x.session.watch("a", "sess-1", true, wide);
	await Promise.all([a, b]);
	await x.session.rescope(scopeOf(["other-1"]));
	const before = x.seen.length;
	appendFileSync(x.path, lines([user("u9", "u1", "RR3-LEAK-MARKER")]));
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(x.seen.slice(before).some(([id, , d]) => id === "a" && JSON.stringify(d).includes("RR3-LEAK-MARKER")), false, "the first watch kept streaming");
});

test("RR3-F007: a watch that resolves after stop() does not register on the stopped session, nor one asked off meanwhile", async () => {
	const x = await world();
	const w = x.session.watch("z", "sess-1", true, scope);
	x.session.stop();
	assert.equal((await w).status, 409);
	assert.equal((await x.session.watch("n", "sess-1", true, scope)).status, 409, "and a watch asked for after it");
	const before = x.seen.length;
	appendFileSync(x.path, lines([user("u8", "u1", "RR3-STOPPED-MARKER")]));
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(x.seen.slice(before).some(([id, , d]) => id === "z" && JSON.stringify(d).includes("RR3-STOPPED-MARKER")), false);
	const y = await world();
	const late = y.session.watch("q", "sess-1", true, scope);
	await y.session.watch("q", "sess-1", false, scope);
	assert.equal((await late).status, 409);
});
