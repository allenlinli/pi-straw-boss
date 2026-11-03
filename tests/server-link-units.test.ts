import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { aeadOpen } from "../src/link/crypto.ts";
import { encodeHeader } from "../src/link/envelope.ts";
import { decodePlaintext, type Kind } from "../src/link/kinds.ts";
import type { Share } from "../src/link/config.ts";
import { LinkStore } from "../src/link/store.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { callControl } from "../src/server/socket.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// What the sb server tells the controllers of an unattended device (docs/specs/2026-10-26-sb-backend.md, Unattended devices): the real link holder and reporter of the server, a policy file in a fake file system, a fake Herdr,
// and the controller's side read from the envelopes the fake relay took (bob is the attended device at dispatch; alice is the unattended one).

let world: TowerWorld, relay: FakeRelay;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	relay = new FakeRelay();
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);

function unattended(share: Share) {
	const home = join(world.root, "home"), project = join(home, "project"), elsewhere = join(world.root, "elsewhere");
	mkdirSync(project, { recursive: true });
	mkdirSync(elsewhere, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link")), entries = rosterOf();
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	const text = JSON.stringify({ unattended: true, trust: { [bob.id]: "dispatch" }, teams: { [TEAM_HEX]: { project: real, share } } });
	const link = { tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home, policy: { read: () => text, stat: () => ({ uid: 0, symlink: false }), writable: () => false, uid: 1000 } };
	return { real, elsewhere, link };
}
/** What bob reads of the envelopes alice sent him of `kind` (opened with the team key, without the receive checks: the roster of this test has alice attended). */
function toBob(kind: string) {
	const key = stateOf(rosterOf(), bob).keys.get(1)!, out: Record<string, unknown>[] = [];
	for (const stored of relay.stored) {
		const { header, nonce, ct } = stored.envelope;
		if (header.kind !== kind || !stored.to.has(bob.id)) continue;
		const plain = aeadOpen(key, nonce, ct, encodeHeader(header));
		const message = plain && decodePlaintext(kind as Kind, plain);
		if (message) out.push(message as unknown as Record<string, unknown>);
	}
	return out;
}
const unitsSeen = () => toBob("unit-status").map((m) => (m.units as { unit: string; monitors: string[] }[]).map((u) => u.unit));

async function towers(u: ReturnType<typeof unattended>) {
	const s = await world.start({ link: u.link, unitsMs: 20 });
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	for (const p of world.herdr.panes) p.cwd = p.workspace_id === "wA" ? u.real : u.elsewhere;
	return s;
}

test("the controller is told the units whose workspace is inside the team's project, under a scrubbed label, and not the others", async () => {
	const u = unattended("status");
	await towers(u);
	await until(() => unitsSeen().some((x) => x.length > 0), "a status with units");
	for (const seen of unitsSeen().filter((x) => x.length)) assert.deepEqual(seen, ["Alpha"]);
});

test("a team that shares presence only gets no unit in the status", async () => {
	const u = unattended("presence");
	await towers(u);
	await until(() => unitsSeen().length > 0, "a status");
	assert.equal(unitsSeen().every((x) => x.length === 0), true);
});

test("a run that crashes reaches the controllers as a notice through the server's own wiring, and the test seam still hears of it", async () => {
	const u = unattended("status");
	const s = await towers(u);
	const tower = world.client("sb-tower-wa")!;
	tower.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "poison" } });
	await until(() => world.pis.size >= 1, "a run");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	const claimed = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(claimed.ok, true, JSON.stringify(claimed));
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the crash");
	await until(() => toBob("notice").length > 0, "the notice at the controller");
	assert.deepEqual(toBob("notice").map((n) => [n.kind, n.unit]), [["run-crashed", "Alpha"]]);
	assert.deepEqual(world.signals.map((x) => x.kind), ["ended"], "a seam that watches the runs hears it as well");
});
