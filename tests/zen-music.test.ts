import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page, stored } from "./fake-dom.ts";

// Zen's music (docs/specs/2026-11-01-zen-view.md, Music): the player (gui/zenmusic.ts) on a fake audio context and fake <audio> elements, and the controls (gui/zenmusicbar.ts) on the fake document with a fake player.
// Nothing here plays a sound or fetches a byte; the clock is the test's own.
const { createAudio } = await import("../gui/audio.ts");
const { musicBus } = await import("../gui/audiobus.ts");
const { createPlayer, FADE_S } = await import("../gui/zenmusic.ts");
const { mountMusic, titleOf } = await import("../gui/zenmusicbar.ts");
const { createPrefs, KEYS } = await import("../gui/prefs.ts");
const flush = () => new Promise<void>((done) => setImmediate(done));

/** A clock the test moves: `later` queues, `advance` runs what falls due. */
function clock() {
	let t = 0;
	const q: { at: number; fn: () => void }[] = [];
	return {
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			q.push(e);
			return () => void (q.includes(e) && q.splice(q.indexOf(e), 1));
		},
		advance(ms: number) {
			t += ms;
			for (let due = q.find((e) => e.at <= t); due; due = q.find((e) => e.at <= t)) {
				q.splice(q.indexOf(due), 1);
				due.fn();
			}
		},
		pending: () => q.length,
	};
}

// ---- the player ----
class Param {
	value = -1;
	calls: unknown[][] = [];
	cancelScheduledValues(t: number) { this.calls.push(["cancel", t]); }
	setValueAtTime(v: number, t: number) { this.calls.push(["at", v, t]); }
	setValueCurveAtTime(c: Float32Array, t: number, d: number) { this.calls.push(["curve", c, t, d]); }
}
class Node {
	gain = new Param();
	to: unknown;
	connect(t: unknown) { this.to = t; return t; }
}
class Media {
	src = "";
	currentTime = 0;
	duration = NaN;
	preload = "";
	paused = true;
	plays = 0;
	loads = 0;
	fail: { name: string } | undefined;
	on: Record<string, (() => void)[]> = {};
	play() { this.plays++; if (this.fail) return Promise.reject(this.fail); this.paused = false; return Promise.resolve(); }
	pause() { this.paused = true; }
	load() { this.loads++; }
	removeAttribute(name: string) { if (name === "src") this.src = ""; }
	addEventListener(type: string, fn: () => void) { (this.on[type] ??= []).push(fn); }
	fire(type: string) { (this.on[type] ?? []).forEach((f) => f()); }
}
function playerRig() {
	const c = clock(), els: Media[] = [], sources: { el: unknown; to: unknown; connect(t: unknown): unknown }[] = [], gains: Node[] = [], reports: string[] = [];
	const ctx = {
		destination: {}, state: "running", currentTime: 10,
		createGain: () => { const n = new Node(); gains.push(n); return n; },
		createMediaElementSource: (el: unknown) => { const s = { el, to: undefined as unknown, connect(t: unknown) { s.to = t; return t; } }; sources.push(s); return s; },
		resume: async () => {},
	};
	const audio = createAudio(() => ctx as never);
	const player = createPlayer({ audio, bus: () => musicBus(audio), make: () => { const e = new Media(); els.push(e); return e; }, url: (f) => `/m/${f}`, later: c.later, report: (why) => reports.push(why) });
	// gains[0] is the master, gains[1] the bus; each slot adds its own after that
	return { c, els, sources, gains, reports, player, ctx, audio, slotGain: (i: number) => sources[i]!.to as Node };
}
const curveOf = (g: Node) => g.gain.calls.find((x) => x[0] === "curve") as [string, Float32Array, number, number] | undefined;

test("nothing is made or fetched until a track starts; a start puts it on one element, through its own gain, into the music bus", async () => {
	const r = playerRig();
	assert.deepEqual([r.els.length, r.gains.length], [0, 0], "no element, no context node");
	assert.equal(await r.player.start("rain.mp3"), true);
	assert.equal(r.els.length, 1);
	const el = r.els[0]!;
	assert.deepEqual([el.src, el.preload, el.plays, el.paused], ["/m/rain.mp3", "none", 1, false]);
	assert.equal(r.sources[0]!.el, el);
	assert.equal(r.sources[0]!.to, r.slotGain(0), "the element reaches its gain");
	assert.equal(r.slotGain(0).to, musicBus(r.audio), "and the gain the music bus, which is under the master (an iPhone ignores an element's volume)");
	assert.equal(r.slotGain(0).gain.value, 1);
	assert.equal(r.player.file(), "rain.mp3");
	assert.equal(await r.player.start("rain.mp3"), true, "the same track again changes nothing");
	assert.deepEqual([r.els.length, el.plays], [1, 1]);
});

test("6 s before the end the other element starts the same track from 0 and the two cross-fade on equal-power curves; the old one is let go after the fade, and the loop goes on", async () => {
	const r = playerRig();
	await r.player.start("rain.mp3");
	const a = r.els[0]!;
	a.duration = 100;
	a.currentTime = 93.9;
	a.fire("timeupdate");
	assert.equal(r.els.length, 1, "more than 6 s left: nothing yet");
	a.currentTime = 94;
	a.fire("timeupdate");
	assert.equal(r.els.length, 2);
	const b = r.els[1]!;
	assert.deepEqual([b.src, b.plays, b.preload], ["/m/rain.mp3", 1, "none"]);
	const [inGain, outGain] = [r.slotGain(1), r.slotGain(0)], inCurve = curveOf(inGain)!, outCurve = curveOf(outGain)!;
	assert.deepEqual([inCurve[2], inCurve[3], outCurve[2], outCurve[3]], [10, FADE_S, 10, FADE_S], "both over 6 s from now on the context's clock");
	assert.deepEqual(inGain.gain.calls.find((x) => x[0] === "at"), ["at", 0, 10], "the new one starts silent");
	assert.ok(Math.abs(inCurve[1][0]!) < 1e-6 && Math.abs(inCurve[1].at(-1)! - 1) < 1e-6 && Math.abs(outCurve[1][0]! - 1) < 1e-6 && Math.abs(outCurve[1].at(-1)!) < 1e-6);
	for (let i = 0; i < inCurve[1].length; i++) assert.ok(Math.abs(inCurve[1][i]! ** 2 + outCurve[1][i]! ** 2 - 1) < 1e-5, `equal power at ${i}`);
	assert.equal(r.c.pending(), 1);
	a.fire("timeupdate"); // the old element's own updates start nothing more
	assert.equal(r.els.length, 2);
	r.c.advance(FADE_S * 1000 - 1);
	assert.equal(a.paused, false, "still fading out");
	r.c.advance(1);
	assert.deepEqual([a.paused, a.src, a.loads, outGain.gain.value, inGain.gain.value], [true, "", 1, 0, 1], "the old element is paused and emptied, the new one stands at full level");
	assert.equal(r.player.file(), "rain.mp3");
	// the next loop goes back to the first element
	b.duration = 100;
	b.currentTime = 94;
	b.fire("timeupdate");
	assert.deepEqual([r.els.length, a.src, a.plays], [2, "/m/rain.mp3", 2]);
});

test("a short track fades over half its length; one that ends before it could fade starts again", async () => {
	const r = playerRig();
	await r.player.start("bell.mp3");
	const a = r.els[0]!;
	a.duration = 8;
	a.currentTime = 3.9;
	a.fire("timeupdate");
	assert.equal(r.els.length, 1, "8 s long: the fade is 4 s");
	a.currentTime = 4;
	a.fire("timeupdate");
	assert.equal(curveOf(r.slotGain(1))![3], 4);
	const lone = playerRig();
	await lone.player.start("x.mp3");
	const e = lone.els[0]!;
	e.currentTime = 50;
	e.fire("ended");
	assert.deepEqual([e.currentTime, e.plays, lone.els.length], [0, 2, 1], "an end with no fade begun plays the track again");
});

test("a new track takes over with the same cross-fade; one picked mid-fade ends that fade first", async () => {
	const r = playerRig();
	await r.player.start("rain.mp3");
	assert.equal(await r.player.start("sea.mp3"), true);
	const [a, b] = r.els as [Media, Media];
	assert.deepEqual([b.src, b.plays, a.paused, r.player.file()], ["/m/sea.mp3", 1, false, "sea.mp3"]);
	assert.equal(curveOf(r.slotGain(1))![3], FADE_S);
	r.c.advance(2000);
	await r.player.start("fire.mp3"); // mid-fade
	assert.equal(r.c.pending(), 1, "the first fade was settled at once, its timer with it; the new fade has its own");
	assert.deepEqual([b.paused, b.src], [false, "/m/sea.mp3"], "the element that was fading in stands at full level and now fades out");
	assert.deepEqual([a.src, a.plays, a.paused], ["/m/fire.mp3", 2, false], "the first element, let go by the settle, carries the newest track");
	r.c.advance(FADE_S * 1000);
	assert.deepEqual([b.paused, b.src, r.slotGain(0).gain.value, r.slotGain(1).gain.value], [true, "", 1, 0]);
});

test("stop lets everything go; pause keeps the place and resume plays on", async () => {
	const r = playerRig();
	await r.player.start("rain.mp3");
	const a = r.els[0]!;
	a.currentTime = 33;
	r.player.pause();
	assert.deepEqual([a.paused, a.currentTime, a.src, r.player.file()], [true, 33, "/m/rain.mp3", "rain.mp3"], "a paused element keeps its place");
	assert.equal(await r.player.resume(), true);
	assert.deepEqual([a.paused, a.plays], [false, 2]);
	r.player.stop();
	assert.deepEqual([a.paused, a.src, r.player.file()], [true, "", undefined]);
	assert.equal(await r.player.resume(), false, "nothing to resume after a stop");
	await r.player.start("sea.mp3");
	assert.deepEqual([r.els.length, a.src], [1, "/m/sea.mp3"], "the same element plays the next start (an element joins the context once)");
	assert.equal(r.sources.length, 1);
});

test("a play the browser refuses says it wants a tap; a file that fails says it failed; an interrupted one says nothing", async () => {
	const r = playerRig();
	const first = r.els.length;
	assert.equal(first, 0);
	await r.player.start("rain.mp3");
	r.player.stop();
	r.els[0]!.fail = { name: "NotAllowedError" };
	assert.equal(await r.player.start("rain.mp3"), false);
	assert.deepEqual(r.reports, ["blocked"]);
	r.els[0]!.fail = { name: "NotSupportedError" };
	assert.equal(await r.player.start("rain.mp3"), false);
	r.els[0]!.fail = { name: "AbortError" };
	assert.equal(await r.player.start("rain.mp3"), false);
	assert.deepEqual(r.reports, ["blocked", "failed"], "AbortError (a pause or a new load took the play over) is not a failure");
	r.els[0]!.fail = undefined;
	r.els[0]!.fire("error");
	assert.deepEqual(r.reports, ["blocked", "failed", "failed"], "the element's own error event");
});

// ---- the controls ----
function barRig(o: { files?: string[]; on?: boolean; track?: string; coarse?: boolean; unlock?: boolean; startOk?: boolean; tracks?: () => Promise<{ file: string; size: number }[]> } = {}) {
	for (const k of Object.keys(page.on)) delete page.on[k];
	const st = new Map<string, string>();
	const store = Object.assign(st, { getItem: (k: string) => st.get(k) ?? null, setItem: (k: string, v: string) => void st.set(k, v) });
	const prefs = createPrefs(store);
	if (o.on !== undefined) prefs.set("zenMusic", o.on);
	if (o.track) prefs.set("zenTrack", o.track);
	const files = o.files ?? ["a-rain.mp3", "b-sea.ogg", "c-fire.wav"];
	const log = { fetched: 0, built: 0, unlocked: 0, started: [] as string[], stops: 0, pauses: 0, resumes: 0, report: undefined as undefined | ((why: "blocked" | "failed") => void) };
	let startOk = o.startOk ?? true, unlock = o.unlock ?? true, resumeOk = true, running = true, playing: string | undefined;
	const player = {
		start: async (f: string) => (log.started.push(f), startOk && (playing = f, true)),
		stop: () => (log.stops++, (playing = undefined)),
		pause: () => void log.pauses++,
		resume: async () => (log.resumes++, resumeOk),
		file: () => playing,
	};
	const bar = mountMusic({
		tracks: o.tracks ?? (async () => (log.fetched++, files.map((file) => ({ file, size: 10 })))),
		player: async (report) => (log.built++, (log.report = report), player),
		unlock: async () => (log.unlocked++, unlock),
		running: () => running,
		prefs: { on: () => prefs.get("zenMusic"), setOn: (v) => void prefs.set("zenMusic", v), track: () => prefs.get("zenTrack"), setTrack: (f) => void prefs.set("zenTrack", f) },
		coarse: () => o.coarse ?? false,
	});
	const host = bar.el as unknown as El, note = bar.button as unknown as El;
	page.body.replaceChildren(host);
	page.focused = undefined;
	const more = host.all((e) => e.getAttribute("aria-haspopup") === "true")[0]!, panel = host.all((e) => e.getAttribute("role") === "radiogroup")[0]!;
	const radios = () => panel.all((e) => e.getAttribute("role") === "radio");
	const gesture = (type: "pointerup" | "keydown", target: unknown = new El("div")) => (page.on[type] ?? []).forEach((f) => f({ target }));
	return {
		bar, host, note, more, panel, radios, log, st, prefs, gesture,
		label: () => note.getAttribute("aria-label"), pressed: () => note.getAttribute("aria-pressed"),
		set: (k: "startOk" | "unlock" | "resumeOk" | "running", v: boolean) => void (k === "startOk" ? (startOk = v) : k === "unlock" ? (unlock = v) : k === "running" ? (running = v) : (resumeOk = v)),
		shown: async () => (bar.show(), await flush()),
		key: (key: string, extra: object = {}) => (page.focused ?? host).bubble("keydown", { key, ...extra }),
	};
}

test("with no music folder the controls stay hidden, nothing is built, and no audio is touched", async () => {
	const r = barRig({ files: [] });
	await r.shown();
	assert.deepEqual([r.host.hidden, r.log.built, r.log.unlocked, r.log.started], [true, 0, 0, []]);
	const failing = barRig({ tracks: () => Promise.reject(new Error("401")) });
	await failing.shown();
	assert.equal(failing.host.hidden, true, "a refused list reads as none");
	assert.equal(failing.log.built, 0);
});

test("with the music off the chunk is not loaded and nothing plays: the list is read, the switch says off", async () => {
	const r = barRig();
	await r.shown();
	assert.deepEqual([r.host.hidden, r.log.fetched, r.log.built, r.log.unlocked, r.log.started], [false, 1, 0, 0, []]);
	assert.deepEqual([r.label(), r.pressed(), r.note.dataset.state], ["Music: off", "false", "off"]);
	assert.equal(r.more.hidden, false, "three tracks: the list opens");
	const one = barRig({ files: ["only.mp3"] });
	await one.shown();
	assert.deepEqual([one.host.hidden, one.more.hidden], [false, true], "one track needs no list");
});

test("a tap on the note turns the music on: the context is resumed in the gesture, the player is built, the chosen track plays, and the switch is kept", async () => {
	const r = barRig();
	await r.shown();
	r.note.click();
	await flush();
	assert.deepEqual([r.log.unlocked, r.log.built, r.log.started, r.label(), r.pressed()], [1, 1, ["a-rain.mp3"], "Music: on", "true"]);
	assert.equal(r.st.get(KEYS.zenMusic), "1");
	r.note.click();
	assert.deepEqual([r.label(), r.pressed(), r.log.stops, r.st.get(KEYS.zenMusic)], ["Music: off", "false", 1, "0"], "a second tap turns it off and stops the player");
	r.note.click();
	await flush();
	assert.deepEqual([r.log.built, r.log.started], [1, ["a-rain.mp3", "a-rain.mp3"]], "the player is built once");
});

test("the stored track is played; an unknown one is the first", async () => {
	const known = barRig({ track: "c-fire.wav" });
	await known.shown();
	known.note.click();
	await flush();
	assert.deepEqual(known.log.started, ["c-fire.wav"]);
	const gone = barRig({ track: "deleted.mp3" });
	await gone.shown();
	gone.note.click();
	await flush();
	assert.deepEqual(gone.log.started, ["a-rain.mp3"]);
	assert.deepEqual(gone.radios().map((x) => x.getAttribute("aria-checked")), ["true", "false", "false"]);
});

test("a switch stored on waits for the first gesture and says tap to play; the controls' own presses do not count, and the gesture counts once", async () => {
	const r = barRig({ on: true });
	await r.shown();
	assert.deepEqual([r.label(), r.pressed(), r.log.built, r.log.started], ["Music: tap to play", "true", 1, []], "the chunk is ready, nothing plays");
	r.gesture("pointerup", r.note);
	await flush();
	assert.deepEqual(r.log.started, [], "a press on the music controls is theirs");
	r.gesture("keydown");
	await flush();
	assert.deepEqual([r.log.started, r.label(), r.log.unlocked], [["a-rain.mp3"], "Music: on", 1]);
	r.gesture("pointerup");
	await flush();
	assert.equal(r.log.started.length, 1, "once");
	const tap = barRig({ on: true });
	await tap.shown();
	tap.note.click(); // the note itself plays it too
	await flush();
	assert.deepEqual([tap.log.started, tap.label()], [["a-rain.mp3"], "Music: on"]);
});

test("a context the browser will not resume, a play it refuses, and a file that fails each return the switch to tap to play", async () => {
	const stuck = barRig({ unlock: false });
	await stuck.shown();
	stuck.note.click();
	await flush();
	assert.deepEqual([stuck.label(), stuck.pressed(), stuck.log.started], ["Music: tap to play", "true", []]);
	stuck.set("unlock", true);
	stuck.note.click();
	await flush();
	assert.deepEqual([stuck.label(), stuck.log.started], ["Music: on", ["a-rain.mp3"]], "a tap in the tap state plays");
	const refused = barRig({ startOk: false });
	await refused.shown();
	refused.note.click();
	await flush();
	assert.equal(refused.label(), "Music: tap to play");
	const failed = barRig();
	await failed.shown();
	failed.note.click();
	await flush();
	failed.log.report!("blocked");
	assert.equal(failed.label(), "Music: tap to play", "the player says the browser stopped it");
	failed.note.click();
	await flush();
	assert.equal(failed.label(), "Music: on");
});

test("the list: a press opens it with the focus on the playing track; a pick stores the track, closes the list, and cross-fades only a playing music; Esc and a press outside close it", async () => {
	const r = barRig({ track: "b-sea.ogg" });
	await r.shown();
	assert.deepEqual([r.radios().map((x) => x.textContent), r.more.getAttribute("aria-expanded")], [["a-rain", "b-sea", "c-fire"], "false"], "named by file, without the extension");
	r.more.click();
	assert.deepEqual([r.bar.isOpen(), r.more.getAttribute("aria-expanded"), r.panel.hidden, page.focused], [true, "true", false, r.radios()[1]]);
	r.key("ArrowDown");
	assert.equal(page.focused, r.radios()[2]);
	r.key("ArrowDown");
	assert.equal(page.focused, r.radios()[0], "round");
	r.key("Tab", { shiftKey: true });
	assert.equal(page.focused, r.radios()[2]);
	r.key("Escape");
	assert.deepEqual([r.bar.isOpen(), page.focused], [false, r.more], "Esc closes it and the focus goes back to its button");
	r.more.click();
	(page.on.pointerdown ?? []).forEach((f) => f({ target: new El("div") }));
	assert.equal(r.bar.isOpen(), false, "a press outside closes it");
	r.more.click();
	(page.on.pointerdown ?? []).forEach((f) => f({ target: r.bar.el }));
	assert.equal(r.bar.isOpen(), false, "so does a press on the veil, the host's own (ZVL-F002)");
	r.more.click();
	r.radios()[2]!.click();
	assert.deepEqual([r.st.get(KEYS.zenTrack), r.bar.isOpen(), r.log.started, r.log.built], ["c-fire.wav", false, [], 0], "music off: the choice is stored, nothing plays or loads");
	assert.deepEqual(r.radios().map((x) => x.getAttribute("aria-checked")), ["false", "false", "true"]);
	r.note.click();
	await flush();
	assert.deepEqual(r.log.started, ["c-fire.wav"]);
	r.more.click();
	r.radios()[0]!.click();
	await flush();
	assert.deepEqual([r.log.started, r.st.get(KEYS.zenTrack), r.label()], [["c-fire.wav", "a-rain.mp3"], "a-rain.mp3", "Music: on"], "playing: the new track takes over");
});

test("on a touch screen a hidden page pauses the music and a shown one resumes it; on a desktop it plays on; a resume the browser refuses says tap to play", async () => {
	const touch = barRig({ coarse: true });
	await touch.shown();
	touch.bar.visible(false);
	assert.equal(touch.log.pauses, 0, "no player yet, nothing to pause");
	touch.note.click();
	await flush();
	touch.bar.visible(false);
	assert.equal(touch.log.pauses, 1);
	touch.bar.visible(true);
	await flush();
	assert.deepEqual([touch.log.resumes, touch.label()], [1, "Music: on"]);
	touch.bar.visible(true);
	assert.equal(touch.log.resumes, 1, "a page that was not paused is not resumed");
	touch.bar.visible(false);
	touch.set("resumeOk", false);
	touch.bar.visible(true);
	await flush();
	assert.equal(touch.label(), "Music: tap to play");
	const desk = barRig({ coarse: false });
	await desk.shown();
	desk.note.click();
	await flush();
	desk.bar.visible(false);
	desk.bar.visible(true);
	assert.deepEqual([desk.log.pauses, desk.log.resumes], [0, 0]);
	const off = barRig({ coarse: true });
	await off.shown();
	off.note.click();
	await flush();
	off.note.click();
	off.bar.visible(false);
	assert.equal(off.log.pauses, 0, "music that is off is not paused");
});

test("leaving Zen stops the music and keeps the switch; coming back resumes it at once when the page has played before, and waits for a gesture when it has not", async () => {
	const r = barRig();
	await r.shown();
	r.note.click();
	await flush();
	r.bar.hide();
	assert.deepEqual([r.log.stops, r.pressed(), r.st.get(KEYS.zenMusic)], [1, "true", "1"]);
	await r.shown();
	assert.deepEqual([r.log.started.length, r.label()], [2, "Music: on"], "unlocked before: no tap is asked");
	const fresh = barRig({ on: true });
	await fresh.shown();
	fresh.bar.hide();
	await fresh.shown();
	assert.deepEqual([fresh.log.started, fresh.label()], [[], "Music: tap to play"]);
	fresh.bar.hide();
	fresh.gesture("keydown");
	await flush();
	assert.deepEqual(fresh.log.started, [], "a gesture while away starts nothing");
	const open = barRig();
	await open.shown();
	open.more.click();
	open.bar.hide();
	assert.equal(open.bar.isOpen(), false, "the list closes with Zen");
});

test("a play that is still starting when the music is switched off does not turn it back on", async () => {
	const r = barRig();
	await r.shown();
	r.note.click();
	r.note.click(); // on, then off, before the player answered
	await flush();
	assert.deepEqual([r.label(), r.pressed(), r.st.get(KEYS.zenMusic)], ["Music: off", "false", "0"]);
});

test("the files' names lose their extension and the words come in both languages", async () => {
	assert.equal(titleOf("zen-rain.mp3"), "zen-rain");
	assert.equal(titleOf("a.b.c.flac"), "a.b.c");
	assert.equal(titleOf("noext"), "noext");
	const { m } = await import("../gui/paraglide/messages.js");
	const zh = { locale: "zh-TW" as const };
	assert.deepEqual([m.zen_music_on({}, zh), m.zen_music_off({}, zh), m.zen_music_tap({}, zh), m.zen_tracks({}, zh)], ["音樂：開", "音樂：關", "音樂：點一下播放", "音樂"]);
	assert.deepEqual([m.zen_music_on(), m.zen_music_off(), m.zen_music_tap(), m.zen_tracks()], ["Music: on", "Music: off", "Music: tap to play", "Music"]);
});

test("prefs keep the switch as 1 or 0 and the track as its file name", () => {
	const st = new Map<string, string>();
	const p = createPrefs({ getItem: (k) => st.get(k) ?? null, setItem: (k, v) => void st.set(k, v) });
	assert.deepEqual([p.get("zenMusic"), p.get("zenTrack"), KEYS.zenMusic, KEYS.zenTrack], [false, null, "sb.zen.music", "sb.zen.track"]);
	p.set("zenMusic", true);
	p.set("zenTrack", "zen-rain.mp3");
	assert.deepEqual([st.get("sb.zen.music"), st.get("sb.zen.track"), p.get("zenMusic"), p.get("zenTrack")], ["1", "zen-rain.mp3", true, "zen-rain.mp3"]);
	p.set("zenMusic", false);
	assert.equal(st.get("sb.zen.music"), "0");
	const refused = createPrefs({ getItem: () => { throw new Error("denied"); } });
	assert.deepEqual([refused.get("zenMusic"), refused.get("zenTrack")], [false, null], "a refused storage reads as the defaults");
	assert.ok(stored);
});

test("a shown phone page whose audio context stayed suspended says tap to play, and the next gesture plays again", async () => {
	const r = barRig({ coarse: true });
	await r.shown();
	r.note.click();
	await flush();
	r.bar.visible(false);
	r.set("running", false);
	r.bar.visible(true);
	await flush();
	assert.equal(r.label(), "Music: tap to play");
	r.set("running", true);
	const before = r.log.started.length;
	r.gesture("pointerup");
	await flush();
	assert.deepEqual([r.log.started.length, r.label()], [before + 1, "Music: on"]);
});

test("after a refused resume the same track plays again at the next start", async () => {
	const r = playerRig();
	await r.player.start("rain.mp3");
	r.player.pause();
	r.els[0]!.fail = { name: "NotAllowedError" };
	assert.equal(await r.player.resume(), false);
	r.els[0]!.fail = undefined;
	const plays = r.els[0]!.plays;
	assert.equal(await r.player.start("rain.mp3"), true);
	assert.deepEqual([r.els[0]!.plays, r.els[0]!.paused], [plays + 1, false], "the element plays, not just claims to");
	assert.equal(await r.player.start("rain.mp3"), true);
	assert.equal(r.els[0]!.plays, plays + 1, "a track that is playing is left alone");
});

test("a context the browser kept shut stops the player: nothing keeps playing under tap to play", async () => {
	const r = barRig({ on: true });
	await r.shown();
	r.set("unlock", false);
	const stops = r.log.stops;
	r.gesture("pointerup");
	await flush();
	assert.equal(r.label(), "Music: tap to play");
	assert.ok(r.log.stops > stops, "the player was stopped");
});
