import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet } from "../src/net.ts";
import { survey } from "../src/stash.ts";
import { FakeHerdr } from "./fakes.ts";

// The head workspace is no base (docs/specs/2026-11-04-head-tower.md, What replaces "head tower = first workspace"): the readers that skip a sub workspace skip it as well (H2).

const ws = (id: string, label: string, tokens: Record<string, string> = {}): Workspace => ({ workspace_id: id, label, tokens });
const pane = (id: string, tab: string, tokens: Record<string, string> = {}): Pane => ({ pane_id: id, tab_id: tab, tokens });
const session = (id: string, name: string, paneId: string, workspace: string, tab: string): Session => ({ id, name, status: "idle", herdrLocation: { status: "current", paneId, workspace: { id: workspace }, tab: { id: tab } } } as Session);

test("buildNet lists no base and no tower for the head workspace, whatever its position", () => {
	const workspaces = [ws("wH", "Head tower", { sb_head: "sb-head", tower: "sb-head" }), ws("wA", "Alpha", { tower: "tower-a" })];
	const panes = [pane("wH:p1", "wH:t1", { sb_role: "head" }), pane("wA:p1", "wA:t1", { sb_role: "tower" })];
	const sessions = [session("sb-head", "head tower", "wH:p1", "wH", "wH:t1"), session("tower-a", "tower · Alpha", "wA:p1", "wA", "wA:t1")];
	const net = buildNet({ sessions, panes, workspaces, children: () => [] });
	assert.deepEqual(net.bases.map((b) => b.id), ["wA"]);
	assert.ok(net.bases.every((b) => !("head" in b)), "no base carries a crown");
});

test("a stash of the head workspace is refused with a reason", async () => {
	const herdr = new FakeHerdr();
	herdr.workspaces.unshift({ workspace_id: "wH", label: "Head tower", tokens: { sb_head: "sb-head" } } as never);
	herdr.addTab("wH:t1", "crown", "wH:p1");
	const got = await survey(herdr.runFor("wH:p1"), "wH", []);
	assert.ok(got?.reasons.some((r) => /head tower's workspace is not stashed/.test(r)), JSON.stringify(got?.reasons));
});
