import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudio } from "../gui/audio.ts";
import { musicBus } from "../gui/audiobus.ts";

// gui/audiobus.ts on a fake context: Zen's music plays through a gain of its own at 0.5, under the background class's gain, so the Background volume governs it.
function rig() {
	const nodes: { gain: { value: number }; to?: unknown; connect(t: unknown): void }[] = [];
	const ac = { destination: {}, state: "suspended", createGain: () => { const n = { gain: { value: -1 }, to: undefined as unknown, connect(t: unknown) { n.to = t; } }; return (nodes.push(n), n); }, resume: async () => void (ac.state = "running") };
	const a = createAudio(() => ac as never);
	return { a, nodes };
}

test("the music bus is a gain at 0.5 wired into the background gain, not the output", () => {
	const r = rig();
	const bus = musicBus(r.a);
	const master = r.a.out("background").g as unknown as (typeof r.nodes)[number];
	assert.equal(r.nodes.length, 2);
	assert.equal(master.to, r.a.out("background").c.destination, "the background gain reaches the output");
	assert.equal((bus as unknown as (typeof r.nodes)[number]).to, master, "music reaches the background gain");
	assert.equal(bus.gain.value, 0.5);
});

test("the music bus is one node per audio, and Volume leaves its own gain alone", () => {
	const r = rig();
	const bus = musicBus(r.a);
	assert.equal(musicBus(r.a), bus);
	r.a.volume("background", 20);
	assert.equal(bus.gain.value, 0.5, "the background gain carries its volume; the bus keeps 0.5 under it");
	assert.equal(r.a.out("background").g.gain.value, 0.2 ** 2);
	assert.equal(r.nodes.length, 2);
	const other = rig();
	assert.notEqual(musicBus(other.a), bus);
});

test("asking for the bus makes the context lazily and only once", () => {
	const r = rig();
	assert.equal(r.nodes.length, 0);
	musicBus(r.a);
	musicBus(r.a);
	assert.equal(r.nodes.length, 2);
});
