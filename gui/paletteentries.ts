import { m } from "./paraglide/messages.js";
import type { Entry } from "./palette.ts";
import type { MenuDeps } from "./zenmenu.ts";

// What Zen puts in the palette: the page's actions it can do now, then the preferences the corner menu has (the same functions, so the two never disagree), and Music when a switch for it is given.
/** The page's actions; one left out is one the page cannot do now (no companion, nothing to step to). */
export interface Acts {
	standard(): void;
	settings?(): void;
	companion?: { name: string; session(): void; terminal(): void; /** Back to the breathing circle (Z-D16). */ rest(): void };
	cycle?: { prev(): void; next(): void };
	/** The head tower, on the circle screen: talk to it, read the whole conversation, or open its page in Standard. */
	head?: { talk(): void; history(): void; page(): void };
}
export interface Prefs extends MenuDeps { music?: { on(): boolean; set(on: boolean): void } }
const STEP = 10;

export function entriesOf(a: Acts, p: Prefs): Entry[] {
	const out: Entry[] = [], add = (id: string, label: string, run: () => void, o: Partial<Entry> = {}) => void out.push({ id, label, run, ...o });
	const here = (on: boolean) => (on ? { hint: m.pal_current() } : {});
	const onoff = (on: boolean) => (on ? m.state_on() : m.state_off());
	if (a.companion) (add("session", m.pal_session({ name: a.companion.name }), a.companion.session), add("terminal", m.pal_terminal({ name: a.companion.name }), a.companion.terminal), add("rest", m.zen_rest(), a.companion.rest));
	if (a.cycle) (add("prev", m.pal_prev(), a.cycle.prev), add("next", m.pal_next(), a.cycle.next));
	if (a.head) (add("head-talk", m.palette_head_talk(), a.head.talk), add("head-history", m.palette_head_history(), a.head.history), add("head-page", m.palette_head_page(), a.head.page));
	if (a.settings) add("settings", m.pal_settings(), a.settings);
	add("standard", m.pal_standard(), a.standard);
	const { view, language, sound, music } = p, pick = (what: string, choice: string) => m.pal_pick({ what, choice });
	if (view) {
		add("view:auto", pick(m.view_label(), view.auto()), () => view.set("auto"), here(view.choice() === "auto"));
		for (const c of ["standard", "geek", "zen"] as const) add(`view:${c}`, pick(m.view_label(), { standard: m.view_standard, geek: m.view_geek, zen: m.view_zen }[c]()), () => view.set(c), here(view.choice() === c));
	}
	if (language) for (const l of language.names()) add(`language:${l.id}`, pick(m.language(), l.name), () => language.set(l.id), here(language.get() === l.id));
	if (sound) {
		const volume = (by: number) => () => (sound.setVolume(Math.min(100, Math.max(0, sound.volume() + by))), sound.try());
		add("sound", m.sound(), () => sound.set(!sound.on()), { hint: onoff(sound.on()), keep: true });
		add("louder", m.pal_louder(), volume(STEP), { hint: String(sound.volume()), keep: true });
		add("quieter", m.pal_quieter(), volume(-STEP), { hint: String(sound.volume()), keep: true });
	}
	if (music) add("music", m.pal_music(), () => music.set(!music.on()), { hint: onoff(music.on()), keep: true });
	return out;
}
