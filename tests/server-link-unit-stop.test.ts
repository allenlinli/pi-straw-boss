import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkStore } from "../src/link/store.ts";
import { callControl } from "../src/server/socket.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { ServerWorld, until } from "./server-world.ts";

// The GUI's `unit-stop` request in the sb server's link service (src/link/service.ts `gui`): the page and `/boss link stop` post `link/unit-stop {team, device, handle, mode, reason}`, and the service hands it
// to the holder's `requestUnitStop`, which keeps every check (an attended asker, an unattended member of the team, the box's caps, the handle, the mode). Only the GUI's host session may ask.

let sw: ServerWorld, relay: FakeRelay;
beforeEach(() => {
	sw = new ServerWorld();
	relay = new FakeRelay();
});
afterEach(() => sw.close());

function team(project = join(sw.root, "home", "project")) {
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(sw.stateDir, "link")), entries = rosterOf();
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	writeFileSync(join(sw.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: real, share: "status" } } } }));
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
}
const linkDeps = () => ({ tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home: join(sw.root, "home") });
const ask = (endpoint: string, secret: string, from: string, body: unknown) => callControl(endpoint, secret, { cmd: "link", from, body } as { cmd: string }).then((r) => r.reply!);

test("the GUI's unit-stop reaches the holder's requestUnitStop with the team, the box, the handle, the mode, and the reason; its refusals come back as the answer", async () => {
	team();
	const s = await sw.start({ link: linkDeps() });
	await s.handle.ready;
	const record = sw.record()!;
	writeFileSync(join(sw.stateDir, "gui.json"), JSON.stringify({ ownerSession: "someone" }));
	await until(async () => ((await ask(record.socket, record.secret, "someone", { op: "gui", name: "state" })).answer as { ok: boolean }).ok, "an active holder");
	const stop = async (args: unknown, from = "someone") => (await ask(record.socket, record.secret, from, { op: "gui", name: "unit-stop", args })).answer;
	const good = { team: TEAM_HEX, device: bob.id, handle: "0123456789abcdef", mode: "quit", reason: "idle for a day" };
	assert.deepEqual(await stop({ ...good, handle: "nope" }), { ok: false, error: "A main's handle is 16 lowercase hex digits" }, "the holder's own check of the handle");
	assert.deepEqual(await stop({ ...good, mode: "kill" }), { ok: false, error: "mode is quit or interrupt" });
	assert.deepEqual(await stop({ ...good, team: "nope" }), { ok: false, error: "That team is not running on this device" });
	assert.deepEqual(await stop(good), { ok: false, error: "Only an unattended box takes a stop request" }, "bob is another attended device: the holder refuses it before anything is sent");
	assert.deepEqual(await stop({ ...good, reason: 7 }), { ok: false, error: "A reason is text" });
	assert.deepEqual(await stop(good, "not-the-gui-host"), { ok: false, error: "Only the session that hosts the GUI may change Straw Link teams" });
});
