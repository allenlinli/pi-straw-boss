// The page's one playback core: every view's sounds (the Standard chime and clips, Zen's later sounds and music) play through one AudioContext and one master gain.
// The context is made at the first play or unlock and resumed at each (a browser that blocks sound before any press keeps it suspended); the gain follows the square of Volume (0 to 100), which an iPhone honours.
type Ctx = Pick<AudioContext, "createGain" | "createBufferSource" | "decodeAudioData" | "resume" | "destination">;
export interface Audio { play(url: string): void; volume(v: number): void; /** Called from a user gesture: makes and resumes the context so a later play is heard. */ unlock(): void }

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
		unlock: () => void out().c.resume().catch(() => {}),
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
