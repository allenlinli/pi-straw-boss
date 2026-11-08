import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Raven's weather on the page (mountWeather in gui/themes/raven/weather.ts): the DOM wiring that createWeather's tests leave out. A hand-made document, observers, storage and audio core; timers are node's mock clock, so nothing waits and nothing sounds.
type Fn = (e: any) => void;
const listeners = new Map<string, Set<Fn>>();
const globalHandlers = new Map<string, Fn[]>();
const store = new Map<string, string>();
class FakeObserver {
	static all: FakeObserver[] = [];
	seen: { target: unknown; options: Record<string, unknown> }[] = [];
	live = true;
	readonly cb: () => void;
	constructor(cb: () => void) { this.cb = cb; FakeObserver.all.push(this); }
	observe(target: unknown, options: Record<string, unknown>) { this.seen.push({ target, options }); }
	disconnect() { this.live = false; }
}
const stage = { dataset: { view: "map" } as Record<string, string> };
const soundSwitch = { dataset: { state: "off" } as Record<string, string> };
const attrs = new Set<string>();
const root = { dataset: { view: "raven" } as Record<string, string>, hasAttribute: (n: string) => attrs.has(n) } as unknown as HTMLElement;
const doc = {
	hidden: false,
	getElementById: (id: string) => (id === "stage" ? stage : id === "sound" ? soundSwitch : null),
	addEventListener: (t: string, f: Fn) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
	removeEventListener: (t: string, f: Fn) => void listeners.get(t)?.delete(f),
};
const env = { motion: true, activation: false };
Object.assign(globalThis, {
	document: doc, MutationObserver: FakeObserver,
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
	matchMedia: () => ({ matches: env.motion }),
	addEventListener: (t: string, f: Fn) => void (globalHandlers.get(t) ?? globalHandlers.set(t, []).get(t)!).push(f),
});
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ userActivation: { isActive: env.activation } }) });

const { mountWeather, FLASH } = await import("../gui/themes/raven/weather.ts");

const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
function core() {
	const made = { loops: 0, thunders: 0, unlocks: 0 };
	const st = { running: false, allow: true };
	const node = () => ({ gain: param(), frequency: param(), connect() {}, type: "" });
	const ac = {
		currentTime: 0, sampleRate: 100,
		createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
		createBufferSource: () => { const s = { loop: false, buffer: null, connect() {}, start() { s.loop && made.loops++; }, stop() {} }; return s; },
		createBiquadFilter: node, createGain: node,
		createOscillator: () => ({ ...node(), start() { made.thunders++; }, stop() {} }),
	};
	const a = { out: () => ({ c: ac, g: {} }) as never, running: () => st.running, unlock: async () => { made.unlocks++; st.running = st.allow; return st.allow; }, play() {}, volume() {} };
	return { a, made, st };
}
/** One mounted weather on a fresh page: Sound on, the map showing, the context already running. */
function page(over: { sound?: boolean; running?: boolean } = {}) {
	listeners.clear(); attrs.clear(); FakeObserver.all.length = 0;
	Object.assign(root.dataset, { view: "raven" }); stage.dataset.view = "map"; soundSwitch.dataset.state = "off"; doc.hidden = false; env.motion = true; env.activation = false;
	store.set("sb.sound", over.sound === false ? "0" : "1");
	const c = core(); c.st.running = over.running ?? true;
	let t = 100_000;
	const frames: (() => void)[] = [];
	const undo = mountWeather(root, c.a as never, () => t, (fn) => void frames.push(fn));
	const [rootWatch, switchWatch] = FakeObserver.all;
	const event = (type: string, e: Record<string, unknown> = {}) => listeners.get(type)?.forEach((f) => f({ type, timeStamp: t, ...e }));
	const names = () => [...listeners].filter(([, s]) => s.size > 0).map(([k]) => k).sort();
	return { ...c, undo, frame: () => frames.splice(0).forEach((f) => f()), rootWatch: rootWatch!, switchWatch: switchWatch!, event, names, now: (ms = 0) => (t += ms), flash: (extra: Record<string, unknown> = {}) => event("animationiteration", { animationName: FLASH, ...extra }) };
}
const settle = () => new Promise<void>((r) => setImmediate(r));
const ALL = ["animationiteration", "animationstart", "keydown", "pointerdown", "visibilitychange"];

test("the page's watchers: <html>'s view and calm marks (the subtree too), the Sound switch's state, and the Sound pref of another tab", () => {
	const p = page();
	assert.deepEqual(p.rootWatch.seen, [{ target: root, options: { attributes: true, subtree: true, attributeFilter: ["data-view", "data-calm"] } }]);
	assert.deepEqual(p.switchWatch.seen, [{ target: soundSwitch, options: { attributes: true, attributeFilter: ["data-state"] } }]);
	assert.equal(globalHandlers.get("storage")?.length, 1, "prefs.on listens for another tab's write");
	assert.equal(p.made.loops, 1, "the rain started at mount: Sound on, backdrop, running");
	p.undo();
	assert.ok(!p.rootWatch.live && !p.switchWatch.live, "undo disconnects both");
});

test("RS-F006: the press, key, and animation listeners are on the page only while the weather can sound (Sound on, tab visible, backdrop shown), and the visibility one always", () => {
	const p = page({ sound: false });
	assert.deepEqual(p.names(), ["visibilitychange"], "Sound off: no hook but visibility, so Standard, Geek, and Zen pay nothing for Raven having loaded");
	store.set("sb.sound", "1");
	p.switchWatch.cb();
	assert.deepEqual(p.names(), ALL, "Sound turned on");
	doc.hidden = true;
	p.event("visibilitychange");
	assert.deepEqual(p.names(), ["visibilitychange"], "hidden tab");
	doc.hidden = false;
	p.event("visibilitychange");
	assert.deepEqual(p.names(), ALL, "visible again");
	root.dataset.view = "standard";
	p.rootWatch.cb();
	assert.deepEqual(p.names(), ["visibilitychange"], "another view");
	root.dataset.view = "raven";
	stage.dataset.view = "session";
	p.rootWatch.cb();
	assert.deepEqual(p.names(), ["visibilitychange"], "a stage that is neither the map nor the head page");
	stage.dataset.view = "head";
	p.rootWatch.cb();
	assert.deepEqual(p.names(), ALL, "the head page is a backdrop too");
	p.undo();
	assert.deepEqual(p.names(), [], "undo takes them all off");
});

test("a press before the browser lets the page play unlocks the audio, and the rain starts once it runs", async () => {
	const p = page({ running: false });
	assert.equal(p.made.loops, 0);
	p.event("pointerdown");
	await settle();
	assert.equal(p.made.unlocks, 1);
	assert.equal(p.made.loops, 1, "unlock, then refresh: the rain");
	p.undo();
});

test("turning Sound on in the settings (a press the page's own hook was not on for) unlocks the audio in that gesture, and not outside one", async () => {
	const p = page({ sound: false, running: false });
	store.set("sb.sound", "1");
	env.activation = false;
	p.switchWatch.cb();
	await settle();
	assert.equal(p.made.unlocks, 0, "no gesture: no attempt (the browser would only log a refusal)");
	env.activation = true;
	p.switchWatch.cb();
	await settle();
	assert.equal(p.made.unlocks, 1);
	assert.equal(p.made.loops, 1);
	p.undo();
});

test("another tab's Sound write (a storage event) starts or stops the rain here", () => {
	const p = page();
	assert.equal(p.made.loops, 1);
	store.set("sb.sound", "0");
	globalHandlers.get("storage")!.forEach((f) => f({ key: "sb.sound" }));
	assert.deepEqual(p.names(), ["visibilitychange"]);
	p.undo();
});

test("the flash is the stylesheet's rk-clap clock: its animationstart and animationiteration make a thunder 1 to 2 s later; an animation of another name makes none", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		for (const type of ["animationstart", "animationiteration"]) {
			const p = page();
			p.event(type, { animationName: "rk-bolt" });
			p.event(type, { animationName: "something-else" });
			mock.timers.tick(2100);
			assert.equal(p.made.thunders, 0, `${type} of another animation`);
			p.event(type, { animationName: FLASH });
			mock.timers.tick(900);
			assert.equal(p.made.thunders, 0, "not before 1 s");
			mock.timers.tick(1200);
			assert.equal(p.made.thunders, 1, `${type}: one thunder by 2 s`);
			p.undo();
		}
	} finally {
		mock.timers.reset();
	}
});

test("RS-F008: a flash event that arrives late is not the flash: an event stamped long ago, or the first one after a hidden tab came back (Blink stamps it when it creates it, however late the flash was), makes no thunder", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const p = page();
		p.flash({ timeStamp: p.now() - 5000 });
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "a stale stamp");
		// the tab was throttled; it comes back and the animations catch up in its first frames
		doc.hidden = true; p.event("visibilitychange");
		p.now(600_000);
		doc.hidden = false; p.event("visibilitychange");
		p.now(16);
		p.flash();
		p.frame();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "the catch-up event right after the tab came back");
		p.now(1500);
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 1, "a flash after that is a flash");
		p.undo();
	} finally {
		mock.timers.reset();
	}
});

test("RS2-F001: under load the first frame after a hidden tab came back can take over a second; the catch-up event of that frame makes no thunder, and the second's window starts at that frame", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const p = page();
		doc.hidden = true; p.event("visibilitychange");
		p.now(600_000);
		doc.hidden = false; p.event("visibilitychange");
		p.now(1500);
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "the catch-up event, 1.5 s late, before the first frame ran");
		p.frame();
		p.now(500);
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "within a second of that first frame");
		p.now(700);
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 1, "a flash after that is a flash");
		p.undo();
	} finally {
		mock.timers.reset();
	}
});

test("calm and the view are watched: calm stops the rain and its end brings it back; leaving Raven stops it; no thunder is scheduled under reduced motion", () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const p = page();
		assert.equal(p.made.loops, 1);
		attrs.add("data-calm");
		p.rootWatch.cb();
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "calm: no thunder");
		attrs.delete("data-calm");
		p.rootWatch.cb();
		assert.equal(p.made.loops, 2, "calm over: a new rain");
		env.motion = false;
		p.flash();
		mock.timers.tick(2100);
		assert.equal(p.made.thunders, 0, "reduced motion: no thunder");
		p.undo();
	} finally {
		mock.timers.reset();
	}
});

test("after undo a late refresh (the Sound pref of another tab, which cannot be unhooked) starts nothing", () => {
	const p = page({ sound: false });
	p.undo();
	store.set("sb.sound", "1");
	globalHandlers.get("storage")!.forEach((f) => f({ key: "sb.sound" }));
	assert.equal(p.made.loops, 0);
	assert.deepEqual(p.names(), []);
});
