import type { Audio } from "./audio.ts";

// Zen's music bus: a gain of its own at half the effects' level, into the one master gain, so Volume governs the music too. Only the Zen chunk imports it, so the entry does not carry it.
const buses = new WeakMap<Audio, GainNode>();

/** The music bus of `a`: made at the first ask (which makes the context), the same node after. */
export function musicBus(a: Audio): GainNode {
	const { c, g } = a.out(), bus = buses.get(a) ?? c.createGain();
	if (!buses.has(a)) (bus.gain.value = 0.5), bus.connect(g), buses.set(a, bus);
	return bus;
}
