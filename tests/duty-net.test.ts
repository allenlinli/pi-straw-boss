import assert from "node:assert/strict";
import { test } from "node:test";
import { trackActivity } from "../src/activity.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet, type Net, type Unit } from "../src/net.ts";
import { readYards } from "../src/server/trainyard.ts";
import { sanitizeNet, type Rewrite } from "../src/server/operatesanitize.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";

// docs/specs/2026-11-09-agent-kinds.md §2 (the net and the yard card), §11 (the page's words and the timeline), §12 (operate).

let locale: "zh-TW" | "en" = "zh-TW";
overwriteGetLocale(() => locale);
const { roleWord } = await import("../gui/render.ts");
const { said } = await import("../gui/log.ts");

const ws: Workspace[] = [{ workspace_id: "wA", label: "Alpha", tokens: { tower: "t" } }];
const pane = (id: string, tokens: Record<string, string>): Pane => ({ pane_id: id, tab_id: "wA:t1", tokens });
const session = (id: string, pane: string): Session => ({ id, name: id, status: "idle", herdrLocation: { status: "current", paneId: pane, workspace: { id: "wA", label: "wA" }, tab: { id: "wA:t1", label: "t1" } } });
const net = (tokens: Record<string, string>, role = "main") => buildNet({ sessions: [session("m", "wA:p1"), session("t", "wA:p9")], panes: [pane("wA:p1", { sb_role: role, ...tokens }), pane("wA:p9", { sb_role: "tower" })], workspaces: ws, children: () => [] });
const unit = (n: Net) => n.bases[0]!.tabs[0]!.units[0]!;

test("Unit.duty comes from sb_duty on a main only, and an unknown value is ignored", () => {
	assert.equal(unit(net({ sb_duty: "standing" })).duty, "standing");
	assert.equal(unit(net({ sb_duty: "integrator" })).duty, "integrator");
	assert.equal(unit(net({ sb_duty: "wizard" })).duty, undefined);
	assert.equal(unit(net({ sb_duty: "standing" }, "member")).duty, undefined, "a member has no kind");
	assert.equal(unit(net({})).duty, undefined);
});

test("a duty event is emitted when a main's kind changes, and not for its first reading", () => {
	let at = 1000;
	const track = trackActivity(() => at);
	const of = (duty: string): Net => ({ bases: [{ id: "wA", label: "A", mark: "idle", tower: null, tabs: [{ id: "t", label: "t", units: [{ id: "m", key: "m", control: true, name: "Docs", role: "main", duty, mark: "idle", subs: [] } as Unit] }], outposts: [], outside: [] }] });
	assert.equal(track(of("coordinator")).events, undefined);
	at = 2000;
	const next = track(of("standing"));
	assert.deepEqual(next.events, [{ at: 2000, ws: "wA", key: "m", name: "Docs", mark: "idle", kind: "duty", from: "coordinator", to: "standing" }]);
	locale = "zh-TW";
	assert.equal(said(next.events![0]!), "Docs：協調者 → 值守");
	locale = "en";
	assert.equal(said(next.events![0]!), "Docs: coordinator → on watch");
});

test("roleWord: the kind word is the same in every theme; a main's graph follows it; a member has no graph", () => {
	locale = "zh-TW";
	assert.equal(roleWord("main", "coordinator", "fan-out/fan-in"), "協調者 · 分支匯流");
	assert.equal(roleWord("main", "integrator", "single-loop"), "整合員 · 單一迴圈");
	assert.equal(roleWord("main", "standing"), "值守");
	assert.equal(roleWord("member", undefined, "orchestrator-worker"), "成員", "no kind and no graph for a member");
	assert.equal(roleWord("main", undefined, "orchestrator-worker"), "主智慧體 · 多工編排");
	locale = "en";
	assert.equal(roleWord("main", "coordinator", "orchestrator-worker"), "coordinator · orchestrated");
	assert.equal(roleWord("main", "standing"), "on watch");
	locale = "zh-TW";
});

test("operate: the sanitizer keeps duty, todo.graph and the duty event, and drops an unknown graph or kind", () => {
	const told: string[] = [];
	const rw: Rewrite = { key: (k) => k, base: (k) => k, tab: (_w, k) => k, bad: (why) => void told.push(why) };
	const base = (u: object) => ({ id: "wA", label: "A", mark: "idle", tower: null, tabs: [{ id: "t", label: "t", units: [{ id: "m", key: "m", control: true, name: "Docs", role: "main", mark: "idle", subs: [], ...u }] }], outposts: [], outside: [] });
	const kept = sanitizeNet({ bases: [base({ duty: "standing", todo: { done: 0, total: 1, graph: "fan-out/fan-in" } })], events: [{ at: 1, ws: "wA", name: "Docs", mark: "idle", kind: "duty", from: "coordinator", to: "standing" }] }, rw)!;
	assert.equal(unit(kept).duty, "standing");
	assert.equal(unit(kept).todo?.graph, "fan-out/fan-in");
	assert.deepEqual([kept.events![0]!.kind, kept.events![0]!.from, kept.events![0]!.to], ["duty", "coordinator", "standing"]);
	const odd = sanitizeNet({ bases: [base({ duty: "wizard", todo: { done: 0, total: 1, graph: "chain" } })] }, rw)!;
	assert.equal(unit(odd).duty, undefined);
	assert.equal(unit(odd).todo?.graph, undefined);
});

test("the yard card: a live writer that publishes integrator, or no kind at all, shows live; one of another kind shows switched; one that is gone shows gone", async () => {
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { writeYard } = await import("../src/train/board.ts");
	const dir = mkdtempSync(join(tmpdir(), "sb-duty-yard-"));
	try {
		writeYard(dir, { v: 1, project: "acme", writer: { session: "m", pid: process.pid, started: new Date(0).toISOString() }, updated: new Date().toISOString(), trains: [] });
		const card = (join: { mains: string[]; integrators: string[] }, alive = true) => readYards({ stateDir: dir, now: () => Date.now(), alive: () => alive }, { trains: [], mains: new Set(join.mains), integrators: new Set(join.integrators) })!.projects[0]!.integrator;
		assert.deepEqual(card({ mains: ["m"], integrators: ["m"] }), { key: "m", live: true });
		assert.deepEqual(card({ mains: ["m"], integrators: [] }), { live: true, switched: true });
		assert.deepEqual(card({ mains: [], integrators: [] }, false), { live: false });
		const { projectView } = await import("../gui/trains.ts");
		const view = (i: object) => projectView({ project: "acme", forming: [], trains: [], waiting: [], integrator: i } as never, { now: 0, load: { now: 1, cores: 2 } } as never, () => undefined).integrator?.text;
		assert.equal(view({ live: true, switched: true }), "整合員：已換種類");
		assert.equal(view({ live: false }), "整合員：已關閉");
		assert.equal(view({ live: true, key: "m" }), "整合員：開啟它的對話");
		locale = "en";
		assert.equal(view({ live: true, switched: true }), "integrator: changed kind");
	} finally {
		locale = "zh-TW";
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live main with no sb_duty (an older sb) counts as an integrator for the yard card's key (the net's join)", () => {
	const n = net({});
	assert.equal(unit(n).duty, undefined);
});
