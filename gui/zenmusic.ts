import type { Audio } from "./audio.ts";

// Zen's music player (docs/specs/2026-11-01-zen-view.md, Music), a chunk of its own: two <audio> elements, each through a gain of its own into the music bus (audiobus.ts), so the loop has no gap and a
// track change is a cross-fade. 6 s before the playing element's end the other starts the same track from 0 and the two fade over equal-power curves; nothing is decoded into a buffer. The files come from
// the server's music folder (src/music.ts); `start` is called from a user gesture, as a browser's autoplay rules want.

export const FADE_S = 6;
/** The slice of an <audio> element the player uses (a test gives its own). */
export interface MediaEl {
	src: string;
	currentTime: number;
	readonly duration: number;
	preload: string;
	play(): Promise<void>;
	readonly paused: boolean;
	pause(): void;
	load(): void;
	removeAttribute(name: string): void;
	addEventListener(type: string, fn: () => void): void;
}
export interface PlayerEnv {
	audio: Audio;
	/** The music bus the elements' gains connect to (audiobus.ts; through Zen's duck node, zensound.ts). */
	bus(): AudioNode;
	make(): MediaEl;
	url(file: string): string;
	/** The page's timer (a test moves its own): runs `fn` after `ms`, returns what cancels it. */
	later(fn: () => void, ms: number): () => void;
	/** The browser refused to play (`blocked`: it wants a tap) or the file would not play (`failed`). */
	report(why: "blocked" | "failed"): void;
}
export interface Player {
	/** Starts `file`, or from a playing track cross-fades to it. True when the browser accepted the play. */
	start(file: string): Promise<boolean>;
	stop(): void;
	/** Holds the place (the page is hidden on a phone). */
	pause(): void;
	resume(): Promise<boolean>;
	/** The file now playing or paused, or undefined when stopped. */
	file(): string | undefined;
}
interface Slot { el: MediaEl; gain: GainNode; file?: string }

/** Equal-power curves: the one coming in rises as sin, the one going out falls as cos, so the sum of their power stays level. */
const curve = (f: (x: number) => number) => Float32Array.from({ length: 64 }, (_, i) => f(i / 63));
const IN = curve((x) => Math.sin((x * Math.PI) / 2)), OUT = curve((x) => Math.cos((x * Math.PI) / 2));

export function createPlayer(env: PlayerEnv): Player {
	const slots: Slot[] = [];
	let at = 0, fading: { from: Slot; to: Slot; stop(): void } | undefined, name: string | undefined;
	const slot = (i: number): Slot => {
		if (slots[i]) return slots[i]!;
		const { c } = env.audio.out(), el = env.make(), gain = c.createGain(), s: Slot = { el, gain };
		el.preload = "none";
		// SAFETY: `make` returns an <audio> element in the page (MediaEl is the slice of it this file reads); a test's fake context takes its fake element as it is
		c.createMediaElementSource(el as unknown as HTMLMediaElement).connect(gain);
		gain.connect(env.bus());
		el.addEventListener("timeupdate", () => i === at && !fading && s.file && left(s) <= span(s) && fade(s.file));
		el.addEventListener("ended", () => i === at && !fading && s.file && void ((el.currentTime = 0), play(s)));
		el.addEventListener("error", () => i === at && env.report("failed"));
		return (slots[i] = s);
	};
	const span = (s: Slot) => (Number.isFinite(s.el.duration) ? Math.min(FADE_S, s.el.duration / 2) : FADE_S);
	const left = (s: Slot) => (Number.isFinite(s.el.duration) ? s.el.duration - s.el.currentTime : Infinity);
	const play = (s: Slot) => s.el.play().then(() => true, (e: unknown) => ((e as { name?: string })?.name === "AbortError" ? false : (env.report((e as { name?: string })?.name === "NotAllowedError" ? "blocked" : "failed"), false)));
	const release = (s: Slot) => (s.el.pause(), s.el.removeAttribute("src"), s.el.load(), (s.file = undefined), s.gain.gain.cancelScheduledValues(0), (s.gain.gain.value = 0));
	/** A cross-fade in progress ends at once: the outgoing element is let go, the incoming one stands at full level. */
	function settle() {
		if (!fading) return;
		const { from, to, stop } = fading;
		fading = undefined;
		stop();
		release(from);
		to.gain.gain.cancelScheduledValues(0);
		to.gain.gain.value = 1;
	}
	function fade(file: string) {
		settle();
		const from = slots[at]!, to = slot(1 - at), t = env.audio.out().c.currentTime, len = span(from);
		to.file = file;
		to.el.src = env.url(file);
		to.gain.gain.cancelScheduledValues(t);
		to.gain.gain.setValueAtTime(0, t);
		to.gain.gain.setValueCurveAtTime(IN, t, len);
		from.gain.gain.cancelScheduledValues(t);
		from.gain.gain.setValueCurveAtTime(OUT, t, len);
		fading = { from, to, stop: env.later(settle, len * 1000) };
		at = 1 - at;
		name = file;
		return play(to);
	}
	return {
		file: () => name,
		async start(file) {
			if (name && slots[at]?.file) return file !== name ? fade(file) : slots[at]!.el.paused ? play(slots[at]!) : true; // the same track on a paused element (a refused resume) plays again
			const s = slot(at);
			s.file = name = file;
			s.el.src = env.url(file);
			s.gain.gain.cancelScheduledValues(0);
			s.gain.gain.value = 1;
			const ok = await play(s);
			if (!ok && name === file) [name, s.file] = [undefined, undefined]; // a play that did not start leaves nothing playing, so the next start tries again
			return ok;
		},
		stop() {
			settle();
			slots.forEach(release);
			name = undefined;
		},
		pause() {
			settle();
			slots[at]?.el.pause();
		},
		resume: async () => (slots[at]?.file ? play(slots[at]!) : false),
	};
}
