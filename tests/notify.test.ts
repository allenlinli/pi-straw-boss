import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { El, page, stored } from "./fake-dom.ts";

// gui/notify.ts on the fake document: the Sound switch and Volume follow another tab's write (the `storage` event), and the first read of the three switches comes from the store.
// The sound clips are .mp3 imports the bundler turns into URLs; here a hook gives each one a string.
register("data:text/javascript," + encodeURIComponent(`export const load = (url, ctx, next) => url.endsWith(".mp3") ? { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true } : next(url, ctx);`));
const heard: ((e: { key: string | null }) => void)[] = [];
Object.assign(globalThis, { addEventListener: (type: string, on: (e: { key: string | null }) => void) => type === "storage" && heard.push(on) });
const { KEYS } = await import("../gui/prefs.ts");
const { mountNotify } = await import("../gui/notify.ts");
const { audio } = await import("../gui/audio.ts");
const { useSounds } = await import("../gui/themesounds.ts");
// The page's one playback core is replaced by recorders: what notify asks of it is what these tests read.
const played: string[] = [], volumes: number[] = [];
audio.play = (url) => void played.push(url);
audio.volume = (v) => void volumes.push(v);

const ids = ["remind", "remind-note", "sound", "sound-vol", "sound-vol-out", "sound-try"];
function rig(seed: Record<string, string> = {}) {
	stored.clear();
	played.length = volumes.length = 0;
	for (const [k, v] of Object.entries(seed)) stored.set(k, v);
	const els = Object.fromEntries(ids.map((id) => [id, new El(id === "sound-vol" ? "input" : id === "sound-vol-out" ? "output" : "button")]));
	Object.assign(page, { getElementById: (id: string) => els[id] });
	const n = mountNotify(() => {});
	// Another tab writes `key`: the store changes, then the event arrives (a tab's own write fires none in itself).
	const other = (key: string, value: string) => (stored.set(key, value), heard.forEach((f) => f({ key })));
	return { n, els, other };
}

test("the first read: Sound and Volume from the store, Remind on unless stored off", () => {
	const r = rig({ [KEYS.sound]: "1", [KEYS.volume]: "35", [KEYS.remind]: "0" });
	assert.equal(r.n.sound.on(), true);
	assert.equal(r.n.sound.volume(), 35);
	assert.equal(r.els.sound!.getAttribute("aria-pressed"), "true");
	assert.equal(r.els["sound-vol"]!.value, "35");
	assert.equal(r.els.remind!.getAttribute("aria-pressed"), "false");
	const d = rig();
	assert.equal(d.n.sound.on(), false);
	assert.equal(d.n.sound.volume(), 60);
	assert.equal(d.els.remind!.getAttribute("aria-pressed"), "true");
});

test("another tab's Sound switch applies here: the button and the answer follow, and nothing is written back", () => {
	const r = rig();
	let told = 0;
	r.n.sound.onChange(() => told++);
	const writes: string[] = [], set = localStorage.setItem;
	localStorage.setItem = (k, v) => (writes.push(k), set(k, v));
	r.other(KEYS.sound, "1");
	localStorage.setItem = set;
	assert.equal(r.n.sound.on(), true);
	assert.equal(r.els.sound!.getAttribute("aria-pressed"), "true");
	assert.equal(r.els.sound!.dataset.state, "on");
	assert.deepEqual(writes, [], "no echo");
	assert.equal(told, 1, "the Zen menu is told");
});

test("another tab's Volume applies here: the slider and the answer follow, and nothing is written back", () => {
	const r = rig();
	let told = 0;
	r.n.sound.onChange(() => told++);
	r.other(KEYS.volume, "25");
	assert.equal(r.n.sound.volume(), 25);
	assert.equal(r.els["sound-vol"]!.value, "25");
	assert.equal(r.els["sound-vol-out"]!.value, "25");
	assert.equal(stored.get(KEYS.volume), "25");
	assert.equal(told, 1);
	r.other(KEYS.view, "zen"); // another key: ignored
	assert.equal(told, 1);
});

const alert = (mark: string) => ({ key: mark, name: mark, mark }) as never;

test("Volume reaches the playback core at mount, on the slider, and from another tab", () => {
	const r = rig({ [KEYS.volume]: "35" });
	assert.equal(volumes.at(-1), 35, "the stored Volume at mount");
	r.n.sound.setVolume(80);
	assert.equal(volumes.at(-1), 80, "the slider");
	r.other(KEYS.volume, "25");
	assert.equal(volumes.at(-1), 25, "another tab");
	assert.deepEqual([...new Set(volumes)].sort(), [25, 35, 80]);
});

test("a batch plays the clip of its most urgent mark, only when Sound is on", () => {
	const off = rig();
	off.n.signal([alert("waiting")]);
	assert.deepEqual(played, [], "Sound off: silent");
	const r = rig({ [KEYS.sound]: "1" });
	r.n.signal([alert("done"), alert("waiting"), alert("error")]);
	assert.equal(played.length, 1);
	assert.match(played[0]!, /waiting\.mp3$/);
	r.n.signal([alert("done"), alert("error")]);
	assert.match(played[1]!, /error\.mp3$/);
	r.n.signal([alert("done")]);
	assert.match(played[2]!, /done\.mp3$/);
	assert.equal(played.length, 3);
	assert.notEqual(played[0], played[1]);
	assert.notEqual(played[1], played[2]);
});

test("chime plays the finished clip with Sound on and nothing with Sound off", () => {
	const off = rig();
	off.n.chime();
	assert.deepEqual(played, []);
	const r = rig({ [KEYS.sound]: "1" });
	r.n.chime();
	assert.equal(played.length, 1);
	assert.match(played[0]!, /done\.mp3$/);
	r.other(KEYS.sound, "0");
	r.n.chime();
	assert.equal(played.length, 1, "another tab's Off silences it");
});

test("Try and turning Sound on play the finished clip, whatever the switch said before", () => {
	const r = rig();
	r.n.sound.try();
	assert.match(played.at(-1)!, /done\.mp3$/);
	played.length = 0;
	r.n.sound.set(true);
	assert.equal(played.length, 1, "on: one clip to say so");
	r.n.sound.set(false);
	assert.equal(played.length, 1, "off: none");
});

test("a theme's sounds replace the base clips for each kind while it is the view, the settings' try and the chime included, and the base clips come back with Standard", () => {
	const r = rig({ [KEYS.sound]: "1" });
	useSounds({ waiting: "/themes/raven/ask-1.mp3", done: "/themes/raven/done-2.mp3", error: "/themes/raven/error-3.mp3" });
	try {
		r.n.signal([alert("waiting")]);
		r.n.signal([alert("error")]);
		r.n.signal([alert("done")]);
		r.n.chime();
		r.n.sound.try();
		assert.deepEqual(played, ["/themes/raven/ask-1.mp3", "/themes/raven/error-3.mp3", "/themes/raven/done-2.mp3", "/themes/raven/done-2.mp3", "/themes/raven/done-2.mp3"]);
	} finally {
		useSounds(undefined);
	}
	played.length = 0;
	r.n.chime();
	assert.match(played[0]!, /done\.mp3$/);
	assert.ok(!played[0]!.includes("themes/"), "Standard's own clip again");
});
