import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createFaces } from "../src/lan/faces.ts";
import { type ServerRecord, writeRecord } from "../src/server/record.ts";
import { listenControl, type Control, type Reply, type Request } from "../src/server/socket.ts";
import { serverSource } from "../src/towerprompt/serversource.ts";
import { ServerWorld } from "./server-world.ts";

// The here mark of the tower prompt's picker (docs/specs/2026-11-10-wait-cards-tui.md, §3a; src/heremark.ts) over the real control socket: the stand-in opens the mark for its own pane and drops it, an absent GUI marks nothing, and
// every other answer (a slow server, a refusal, a folder that is not the boss's) refuses the mode: a paired device could answer where the boss believes nobody can.

const SECRET = "h".repeat(64), PANE = "wA:p1";
let world: ServerWorld;
const controls: Control[] = [];
beforeEach(() => void (world = new ServerWorld()));
afterEach(async () => {
	await Promise.all(controls.splice(0).map((c) => c.close()));
	await world.close();
});

const plant = (over: Partial<ServerRecord> = {}) => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, { pid: 7, started: "T-7", version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket: "/nowhere.sock", secret: SECRET, intercomId: "sb-server-00000000", ...over });
};
/** A server that answers `handle`; its record is planted. */
async function serving(handle: (request: Request) => Promise<Reply> | Reply) {
	mkdirSync(world.slot.dir, { recursive: true });
	const requests: Request[] = [], endpoint = join(world.slot.dir, "here.sock");
	world.live.add(7);
	controls.push(await listenControl({ endpoint, secret: SECRET, hello: () => ({ pid: 7, version: "0.44.0", mode: "detached", desk: false, phase: "ready", ready: true }), handle: (r) => (requests.push(r), handle(r)), refused: () => {} }));
	plant({ socket: endpoint });
	return requests;
}
const MARK = /could not be marked as local-only/;

test("the stand-in opens the here mark for its own pane while the picker runs, and drops the mark when the picker ends (also when it throws)", async () => {
	const faces = createFaces();
	const requests = await serving((r) => {
		if (r.cmd === "gui-lan-face") return r.open === true ? (() => { const face = faces.open(r.pane); return face ? { ok: true, face } : { ok: false, error: "bad_request" }; })() : { ok: true, closed: faces.close(r.face) };
		if (r.cmd === "gui-lan-pending") return faces.renew(r.face) ? { ok: true } : { ok: false, error: "unknown_face" };
		return { ok: false, error: "bad_request" };
	});
	const source = serverSource(world.ctx(), "wA", 4100, PANE);
	assert.equal(faces.marked(PANE), false);
	const seen = await source.pick!.here(async () => [faces.marked(PANE), faces.marked("wA:p2")]);
	assert.deepEqual(seen, [true, false], "the mark is on the stand-in's own pane, and only there");
	assert.equal(faces.any(), false, "dropped when the picker ends");
	await assert.rejects(source.pick!.here(async () => { assert.equal(faces.marked(PANE), true); throw new Error("the picker failed"); }), /the picker failed/);
	assert.equal(faces.any(), false, "dropped when the picker throws");
	const asked = requests.filter((r) => r.cmd === "gui-lan-face").map((r) => [r.open, r.open === true ? r.pane : "face" in r]);
	assert.deepEqual(asked, [[true, PANE], [false, true], [true, PANE], [false, true]]);
});

test("a GUI that is not there marks nothing and the picker runs: no record, a record of a socket nobody listens on, and a server that says no GUI listens", async () => {
	let ran = 0;
	const run = (source: ReturnType<typeof serverSource>) => source.pick!.here(async () => ++ran);
	assert.equal(await run(serverSource(world.ctx(), "wA", 4100, PANE)), 1, "no record");
	plant();
	assert.equal(await run(serverSource(world.ctx(), "wA", 4100, PANE)), 2, "a socket nobody listens on");
	await world.close();
	world = new ServerWorld();
	await serving(() => ({ ok: false, error: "stopped" }));
	assert.equal(await run(serverSource(world.ctx(), "wA", 4100, PANE)), 3, "a GUI stopped on purpose");
});

test("WTUI-F002: a server that is slow to mark, one that refuses, and a folder that is not the boss's refuse the mode: the picker does not run unmarked", async () => {
	let ran = 0;
	const run = (source: ReturnType<typeof serverSource>) => source.pick!.here(async () => ++ran);
	// Up and serving the GUI, but the mark is not answered within the time the stand-in allows.
	await serving((r) => (r.cmd === "gui-lan-face" ? new Promise<Reply>(() => {}) : { ok: true }));
	await assert.rejects(run(serverSource(world.ctx(), "wA", 4100, PANE)), MARK);
	await world.close();
	world = new ServerWorld();
	// It answers, and refuses.
	await serving((r) => (r.cmd === "gui-lan-face" ? { ok: false, error: "bad_request" } : { ok: true }));
	await assert.rejects(run(serverSource(world.ctx(), "wA", 4100, PANE)), /bad_request/);
	// A reply that names no face is no mark either.
	await world.close();
	world = new ServerWorld();
	await serving((r) => (r.cmd === "gui-lan-face" ? { ok: true } : { ok: true }));
	await assert.rejects(run(serverSource(world.ctx(), "wA", 4100, PANE)), MARK);
	// A state folder whose owner is not judged to be the boss.
	await world.close();
	world = new ServerWorld();
	plant();
	await assert.rejects(run(serverSource(world.ctx({ gate: async () => { throw new Error("the folder belongs to another account"); } }), "wA", 4100, PANE)), /another account/);
	assert.equal(ran, 0, "the picker never ran");
});
