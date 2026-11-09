import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConfirmDeps, confirmStaged } from "../src/bossconfirm.ts";

// The head pane's confirm lives as long as the staged request (docs/specs/2026-11-09-auto-mode.md, §2; AMC-F003).

type Ask = ConfirmDeps["ask"];
/** A dialog that stays open until its signal fires (the boss has not answered), or answers at once. */
const waiting = (seen: { timeout?: number }[]): ConfirmDeps["draw"] => (_t, _b, opts) => (seen.push({ timeout: opts.timeout }), new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve(undefined), { once: true })));
const deps = (draw: ConfirmDeps["draw"], ask: Ask, extra: Partial<ConfirmDeps> = {}): ConfirmDeps => ({ draw, ask, now: () => 1_000_000, who: { session: "s" }, pollMs: 5, ...extra });
const stage = { id: "p1", said: "我要睡了", expires: 1_000_000 + 600_000 };

test("the dialog times out at the request's own expiry", async () => {
	const seen: { timeout?: number }[] = [];
	const out = await confirmStaged({ ...stage, expires: 1_000_000 + 125_000 }, deps(async (_t, _b, o) => (seen.push({ timeout: o.timeout }), false), async () => ({ ok: true, state: { on: false, pending: { id: "p1" } } })));
	assert.equal(seen[0]!.timeout, 125_000);
	assert.match(out, /did not confirm in the pane/);
});

test("confirmed in the GUI: the dialog closes by itself and the result says where it stands", async () => {
	const out = await confirmStaged(stage, deps(waiting([]), async () => ({ ok: true, state: { on: true } })));
	assert.match(out, /^Auto mode is on: it was confirmed elsewhere/);
});

test("replaced or expired meanwhile: the dialog closes and says to ask again", async () => {
	const out = await confirmStaged(stage, deps(waiting([]), async () => ({ ok: true, state: { on: false, pending: { id: "p2" } } })));
	assert.match(out, /expired or was replaced/);
	assert.equal((await confirmStaged(stage, deps(waiting([]), async () => ({ ok: true, state: { on: false } })))).includes("expired or was replaced"), true);
});

test("a yes that comes after the GUI confirmed reports the state, not the refusal", async () => {
	const asked: string[] = [];
	const out = await confirmStaged(stage, deps(async () => true, async (r) => (asked.push(String(r.cmd)), r.cmd === "auto-confirm" ? { ok: false, error: "This request expired or was replaced: ask again" } : { ok: true, state: { on: true } }), { pollMs: 100000 }));
	assert.match(out, /^Auto mode is on: it was confirmed elsewhere/);
	assert.ok(asked.includes("auto-confirm"));
});

test("a yes in time confirms with the pane's identity", async () => {
	let sent: Record<string, unknown> | undefined;
	const out = await confirmStaged(stage, deps(async () => true, async (r) => (r.cmd === "auto-confirm" ? ((sent = r), { ok: true }) : { ok: true, state: { on: false, pending: { id: "p1" } } }), { pollMs: 100000 }));
	assert.equal(out, "The boss confirmed in the pane: auto mode is on.");
	assert.deepEqual({ id: sent?.id, name: sent?.name, session: sent?.session }, { id: "p1", name: "the head pane", session: "s" });
});
