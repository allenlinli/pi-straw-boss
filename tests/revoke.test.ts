import assert from "node:assert/strict";
import { test } from "node:test";
import { createRevoker, type OpenedMain } from "../src/server/revoke.ts";
import { runNotice } from "../src/link/unitstatus.ts";
import type { RunSignal } from "../src/server/runs.ts";

// G4 (docs/specs/2026-11-05-link-shared-box.md, Ending what a controller started): a main an ally run opened for a device that has left the team, or lost `dispatch`, is asked to quit (the graceful close of
// `boss_close_main`), and the team's admins are told. Mains opened with the boss's Allow below `dispatch` are left alone.

const DEV = "n".repeat(26), T = "t".repeat(16);
const main = (over: Partial<OpenedMain> = {}): OpenedMain => ({ workspace: "wA", label: "Alpha", main: "m-1", name: "main", device: DEV, team: T, deviceLabel: "dev-mac", level: "dispatch", ...over });

function rig(rows: OpenedMain[], levels: Record<string, string | undefined> = {}) {
	const closes: string[] = [], forgot: string[] = [], signals: RunSignal[] = [], logs: Record<string, unknown>[] = [];
	const world = { rows, levels, closeError: undefined as string | undefined, known: true, paneGone: true, errors: [] as (string | undefined)[], told: true };
	const revoker = createRevoker({
		opened: () => world.rows, known: () => world.known,
		standing: (device) => (world.levels[device] ? { level: world.levels[device]! } : undefined),
		close: async (workspace, m) => {
			closes.push(`${workspace}/${m}`);
			const next = world.errors.length ? world.errors.shift() : world.closeError;
			if (next) throw new Error(next);
		},
		paneGone: async () => world.paneGone,
		forget: (workspace, m) => void (forgot.push(`${workspace}/${m}`), (world.rows = world.rows.filter((x) => !(x.workspace === workspace && x.main === m)))),
		signal: (s) => (signals.push(s), world.told), log: (e) => void logs.push(e),
	});
	/** What a sweep does on its second look at a device found short of `dispatch`; a first look only notes it. */
	const twice = async () => (await revoker.sweep(), await revoker.sweep());
	return { revoker, closes, forgot, signals, logs, world, twice };
}

test("a main opened at dispatch for a device that lost dispatch is asked to quit, once it is accepted the admins are told and the route is let go", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	await r.revoker.sweep();
	assert.deepEqual(r.closes, [], "found short of dispatch once: noted, not acted on");
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1"]);
	assert.deepEqual(r.signals.map((s) => s.kind === "revoked" ? [s.main, s.ended, s.device, s.team, s.text] : s.kind), [["m-1", true, DEV, T, 'The main "main" opened for dev-mac was ended: the device lost dispatch.']]);
	assert.deepEqual(r.forgot, ["wA/m-1"], "the route of a main that quit is let go");
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1"], "and the next sweep asks nobody");
});

test("a device that left the team is the same, with its own reason", async () => {
	const r = rig([main()], {});
	await r.twice();
	assert.deepEqual(r.signals.map((s) => s.kind === "revoked" ? s.text : ""), ['The main "main" opened for dev-mac was ended: the device left the team.']);
});

test("a device still at dispatch keeps its main; so does one opened below dispatch (the boss's Allow), whatever the device is at now", async () => {
	const r = rig([main(), main({ main: "m-2", level: "forward" }), main({ main: "m-3", level: "reply", device: "z".repeat(26) })], { [DEV]: "dispatch" });
	await r.twice();
	assert.deepEqual(r.closes, []);
	assert.deepEqual(r.signals, []);
});

test("a row with no level on record (opened before the level was kept) counts as opened at dispatch", async () => {
	const { level: _level, ...old } = main();
	const r = rig([old], { [DEV]: "reply" });
	await r.twice();
	assert.deepEqual(r.closes, ["wA/m-1"]);
});

test("a main that is busy is asked again at every sweep, the admins are told once that it still runs, and once it quits they are told it ended", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	for (let i = 0; i < 4; i++) await r.revoker.sweep();
	assert.equal(r.closes.length, 3, "asked at every sweep after the first look");
	assert.deepEqual(r.signals.map((s) => s.kind === "revoked" ? [s.ended, s.text] : s.kind), [[false, 'The main "main" opened for dev-mac could not be ended yet (main is working; try again when it is idle). The box asks again until it quits.']]);
	r.world.closeError = undefined;
	await r.revoker.sweep();
	assert.deepEqual(r.signals.map((s) => s.kind === "revoked" && s.ended), [false, true]);
});

test("a main that is gone (no live session, not a main any more, not the tower's to close) is let go without a notice, but only after two misses in a row and with its pane absent from Herdr (g346-F002)", async () => {
	for (const why of ["No live session is named or has the id \"m-1\"", "main is not in this workspace; a tower closes only the mains it opened here", "main is not a main agent", "main was not opened by a tower (the boss opened it), so only the boss closes it"]) {
		const r = rig([main()], { [DEV]: "reply" });
		r.world.closeError = why;
		await r.twice();
		assert.deepEqual(r.forgot, [], `${why}: one miss forgets nothing`);
		await r.revoker.sweep();
		assert.deepEqual(r.forgot, ["wA/m-1"], why);
		assert.deepEqual(r.signals, [], why);
	}
});

test("one miss between working answers does not count: the main is asked again and its route stays (g346-F002)", async () => {
	const r = rig([main({ pane: "p-1" })], { [DEV]: "reply" });
	r.world.errors = ["main is working; try again when it is idle", "No live session is named or has the id \"m-1\"", "main is working; try again when it is idle", "No live session is named or has the id \"m-1\""];
	r.world.closeError = "main is working; try again when it is idle";
	for (let i = 0; i < 6; i++) await r.revoker.sweep();
	assert.deepEqual(r.forgot, []);
	assert.equal(r.closes.length, 5);
});

test("a main whose pane Herdr still lists is never let go on a miss; the admins are told it still runs, once (g346-F002)", async () => {
	for (const why of ["No live session is named or has the id \"m-1\"", "main was not opened by a tower (the boss opened it), so only the boss closes it"]) {
		const r = rig([main({ pane: "p-1" })], { [DEV]: "reply" });
		r.world.closeError = why;
		r.world.paneGone = false;
		for (let i = 0; i < 6; i++) await r.revoker.sweep();
		assert.deepEqual(r.forgot, [], why);
		assert.deepEqual(r.signals.map((s) => s.kind === "revoked" && s.ended), [false], why);
		// The broker's miss names the session id, so the notice says what it means instead (USB-F003); the boss-opened main's reason names no id.
		assert.match(r.signals.map((s) => (s.kind === "revoked" ? s.text : ""))[0]!, new RegExp(why.startsWith("No live") ? "the broker no longer lists it but its pane is still open" : why.slice(0, 20)), why);
	}
});

test("a pending notice nobody could be told of is sent again at a later sweep (g346-F005c)", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	r.world.told = false;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 2, "asked again each sweep while nobody was told");
	r.world.told = true;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 3, "once told, never again");
});

test("sweeps that overlap run once; a lookup that fails is tried again at the next sweep and breaks nothing", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	let release!: () => void;
	const hold = new Promise<void>((resolve) => (release = resolve));
	const slow = createRevoker({ opened: () => r.world.rows, known: () => true, standing: () => ({ level: "reply" }), close: async () => { r.closes.push("slow"); await hold; }, forget: () => {}, signal: () => {}, paneGone: async () => true, log: () => {} });
	await slow.sweep();
	const a = slow.sweep(), b = slow.sweep();
	release();
	await Promise.all([a, b]);
	assert.deepEqual(r.closes, ["slow"]);
	const broken = createRevoker({ opened: () => { throw new Error("route file unreadable"); }, known: () => true, standing: () => undefined, close: async () => {}, forget: () => {}, signal: () => {}, paneGone: async () => true, log: (e) => void r.logs.push(e) });
	await broken.sweep();
	assert.deepEqual(r.logs.map((e) => e.event), ["revoke-failed"]);
});

test("runNotice tells a revoked main to the admins by the device's scope, under a key per main and outcome", () => {
	const ended = runNotice({ kind: "revoked", workspace: "wA", label: "Alpha", ally: true, device: DEV, team: T, main: "m-1", ended: true, text: "The main was ended" });
	assert.deepEqual([ended.key, ended.notice.kind, ended.notice.unit, ended.scope], ["revoked/m-1/ended", "main-revoked", "Alpha", { device: DEV, team: T }]);
	const pending = runNotice({ kind: "revoked", workspace: "wA", label: "Alpha", ally: true, device: DEV, main: "m-1", ended: false, text: "still running" });
	assert.deepEqual([pending.key, pending.notice.kind, pending.scope], ["revoked/m-1/pending", "main-revoke-pending", { device: DEV }]);
});

test("a device is never taken as gone while the holder cannot tell (not running, the team not running, the roster unreadable), and one good look in between starts the count again", async () => {
	const r = rig([main()], {});
	r.world.known = false;
	await r.twice();
	await r.twice();
	assert.deepEqual(r.closes, []);
	r.world.known = true;
	await r.revoker.sweep();
	r.world.levels[DEV] = "dispatch";
	await r.revoker.sweep();
	delete r.world.levels[DEV];
	await r.revoker.sweep();
	assert.deepEqual(r.closes, [], "dispatch seen in between: the count starts again");
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1"]);
});

test("the Close it by hand notice is told even when a pending notice was told for that main before (g346b-F001)", async () => {
	const r = rig([main({ pane: "p-1" })], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	for (let i = 0; i < 2; i++) await r.revoker.sweep();
	r.world.closeError = "main was not opened by a tower (the boss opened it), so only the boss closes it";
	r.world.paneGone = false;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	const texts = r.signals.map((s) => (s.kind === "revoked" ? s.text : ""));
	assert.equal(texts.length, 2);
	assert.match(texts[1]!, /Close it by hand/);
	const keys = r.signals.map((s) => runNotice(s).key);
	assert.notEqual(keys[0], keys[1]);
});

test("a route with no pane is kept after any number of GONE answers (g346b-F003)", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	r.world.closeError = "No live session is named or has the id \"m-1\"";
	r.world.paneGone = false;
	for (let i = 0; i < 6; i++) await r.revoker.sweep();
	assert.deepEqual(r.forgot, []);
});
