// The device's sound preference: the settings page's Sound switch and Volume (notify.ts) and the Zen menu's rows read and write these two keys, so they never disagree.
export const SOUND_KEY = "sb.sound", VOLUME_KEY = "sb.volume";
type Store = Pick<Storage, "getItem" | "setItem">;
const safe = <T>(fn: () => T, fallback: T): T => {
	try {
		return fn();
	} catch {
		return fallback; // storage refused: the default holds for this page
	}
};
export const readSound = (store: Store = localStorage) => safe(() => store.getItem(SOUND_KEY), null) === "1";
export const readVolume = (store: Store = localStorage) => Math.min(100, Math.max(0, Number(safe(() => store.getItem(VOLUME_KEY), null) ?? "60") || 0));
export const writeSound = (on: boolean, store: Store = localStorage) => safe(() => store.setItem(SOUND_KEY, on ? "1" : "0"), undefined);
export const writeVolume = (volume: number, store: Store = localStorage) => safe(() => store.setItem(VOLUME_KEY, String(volume)), undefined);
