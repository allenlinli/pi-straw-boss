import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Player } from "./zenmusic.ts";

// Zen's music controls (docs/specs/2026-11-01-zen-view.md, Music), in the Zen chunk: the corner's ♪ switch and the ⌄ list of tracks. The tracks are the audio files of the server's music folder; with none, both stay hidden.
// The player itself (zenmusic.ts) is a chunk of its own, fetched only once the music is on (or is stored on and the page shows Zen), and the audio only when it plays. Playing starts from a gesture: ♪, or, for a switch
// stored on from before, the first press or key anywhere on the page. A phone's hidden page pauses the music; leaving Zen stops it.

export interface Track { file: string; size: number }
export interface MusicDeps {
	/** The server's music folder (GET api/music); a refusal reads as none. */
	tracks(): Promise<Track[]>;
	/** The player, built on the first call (its chunk loads then); `report` is how it says the browser refused or the file failed. */
	player(report: (why: "blocked" | "failed") => void): Promise<Player>;
	/** Resumes the page's audio context from a gesture; false when the browser refused. */
	unlock(): Promise<boolean>;
	/** The page's audio context is running (a hidden phone page may have left it suspended or interrupted). */
	running(): boolean;
	prefs: { on(): boolean; setOn(on: boolean): void; track(): string | null; setTrack(file: string): void };
	/** A touch screen: a hidden page pauses the music (O6). */
	coarse(): boolean;
}
type Status = "off" | "playing" | "tap";
/** A track's name for the list: the file name without its extension. */
export const titleOf = (file: string) => file.replace(/\.[^./\\]+$/, "");

export function mountMusic(deps: MusicDeps) {
	const note = h("button", { type: "button", class: "zen-music-btn", "aria-pressed": "false" }, "♪");
	const more = h("button", { type: "button", class: "zen-musicmore", "aria-haspopup": "true", "aria-expanded": "false", "aria-label": m.zen_tracks(), title: m.zen_tracks() }, "⌄");
	const panel = h("div", { class: "zen-musicpanel", role: "radiogroup", "aria-label": m.zen_tracks(), hidden: "" });
	const host = h("div", { class: "zen-musichost", hidden: "" }, note, more, panel);
	let list: Track[] = [], on = deps.prefs.on(), status: Status = "off", shown = false, open = false, armed = false, heard = false, held = false, player: Promise<Player> | undefined, ready: Player | undefined, run = 0, turn = 0;
	let items: HTMLElement[] = [];
	const radios = () => items;
	const chosen = () => ((t) => list.find((x) => x.file === t)?.file ?? list[0]?.file)(deps.prefs.track());
	const draw = () => {
		const words = !on ? m.zen_music_off() : status === "playing" ? m.zen_music_on() : m.zen_music_tap();
		host.hidden = !list.length;
		more.hidden = list.length < 2;
		note.setAttribute("aria-pressed", String(on));
		note.setAttribute("aria-label", words);
		note.title = words;
		note.dataset.state = !on ? "off" : status;
		const at = chosen();
		radios().forEach((r) => r.setAttribute("aria-checked", String(r.dataset.file === at)));
	};
	const built = () => (player ??= deps.player((why) => why && settle("tap")).then((p) => (ready = p)));
	/** The browser would not play (or the file failed): the switch stays on and says to tap. */
	function settle(next: Status) {
		status = next;
		if (shown) draw();
	}
	/** Starts the chosen track. Called from a gesture: the context is resumed first, in the gesture's own turn. */
	async function begin() {
		const mine = ++run, file = chosen();
		if (!file || !shown) return;
		status = "playing";
		draw();
		const un = deps.unlock(), first = ready ? ready.start(file) : undefined; // already built: play() runs in the gesture's own turn (iOS), before any await
		const p = first ? ready : await built().catch(() => undefined);
		if (!p) return mine === run ? settle("tap") : undefined;
		const ok = (await un) && (await (first ?? p.start(file)));
		if (mine !== run) return;
		if (ok) heard = true;
		else if (!(await un)) p.stop(); // the context stayed shut: nothing is fetched or left playing under "tap to play"
		settle(ok ? "playing" : "tap");
	}
	function stop() {
		run++;
		held = false;
		ready?.stop();
	}
	/** The switch: on starts the chosen track (from a gesture), off stops it. */
	function setOn(next: boolean) {
		if (!list.length) return;
		on = next;
		deps.prefs.setOn(on);
		if (on) return void begin();
		stop();
		settle("off");
	}
	note.onclick = () => (on && status === "tap" ? void begin() : setOn(!on));
	// The pick list: a native-feeling popover as the corner menu's (a press opens it, Esc, a press outside, and a choice close it).
	const close = () => {
		if (!open) return false;
		const inside = host.contains(document.activeElement as Node | null);
		[open, panel.hidden] = [false, true];
		more.setAttribute("aria-expanded", "false");
		if (inside) more.focus();
		return true;
	};
	more.onclick = () => {
		if (open) return void close();
		[open, panel.hidden] = [true, false];
		more.setAttribute("aria-expanded", "true");
		draw();
		(radios().find((r) => r.getAttribute("aria-checked") === "true") ?? radios()[0])?.focus();
	};
	host.addEventListener("keydown", (k) => {
		if (!open) return;
		if (k.key === "Escape") return void (k.preventDefault(), k.stopPropagation?.(), close());
		const at = radios().indexOf(document.activeElement as HTMLElement), n = radios().length;
		if (k.key === "Tab" || k.key === "ArrowDown" || k.key === "ArrowUp") {
			const back = k.key === "ArrowUp" || (k.key === "Tab" && k.shiftKey), to = back ? (at <= 0 ? n - 1 : at - 1) : at < 0 || at === n - 1 ? 0 : at + 1;
			k.preventDefault();
			radios()[to]?.focus();
		}
	});
	document.addEventListener("pointerdown", (e) => open && !host.contains(e.target as Node | null) && close());
	/** The first press or key anywhere (outside the controls, which act for themselves) starts a switch that was stored on. Press-up and key-down both count as the browser's user activation, an iPhone's included. */
	const gesture = (e: { target: unknown }) => {
		if (!armed || !shown || host.contains(e.target as Node | null)) return;
		armed = false;
		void begin();
	};
	for (const type of ["pointerup", "keydown"]) document.addEventListener(type, gesture, { capture: true } as AddEventListenerOptions);
	function fill() {
		items.forEach((r) => r.remove());
		panel.append(...(items = list.map((t) => {
			const r = h("button", { type: "button", role: "radio", class: "zen-opt", "aria-checked": "false", "data-file": t.file }, titleOf(t.file));
			r.dataset.file = t.file;
			r.onclick = () => {
				deps.prefs.setTrack(t.file);
				draw();
				close();
				if (on && status === "playing") void built().then((p) => p.start(t.file)).then((ok) => ok || settle("tap"), () => settle("tap")); // a new track takes over with the same cross-fade
			};
			return r;
		})));
	}
	return {
		el: host,
		button: note,
		isOpen: () => open,
		close,
		/** The palette's switch (a keypress is a gesture). */
		switch: { on: () => on, set: setOn },
		/** Zen shows (first, or again): the folder is read, and a switch stored on gets ready to play. */
		show() {
			shown = true;
			const mine = ++turn;
			void deps.tracks().catch(() => [] as Track[]).then((found) => {
				if (mine !== turn) return;
				list = found;
				fill();
				on = deps.prefs.on();
				if (!list.length) return draw();
				if (!on) return settle("off");
				void built().catch(() => {}); // the chunk only, so the first gesture can play at once
				status = "tap";
				draw();
				if (heard) void begin(); // the context is already unlocked: coming back to Zen resumes
				else armed = true;
			});
		},
		/** Zen is left: the music stops, and the switch keeps its place. */
		hide() {
			shown = false;
			armed = false;
			turn++;
			close();
			stop();
			status = "off";
		},
		/** The page was hidden or shown: on a touch screen the music pauses and resumes (O6); a desktop plays on. */
		visible(page: boolean) {
			if (!shown || !deps.coarse() || !ready) return;
			if (!page && status === "playing") (held = true), ready.pause();
			else if (page && held) {
				held = false;
				void ready.resume().then((ok) => {
					if (ok && deps.running()) return;
					(armed = true), settle("tap"); // a suspended context stays silent: the next gesture starts it again
				}, () => ((armed = true), settle("tap")));
			}
		},
	};
}
