import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { DeviceKeys } from "../src/link/device.ts";
import { LinkHolder, type OperateIn } from "../src/link/holder.ts";
import { OperateSession } from "../src/link/operate.ts";
import { RelayClient } from "../src/link/relay.ts";
import { roleEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { addEntry } from "../src/link/roster.ts";
import { alice, bob, clientFor, netOf, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { det, DEVICES, LABELS, TEAM, view } from "./link/scenario.ts";
import { ServerWorld, until } from "./server-world.ts";

// The box's bridge inside the real sb server (src/server/main.ts wiring; the behaviour is tests/server-operate-box.test.ts): dave's device is an unattended box (alice founded the team) whose policy gives bob (an attended admin of the team, run here as
// a real holder) `operate`. Bob's open reaches the box through the fake relay's live stream, the server's holder hands it to the bridge, and the `accept` comes back the same way. A roster change that demotes bob then ends the session
// through the holder's `onRoster` hook, with no policy event at all.

let sw: ServerWorld, relay: FakeRelay;
beforeEach(() => {
	sw = new ServerWorld();
	relay = new FakeRelay();
});
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	await sw.close();
});

/** The box (a server with the bridge) and bob's open session on it, accepted. */
async function accepted() {
	const project = join(sw.root, "home", "project");
	mkdirSync(project, { recursive: true });
	const dave = DEVICES.dave, real = realpathSync(project), boxStore = new LinkStore(join(sw.stateDir, "link")), entries = rosterOf();
	entries.push(addEntry({ state: view(entries), signer: alice, record: dave, label: LABELS.dave, attended: false, ...det("add-dave") }));
	entries.push(roleEntry({ state: stateOf(entries, alice), signer: alice, subjectId: bob.id, role: "admin" }));
	writeDevice(boxStore, dave, "ci-box");
	writeTeam(boxStore, entries, dave);
	relay.addTeam(TEAM, [alice.id, bob.id, dave.id], entries);
	const policy = JSON.stringify({ unattended: true, trust: { [bob.id]: "dispatch" }, teams: { [TEAM_HEX]: { project: real, share: "status" } }, operate: { [bob.id]: "team" } });
	const s = await sw.start({ link: { tickMs: 15, drainMs: 20, presenceMs: 40, capsMs: 3_600_000, capsMinMs: 5, relay: clientFor(relay), home: join(sw.root, "home"), policy: { path: "/etc/straw-link/policy.json", uid: 501, stat: () => ({ uid: 0, symlink: false }), writable: () => false, read: () => policy } } });
	await s.handle.ready;

	// Bob: an attended holder with an operate sink, in a folder of its own.
	const bobStore = new LinkStore(join(sw.root, "bob", "link"), { alive: () => true });
	bobStore.ensure();
	writeDevice(bobStore, bob, "bob-mac");
	writeTeam(bobStore, entries, bob);
	const got: OperateIn[] = [];
	const holder = new LinkHolder({
		store: bobStore, isHolder: () => true, attended: () => true, net: async () => netOf([["tower-bob", "w-bob", "l-bob", project]]),
		relay: (url: string, device: DeviceKeys) => new RelayClient({ url, device, fetch: (i, init) => relay.fetch(i, init), timeoutMs: 2000 }),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, capsMs: 3_600_000, capsMinMs: 5,
		operate: (m: OperateIn) => void got.push(m),
	});
	stops.push(() => holder.stop());
	await holder.start();
	await until(() => holder.capsFor(TEAM_HEX, dave.id).includes("operate/1"), "the box lists operate/1 in its caps");

	const ended: { reason: string; peer?: string }[] = [];
	const session = OperateSession.open({ now: Date.now, send: (m) => void holder.sendLive(TEAM_HEX, dave.id, m).catch(() => undefined), onInner: () => undefined, onEnd: (e) => void ended.push(e), onTransportError: () => undefined }, { team: TEAM, self: bob.id, peer: dave.id, want: "team" });
	const pump = setInterval(() => { for (const m of got.splice(0)) session.receive(m.message, m.from); }, 10);
	stops.push(() => clearInterval(pump));
	await until(() => session.state === "open", "the accept");

	const log = () => (existsSync(join(sw.stateDir, "link", "link.log")) ? readFileSync(join(sw.stateDir, "link", "link.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
	assert.deepEqual(log().filter((l) => l.event === "operate-open").map((l) => [l.team, l.from, l.want, l.verdict]), [[TEAM_HEX, bob.id, "team", "accepted"]]);

	return { s, relay, entries, ended, log };
}

test("an open from a granted admin is accepted through the server, and a roster change that demotes the admin ends the session with a close", async () => {
	const { entries, ended, log } = await accepted();
	// Bob is demoted by the founder: the roster event reaches the box's holder, whose hook ends the session.
	relay.pushRoster(TEAM, roleEntry({ state: stateOf(entries, alice), signer: alice, subjectId: bob.id, role: "member" }));
	await until(() => ended.length > 0, "the close");
	assert.deepEqual(ended, [{ reason: "peer-closed", peer: "roster" }]);
	await until(() => log().some((l) => l.event === "operate-close"), "the box's log line");
	assert.deepEqual(log().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason, l.from]), [["box", "roster", bob.id]]);
});

test("OBX-F005 (M22): stopping the server ends the session with a close that reaches the operator, and the box logs it", async () => {
	const { s, ended, log } = await accepted();
	await s.handle.shutdown(0);
	await until(() => ended.length > 0, "the close");
	assert.deepEqual(ended, [{ reason: "peer-closed", peer: "stopped" }]);
	assert.deepEqual(log().filter((l) => l.event === "operate-close").map((l) => [l.by, l.reason, l.from]), [["box", "stopped", bob.id]]);
});
