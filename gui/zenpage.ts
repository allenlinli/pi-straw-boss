import type { Net } from "../src/net.ts";
import { audio } from "./audio.ts";
import { prefs } from "./prefs.ts";
import { activityOf, companionsOf } from "./zenunits.ts";
import type { mountZen } from "./zen.ts";
import { createZenSound } from "./zensound.ts";

// What the page hands the Zen layer besides its own parts, built inside the Zen chunk so the page's entry carries none of it: the effects on the page's one audio core,
// the music (tracks, player, switch), and the companion and strip readers over the newest snapshot.
type Deps = Parameters<typeof mountZen>[1];
export interface ZenPageIo {
	/** The Sound switch of the settings page. */
	sound: { on(): boolean };
	/** The page's JSON read of its own server (`api/<path>`). */
	api(path: string): Promise<unknown>;
	/** The newest snapshot, if any. */
	snapshot(): Net | undefined;
}
export function zenPage(io: ZenPageIo): Pick<Deps, "sound" | "music" | "companions" | "activity"> & { menuSound: { try(): void; effects(): void } } {
	let player: { file(): string | undefined } | undefined;
	const zs = createZenSound(audio, io.sound, () => (player?.file() ? zs.bus() : undefined)); // an effect ducks the music while it plays; Zen's effects play on the page's one audio core, behind the Sound switch
	return {
		sound: zs.play,
		menuSound: { try: zs.try, effects: zs.tryAll },
		music: {
			tracks: async () => ((await io.api("music")) as { tracks: { file: string; size: number }[] }).tracks,
			player: async (report) => {
				const { createPlayer } = await import("./zenmusic.ts"); // the player is a chunk of its own, loaded once the music is on
				const { musicBus } = await import("./audiobus.ts");
				return (player = createPlayer({ audio, bus: () => musicBus(audio, zs.bus()), make: () => document.createElement("audio"), url: (file) => `api/music/${encodeURIComponent(file)}`, later: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }, report }));
			},
			unlock: () => audio.unlock(),
			running: () => audio.running(),
			prefs: { on: () => prefs.get("zenMusic"), setOn: (on) => void prefs.set("zenMusic", on), track: () => prefs.get("zenTrack"), setTrack: (file) => void prefs.set("zenTrack", file) },
			coarse: () => matchMedia("(pointer: coarse)").matches,
		},
		companions: () => companionsOf(io.snapshot()),
		activity: () => activityOf(io.snapshot()),
	};
}
