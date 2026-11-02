import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { El, page, stored } from "./zen-dom.ts";

// gui/notify.ts on the fake document: the Sound switch and Volume follow another tab's write (the `storage` event), and the first read of the three switches comes from the store.
// The sound clips are .mp3 imports the bundler turns into URLs; here a hook gives each one a string.
register("data:text/javascript," + encodeURIComponent(`export const load = (url, ctx, next) => url.endsWith(".mp3") ? { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true } : next(url, ctx);`));
const heard: ((e: { key: string | null }) => void)[] = [];
Object.assign(globalThis, { addEventListener: (type: string, on: (e: { key: string | null }) => void) => type === "storage" && heard.push(on) });
const { KEYS } = await import("../gui/prefs.ts");
const { mountNotify } = await import("../gui/notify.ts");

const ids = ["remind", "remind-note", "sound", "sound-vol", "sound-vol-out", "sound-try"];
function rig(seed: Record<string, string> = {}) {
	stored.clear();
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
