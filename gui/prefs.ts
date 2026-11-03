// The device's preferences: one typed store over localStorage for the keys the page keeps (view, language, Sound and Volume, Remind, Enlarge, Zen's last talk, Home Screen hint, music switch and track).
// A refused storage reads as the default (zenHint: as already told, so no hint) and a write it refuses is dropped; `on` hears another tab's write (the `storage` event) for one name.
type Store = { getItem?(key: string): string | null; setItem?(key: string, value: string): void };
type Raw = string | null | undefined; // a stored string; null: none; undefined: the storage refused
export const KEYS = { view: "sb.view", locale: "sb-locale", sound: "sb.sound", volume: "sb.volume", remind: "sb.remind", wide: "sb.dialog-wide", zenWith: "sb.zen.with", zenHint: "sb.zen.homehint", zenMusic: "sb.zen.music", zenTrack: "sb.zen.track" } as const;
export type Name = keyof typeof KEYS;
/** How each stored string reads. A value is written as its string, a boolean as 1 or 0 (Zen's hint, true: 1). */
const READ = {
	view: (v: Raw) => v ?? "auto", locale: (v: Raw) => v ?? null, sound: (v: Raw) => v === "1", volume: (v: Raw) => Math.min(100, Math.max(0, Number(v ?? "60") || 0)),
	remind: (v: Raw) => (v ?? "1") === "1", wide: (v: Raw) => v === "1", zenWith: (v: Raw) => v ?? null, zenHint: (v: Raw) => v !== null, zenMusic: (v: Raw) => v === "1", zenTrack: (v: Raw) => v ?? null,
};
type Value<N extends Name> = ReturnType<(typeof READ)[N]>;

export function createPrefs(store: Store) {
	const heard: [string, () => void][] = [];
	return {
		get<N extends Name>(name: N) {
			let raw: Raw;
			try {
				raw = store.getItem?.(KEYS[name]);
			} catch {} // storage refused: the default holds for this page
			return READ[name](raw) as Value<N>;
		},
		/** False when the storage refused: the value holds for this page only. */
		set<N extends Name>(name: N, value: Value<N>) {
			try {
				store.setItem!(KEYS[name], typeof value === "boolean" ? (value ? "1" : "0") : String(value));
				return true;
			} catch {
				return false;
			}
		},
		/** Another tab of this device wrote `name`. */
		on(name: Name, fn: () => void) {
			if (!heard.length) addEventListener("storage", (e) => heard.forEach(([key, f]) => e.key === key && f()));
			heard.push([KEYS[name], fn]);
		},
	};
}
/** The page's own: localStorage, looked up at each use (a page that refuses it throws there, which reads as refused). */
export const prefs = createPrefs({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) });
