import type { Audio } from "./audio.ts";

// Zen's music bus: a gain of its own at half the effects' level, into the background class's gain (through Zen's duck node when the page gives it), so the Background volume governs the music. Only the Zen chunk imports it, so the entry does not carry it.
const buses = new WeakMap<Audio, GainNode>();

/** The music bus of `a`: made at the first ask (which makes the context), the same node after. It reaches the background gain, or `into` when the first ask names a node (Zen's duck node, zensound.ts, so an effect can duck the music). */
export function musicBus(a: Audio, into?: AudioNode): GainNode {
	const { c, g } = a.out("background"), bus = buses.get(a) ?? c.createGain();
	if (!buses.has(a)) (bus.gain.value = 0.5), bus.connect(into ?? g), buses.set(a, bus);
	return bus;
}
