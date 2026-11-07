import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { KeybindingsManager, matchesKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { BYTES, bindingReport } from "../src/bindings.ts";
import { type Editor, operateKeyRefusal } from "../src/probe.ts";
import { scopeOf, world } from "./operate-world.ts";
import { assistant, call, lines } from "./sessions.ts";

// The re-review of a59866cc (backlog "Re-review a59866cc"): RR4-F001 to RR4-F004.

const Q = new URLSearchParams(), scope = scopeOf(["sess-1"]), RAW = { isTTY: true, isRaw: true };
const why = (r: { status: number; body: unknown }) => [r.status, (r.body as { why?: string; error?: string }).why ?? (r.body as { error?: string }).error];
const pi = { pid: 11, name: "pi", argv0: "pi", cmdline: "pi" };
const defs = async () => ((await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js")).href)) as { KEYBINDINGS: never }).KEYBINDINGS;
const ok = { editor: "empty", keys: [], holds: {}, raw: true } as Editor;
after(() => setKittyProtocolActive(false));

test("RR4-F001: under either keyboard protocol state, every pad key bound to the external editor is reported, and so is an extension id on it", async () => {
	for (const kitty of [false, true]) {
		setKittyProtocolActive(kitty);
		for (const pad of Object.keys(BYTES)) {
			const report = bindingReport(new KeybindingsManager(await defs(), { "app.editor.external": pad } as never) as never, RAW)!;
			assert.equal(report.keys.includes(pad), true, `kitty ${kitty}: ${pad} reported`);
			assert.equal(operateKeyRefusal({ editor: "empty", ...report }, pad)?.why, "binding", `kitty ${kitty}: ${pad} refused`);
		}
		const ext = bindingReport(new KeybindingsManager(await defs(), { "mcp.panel.open": "alt+d" } as never) as never, RAW)!;
		assert.equal(ext.keys.includes("alt+d"), true, `kitty ${kitty}: an extension id on alt+d`);
	}
});

test("RR4-F001: each pad key has a kitty CSI-u and an xterm modifyOtherKeys spelling that pi reads as that key", () => {
	const seen = [["alt+b", "\x1b[98;3u", "\x1b[27;3;98~"], ["alt+enter", "\x1b[13;3u", "\x1b[27;3;13~"], ["ctrl+e", "\x1b[101;5u", "\x1b[27;5;101~"], ["esc", "\x1b[27u", undefined], ["enter", "\x1b[13u", undefined]] as const;
	for (const [pad, ...forms] of seen) for (const f of forms) if (f) assert.ok(BYTES[pad]!.includes(f), `${pad} has ${JSON.stringify(f)}`);
});

test("RR4-F002: the composer's Send goes through the Enter binding check, and a follow-up while working through Alt+Enter's", async () => {
	for (const editor of [{ ...ok, keys: ["enter"] }, { ...ok, holds: { clear: ["enter"] } }] as Editor[]) {
		const x = await world({ editor });
		await x.attach(scope);
		assert.deepEqual(why(await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "RR4-MARKER", as: "send" }, scope)), [403, "binding"]);
		assert.deepEqual(x.typed(), []);
	}
	const y = await world({ editor: { ...ok, keys: ["alt+enter"] } as Editor, status: "working" });
	await y.attach(scope);
	assert.deepEqual(why(await y.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "RR4-FU", as: "followUp" }, scope)), [403, "binding"]);
	assert.deepEqual(y.typed(), []);
	// a follow-up sends Alt+Enter, not Enter: a binding on Enter alone is no reason to refuse it; a send while working is Enter's
	const z = await world({ editor: { ...ok, keys: ["enter"] } as Editor, status: "working" });
	await z.attach(scope);
	assert.equal((await z.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "RR4-FU", as: "followUp" }, scope)).status, 200);
	assert.deepEqual(why(await z.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "RR4-S", as: "send" }, scope)), [403, "binding"]);
	// and the plain case still goes
	const w = await world({ editor: ok });
	await w.attach(scope);
	assert.equal((await w.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "RR4-OK", as: "send" }, scope)).status, 200);
});

test("RR4-F003: an editor that pi starts sits beside pi in its group; raw is read again right before the write, so it stops every write", async () => {
	const vim = { pid: 12, name: "vim", argv0: "vim", cmdline: "vim /tmp/pi-editor-x/prompt.md" };
	const opens = (x: Awaited<ReturnType<typeof world>>) => { let n = 0; x.w.onProbe = () => { ++n; if (n === 1) x.w.procs = [pi, vim]; if (n === 2) x.w.editor = { ...ok, raw: false } as Editor; }; }; // opens just after the first probe said raw, and sits beside pi; the next probe says not raw
	const x = await world();
	await x.attach(scope);
	opens(x);
	assert.deepEqual(why(await x.key(x.session, scope, "enter")), [403, "terminal"]);
	assert.deepEqual(x.typed(), []);
	const y = await world();
	await y.attach(scope);
	opens(y);
	assert.deepEqual(why(await y.key(y.session, scope, "up")), [403, "terminal"]);
	assert.deepEqual(y.typed(), []);
	const z = await world();
	await z.attach(scope);
	opens(z);
	assert.deepEqual(why(await z.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "hi", as: "send" }, scope)), [403, "terminal"]);
	assert.deepEqual(z.typed(), []);
	const p = await world();
	await p.attach(scope);
	opens(p);
	assert.deepEqual(why(await p.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", paste: "hi" }, scope)), [403, "terminal"]);
	assert.deepEqual(p.typed(), []);
});

test("RR4-F004 (N10): a secret that opens while the text or paste raw probe runs stops the write", async () => {
	for (const extra of [{ text: "hi" }, { paste: "hi" }]) {
		const x = await world();
		await x.attach(scope);
		x.w.onProbe = () => appendFileSync(x.path, lines([assistant("s1", "u1", [call("c1", "secret_drop", { label: "token" })])]));
		assert.deepEqual(why(await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { stream: "s", ...extra }, scope)), [409, "blocked"], JSON.stringify(extra));
		assert.deepEqual(x.typed(), []);
	}
});
