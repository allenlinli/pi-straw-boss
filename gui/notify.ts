import { m } from "./paraglide/messages.js";
import type { Alert } from "./alerts.ts";
import { prefs } from "./prefs.ts";
import doneUrl from "./sounds/done.mp3";
import errorUrl from "./sounds/error.mp3";
import waitingUrl from "./sounds/waiting.mp3";

// Reminders and sounds for the alerts a snapshot raises: a unit waiting on an answer, one that finished, one that failed.
// Each has a switch on the settings page (This device), kept per browser: reminders on, sounds off, so a page that opens makes no noise. The switch is a button that says its
// state in a word (On, Off), and under Sound sit a volume (0 to 100, default 60) and a try; the sounds play through Web Audio, whose gain an
// iPhone honours (it ignores an audio element's volume).
// A reminder is a system notification while the page is hidden or unfocused (the alert queue shows it on a focused page);
// clicking it brings the page forward on that unit. Only a question is urgent: a failure or a finish shows a silent system notification, and with Sound on plays its
// own softer clip (the error clip) beside the question's. A batch plays one sound, the most urgent of its marks.

type Kind = "waiting" | "error" | "done";
const SOUNDS: Record<Kind, string> = { waiting: waitingUrl, error: errorUrl, done: doneUrl };
const kindOf = (a: Alert): Kind | undefined => (a.mark === "waiting" || a.pending ? "waiting" : a.mark === "error" ? "error" : a.mark === "done" ? "done" : undefined);

export interface Notifier { signal(fresh: Alert[]): void; /** Zen: the system notification for the one item that took the screen while the page is hidden or unfocused (no clip, nothing for the items behind it). */ remind(a: Alert): void; /** The finished-unit clip, when Sound is on: a new unit that is ready (deploy.ts). */ chime(): void; /** The Sound switch and Volume as the settings page has them (the Zen menu drives the same). */ sound: { on(): boolean; volume(): number; set(on: boolean): void; setVolume(v: number): void; try(): void } }

/** Mounts the settings page's reminder switch (`#remind`) and sound switch with its volume (`#sound`, `#sound-vol`) and returns what plays a snapshot's new alerts. */
export function mountNotify(open: (a: Alert) => void): Notifier {
	const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
	const remindBtn = $<HTMLButtonElement>("remind"), soundBtn = $<HTMLButtonElement>("sound");
	const vol = $<HTMLInputElement>("sound-vol"), volOut = $<HTMLOutputElement>("sound-vol-out");
	const can = typeof Notification !== "undefined";
	let remind = prefs.get("remind"), sound = prefs.get("sound"), volume = prefs.get("volume");
	let ac: AudioContext | undefined, gain: GainNode | undefined;
	const clips = new Map<Kind, Promise<AudioBuffer>>();
	const draw = () => {
		const perm = can ? Notification.permission : "denied";
		remindBtn.setAttribute("aria-pressed", String(remind));
		// On but not yet allowed: the next press asks the browser; refused: the browser's settings decide.
		remindBtn.dataset.state = !remind ? "off" : perm === "granted" ? "on" : perm === "denied" ? "blocked" : "ask";
		remindBtn.title = !can ? m.remind_unsupported() : !remind ? m.remind_off() : perm === "granted" ? m.remind_on() : perm === "denied" ? m.remind_blocked() : m.remind_ask();
		$("remind-note").textContent = remindBtn.title; // a phone has no hover: the page says what the state means
		soundBtn.dataset.state = sound ? "on" : "off";
		// The state in a word (the button's text; the Standard view adds a dot, the Geek view brackets), never by colour alone.
		remindBtn.textContent = { off: m.state_off, on: m.state_on, blocked: m.state_blocked, ask: m.state_ask }[remindBtn.dataset.state as "off"]();
		soundBtn.textContent = sound ? m.state_on() : m.state_off();
		soundBtn.setAttribute("aria-pressed", String(sound));
		vol.value = volOut.value = String(volume);
		if (gain) gain.gain.value = (volume / 100) ** 2; // loudness follows the square of the gain more closely than the gain
	};
	remindBtn.onclick = async () => {
		if (remind && can && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
		else prefs.set("remind", (remind = !remind));
		draw();
	};
	// Each press here lets the page play, and says what a finished unit sounds like.
	const setSound = (on: boolean) => {
		prefs.set("sound", (sound = on));
		draw();
		if (sound) play("done");
	};
	const setVolume = (v: number) => (prefs.set("volume", (volume = v)), draw());
	prefs.on("sound", () => ((sound = prefs.get("sound")), draw())); // another tab's switch applies here
	prefs.on("volume", () => ((volume = prefs.get("volume")), draw()));
	soundBtn.onclick = () => setSound(!sound);
	vol.oninput = () => setVolume(Number(vol.value));
	vol.onchange = () => play("done");
	$("sound-try").onclick = () => play("done");
	function play(kind: Kind) {
		ac ??= new AudioContext();
		if (!gain) (gain = ac.createGain()).connect(ac.destination), draw();
		const c = ac, out = gain;
		if (!clips.has(kind)) clips.set(kind, fetch(SOUNDS[kind]).then((r) => r.arrayBuffer()).then((bytes) => c.decodeAudioData(bytes)));
		// A browser that blocks sound before any press keeps the context suspended, and the sound stays silent.
		void Promise.all([c.resume(), clips.get(kind)!]).then(([, clip]) => {
			const source = c.createBufferSource();
			source.buffer = clip;
			source.connect(out);
			source.start();
		}).catch(() => clips.delete(kind));
	}
	/** The system notification of an alert, while the page is hidden or unfocused and Remind is on and allowed. */
	function notice(a: Alert, k: Kind) {
		if (!remind || !can || Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) return;
		const n = new Notification(a.name, { body: a.trust ? m.trust_reminder() : { waiting: m.notify_waiting, error: m.notify_error, done: m.notify_done }[k]({ note: a.note ?? "" }).trim(), tag: a.key, icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href, silent: k !== "waiting" }); // only a question may make the system beep: a failure or a finish is a quiet notice
		n.onclick = () => (window.focus(), n.close(), open(a));
	}
	draw();
	return {
		remind: (a) => notice(a, "waiting"),
		sound: { on: () => sound, volume: () => volume, set: setSound, setVolume, try: () => play("done") },
		chime: () => sound && play("done"),
		signal(fresh) {
			const due = fresh.flatMap((a) => ((k) => (k ? [{ a, k }] : []))(kindOf(a)));
			if (!due.length) return;
			if (sound) play((["waiting", "error", "done"] as const).find((k) => due.some((d) => d.k === k))!);
			for (const { a, k } of due) notice(a, k);
		},
	};
}
