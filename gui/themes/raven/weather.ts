import { audio, type Audio } from "../../audio.ts";
import { prefs } from "../../prefs.ts";

// The keep's weather (boss, 2026-11-08: 「背景的雨聲和閃電的雷聲（兩個都不要太大聲），雷聲要比閃電慢一兩秒」): a quiet rain loop under the backdrop (the map and the head page) and a low thunder 1 to 2 s after each lightning flash.
// Both are synthesized on the page's one audio core (audio.ts, so Volume and the Sound switch govern them), no files: rain is a looped noise through a band-pass, thunder a low-passed brown noise that falls in pitch and rolls twice.
// The flash is the stylesheet's own clock: raven.css runs a no-op `rk-clap` animation beside the strike on the same layer, 61 s long and delayed to the strike's instant (94.4 % of the cycle), so its `animationstart` / `animationiteration` is the flash itself, whichever page shows it.
// Nothing sounds with Sound off, on a hidden tab, before the browser let the page play (the first press), or off the backdrop; no thunder under calm or prefers-reduced-motion, where the lightning is off.
type Ctx = ReturnType<Audio["out"]>["c"];

/** Rain: seconds of noise in the loop, the band-pass edges (Hz), the level at the master gain (the noise's RMS is about a quarter of it), and the fades in seconds. */
export const RAIN = { loop: 4, high: 700, low: 5200, gain: 0.03, fadeIn: 2.5, fadeOut: 0.8 };
/** Thunder: the wait after the flash (ms, a random point of it each time), the noise's low-pass falling from `from` to `to` Hz over `fall` s, the noise's peak gain, a low sine's (gain, Hz), the rise, the main decay and the two rolls (offset s, share of the peak), and the length in seconds. */
export const THUNDER = { delay: [1000, 2000] as const, from: 380, to: 90, fall: 3, noise: 0.1, hum: 0.01, hz: 46, attack: 0.4, tau: 1.5, rolls: [[1.1, 0.55], [2.3, 0.35]] as const, length: 6 };
export const FLASH = "rk-clap";

export interface WeatherEnv {
	audio: Pick<Audio, "out" | "running">;
	/** Raven's backdrop is on the page: the view is Raven and the stage is the map or the head page. */
	backdrop(): boolean;
	sound(): boolean;
	hidden(): boolean;
	/** The page is calm (no input for a while): the lightning is off. */
	calm(): boolean;
	/** prefers-reduced-motion: no-preference. */
	motion(): boolean;
	random(): number;
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const noise = (c: Ctx, seconds: number, brown: boolean) => {
	const buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * seconds)), c.sampleRate), d = buf.getChannelData(0);
	let last = 0;
	for (let i = 0; i < d.length; i++) {
		const white = Math.random() * 2 - 1;
		d[i] = brown ? (last = (last + 0.02 * white) / 1.02) * 3.5 : white; // brown noise for the rumble: its energy sits low
	}
	return buf;
};

/** Schedules one thunder into `dest` starting at `t`; returns its end. */
export function thunder(c: Ctx, dest: AudioNode, t: number): number {
	const T = THUNDER, src = c.createBufferSource();
	src.buffer = noise(c, T.length, true);
	const low = c.createBiquadFilter();
	low.type = "lowpass";
	low.frequency.setValueAtTime(T.from, t);
	low.frequency.exponentialRampToValueAtTime(T.to, t + T.fall);
	const env = c.createGain();
	env.gain.setValueAtTime(0, t);
	env.gain.linearRampToValueAtTime(T.noise, t + T.attack);
	env.gain.setTargetAtTime(0, t + T.attack, T.tau);
	for (const [at, share] of T.rolls) {
		env.gain.setTargetAtTime(T.noise * share, t + at, 0.25);
		env.gain.setTargetAtTime(0, t + at + 0.4, T.tau * 0.7);
	}
	src.connect(low);
	low.connect(env);
	env.connect(dest);
	src.start(t);
	src.stop(t + T.length);
	const hum = c.createOscillator(), hg = c.createGain();
	hum.type = "sine";
	hum.frequency.setValueAtTime(T.hz, t);
	hum.frequency.linearRampToValueAtTime(T.hz * 0.7, t + T.length);
	hg.gain.setValueAtTime(0, t);
	hg.gain.linearRampToValueAtTime(T.hum, t + T.attack);
	hg.gain.setTargetAtTime(0, t + T.attack, T.tau);
	hum.connect(hg);
	hg.connect(dest);
	hum.start(t);
	hum.stop(t + T.length);
	return t + T.length;
}

/** The weather on `env`: `refresh` after anything that changes whether rain is due, `flash` at each lightning flash, `stop` for good. */
export function createWeather(env: WeatherEnv) {
	let rain: { src: AudioBufferSourceNode; gain: GainNode } | undefined, buffer: AudioBuffer | undefined, owner: Ctx | undefined;
	const pending = new Set<unknown>();
	const heard = () => env.sound() && !env.hidden() && env.backdrop() && env.audio.running();
	const stopRain = () => {
		if (!rain) return;
		const { c } = env.audio.out(), { src, gain } = rain;
		rain = undefined;
		gain.gain.cancelScheduledValues(c.currentTime);
		gain.gain.setTargetAtTime(0, c.currentTime, RAIN.fadeOut / 4);
		src.stop(c.currentTime + RAIN.fadeOut);
	};
	const startRain = () => {
		const { c, g } = env.audio.out();
		if (owner !== c) (owner = c), (buffer = noise(c, RAIN.loop, false));
		const src = c.createBufferSource(), hp = c.createBiquadFilter(), lp = c.createBiquadFilter(), gain = c.createGain();
		src.buffer = buffer!;
		src.loop = true;
		hp.type = "highpass";
		hp.frequency.value = RAIN.high;
		lp.type = "lowpass";
		lp.frequency.value = RAIN.low;
		gain.gain.setValueAtTime(0, c.currentTime);
		gain.gain.linearRampToValueAtTime(RAIN.gain, c.currentTime + RAIN.fadeIn);
		src.connect(hp);
		hp.connect(lp);
		lp.connect(gain);
		gain.connect(g);
		src.start();
		rain = { src, gain };
	};
	const thunderDue = () => heard() && !env.calm() && env.motion();
	return {
		refresh() {
			if (heard()) rain || startRain();
			else stopRain();
		},
		/** The lightning flashed: a thunder follows after 1 to 2 s if every condition still holds then. */
		flash() {
			if (!thunderDue()) return;
			const [lo, hi] = THUNDER.delay, handle = env.set(() => {
				pending.delete(handle);
				if (!thunderDue()) return;
				const { c, g } = env.audio.out();
				thunder(c, g, c.currentTime);
			}, lo + env.random() * (hi - lo));
			pending.add(handle);
		},
		stop() {
			for (const h of pending) env.clear(h);
			pending.clear();
			stopRain();
		},
	};
}

/** Wires the weather to the page: the view and calm marks on <html>, the stage's view, the Sound switch, visibility, the first press, and the stylesheet's flash clock. Returns what undoes it. */
export function mountWeather(root: HTMLElement = document.documentElement, a: Audio = audio): () => void {
	const w = createWeather({
		audio: a,
		backdrop: () => root.dataset.view === "raven" && ["map", "head"].includes(document.getElementById("stage")?.dataset.view ?? ""),
		sound: () => prefs.get("sound"),
		hidden: () => document.hidden,
		calm: () => root.hasAttribute("data-calm"),
		motion: () => matchMedia("(prefers-reduced-motion: no-preference)").matches,
		random: Math.random,
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	});
	const refresh = () => w.refresh();
	const watch = new MutationObserver(refresh);
	watch.observe(root, { attributes: true, subtree: true, attributeFilter: ["data-view", "data-calm"] });
	// notify.ts redraws the Sound switch (`data-state`) when it changes in this tab; another tab's change arrives as a storage event.
	const sw = document.getElementById("sound"), swatch = new MutationObserver(refresh);
	if (sw) swatch.observe(sw, { attributes: true, attributeFilter: ["data-state"] });
	prefs.on("sound", refresh);
	// A press or key lets the browser play: the context is resumed then.
	const press = () => void a.unlock().then(refresh);
	const flash = (e: Event) => {
		// A late event (the tab was throttled) is not the flash any more.
		if ((e as AnimationEvent).animationName === FLASH && performance.now() - e.timeStamp < 1000) w.flash();
	};
	document.addEventListener("visibilitychange", refresh);
	for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, press, true);
	for (const type of ["animationstart", "animationiteration"]) document.addEventListener(type, flash, true);
	refresh();
	return () => {
		watch.disconnect();
		swatch.disconnect();
		document.removeEventListener("visibilitychange", refresh);
		for (const type of ["pointerdown", "keydown"]) document.removeEventListener(type, press, true);
		for (const type of ["animationstart", "animationiteration"]) document.removeEventListener(type, flash, true);
		w.stop();
	};
}
