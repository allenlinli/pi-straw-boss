import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAudio } from "../gui/audio.ts";
import { BOWL, createZenSound, DUCK, GAP, KNOCK, LOW, schedule } from "../gui/zensound.ts";

// gui/zensound.ts on a fake context: the recipes' nodes, the Sound switch, the first-gesture unlock, and the ducking. No sound is made.
interface Param { value: number; ev: [string, number, number][]; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void; setTargetAtTime(v: number, t: number, k: number): void; cancelScheduledValues(t: number): void }
const param = (): Param => { const p: Param = { value: 0, ev: [], setValueAtTime: (v, t) => void p.ev.push(["set", v, t]), linearRampToValueAtTime: (v, t) => void p.ev.push(["lin", v, t]), exponentialRampToValueAtTime: (v, t) => void p.ev.push(["exp", v, t]), setTargetAtTime: (v, t, k) => void p.ev.push(["target", v, t + k * 0]), cancelScheduledValues: (t) => void p.ev.push(["cancel", 0, t]) }; return p; };
function rig(running = true) {
	const oscs: { frequency: Param; started: number[]; stopped: number[]; to?: { gain: Param } }[] = [], gains: { gain: Param; to?: unknown }[] = [], filters: { frequency: { value: number }; Q: { value: number }; type: string }[] = [], noise: { len: number }[] = [];
	const ac = {
		state: running ? "running" : "suspended", currentTime: 10, sampleRate: 1000, destination: {},
		createGain: () => { const n = { gain: param(), to: undefined as unknown, connect(t: unknown) { n.to = t; } }; gains.push(n); return n; },
		createOscillator: () => { const o = { type: "", frequency: param(), started: [] as number[], stopped: [] as number[], to: undefined as { gain: Param } | undefined, connect(t: { gain: Param }) { o.to = t; }, start: (t: number) => void o.started.push(t), stop: (t: number) => void o.stopped.push(t) }; oscs.push(o); return o; },
		createBiquadFilter: () => { const f = { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} }; filters.push(f); return f; },
		createBuffer: (_c: number, len: number) => (noise.push({ len }), { getChannelData: () => new Float32Array(len) }),
		createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
		resume: async () => void (ac.state = "running"),
	};
	const a = createAudio(() => ac as never);
	const listeners = new Map<string, () => void>();
	const doc = { addEventListener: (n: string, f: () => void) => void listeners.set(n, f), removeEventListener: (n: string) => void listeners.delete(n) };
	let on = true, bus: { gain: Param } | undefined;
	const z = createZenSound(a, { on: () => on }, () => bus as never, doc as never);
	return { ac, a, z, oscs, gains, filters, noise, listeners, setOn: (v: boolean) => (on = v), setBus: (b?: { gain: Param }) => (bus = b), duckGain: () => gains.find((g) => g.to === a.out().g && g.gain.ev.some((e) => e[0] === "cancel"))!, settle: () => new Promise((r) => setTimeout(r, 0)) };
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("the bowl is four partials of two sines 1.2 Hz apart, 5 s long, attack 15 ms, and the stated decays", () => {
	const r = rig();
	const end = schedule(r.a.out().c, r.a.out().g, 10, BOWL);
	assert.equal(end, 15);
	assert.equal(r.oscs.length, 8);
	const f = r.oscs.map((o) => o.frequency.ev[0]![1]);
	for (const [i, ratio] of [1, 2.71, 5.15, 8.42].entries()) {
		assert.ok(close(f[i * 2]!, 228 * ratio - 0.6) && close(f[i * 2 + 1]!, 228 * ratio + 0.6), `partial ${ratio}`);
	}
	assert.ok(r.oscs.every((o) => o.started[0] === 10 && o.stopped[0] === 15));
	const env = r.oscs.map((o) => o.to!.gain.ev);
	assert.ok(env.every((e) => e[0]![1] === 0 && e[1]![0] === "lin" && close(e[1]![2], 10.015)));
	assert.deepEqual([0, 2, 4, 6].map((i) => env[i]![2]![0]), ["target", "target", "target", "target"]);
	const total = env.reduce((s, e) => s + e[1]![1], 0);
	assert.ok(close(total, 0.35), "the peaks add to 0.35");
	assert.ok(close(env[2]![1]![1] / env[0]![1]![1], 0.45) && close(env[6]![1]![1] / env[0]![1]![1], 0.08));
});

test("the low bowl is on 146 Hz, decays at two thirds, bends down 1 %, peak 0.3", () => {
	const r = rig();
	schedule(r.a.out().c, r.a.out().g, 10, LOW);
	assert.ok(close(r.oscs[0]!.frequency.ev[0]![1], 146 - 0.6));
	const bend = r.oscs[0]!.frequency.ev[1]!;
	assert.deepEqual([bend[0], close(bend[1], (146 - 0.6) * 0.99), bend[2]], ["exp", true, 15]);
	assert.ok(close(r.oscs.reduce((s, o) => s + o.to!.gain.ev[1]![1], 0), 0.3));
	assert.deepEqual(LOW.kind === "bowl" && LOW.partials.map((p) => Math.round(p.tau * 1000) / 1000), [1.6, 0.933, 0.533, 0.267]);
});

test("the knock is a sine falling 560 to 480 Hz over 40 ms plus a 25 ms noise burst through a 1.1 kHz band-pass (Q 6), 250 ms long", () => {
	const r = rig();
	const end = schedule(r.a.out().c, r.a.out().g, 10, KNOCK);
	assert.ok(close(end, 10.25));
	const o = r.oscs[0]!;
	assert.deepEqual([o.frequency.ev[0]![1], o.frequency.ev[1]![1], close(o.frequency.ev[1]![2], 10.04)], [560, 480, true]);
	assert.equal(r.noise[0]!.len, 25, "25 ms at the fake 1000 Hz rate");
	assert.deepEqual([r.filters[0]!.type, r.filters[0]!.frequency.value, r.filters[0]!.Q.value], ["bandpass", 1100, 6]);
	assert.ok(close(r.gains.filter((g) => g.gain.ev[1]).reduce((s, g) => s + g.gain.ev[1]![1], 0), 0.5));
	assert.equal(o.to!.gain.ev[2]![0], "target");
});

test("an effect plays only with Sound on", async () => {
	const r = rig();
	await r.a.unlock();
	r.setOn(false);
	r.z.play("bowl");
	assert.equal(r.oscs.length, 0);
	r.setOn(true);
	r.z.play("bowl");
	assert.equal(r.oscs.length, 8);
	r.z.play("knock");
	assert.equal(r.oscs.length, 9);
});

test("volume is the master gain's square, read at each play through the one gain", () => {
	const r = rig();
	r.a.volume(30);
	r.z.play("bowl");
	assert.ok(close(r.a.out().g.gain.value, 0.09));
	assert.ok(r.oscs.every((o) => (o.to as unknown as { to: unknown }).to === r.a.out().g), "each partial reaches the master gain");
	r.a.volume(100);
	assert.equal(r.a.out().g.gain.value, 1);
});

test("before the first gesture an effect is dropped, after it the context resumes and effects play", async () => {
	const r = rig(false);
	r.z.play("bowl");
	assert.equal(r.oscs.length, 0, "dropped, not queued");
	assert.deepEqual([...r.listeners.keys()].sort(), ["keydown", "pointerdown"]);
	r.listeners.get("pointerdown")!();
	await r.settle();
	assert.equal(r.ac.state, "running");
	assert.equal(r.listeners.size, 0, "the listeners go after the first gesture");
	assert.equal(r.oscs.length, 0, "the dropped effect does not come back");
	r.z.play("bowl");
	assert.equal(r.oscs.length, 8);
});

test("an effect ducks playing music through a fixed duck node by 6 dB over 0.3 s and lets it back over 1.5 s", async () => {
	const r = rig();
	await r.a.unlock();
	const bus = { gain: param() };
	bus.gain.value = 0.5;
	r.setBus(bus);
	r.z.play("knock");
	assert.equal(bus.gain.ev.length, 0, "the music bus's own gain is never touched");
	const d = r.duckGain();
	const ev = d.gain.ev;
	assert.deepEqual(ev[0], ["cancel", 0, 10]);
	assert.deepEqual(ev[1], ["set", 1, 10]);
	assert.ok(close(ev[2]![1], 10 ** (-DUCK.db / 20)) && close(ev[2]![2], 10.3) && ev[2]![0] === "lin");
	assert.ok(ev[3]![1] === 1 && close(ev[3]![2], 11.8));
	assert.ok(ev[2]![1] < 0.5013 && ev[2]![1] > 0.5009, "6 dB is about half");
	assert.equal(d.to, r.a.out().g, "the duck node feeds the master gain");
});

test("overlapping ducks never read the param: each ramp starts at 1 and ends at 1", async () => {
	const r = rig();
	await r.a.unlock();
	r.setBus({ gain: param() });
	r.z.play("knock");
	const d = r.duckGain();
	Object.defineProperty(d.gain, "value", { get() { throw new Error("value read"); } });
	r.ac.currentTime = 10.5;
	r.z.play("bowl");
	const sets = d.gain.ev.filter((e) => e[0] === "set"), lins = d.gain.ev.filter((e) => e[0] === "lin");
	assert.deepEqual(sets.map((e) => e[1]), [1, 1]);
	assert.deepEqual(lins.map((e) => e[1]).map((v) => Math.round(v * 1000)), [501, 1000, 501, 1000]);
});

test("a try ducks once for each of its three effects", async () => {
	const r = rig();
	r.setBus({ gain: param() });
	r.z.tryAll();
	await r.settle();
	const d = r.duckGain();
	assert.deepEqual(d.gain.ev.filter((e) => e[0] === "set").map((e) => e[2]), [10, 10 + GAP, 10 + 2 * GAP]);
});

test("after the context is suspended again the next gesture re-arms the unlock and effects resume", async () => {
	const r = rig();
	await r.a.unlock();
	r.listeners.clear();
	r.ac.state = "suspended";
	r.z.play("bowl");
	assert.equal(r.oscs.length, 0, "dropped while suspended");
	assert.deepEqual([...r.listeners.keys()].sort(), ["keydown", "pointerdown"], "the gesture hooks are back");
	r.listeners.get("keydown")!();
	await r.settle();
	r.z.play("bowl");
	assert.equal(r.oscs.length, 8);
});

test("main.ts hands the page's Sound switch to the Zen chunk, which builds createZenSound on the page's audio and gives Zen its play, try, and tryAll", () => {
	const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8"), src = readFileSync(new URL("../gui/zenpage.ts", import.meta.url), "utf8");
	assert.match(main, /zenPage\(\{ sound: notify\.sound, /);
	assert.match(src, /createZenSound\(audio, io\.sound, /);
	assert.match(src, /musicBus\(audio, zs\.bus\(\)\)/, "the music reaches the master through the duck node, so an effect ducks it");
	assert.match(src, /sound: zs\.play/);
	assert.match(src, /try: zs\.try/);
	assert.match(src, /effects: zs\.tryAll/);
});

test("Try ignores the Sound switch, lets the page play, and plays the bowl, knock, and low bowl in turn", async () => {
	const r = rig(false);
	r.setOn(false);
	r.z.tryAll();
	await r.settle();
	assert.equal(r.ac.state, "running");
	assert.equal(r.oscs.length, 8 + 1 + 8);
	const starts = [...new Set(r.oscs.map((o) => o.started[0]))];
	assert.deepEqual(starts, [10, 10 + GAP, 10 + 2 * GAP]);
	const one = rig();
	one.z.try();
	await one.settle();
	assert.equal(one.oscs.length, 8, "the volume's release plays the bowl alone");
});

test("the effects use no audio file and no second context", async () => {
	let made = 0;
	const ac = { state: "running", currentTime: 0, sampleRate: 1000, destination: {}, createGain: () => ({ gain: param(), connect() {} }), createOscillator: () => ({ frequency: param(), connect() {}, start() {}, stop() {} }), resume: async () => {} };
	const a = createAudio(() => (made++, ac as never));
	const z = createZenSound(a, { on: () => true }, undefined, { addEventListener() {}, removeEventListener() {} } as never);
	await a.unlock();
	z.play("bowl");
	z.play("low");
	assert.equal(made, 1);
});

test("Zen's pages never import the trains model statically; zenPage loads it only when a snapshot has yards, and a failed load is tried again on the next snapshot (TPG2-F002)", async () => {
	const { readdirSync } = await import("node:fs");
	const dir = new URL("../gui/", import.meta.url);
	for (const f of readdirSync(dir).filter((n) => /^zen.*\.ts$/.test(n))) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /^\s*import\b[^\n]*["']\.\/trains\.ts["']/m, `${f} imports trains.ts statically`);
	const had = "document" in globalThis;
	if (!had) Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {} } });
	const { zenPage } = await import("../gui/zenpage.ts");
	const real = await import("../gui/trains.ts");
	let net: unknown = { units: [] }, calls = 0, fail = true;
	const z = zenPage({ sound: { on: () => false }, api: async () => ({}), snapshot: () => net as never, loadTrains: async () => (calls++, fail ? Promise.reject(new Error("chunk")) : real) });
	assert.deepEqual(z.trains!(), { count: 0, waiting: 0 });
	assert.equal(calls, 0, "no yards, no load");
	net = { units: [], yards: { projects: [] } };
	z.trains!();
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 1);
	z.trains!();
	await new Promise((r) => setImmediate(r));
	assert.equal(calls, 2, "the failed load is tried again with the next snapshot");
	fail = false;
	z.trains!();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(z.trains!(), { count: 0, waiting: 0 });
	assert.equal(calls, 3);
	if (!had) delete (globalThis as { document?: unknown }).document;
});
