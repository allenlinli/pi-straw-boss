import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudio } from "../gui/audio.ts";

// gui/audio.ts on a fake context: made at first play, resumed each time, one gain wired to the output, clips fetched once and played from their decoded buffer, a failed clip tried again.
function rig(failFirst = false, failResume = false) {
	const log: string[] = [], destination = { id: "destination" }, bufs: unknown[] = [];
	const gain = { gain: { value: -1 }, connect: (to: unknown) => log.push(to === destination ? "gain->destination" : "gain->?") };
	let made = 0, fetched = 0;
	const ac = {
		destination, state: "suspended", createGain: () => (log.push("createGain"), gain),
		resume: async () => { log.push("resume"); if (failResume) throw new Error("blocked"); ac.state = "running"; },
		decodeAudioData: async (b: ArrayBuffer) => ({ b }),
		createBufferSource: () => { const src = { buffer: null as unknown, connect: (g: unknown) => log.push(g === gain ? "src->gain" : "src->?"), start: () => (bufs.push(src.buffer), log.push("start")) }; return src; },
	};
	const a = createAudio(() => (made++, ac as never), async () => { fetched++; if (failFirst && fetched === 1) throw new Error("x"); return new ArrayBuffer(1); });
	const settle = () => new Promise((r) => setTimeout(r, 0));
	return { a, ac, log, gain, destination, bufs, made: () => made, fetches: () => fetched, settle };
}

test("the context is made at first play, not before, and once", async () => {
	const r = rig();
	assert.equal(r.made(), 0);
	r.a.play("a.mp3"); r.a.play("b.mp3");
	await r.settle();
	assert.equal(r.made(), 1);
	assert.equal(r.log.filter((l) => l === "createGain").length, 1);
	assert.equal(r.log.filter((l) => l === "start").length, 2);
	assert.equal(r.log.filter((l) => l === "resume").length, 2, "resumed at each play");
});

test("a play routes the source through the gain", async () => {
	const r = rig();
	r.a.play("a.mp3");
	await r.settle();
	assert.ok(r.log.includes("src->gain"));
});

test("volume is the square of the fraction, before and after the gain exists", async () => {
	const r = rig();
	r.a.volume(50);
	r.a.play("a.mp3");
	assert.equal(r.gain.gain.value, 0.25);
	r.a.volume(100);
	assert.equal(r.gain.gain.value, 1);
	await r.settle();
});

test("unlock makes and resumes the context without playing", async () => {
	const r = rig();
	r.a.unlock();
	await r.settle();
	assert.equal(r.made(), 1);
	assert.ok(r.log.includes("resume"));
	assert.ok(!r.log.includes("start"));
});

test("a clip is fetched once; a failed one is tried again at the next play", async () => {
	const r = rig(true);
	r.a.play("a.mp3");
	await r.settle();
	assert.ok(!r.log.includes("start"), "failed fetch is silent");
	r.a.play("a.mp3");
	await r.settle();
	assert.equal(r.log.filter((l) => l === "start").length, 1);
	r.a.play("a.mp3");
	await r.settle();
	assert.equal(r.log.filter((l) => l === "start").length, 2);
});

test("a clip played twice is fetched once", async () => {
	const r = rig();
	r.a.play("a.mp3"); r.a.play("a.mp3");
	await r.settle();
	assert.equal(r.fetches(), 1);
	r.a.play("b.mp3");
	await r.settle();
	assert.equal(r.fetches(), 2);
});

test("the master gain is wired to the context's output, so a clip is heard", async () => {
	const r = rig();
	r.a.play("a.mp3");
	await r.settle();
	assert.deepEqual(r.log.filter((l) => l.startsWith("gain->")), ["gain->destination"]);
});

test("a source plays the decoded clip, not an empty buffer", async () => {
	const r = rig();
	r.a.play("a.mp3");
	await r.settle();
	assert.equal(r.bufs.length, 1);
	assert.ok(r.bufs[0] instanceof Object && "b" in (r.bufs[0] as object), "the buffer decodeAudioData returned");
	assert.ok((r.bufs[0] as { b: unknown }).b instanceof ArrayBuffer);
});

test("out() is the one context and master gain play uses, made on first ask and not before", async () => {
	const r = rig();
	assert.equal(r.made(), 0);
	const o = r.a.out();
	assert.equal(r.made(), 1);
	assert.equal(o.c, r.ac);
	assert.equal(o.g, r.gain);
	assert.equal(r.a.out().g, o.g);
	r.a.play("a.mp3");
	await r.settle();
	assert.equal(r.made(), 1, "play uses the same context");
	assert.equal(r.log.filter((l) => l === "createGain").length, 1, "and the same gain");
	assert.deepEqual(r.log.filter((l) => l.startsWith("gain->")), ["gain->destination"]);
});

test("running() is false before any context, false while suspended, true once resumed", async () => {
	const r = rig();
	assert.equal(r.a.running(), false);
	assert.equal(r.made(), 0, "asking does not make the context");
	r.a.out();
	assert.equal(r.a.running(), false, "made but suspended");
	await r.a.unlock();
	assert.equal(r.a.running(), true);
	r.ac.state = "suspended";
	assert.equal(r.a.running(), false, "follows the context");
});

test("unlock() says whether the context is running; a refused resume is false and does not throw", async () => {
	const r = rig();
	assert.equal(await r.a.unlock(), true);
	assert.equal(r.made(), 1);
	const f = rig(false, true);
	assert.equal(await f.a.unlock(), false);
	assert.equal(f.a.running(), false);
	assert.equal(await f.a.unlock(), false, "and again");
});

test("unlock() is false when resume() resolves but the context stays suspended", async () => {
	const r = rig();
	r.ac.resume = async () => {}; // an iPhone that resolves and stays suspended or interrupted
	assert.equal(await r.a.unlock(), false);
});
