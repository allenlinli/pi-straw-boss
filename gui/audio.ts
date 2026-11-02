// The page's one playback core: every view's sounds (the Standard chime and clips, Zen's later sounds and music) play through one AudioContext and one master gain.
// The context is made at the first play or unlock and resumed at each (a browser that blocks sound before any press keeps it suspended); the gain follows the square of Volume (0 to 100), which an iPhone honours.
// `out()` is for the views' own nodes (Zen's effects, its music bus in audiobus.ts); `running()` says whether a sound due now would be heard (a suspended context queues it; Zen drops an effect instead).
type Ctx = Pick<AudioContext, "createGain" | "createBufferSource" | "createOscillator" | "createMediaElementSource" | "decodeAudioData" | "resume" | "destination" | "currentTime" | "state">;
/** `play`: a short clip, decoded whole and kept (the Standard sounds, Zen's effects), never music. `unlock`: called from a user gesture; false when the browser refused to resume. */
export interface Audio { play(url: string): void; volume(v: number): void; unlock(): Promise<boolean>; out(): { c: Ctx; g: GainNode }; running(): boolean }

export function createAudio(make: () => Ctx = () => new AudioContext(), bytes: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => r.arrayBuffer())): Audio {
	let ac: Ctx | undefined, gain: GainNode | undefined, level = 1;
	const clips = new Map<string, Promise<AudioBuffer>>();
	const out = () => {
		ac ??= make();
		if (!gain) (gain = ac.createGain()).connect(ac.destination), (gain.gain.value = level);
		return { c: ac, g: gain };
	};
	return {
		volume: (v) => void ((level = (v / 100) ** 2), gain && (gain.gain.value = level)),
		unlock: () => out().c.resume().then(() => true, () => false),
		out,
		running: () => ac?.state === "running",
		play(url) {
			const { c, g } = out();
			if (!clips.has(url)) clips.set(url, bytes(url).then((b) => c.decodeAudioData(b)));
			void Promise.all([c.resume(), clips.get(url)!]).then(([, clip]) => {
				const s = c.createBufferSource();
				s.buffer = clip;
				s.connect(g);
				s.start();
			}).catch(() => clips.delete(url));
		},
	};
}
/** The page's own. */
export const audio = createAudio();
