import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { bindingReport } from "../src/bindings.ts";
import { createKeys, PAD } from "../src/keys.ts";
import { checkProbe, type Editor, HOME, operateKeyRefusal, probeEditor } from "../src/probe.ts";
import { scopeOf, world } from "./operate-world.ts";
import { lines, user } from "./sessions.ts";

// The re-review of #121 task 4 (backlog "Re-review c008b3d5"): RR-F001 to RR-F005.

const Q = new URLSearchParams(), scope = scopeOf(["sess-1"]);
const why = (r: { status: number; body: unknown }) => [r.status, (r.body as { why?: string; error?: string }).why ?? (r.body as { error?: string }).error];
const found = { key: "k", base: "b", name: "k", role: "main", file: "/f", pane: "p", live: true };
const pane = { pane_id: "p", tab_id: "t", agent: "pi", agent_status: "idle" };

test("RR-F001: a confirmed double-esc is never honoured under operate (one Escape at most, whatever the confirm)", async () => {
	let t = 10_000;
	const pad = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => ({ editor: "empty", keys: [], holds: {}, raw: true }), now: () => t });
	const first = await pad.send("k", found, pane, { key: "esc", stream: "s", remote: true, operate: true });
	pad.sent("k", first);
	for (const gap of [200, 1200, 5000]) {
		t += gap;
		const second = await pad.send("k", found, pane, { key: "esc", stream: "s", confirmed: "double-esc", remote: true, operate: true }).catch((e) => e as { status: number });
		const sent = "calls" in second ? second.calls.length : 0;
		assert.ok(sent <= 1, `gap ${gap}: ${sent} Escapes`);
		if ("calls" in second) pad.sent("k", second);
	}
	// without operate the confirm still works (the paired device's rule is unchanged)
	t += 5000;
	const plain = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => undefined, now: () => t });
	pad_sent(plain, await plain.send("p", found, pane, { key: "esc", stream: "s", remote: true }));
	t += 1200;
	assert.equal((await plain.send("p", found, pane, { key: "esc", stream: "s", confirmed: "double-esc", remote: true })).calls.length, 2);
});
const pad_sent = (pad: ReturnType<typeof createKeys>, plan: Awaited<ReturnType<ReturnType<typeof createKeys>["send"]>>) => pad.sent("p", plan);

test("RR-F005: the operate Escape rule counts the Escape while Herdr still says working or blocked", async () => {
	let t = 10_000;
	const pad = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => ({ editor: "empty", keys: [], holds: {}, raw: true }), now: () => t });
	for (const status of ["working", "blocked"]) {
		const busy = { ...pane, agent_status: status }, key = `k-${status}`;
		pad.sent(key, await pad.send(key, found, busy, { key: "esc", stream: "s", remote: true, operate: true }));
		t += 300;
		const second = await pad.send(key, found, busy, { key: "esc", stream: "s", remote: true, operate: true }).catch((e) => e as { status: number; body: { why?: string } });
		assert.equal("calls" in second ? "sent" : second.body.why, "leaves-editor", status);
	}
});

test("RR-F003: a watch started while rescope() narrows ends with the narrower scope", async () => {
	const x = await world(), wide = scopeOf(["sess-1", "other-1"]), narrow = scopeOf(["sess-1"]);
	await x.session.watch("warm", "sess-1", true, narrow);
	const started = x.session.watch("a", "other-1", true, wide);
	await x.session.rescope(narrow);
	assert.equal((await started).status, 403);
	appendFileSync(x.path, lines([user("u9", "u1", "RACE-MARKER")]));
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(x.seen.some(([id, , d]) => id === "a" && JSON.stringify(d).includes("RACE-MARKER")), false);
});

test("RR-F003: a mirror turned on while rescope() narrows is turned off again", async () => {
	const x = await world(), wide = scopeOf(["sess-1", "other-1"]), narrow = scopeOf(["other-1"]);
	const on = x.session.mirror("sess-1", true, wide);
	await x.session.rescope(narrow);
	assert.equal((await on).status, 403);
	await new Promise((r) => setTimeout(r, 400));
	const n = x.seen.filter(([id]) => id === "m:sess-1").length;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(x.seen.filter(([id]) => id === "m:sess-1").length, n, "frames keep coming");
});

test("RR-F004: close/tab is refused (and nothing closed) when the pane listing is rejected, has no panes, or lists a pane that is no unit's", async () => {
	for (const listing of ["reject", "shape"] as const) {
		const x = await world();
		x.w.listing = listing;
		const done = await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope);
		assert.deepEqual([listing, done.status, x.effects], [listing, 403, []]);
	}
	const x = await world();
	x.w.strangers = [{ pane_id: "wA:p9", tab_id: "t1" }];
	assert.equal((await x.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope)).status, 403);
	assert.deepEqual(x.effects, []);
	const y = await world();
	assert.equal((await y.session.request("POST", ["close", "tab"], Q, { workspace: "wA", tab: "t1" }, scope)).status, 200); // the same call goes when the listing is whole
});

test("RR-F002 (a): a key whose binding the bridge cannot name, or has moved onto another app action, is refused before anything is sent", async () => {
	for (const [keys, key, want] of [[undefined, "up", "binding-unread"], [["ctrl+a"], "ctrl+a", "binding"], [["tab"], "tab", "binding"], [["pageup"], "pageup", "binding"], [["esc"], "esc", "binding"]] as const) {
		const x = await world({ editor: { editor: "empty", keys: keys ? [...keys] : undefined } as Editor });
		await x.attach(scope);
		const done = await x.key(x.session, scope, key);
		assert.deepEqual(why(done), [403, want], `${key}`);
		assert.deepEqual(x.typed(), [], key);
	}
	const x = await world({ editor: { editor: "empty", keys: ["ctrl+g"] } as Editor });
	await x.attach(scope);
	assert.equal((await x.key(x.session, scope, "ctrl+a")).status, 200); // another key's binding does not matter
	assert.equal((await x.key(x.session, scope, "up")).status, 200);
});

const RAW = { isTTY: true, isRaw: true };
test("RR-F002 (a): the bridge names the keys bound outside the editor, and only when pi's live manager knows its app actions", () => {
	const defs = { ...TUI_KEYBINDINGS, "app.editor.external": { defaultKeys: "ctrl+g" }, "app.interrupt": { defaultKeys: "escape" }, "app.clear": { defaultKeys: "ctrl+c" }, "app.model.select": { defaultKeys: "ctrl+l" } } as never;
	const stock = bindingReport(new KeybindingsManager(defs, {}) as never, RAW);
	assert.ok(stock?.keys.includes("ctrl+g") === false, "ctrl+g is no key of the operate pad, so it is not named"); // the pad's keys only
	assert.deepEqual(stock?.holds, { interrupt: ["esc"], clear: ["ctrl+c"], submit: ["enter"] });
	const moved = bindingReport(new KeybindingsManager(defs, { "app.editor.external": ["ctrl+a", "tab"] }) as never, RAW)!;
	assert.deepEqual(moved.keys.sort(), ["ctrl+a", "tab"]);
	assert.equal(bindingReport(new KeybindingsManager(TUI_KEYBINDINGS, {}) as never, RAW), undefined); // outside pi: its app actions are unknown
	assert.equal(bindingReport({ getDefinition: () => { throw new Error("x"); } } as never), undefined);
});

test("RR-F002 (a): on a stock pi no key of the pad or the operate chords is bound outside the editor, so a stock box is operable", async () => {
	const pi = (await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href)) as { KEYBINDINGS: never };
	const stock = bindingReport(new KeybindingsManager(pi.KEYBINDINGS, {}) as never, RAW)!;
	assert.deepEqual(stock.keys, [], "no key of the pad or the operate chords is foreign on a stock pi");
	for (const [action, keys] of Object.entries(stock.holds)) for (const key of keys) assert.ok(HOME[action as keyof typeof HOME].includes(key), `${action} on ${key}`);
	for (const key of [...PAD, "alt+enter", "alt+backspace", "ctrl+left", "ctrl+right", "alt+left", "alt+right", ...[..."abefkuwyc"].map((l) => `ctrl+${l}`), ...[..."bdfy"].map((l) => `alt+${l}`)]) assert.equal(operateKeyRefusal({ editor: "empty", ...stock }, key), undefined, key);
});

test("RR-F002 (a): the probe carries the report only with the flags, and the server takes it only whole and well-formed", () => {
	const ctx = { hasUI: true, ui: { getEditorText: () => "" } } as never, rep = () => ({ keys: ["tab"], holds: { clear: ["ctrl+c"] }, raw: true });
	assert.equal("keys" in probeEditor(ctx, undefined, undefined, rep), false);
	assert.deepEqual(probeEditor(ctx, undefined, true, rep), { editor: "empty", keys: ["tab"], holds: { clear: ["ctrl+c"] }, raw: true });
	assert.deepEqual(probeEditor({ hasUI: false } as never, undefined, true, rep).keys, ["tab"]);
	assert.equal("keys" in probeEditor(ctx, undefined, true, () => undefined), false);
	const whole = { editor: "empty", keys: ["ctrl+g", "pageup"], holds: { clear: ["ctrl+c"] }, raw: true };
	assert.deepEqual(checkProbe(whole), whole);
	for (const bad of [{ keys: ["ctrl+g", 5] }, { keys: "ctrl+g" }, { keys: ["x\n"] }, { holds: { nothing: ["a"] } }, { holds: [] }, { raw: "yes" }, { raw: undefined }, { holds: undefined }, { keys: undefined }]) assert.equal(checkProbe({ ...whole, ...bad } as never)?.keys, undefined, JSON.stringify(bad));
	assert.deepEqual(checkProbe({ ...whole, editor: "text", ending: "quit" }), { editor: "text", ending: "quit", keys: whole.keys, holds: whole.holds, raw: true });
});

test("RR-F002 (b): every operate write needs pi alone in the pane's foreground, and an unreadable list refuses", async () => {
	const pi = { pid: 11, name: "pi", argv0: "pi", cmdline: "pi" };
	const cases: [string, { pid: number; name: string; argv0?: string; cmdline?: string }[] | undefined][] = [
		["only an editor", [{ pid: 12, name: "vim", argv0: "vim" }]],
		["no list", []],
		["Herdr failing", undefined],
		["two pis", [pi, { ...pi, pid: 13 }]],
		["something that only calls itself pi", [{ pid: 12, name: "node", argv0: "node", cmdline: "node pi-fake.js" }]],
	];
	for (const [name, procs] of cases) {
		const x = await world();
		await x.attach(scope);
		x.w.procs = procs;
		for (const [what, done] of [["key", await x.key(x.session, scope, "up")], ["text", await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", text: "hi" }, scope)], ["paste", await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", paste: "hi" }, scope)], ["input", await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hi", as: "send" }, scope)]] as const) assert.deepEqual(why(done), [403, "foreground"], `${name}: ${what}`);
		assert.deepEqual(x.typed(), [], name);
	}
	const x = await world();
	await x.attach(scope);
	x.w.procs = [pi, { pid: 10, name: "zsh", argv0: "zsh" }]; // the pane's own shell is no program
	assert.equal((await x.key(x.session, scope, "up")).status, 200);
});
