import assert from "node:assert/strict";
import { test } from "node:test";
import { createHereMark } from "../src/heremark.ts";
import { LEASE_MS } from "../src/lan/faces.ts";
import { hereWorld } from "./here.ts";

// The mark a `/boss` command holds while it asks something of this computer only (PLP-F001): the server's overlay mark of the pane (lan/faces.ts), so a paired device's key pad sends Escape only to a pane
// that shows the screen. It is opened before the screen, renewed while the screen waits, and dropped on every way out.

test("the pane is marked from before the screen opens until it is answered, and the lease is renewed meanwhile", async () => {
	const h = hereWorld();
	assert.equal(h.marked(), false);
	let during = false, release!: () => void;
	const held = h.here(async () => {
		during = h.marked();
		await new Promise<void>((r) => (release = r));
		return "answered";
	});
	await new Promise((r) => setImmediate(r));
	assert.equal(during, true, "the mark is open when the screen starts");
	for (let i = 0; i < 4; i++) await h.tick(LEASE_MS / 2);
	assert.equal(h.marked(), true, "twice the lease later it is still marked: the renewals kept it");
	release();
	assert.equal(await held, "answered");
	assert.deepEqual([h.marked(), h.faces.any(), h.timers()], [false, false, 0], "dropped, with no timer left");
});

test("the mark is dropped when the screen throws, and the throw is the caller's", async () => {
	const h = hereWorld();
	await assert.rejects(h.here(async () => { assert.equal(h.marked(), true); throw new Error("boom"); }), /boom/);
	assert.deepEqual([h.marked(), h.faces.any(), h.timers()], [false, false, 0]);
});

test("a server that forgot the mark (restarted, or the lease lapsed) is given a new one at the next renewal", async () => {
	const h = hereWorld();
	let release!: () => void;
	const held = h.here(() => new Promise<void>((r) => (release = r)));
	await new Promise((r) => setImmediate(r));
	h.faces.close(h.opened[0]!); // the server forgot it
	assert.equal(h.marked(), false);
	await h.tick(1000);
	assert.equal(h.marked(), true, "reopened");
	release();
	await held;
	assert.deepEqual([h.marked(), h.faces.any()], [false, false]);
});

test("no GUI is running (stopped, or no server): nobody can write to the pane, so the screen opens unmarked", async () => {
	for (const error of ["no server", "stopped"]) {
		const h = hereWorld("wA:p1", { reply: () => ({ ok: false, error }) });
		let ran = false;
		await h.here(async () => void (ran = true));
		assert.equal(ran, true, error);
		assert.equal(h.asked.length, 1, "asked once, never renewed");
		assert.equal(h.timers(), 0);
	}
});

test("any other refusal of the mark (a secondary slot, a server that errors) refuses the screen: nothing is asked of the boss", async () => {
	for (const error of ["Wi-Fi access is served by the default Herdr's sb server", "the sb server gave no answer", "bad_request"]) {
		const h = hereWorld("wA:p1", { reply: () => ({ ok: false, error }) });
		let ran = false;
		await assert.rejects(h.here(async () => void (ran = true)), /local-only|this computer only/i, error);
		assert.equal(ran, false, error);
	}
	const down = createHereMark({ ask: async () => { throw new Error("socket closed"); }, pane: "wA:p1", every: () => () => {} });
	await assert.rejects(down(async () => 1), /socket closed/);
});

test("two screens at once each hold their own mark; one ending leaves the other's", async () => {
	const h = hereWorld();
	let a!: () => void, b!: () => void;
	const first = h.here(() => new Promise<void>((r) => (a = r)));
	const second = h.here(() => new Promise<void>((r) => (b = r)));
	await new Promise((r) => setImmediate(r));
	a();
	await first;
	assert.equal(h.marked(), true);
	b();
	await second;
	assert.equal(h.marked(), false);
});

test("a session outside Herdr (no pane) holds a mark that no pane has: nothing breaks", async () => {
	const h = hereWorld(null as unknown as string);
	await h.here(async () => assert.equal(h.faces.any(), true));
	assert.equal(h.faces.any(), false);
});
