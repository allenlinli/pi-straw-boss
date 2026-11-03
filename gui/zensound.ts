import type { Audio } from "./audio.ts";
import type { Sound } from "./zenmodel.ts";

// Zen's three effects, synthesized (no files) and scheduled on the page's one audio core (audio.ts), so there is no second context and Volume (the master gain's square) governs them.
// A recipe is a plain object; `schedule` turns it into nodes on any BaseAudioContext, so tests read the schedule from a fake one. The numbers are the spec's starting point (docs/specs/2026-11-01-zen-view.md, Sound).
type Ctx = ReturnType<Audio["out"]>["c"];
/** A partial: its ratio to the base, relative gain, and the decay time constant in seconds. Each sounds as two sines `beat` Hz apart. */
export interface Partial { ratio: number; gain: number; tau: number }
interface Bowl { kind: "bowl"; freq: number; partials: Partial[]; beat: number; attack: number; length: number; peak: number; bend: number }
interface Knock { kind: "knock"; freq: number; to: number; sweep: number; burst: number; band: number; q: number; tau: number; length: number; peak: number }
export type Recipe = Bowl | Knock;
export const BOWL: Bowl = { kind: "bowl", freq: 228, partials: [{ ratio: 1, gain: 1, tau: 2.4 }, { ratio: 2.71, gain: 0.45, tau: 1.4 }, { ratio: 5.15, gain: 0.2, tau: 0.8 }, { ratio: 8.42, gain: 0.08, tau: 0.4 }], beat: 1.2, attack: 0.015, length: 5, peak: 0.35, bend: 1 };
export const LOW: Bowl = { ...BOWL, freq: 146, partials: BOWL.partials.map((p) => ({ ...p, tau: (p.tau * 2) / 3 })), peak: 0.3, bend: 0.99 };
export const KNOCK: Knock = { kind: "knock", freq: 560, to: 480, sweep: 0.04, burst: 0.025, band: 1100, q: 6, tau: 0.07, length: 0.25, peak: 0.5 };
export const RECIPES: Record<Sound, Recipe> = { bowl: BOWL, knock: KNOCK, low: LOW };
/** While music plays an effect ducks it by 6 dB over `IN` seconds and lets it back over `OUT`. */
export const DUCK = { db: 6, in: 0.3, out: 1.5 };
/** The gap between the three in a try. */
export const GAP = 1.6;

/** Schedules `r` into `dest` starting at `t`; returns the time it ends. */
export function schedule(c: Ctx, dest: AudioNode, t: number, r: Recipe): number {
	const env = (peak: number, attack: number, tau: number) => {
		const g = c.createGain();
		g.gain.setValueAtTime(0, t);
		g.gain.linearRampToValueAtTime(peak, t + attack);
		g.gain.setTargetAtTime(0, t + attack, tau);
		g.connect(dest);
		return g;
	};
	if (r.kind === "knock") {
		const o = c.createOscillator();
		o.type = "sine";
		o.frequency.setValueAtTime(r.freq, t);
		o.frequency.linearRampToValueAtTime(r.to, t + r.sweep);
		o.connect(env(r.peak * 0.7, 0.002, r.tau));
		o.start(t);
		o.stop(t + r.length);
		const n = c.createBufferSource(), buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * r.burst)), c.sampleRate), d = buf.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
		n.buffer = buf;
		const f = c.createBiquadFilter();
		f.type = "bandpass";
		f.frequency.value = r.band;
		f.Q.value = r.q;
		n.connect(f);
		f.connect(env(r.peak * 0.3, 0.002, r.tau));
		n.start(t);
		return t + r.length;
	}
	const sum = r.partials.reduce((s, p) => s + p.gain, 0) * 2;
	for (const p of r.partials) for (const side of [-0.5, 0.5]) {
		const o = c.createOscillator(), f = r.freq * p.ratio + side * r.beat;
		o.type = "sine";
		o.frequency.setValueAtTime(f, t);
		if (r.bend !== 1) o.frequency.exponentialRampToValueAtTime(f * r.bend, t + r.length);
		o.connect(env((r.peak * p.gain) / sum, r.attack, p.tau));
		o.start(t);
		o.stop(t + r.length);
	}
	return t + r.length;
}

/** What Zen's effects need: the page's audio core, the Sound switch, the music bus when one plays (Z6), and the document that carries the first gesture. */
export function createZenSound(a: Audio, sw: { on(): boolean }, music: () => GainNode | undefined = () => undefined, doc: Pick<Document, "addEventListener" | "removeEventListener"> = document) {
	// The first press or key lets the browser play: the context is resumed then, and an effect due before it is dropped, not queued behind it.
	const gestures = ["pointerdown", "keydown"], unlock = () => (gestures.forEach((g) => doc.removeEventListener(g, unlock, true)), void a.unlock());
	gestures.forEach((g) => doc.addEventListener(g, unlock, true));
	const duck = (t: number) => {
		const p = music()?.gain;
		if (!p) return;
		const base = p.value;
		p.cancelScheduledValues(t);
		p.setValueAtTime(base, t);
		p.linearRampToValueAtTime(base * 10 ** (-DUCK.db / 20), t + DUCK.in);
		p.linearRampToValueAtTime(base, t + DUCK.in + DUCK.out);
	};
	const at = (names: Sound[]) => {
		const { c, g } = a.out(), t0 = c.currentTime;
		names.forEach((n, i) => schedule(c, g, t0 + i * GAP, RECIPES[n]));
		duck(t0);
	};
	return {
		/** One effect, when Sound is on and the page may play; otherwise nothing, and nothing queued. */
		play(s: Sound) { if (sw.on() && a.running()) at([s]); },
		/** The bowl alone, for the volume's release: it ignores the switch (a press lets the page play). */
		try() { void a.unlock().then((ok) => ok && at(["bowl"])); },
		/** The Try button: the three in turn. */
		tryAll() { void a.unlock().then((ok) => ok && at(["bowl", "knock", "low"])); },
	};
}
