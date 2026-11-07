import assert from "node:assert/strict";
import { test } from "node:test";
import { createCloseMain } from "../src/closemain.ts";
import type { Kit } from "../src/state.ts";

// Todo #100 task 3 (docs/specs/2026-11-07-link-remote-stop.md, sections 5 and 8): a main of an older build has no `turn` to abort with, so an `interrupt` is a plain quit for it: busy while it works, and never aborted.

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function ask(turn: { running(): boolean; blockers(): string | undefined; abort(): void } | undefined, busy: string | undefined) {
	const published: Record<string, unknown>[] = [];
	let onEvent: ((e: unknown) => void) | undefined, quit = 0;
	const reply = (result: unknown) => JSON.stringify({ result });
	const run = async (args: string[]) => (args[0] === "workspace" ? reply({ workspaces: [{ workspace_id: "w", tokens: { tower: "tower-1" } }] }) : reply({ panes: [{ pane_id: "p1", workspace_id: "w", tokens: { sb_opened_by: "link:x" } }] }));
	const kit = { pi: { events: { emit: (_c: string, reg: { onReady(c: unknown): void; onEvent(e: unknown): void }) => ((onEvent = reg.onEvent), reg.onReady({ publish: (p: Record<string, unknown>) => void published.push(p) })) } }, cfg: { run, sleep: async () => {}, now: () => Date.now() }, s: { isTower: false, joined: true, at: { workspaceId: "w", paneId: "p1" } }, me: () => "main-1" } as unknown as Kit;
	const control = createCloseMain(kit, { closeSelf: () => (quit++, undefined), check: () => busy, ...(turn ? { turn } : {}) });
	control.register();
	onEvent!({ type: "message", fromSessionId: "tower-1", payload: { version: 1, type: "close-main", to: "main-1", reqId: "r1", interrupt: true } });
	for (let i = 0; i < 20 && !published.length; i++) await flush();
	return { answer: published[0], quit };
}

test("a main with no turn handle answers an interrupt as a plain quit: busy while it works, never aborted", async () => {
	const old = await ask(undefined, "a turn is running");
	assert.deepEqual([old.answer?.accepted, old.answer?.busy, old.answer?.reason], [false, true, "a turn is running"]);
	assert.equal(old.quit, 0);
	const idle = await ask(undefined, undefined);
	assert.deepEqual([idle.answer?.accepted, idle.quit], [true, 1], "idle: it quits as before");
	let aborted = 0;
	const now = await ask({ running: () => true, blockers: () => undefined, abort: () => void aborted++ }, "a turn is running");
	assert.equal(aborted, 1, "a main of this build aborts");
	assert.match(String(now.answer?.reason), /interrupted/);
});
