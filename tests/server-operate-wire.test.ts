import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { HerdrRun } from "../src/herdr.ts";
import type { Ref } from "../src/net.ts";
import { addRoute } from "../src/server/allyroute.ts";
import { operateFacts } from "../src/server/operatewire.ts";
import { slotOf } from "../src/server/record.ts";
import { DEVICES } from "./link/scenario.ts";

// The facts an operate session's scope is read from (docs/specs/2026-11-07-link-operate.md §4, §11.3): Herdr's listing, refreshed before each check. A listing that cannot be read is no listing, for every scope.

const { alice } = DEVICES;
const A = "a".repeat(32), WS = "w1";
let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-operate-wire-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function facts() {
	const slot = slotOf(root, {}, "linux"), now = Date.now();
	addRoute(slot, WS, { to: "s-main", device: alice.id, team: A, kind: "opened", at: now, name: "s-main", label: "x", short: "x", teamName: "x" }, now);
	const refs: Ref[] = [{ key: "s-main", base: WS, name: "s-main", role: "main", pane: "p1" }, { key: "tower-1", base: WS, name: "tower", role: "tower", pane: "pt" }];
	const state = { fail: false, reads: 0 };
	const run: HerdrRun = async () => {
		state.reads++;
		if (state.fail) throw new Error("herdr pane list failed: socket timeout");
		return JSON.stringify({ result: { panes: [{ pane_id: "p1", tab_id: "t1", workspace_id: WS, tokens: { sb_opened_by: `link:${alice.id}` } }, { pane_id: "pt", tab_id: "t0", workspace_id: WS }] } });
	};
	const f = operateFacts({ slot, now: () => now, run, gui: () => ({ api: undefined as never, refs: () => refs, lookup: () => undefined }), allyPanes: () => [] });
	return { f, state };
}

test("OBX-F002: before the first read, and after a failed one, a team's main is nobody's; a good read brings it back", async () => {
	const { f, state } = facts();
	assert.equal(f.owner("s-main"), undefined, "no listing has been read yet");
	await f.refresh();
	assert.deepEqual(f.owner("s-main"), { team: A });
	state.fail = true;
	await f.refresh(); // swallows the failure: it is the bridge's refresh, which never rejects
	assert.equal(f.owner("s-main"), undefined, "a failed read does not keep the old listing, and does not hand the unit to the box");
	assert.deepEqual(f.owner("tower-1"), { box: true });
	state.fail = false;
	await f.refresh();
	assert.deepEqual(f.owner("s-main"), { team: A });
});
