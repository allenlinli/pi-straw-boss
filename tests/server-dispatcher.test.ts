import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pane } from "../src/herdr.ts";
import { dispatcherOf } from "../src/server/dispatcher.ts";

// Whose unit a pane is (docs/specs/2026-11-05-link-shared-box.md, Who is told).

const DEV = "n".repeat(26), OTHER = "m".repeat(26);
const pane = (id: string, tab: string, tokens: Record<string, string> = {}): Pane => ({ pane_id: id, tab_id: tab, workspace_id: "w", tokens });
const listed = [
	pane("p-tower", "w:t0", { sb_role: "tower" }),
	pane("p-ally", "w:t0", { sb_role: "ally" }),
	pane("p-main", "w:t1", { sb_role: "main", sb_opened_by: `link:${DEV}` }),
	pane("p-worker", "w:t1", { sb_role: "member" }),
	pane("p-boss-main", "w:t2", { sb_role: "main", sb_opened_by: "pi-session-id" }),
	pane("p-doubled", "w:t3", { sb_role: "main", sb_opened_by: `link:link:${OTHER}` }),
	pane("p-odd", "w:t4", { sb_role: "main", sb_opened_by: "link:not-a-device" }),
	pane("p-boss", "w:t5", { sb_role: "main" }),
];

test("an ally run's pane is its device's, with the team the run record names; the tower beside it is nobody's", () => {
	const ally = [{ pane: "p-ally", device: DEV, team: "team-1" }];
	assert.deepEqual(dispatcherOf("p-ally", listed, ally), { device: DEV, team: "team-1" });
	assert.deepEqual(dispatcherOf("p-ally", listed, [{ pane: "p-ally", device: DEV }]), { device: DEV });
	assert.equal(dispatcherOf("p-tower", listed, ally), undefined, "the tower shares the ally's tab and is not its unit: only the pane itself counts");
});

test("a main opened for a device, and a worker in its tab, are that device's", () => {
	assert.deepEqual(dispatcherOf("p-main", listed, []), { device: DEV });
	assert.deepEqual(dispatcherOf("p-worker", listed, []), { device: DEV });
	assert.deepEqual(dispatcherOf("p-doubled", listed, []), { device: OTHER }, "a doubled link: prefix is one prefix");
});

test("a main the boss's own session opened, a main nobody opened, a token that names no device, an unlisted pane: nobody's", () => {
	for (const p of ["p-boss-main", "p-boss", "p-odd", "p-gone"]) assert.equal(dispatcherOf(p, listed, []), undefined, p);
});
