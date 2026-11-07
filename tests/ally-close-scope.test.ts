import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool, type ToolHost } from "../src/server/runtools.ts";

// Decision 7 of docs/specs/2026-11-07-link-remote-stop.md: an ally run's `boss_close_main` is refused, before the gate, for a main not opened for its own device (the route table or the pane token names
// another device, or no ally route holds the main). A refusal spends no Allow and never reaches the workspace's `closeMain`.

const DEV = "a".repeat(26), OTHER = "b".repeat(26), TEAM = "1".repeat(32);
const sessions = [
	{ id: "s-mine", name: "Mine", herdrLocation: { paneId: "p1" } },
	{ id: "s-theirs", name: "Theirs", herdrLocation: { paneId: "p2" } },
	{ id: "s-box", name: "BoxMain", herdrLocation: { paneId: "p3" } },
	{ id: "s-dup1", name: "Dup", herdrLocation: { paneId: "p4" } },
	{ id: "s-dup2", name: "Dup", herdrLocation: { paneId: "p5" } },
	{ id: "s-forged", name: "Forged", herdrLocation: { paneId: "p6" } },
];
const routes: Record<string, string> = { "s-mine": DEV, "s-theirs": OTHER, "s-dup1": DEV, "s-dup2": DEV, "s-forged": DEV };
const tokens: Record<string, string> = { p6: `link:${OTHER}` };

function host(level: string) {
	const allows: unknown[] = [], closes: string[] = [];
	const h = {
		reach: { read: async () => ({ sessions, ps: Object.entries(tokens).map(([pane_id, t]) => ({ pane_id, tokens: { sb_opened_by: t } })) }) },
		closeMain: async (q: string) => (closes.push(q), { text: "closed", main: q }),
		allow: async (q: unknown) => (allows.push(q), { ok: true }),
		who: { device: DEV, team: TEAM, level, pane: "px" },
		openedFor: (s: string) => routes[s],
	} as unknown as ToolHost;
	return { h, allows, closes };
}
const close = (h: ToolHost, main: string) => runTool(h, "ally", "boss_close_main", { main }, { toolCallId: "c1" });

for (const level of ["dispatch", "forward"]) {
	test(`at ${level}: an ally run closes a main opened for its own device`, async () => {
		const { h, closes, allows } = host(level);
		await close(h, "s-mine");
		await close(h, "Mine");
		assert.deepEqual(closes, ["s-mine", "Mine"]);
		assert.equal(allows.length, level === "dispatch" ? 0 : 2);
	});
	test(`at ${level}: another device's main, a main no route holds, an ambiguous or missing name, and a token naming another device are refused before the gate`, async () => {
		const { h, closes, allows } = host(level);
		for (const q of ["s-theirs", "Theirs", "s-box", "BoxMain", "Dup", "nobody", "s-forged"]) await assert.rejects(close(h, q), /boss_close_main has no such target/, q);
		assert.equal(allows.length, 0, "no Allow spent");
		assert.deepEqual(closes, [], "closeMain never reached");
	});
}
