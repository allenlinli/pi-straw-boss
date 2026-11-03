import assert from "node:assert/strict";
import { test } from "node:test";
import type { Base, Net, Unit } from "../src/net.ts";
import { composerUnit, liveOf } from "../gui/sessionfacts.ts";

// The facts a session's composer and live line read, decided once for the session view and Zen's companion (gui/sessionfacts.ts).

const unit = (extra: Partial<Unit> = {}): Unit => ({ id: "u", key: "u", name: "Ada", role: "main", mark: "idle", control: true, subs: [], ...extra });
const tower = unit({ key: "t", name: "Tower" });
const net = (...units: Unit[]): Net => ({ bases: [{ id: "w1", label: "Harbor", mark: "idle", head: true, tower, outposts: [], outside: [], tabs: [{ id: "w1:t1", label: "squad", units }] } as unknown as Base] }) as unknown as Net;
const ok = () => Promise.resolve({ ok: true, status: 200, body: {} });

test("the composer's unit: control, agent, live, the mark as given, online, and whether a dialog is open", () => {
	const u = unit({ agent: "claude", pending: { callId: "c", tool: "dialog", answer: { dialog: "d" } } as Unit["pending"] });
	const c = composerUnit(u, { name: "Ada", mk: "waiting", state: "live", online: true });
	assert.deepEqual([c.name, c.control, c.agent, c.live, c.mark, c.online, c.answerable, c.ally, c.run], ["Ada", true, "claude", true, "waiting", true, true, false, false]);
	const bare = composerUnit(unit({ control: false }), { name: "Ada", mk: "idle", state: "recent", online: false });
	assert.deepEqual([bare.control, bare.live, bare.online, bare.answerable], [false, false, false, false], "a session that left the net is not live");
});

test("an ally run or an event run, which the net does not list, takes the composer's ally and run; a listed unit never does", () => {
	const ally = composerUnit(undefined, { name: "d", mk: "unknown", state: "live", online: true, role: "ally" });
	assert.deepEqual([ally.ally, ally.run, ally.control], [true, false, false]);
	const run = composerUnit(undefined, { name: "r", mk: "unknown", state: "live", online: true, role: "run" });
	assert.deepEqual([run.ally, run.run], [true, true]);
	const listed = composerUnit(unit(), { name: "Ada", mk: "idle", state: "live", online: true, role: "run" });
	assert.deepEqual([listed.ally, listed.run], [false, false]);
});

test("the live line: a working unit says what it does, a waiting one that it waits, and a finished subagent keeps no working mark", () => {
	const [note, mark] = liveOf(unit({ note: "read(a.ts)" }), "live", "working");
	assert.ok(note.length > 0);
	assert.equal(mark, "working");
	assert.equal(liveOf(unit({ ended: true, control: false, note: "x" }), "live", "working")[0], "");
	assert.equal(liveOf(unit({ ended: true, control: false }), "live", "working")[1], "done");
	assert.equal(liveOf(unit(), "recent", "commanding")[1], "done", "a session that left the net");
	assert.ok(liveOf(unit(), "live", "waiting")[0].length > 0);
	assert.equal(liveOf(unit(), "live", "idle")[0], "");
});

