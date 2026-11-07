import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkHolder } from "../src/link/holder.ts";
import type { MainStatus } from "../src/link/kinds.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// What the controller's holder hands the page and pi about a box's mains (docs/specs/2026-11-07-link-remote-stop.md §6): `DeviceUnits` carries `canStop` (the box's fresh caps list unit-stop) and the labels
// of the dispatchers the mains name, so the card shows a Stop button only where the box takes one and names who dispatched a main. alice is the controller, dave and eve are boxes, bob another controller.

const { alice, bob, dave } = DEVICES;
const HANDLE = "0123456789abcdef", OTHER = "fedcba9876543210";
const main = (over: Partial<MainStatus> = {}): MainStatus => ({ handle: HANDLE, unit: "build", name: "docs", state: "idle", by: alice.id, stopping: false, ...over });
const UNITS = [{ unit: "build", state: "working", monitors: [], report: "r" }];

let root = "";
let relay: FakeRelay;
let skew = 0;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-unit-stop-ctl-"));
	relay = new FakeRelay();
	skew = 0;
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});
const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const [who, attended] of [["bob", true], ["dave", false]] as const) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	return log;
})();
/** `sink: false` is a box whose build wires no stop sink: it lists `unit-status.mains` but not `unit-stop`. */
function rig(who: "alice" | "dave", o: { sink?: boolean } = {}) {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who === "alice", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: 5,
		...(o.sink === false ? {} : { unitStop: () => {} }), now: () => Date.now() + skew,
	});
	cleanup.push(() => holder.stop());
	return { holder };
}

test("a box that lists unit-stop is canStop, and the dispatchers of its mains are named: this computer's own as self, a teammate's by its label", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id], entries);
	const a = rig("alice"), d = rig("dave");
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("unit-stop") && d.holder.capsFor(TEAM_HEX, alice.id).includes("unit-status.mains"), 3000, "caps on both sides");
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main(), main({ handle: OTHER, name: "api", by: bob.id })]);
	await until(() => a.holder.summary().units.length === 1, 3000, "the status on alice");
	const row = a.holder.summary().units[0]!;
	assert.equal(row.canStop, true);
	assert.deepEqual(row.dispatchers, { [alice.id]: { label: LABELS.alice, self: true }, [bob.id]: { label: LABELS.bob } });
	assert.equal(row.mains!.length, 2, "the mains stay as the box sent them");
	skew += 3 * 3600_000;
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS);
	await until(() => a.holder.summary().units[0]?.mains === undefined, 3000, "the next status without mains");
	assert.equal(a.holder.summary().units[0]!.canStop, undefined, "no mains, nothing to stop, and caps older than 2 hours count as none");
});

test("a box with no stop sink lists no unit-stop in its caps: its mains are shown and cannot be stopped", async () => {
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id], entries);
	const a = rig("alice"), d = rig("dave", { sink: false });
	await Promise.all([a.holder.start(), d.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).length > 0 && d.holder.capsFor(TEAM_HEX, alice.id).includes("unit-status.mains"), 3000, "caps on both sides");
	assert.ok(!a.holder.capsFor(TEAM_HEX, dave.id).includes("unit-stop"));
	await d.holder.sendUnitStatus(TEAM_HEX, alice.id, UNITS, [main()]);
	await until(() => a.holder.summary().units[0]?.mains !== undefined, 3000, "the mains on alice");
	assert.equal(a.holder.summary().units[0]!.canStop, undefined);
});
