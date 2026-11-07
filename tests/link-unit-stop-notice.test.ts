import assert from "node:assert/strict";
import { test } from "node:test";
import { wireId } from "../src/board.ts";
import type { MainStatus, Notice, UnitStatus } from "../src/link/kinds.ts";
import { runNotice, UnitReporter } from "../src/link/unitstatus.ts";
import { reaches } from "../src/link/scope.ts";
import { createRevoker, type OpenedMain } from "../src/server/revoke.ts";
import type { RunSignal } from "../src/server/runs.ts";
import { createUnitStop, mainsFor, type MainFact } from "../src/server/unitstop.ts";

// Todo #100 task 3, the notices and the `mains` of docs/specs/2026-11-07-link-remote-stop.md (3.2, 3.4, 4): each outcome of a stop is a notice in the scope {device: row.device, team: row.team}, which reaches the dispatcher and that
// team's admins and never a third dev; a refusal reaches the requester's scope; and the box tells each controller the mains it may stop.

const BOX = "x".repeat(26), DISP = "d".repeat(26), ADMIN = "a".repeat(26), THIRD = "c".repeat(26), FOREIGN = "f".repeat(26), T1 = "1".repeat(16), T2 = "2".repeat(16);
const REASON = "secret reason of the stop";
const ADMINS: Record<string, string[]> = { [T1]: [ADMIN], [T2]: [FOREIGN] };
const admin = (team: string, device: string) => ADMINS[team]?.includes(device) ?? false;
const controllers = [{ team: T1, device: DISP }, { team: T1, device: ADMIN }, { team: T1, device: THIRD }, { team: T2, device: FOREIGN }];
const row = (over: Partial<OpenedMain> = {}): OpenedMain => ({ workspace: "wA", label: "Alpha", main: "sess-1", name: "opened main", device: DISP, deviceLabel: "dev-mac", team: T1, level: "dispatch", ...over });
const who = (scope: Parameters<typeof reaches>[0]) => controllers.filter((c) => reaches(scope, c, admin)).map((c) => c.device).sort();

const stopSignal = (outcome: "pending" | "stopped" | "manual" | "refused", over: Partial<Extract<RunSignal, { kind: "main-stop" }>> = {}): RunSignal => ({ kind: "main-stop", outcome, workspace: "wA", label: "Alpha", ally: true, device: DISP, team: T1, main: "sess-1", stopId: "5".repeat(32), text: `text of ${outcome}`, ...over });

test("runNotice: each stop outcome has its notice kind, a key per main and outcome (per stop for a refusal), and the dispatcher's scope", () => {
	const rows = (["pending", "stopped", "manual", "refused"] as const).map((o) => runNotice(stopSignal(o)));
	assert.deepEqual(rows.map((r) => r.notice.kind), ["main-stop-pending", "main-stopped", "main-stop-manual", "unit-stop-refused"]);
	assert.deepEqual(rows.map((r) => r.key), ["stop/sess-1/pending", "stop/sess-1/stopped", "stop/sess-1/manual", `stop-refused/${"5".repeat(32)}`]);
	assert.ok(rows.every((r) => r.notice.unit === "Alpha" && r.notice.text.startsWith("text of")));
	assert.deepEqual(rows[0]!.scope, { device: DISP, team: T1 });
});

test("the outcome notices reach the dispatcher and the team's admins, never a third dev nor another team's admin", async () => {
	for (const outcome of ["pending", "stopped", "manual"] as const) assert.deepEqual(who(runNotice(stopSignal(outcome)).scope), [ADMIN, DISP].sort(), outcome);
});

test("a refusal's notice is in the requester's scope: the requester and the team's admins are told, a third dev is not", () => {
	assert.deepEqual(who(runNotice(stopSignal("refused", { device: THIRD })).scope), [ADMIN, THIRD].sort());
	assert.deepEqual(who(runNotice(stopSignal("refused", { device: FOREIGN, team: T2 })).scope), [FOREIGN], "another team's admin asked on its own team: only its own scope");
});

test("the reporter tells the notice once, to those the scope covers", async () => {
	const told: [string, Notice][] = [];
	const reporter = new UnitReporter({ controllers: () => controllers, units: async () => [], report: () => "", status: async () => {}, notice: async (_t, device, n) => void told.push([device, n]), admin, now: () => 1, log: () => {} });
	const r = runNotice(stopSignal("pending"));
	assert.equal(await reporter.notify(r.key, r.notice, r.scope), true);
	assert.equal(await reporter.notify(r.key, r.notice, r.scope), false, "once");
	assert.deepEqual(told.map(([d]) => d).sort(), [ADMIN, DISP].sort());
});

// `mains` per controller.
const fact = (over: Partial<OpenedMain> = {}, name = "tester", state = "idle"): MainFact => ({ row: row(over), name, state });
const view = (facts: MainFact[], device: string, team = T1) => mainsFor(facts, { team, device }, { box: BOX, admin });

test("mains: the dispatcher sees its own mains, an admin sees every main of the team, a third dev and another team's admin see none; the handle is the board's wire id", () => {
	const facts = [fact({ main: "s-1" }), fact({ main: "s-2", device: THIRD, deviceLabel: "third-mac" }, "other")];
	assert.deepEqual(view(facts, DISP).map((m) => m.name), ["tester"]);
	assert.deepEqual(view(facts, ADMIN).map((m) => m.name), ["tester", "other"]);
	assert.deepEqual(view(facts, THIRD).map((m) => m.name), ["other"], "a dev sees its own, never another's");
	assert.deepEqual(view(facts, FOREIGN, T2), []);
	assert.deepEqual(view(facts, FOREIGN, T1), [], "an admin of another team is no admin of this one");
	const m = view(facts, ADMIN)[0]!;
	assert.deepEqual(m, { handle: wireId(BOX, "s-1"), unit: "Alpha", name: "tester", state: "idle", by: DISP, stopping: false } satisfies MainStatus);
});

test("mains: a pending stop shows as stopping; the name is scrubbed and cut to 40; at most 20 are listed; a main of no known state is `unknown`", () => {
	const stop = { by: ADMIN, at: 1, stopId: "5".repeat(32), mode: "quit" };
	const facts = [fact({ main: "s-1", stop }, "x".repeat(60), ""), ...Array.from({ length: 24 }, (_, i) => fact({ main: `s-${i + 2}` }))];
	const mains = view(facts, ADMIN);
	assert.equal(mains.length, 20);
	assert.deepEqual([mains[0]!.stopping, mains[0]!.name.length, mains[0]!.state], [true, 40, "unknown"]);
	assert.equal(mains[1]!.stopping, false);
});

test("mains: the pending-stop mains are listed first, so the 20 cut never hides a stopping one", () => {
	const stop = { by: ADMIN, at: 1, stopId: "5".repeat(32), mode: "quit" };
	const facts = [...Array.from({ length: 22 }, (_, i) => fact({ main: `s-${i}` })), fact({ main: "last", stop })];
	assert.ok(view(facts, ADMIN).some((m) => m.handle === wireId(BOX, "last") && m.stopping));
});

test("the reporter gives each controller its own mains and sends a status again when they change", async () => {
	const sent: [string, MainStatus[] | undefined][] = [];
	let facts = [fact({ main: "s-1" })];
	const units = async (): Promise<Omit<UnitStatus, "report">[]> => [];
	const reporter = new UnitReporter({ controllers: () => controllers.slice(0, 3), units, report: () => "", status: async (_t, device, _u, mains) => void sent.push([device, mains]), mains: async (team, device) => view(facts, device, team), notice: async () => {}, admin, now: () => 1, log: () => {} });
	const seen = () => sent.map(([d, m]) => [d, m?.length, m?.[0]?.stopping] as const).sort();
	await reporter.tick();
	assert.deepEqual(seen(), [[ADMIN, 1, false], [DISP, 1, false], [THIRD, 0, undefined]].sort());
	sent.length = 0;
	await reporter.tick();
	assert.equal(seen().length, 0, "nothing changed, nothing sent");
	facts = [fact({ main: "s-1", stop: { by: ADMIN, at: 1, stopId: "5".repeat(32), mode: "quit" } })];
	await reporter.tick();
	assert.deepEqual(seen(), [[ADMIN, 1, true], [DISP, 1, true]].sort(), "only those who see the main are told it is stopping");
});

test("the whole chain keeps the reason text out of every notice, signal, audit line and log", async () => {
	const out: unknown[] = [], signals: RunSignal[] = [];
	let stop: OpenedMain["stop"];
	let busy: string | undefined = "main is working; try again when it is idle";
	const revoker = createRevoker({
		opened: () => [{ ...row(), ...(stop ? { stop } : {}) }], known: () => true, standing: () => ({ level: "dispatch" }), close: async () => { if (busy) throw new Error(busy); },
		paneGone: async () => true, forget: () => {}, label: () => "admin-mac", signal: (s) => void signals.push(s), log: (e) => void out.push(e), audit: (e) => void out.push(e),
	});
	const unit = createUnitStop({
		box: () => BOX, opened: () => [row()], admin, witness: async () => ({ device: DISP, name: "tester" }), record: (_r, s) => ((stop = s), { set: true }), sweep: () => void revoker.sweep(),
		signal: (s) => void signals.push(s), tell: async (_t, _d, n) => void out.push(n), label: () => "admin-mac", audit: (e) => void out.push(e), now: () => 5,
	});
	await unit.handle({ team: T1, from: ADMIN, stopId: "5".repeat(32), handle: wireId(BOX, "sess-1"), mode: "quit", reason: REASON, at: 5 });
	await revoker.sweep();
	busy = undefined;
	await revoker.sweep();
	const notices = signals.map((s) => runNotice(s).notice);
	assert.deepEqual(notices.map((n) => n.kind), ["main-stop-pending", "main-stopped"]);
	assert.ok(!JSON.stringify([out, signals, notices]).includes("secret reason"));
	assert.ok(notices.every((n) => /admin-mac/.test(n.text)), "the notice names the requester's label");
});
