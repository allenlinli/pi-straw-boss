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
	/** The settings page's two sound classes: the effects' switch (Zen's bowl and knock), and the Background switch with its changes (Zen's music plays only while it is on). */
	sound: { effects: { on(): boolean }; background: { on(): boolean; onChange(fn: () => void): void } };
	/** The page's JSON read of its own server (`api/<path>`). */
	api(path: string): Promise<unknown>;
	/** The newest snapshot, if any. */
	snapshot(): Net | undefined;
	/** The trains model's chunk (a test hands its own). */
	loadTrains?(): Promise<typeof import("./trains.ts")>;
}
export function zenPage(io: ZenPageIo): Pick<Deps, "sound" | "music" | "companions" | "activity" | "trains"> & { menuSound: { try(): void; all(): void } } {
	let zenTrains: typeof import("./trains.ts").zenTrains | undefined, loading = false;
	let player: { file(): string | undefined } | undefined;
	const zs = createZenSound(audio, io.sound.effects, () => (player?.file() ? zs.bus() : undefined)); // an effect ducks the music while it plays; Zen's effects play on the page's one audio core, behind the Sound effects switch
	return {
		sound: zs.play,
		menuSound: { try: zs.try, all: zs.tryAll },
		music: {
			tracks: async () => ((await io.api("music")) as { tracks: { file: string; size: number }[] }).tracks,
			player: async (report) => {
				const { createPlayer } = await import("./zenmusic.ts"); // the player is a chunk of its own, loaded once the music is on
				const { musicBus } = await import("./audiobus.ts");
				return (player = createPlayer({ audio, bus: () => musicBus(audio, zs.bus()), make: () => document.createElement("audio"), url: (file) => `api/music/${encodeURIComponent(file)}`, later: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }, report }));
			},
			background: io.sound.background,
			unlock: () => audio.unlock(),
			running: () => audio.running(),
			prefs: { on: () => prefs.get("zenMusic"), setOn: (on) => void prefs.set("zenMusic", on), track: () => prefs.get("zenTrack"), setTrack: (file) => void prefs.set("zenTrack", file) },
			coarse: () => matchMedia("(pointer: coarse)").matches,
		},
		companions: () => companionsOf(io.snapshot()),
		activity: () => activityOf(io.snapshot()),
		trains: () => {
			const net = io.snapshot();
			if (!net?.yards) return { count: 0, waiting: 0 }; // no yards, no trains model: a computer without trains carries none of its words (spec §26)
			if (!zenTrains && !loading) (loading = true, void (io.loadTrains?.() ?? import("./trains.ts")).then((t) => (zenTrains = t.zenTrains), () => undefined).finally(() => (loading = false))); // the strip says it from the next snapshot on
			return zenTrains?.(net) ?? { count: 0, waiting: 0 };
		},
	};
}
