import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudio } from "../gui/audio.ts";

// gui/audio.ts on a fake context: made at first play, resumed each time, one gain, clips fetched once, a failed clip tried again.
function rig(failFirst = false) {
	const log: string[] = [], gain = { gain: { value: -1 }, connect: () => log.push("gain.connect") };
	let made = 0, fetched = 0;
	const ac = {
		destination: {}, createGain: () => (log.push("createGain"), gain), resume: async () => void log.push("resume"),
		decodeAudioData: async (b: ArrayBuffer) => ({ b }), createBufferSource: () => ({ buffer: null as unknown, connect: (g: unknown) => log.push(g === gain ? "src->gain" : "src->?"), start: () => log.push("start") }),
	};
	const a = createAudio(() => (made++, ac as never), async () => { fetched++; if (failFirst && fetched === 1) throw new Error("x"); return new ArrayBuffer(1); });
	const settle = () => new Promise((r) => setTimeout(r, 0));
	return { a, log, gain, made: () => made, fetches: () => fetched, settle };
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
