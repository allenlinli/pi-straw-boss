import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Net } from "../src/net.ts";
import { netSource } from "../src/net.ts";
import { createAutoMode, PENDING_MS } from "../src/server/automode.ts";
import { autoPanel } from "../src/server/autoops.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { until } from "./fakes.ts";

// The head's confirm button (docs/specs/2026-11-09-auto-mode.md, sections 2 and 7; D9, task 5a): it shows only while the snapshot carries a pending record, a tap sends the record's id and nothing else, and a tap on a lapsed or
// replaced one shows the server's refusal. The snapshot carries `auto` only while it is on or a request waits.

sessionGlobals();
const { fillAuto, io, pendingOf } = await import("../gui/auto.ts");
const { m } = await import("../gui/paraglide/messages.js");

const net = (auto?: Net["auto"]): Net => ({ bases: [], ...(auto ? { auto } : {}) });
const PENDING = { id: "p1", said: "我要睡了", expires: Date.now() + 600_000 };
const box = () => page.createElement("div") as unknown as El;
const button = (b: El) => b.querySelector(".auto-confirm") as El | null;
const note = (b: El) => b.querySelector(".auto-note")!.textContent;

test("the button shows only while a pending record lives: not with auto mode off, not with it on, not after the record lapsed", () => {
	const b = box();
	fillAuto(b as never, net());
	assert.equal(b.hidden, true);
	assert.equal(button(b), null);
	fillAuto(b as never, net({ on: true, since: "2026-11-09T15:10:00Z" }));
	assert.equal(b.hidden, true, "on, nothing pending: no button");
	fillAuto(b as never, net({ on: false, pending: PENDING }));
	assert.equal(b.hidden, false);
	assert.equal(button(b)!.textContent, m.auto_confirm_button());
	assert.match(b.querySelector(".auto-said")!.textContent, /我要睡了/);
	assert.equal(pendingOf(net({ on: false, pending: PENDING }))?.id, "p1");
	fillAuto(b as never, net());
	assert.equal(b.hidden, true, "the record is gone from the snapshot");
	assert.equal(button(b), null);
	fillAuto(b as never, undefined);
	assert.equal(b.hidden, true);
});

test("a tap sends the record's id to auto/confirm, once at a time; the words come from the server's record, never from markup", async () => {
	const posts: [string, Record<string, unknown>][] = [];
	io.post = async (path, body) => (posts.push([path, body]), { ok: true, status: 200, body: {} });
	const b = box();
	fillAuto(b as never, net({ on: false, pending: { ...PENDING, said: "<img src=x onerror=alert(1)>" } }));
	assert.equal(b.querySelector("img"), null, "the said words are text");
	const first = button(b)!;
	first.click();
	first.click();
	await until(() => note(b) === m.auto_confirmed(), "the confirmed line");
	assert.deepEqual(posts, [["auto/confirm", { id: "p1" }]], "one post, the id and nothing else");
	// the same record in the next snapshot does not rebuild the button or clear its line
	fillAuto(b as never, net({ on: false, pending: PENDING }));
	assert.equal(button(b), first);
});

test("a tap on an expired or replaced record shows the server's refusal and the button can be tried again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-autogui-"));
	let now = 1_800_000_000_000, n = 0;
	const auto = createAutoMode({ dir, now: () => now, log: () => {}, id: () => `id${++n}` });
	auto.start();
	const panel = autoPanel(auto);
	assert.equal(panel.snap(), undefined, "off and nothing pending: the snapshot carries nothing");
	auto.stage("我要睡了", { via: "head", name: "head tower" });
	assert.deepEqual(panel.snap(), { on: false, pending: { id: "id1", said: "我要睡了", expires: now + PENDING_MS } });
	io.post = async (path, body) => {
		assert.equal(path, "auto/confirm");
		const r = panel.confirm(body.id, false);
		return { ok: r.status === 200, status: r.status, body: r.body as never };
	};
	const b = box();
	fillAuto(b as never, net({ on: false, pending: panel.snap()!.pending }));
	now += PENDING_MS + 1;
	button(b)!.click();
	await until(() => note(b) !== "", "the refusal");
	assert.equal(note(b), m.auto_stale());
	assert.equal(auto.view().on, false, "an expired confirm switches nothing");
	assert.equal(button(b)!.hasAttribute("disabled"), false);
	// a replaced record
	now -= PENDING_MS;
	auto.stage("我要睡了", { via: "head", name: "head tower" });
	auto.stage("睡覺", { via: "head", name: "head tower" });
	const stale = { id: "id2", said: "x", expires: now + 1000 };
	fillAuto(b as never, net({ on: false, pending: stale }));
	button(b)!.click();
	await until(() => note(b) === m.auto_stale(), "the refusal for a replaced id");
	assert.equal(auto.view().on, false);
	// the live record confirms
	fillAuto(b as never, net({ on: false, pending: panel.snap()!.pending }));
	button(b)!.click();
	await until(() => auto.view().on, "the switch");
	assert.deepEqual(panel.snap(), { on: true, since: auto.view().since });
});

test("the net snapshot carries `auto` only while it is on or a request waits, as the panel reads it", async () => {
	const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: [] } : { workspaces: [] } });
	let snap: Net["auto"];
	const read = () => netSource({ run: herdr, sessions: async () => [], sessionDir: "/s", auto: () => snap }).read();
	assert.ok(!("auto" in (await read())));
	snap = { on: false };
	assert.ok(!("auto" in (await read())), "off and nothing pending: no field");
	snap = { on: false, pending: PENDING };
	assert.deepEqual((await read()).auto, { on: false, pending: PENDING });
	snap = { on: true, since: "2026-11-09T15:10:00Z" };
	assert.deepEqual((await read()).auto, snap);
});
