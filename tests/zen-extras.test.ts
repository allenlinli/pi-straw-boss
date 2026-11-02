import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Choice } from "../gui/view.ts";
import { El, page } from "./zen-dom.ts";

// Z4's small parts, each on the fake document: the corner menu (gui/zenmenu.ts), the full-screen control (gui/zenfs.ts), the line under the idle circle (gui/zenlines.ts), the shared sound and
// language stores, and the words.
const { mountMenu, OPEN_MS, GRACE_MS } = await import("../gui/zenmenu.ts");
const { mountFullscreen, HINT_KEY } = await import("../gui/zenfs.ts");
const { deck, LINES, mountLine, LINE_MS, FADE_MS } = await import("../gui/zenlines.ts");
const { createPrefs, KEYS } = await import("../gui/prefs.ts"); // the sound stores are prefs.ts's now
const [SOUND_KEY, VOLUME_KEY] = [KEYS.sound, KEYS.volume];
type St = Parameters<typeof createPrefs>[0];
const [readSound, readVolume] = [(st: St) => createPrefs(st).get("sound"), (st: St) => createPrefs(st).get("volume")];
const [writeSound, writeVolume] = [(on: boolean, st: St) => createPrefs(st).set("sound", on), (v: number, st: St) => createPrefs(st).set("volume", v)];
const { setLocale } = await import("../gui/i18n.ts");

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
			for (;;) {
				const due = q.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
				if (!due) return;
				q.splice(q.indexOf(due), 1);
				due.fn();
			}
		},
		pending: () => q.length,
	};
}
const store = () => {
	const m = new Map<string, string>();
	return Object.assign(m, { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }) as Map<string, string> & Pick<Storage, "getItem" | "setItem">;
};
const text = (e: El) => e.textContent;

function menuRig(o: { sound?: boolean } = {}) {
	const c = clock(), st = store(), calls: string[] = [];
	let lang = "en", view: Choice = "zen";
	let sound = o.sound ?? false, volume = 60;
	const m = mountMenu({
		language: { get: () => lang, names: () => [{ id: "en", name: "English" }, { id: "zh-TW", name: "正體中文" }], set: (id) => ((lang = id), calls.push(`lang:${id}`)) },
		view: { choice: () => view, auto: () => "Auto", set: (v) => ((view = v), calls.push(`view:${v}`)) },
		sound: { on: () => sound, volume: () => volume, set: (on) => ((sound = on), writeSound(on, st), calls.push(`sound:${on}`)), setVolume: (v) => ((volume = v), writeVolume(v, st)), try: () => calls.push("try") },
	}, () => calls.push("leave"), c.later);
	page.body.replaceChildren(m.el as unknown as El);
	page.focused = undefined;
	const host = m.el as unknown as El, btn = m.button as unknown as El;
	const by = (label: string) => host.all((e) => e.tagName === "button" && text(e) === label)[0]!;
	return { c, st, calls, m, host, btn, by, key: (key: string, extra: object = {}) => (page.focused ?? host).bubble("keydown", { key, ...extra }), mouse: (type: string) => host.bubble(type, { pointerType: "mouse" }) };
}

test("the menu opens by hover after a short delay, stays through a grace area, and a press keeps it open", () => {
	const r = menuRig();
	assert.equal(r.btn.getAttribute("aria-expanded"), "false");
	r.mouse("pointerenter");
	r.c.advance(OPEN_MS - 1);
	assert.equal(r.m.isOpen(), false, "not before the delay");
	r.c.advance(2);
	assert.equal(r.m.isOpen(), true);
	r.mouse("pointerleave");
	r.c.advance(GRACE_MS - 10);
	assert.equal(r.m.isOpen(), true, "the pointer may cross the gap");
	r.mouse("pointerenter");
	r.c.advance(GRACE_MS * 2);
	assert.equal(r.m.isOpen(), true, "coming back cancels the close");
	r.mouse("pointerleave");
	r.c.advance(GRACE_MS + 1);
	assert.equal(r.m.isOpen(), false, "closed after the grace period");
	r.mouse("pointerenter");
	r.c.advance(OPEN_MS + 1);
	r.btn.click();
	r.mouse("pointerleave");
	r.c.advance(GRACE_MS * 3);
	assert.equal(r.m.isOpen(), true, "a press on a hover-opened menu pins it");
	r.btn.click();
	assert.equal(r.m.isOpen(), false, "a second press closes it");
});

test("a touch or a pen does not open it by hover; a tap and Enter open it with the focus inside, Esc closes it and returns the focus to the button", () => {
	const r = menuRig();
	r.host.bubble("pointerenter", { pointerType: "touch" });
	r.c.advance(5000);
	assert.equal(r.m.isOpen(), false);
	r.btn.click(); // a tap, or Enter on the focused button: both are a click
	assert.equal(r.m.isOpen(), true);
	assert.equal(r.btn.getAttribute("aria-expanded"), "true");
	assert.equal(page.focused, r.by("English"), "the focus moves into the menu");
	r.key("Escape");
	assert.equal(r.m.isOpen(), false);
	assert.equal(page.focused, r.btn, "and returns to the button");
	assert.equal(r.m.close(), false, "closing a closed menu is not Zen's key to take");
});

test("an open menu traps Tab inside, and a press outside closes it", () => {
	const r = menuRig();
	r.btn.click();
	const stops = r.host.all((e) => e.tagName === "button" || e.tagName === "input").filter((e) => e !== r.btn);
	assert.ok(stops.length >= 6, "language, view, sound, volume, and the way back");
	page.focused = stops.at(-1);
	r.key("Tab");
	assert.equal(page.focused, stops[0], "past the last control it wraps to the first");
	r.key("Tab", { shiftKey: true });
	assert.equal(page.focused, stops.at(-1), "and back");
	for (const on of page.on.pointerdown ?? []) on({ target: new El("div") });
	assert.equal(r.m.isOpen(), false);
});

test("each row acts through the settings page's own function or store: language, view, sound and its volume, and the way back", () => {
	const r = menuRig();
	r.btn.click();
	r.by("正體中文").click();
	r.by("Auto").click();
	r.by("Standard").click();
	r.by("Geek").click();
	r.by("Off").click();
	const vol = r.host.all((e) => e.tagName === "input")[0]!;
	vol.value = "35";
	vol.oninput?.();
	vol.bubble("change");
	r.by("Back to the Standard view (Esc Esc)").click();
	assert.deepEqual(r.calls.filter((c) => c !== "try"), ["lang:zh-TW", "view:auto", "view:standard", "view:geek", "sound:true", "leave"]);
	assert.equal(r.st.get(SOUND_KEY), "1", "the Sound switch's own key");
	assert.equal(r.st.get(VOLUME_KEY), "35", "the Volume's own key");
	assert.equal(readSound(r.st), true);
	assert.equal(readVolume(r.st), 35);
	assert.equal(r.host.all((e) => e.getAttribute("class") === "zen-music")[0]!.getAttribute("hidden"), "", "the music's slot is there and hidden until Z6");
});

test("the language is kept under the settings page's key and the page reloads; a refused store reports it", () => {
	const st = store();
	let reloaded = 0;
	assert.equal(setLocale("zh-TW", st, () => reloaded++), true);
	assert.equal(st.get("sb-locale"), "zh-TW");
	assert.equal(reloaded, 1);
	assert.equal(setLocale("en", { setItem() { throw new Error("refused"); } }, () => reloaded++), false);
	assert.equal(reloaded, 1, "no reload when nothing was kept");
});

function fsRig(o: { enabled?: boolean; standalone?: boolean; touch?: boolean; seen?: boolean } = {}) {
	const c = clock(), st = store(), calls: string[] = [], listeners: Record<string, (() => void)[]> = {};
	if (o.seen) st.setItem(HINT_KEY, "1");
	const doc = {
		fullscreenEnabled: o.enabled ?? true, fullscreenElement: undefined as unknown,
		exitFullscreen: async () => void (calls.push("exit"), (doc.fullscreenElement = undefined)),
		addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
		documentElement: { requestFullscreen: async () => void (calls.push("request"), (doc.fullscreenElement = {})) },
	};
	const f = mountFullscreen({ doc, standalone: () => o.standalone ?? false, touch: () => o.touch ?? false, seen: st, later: c.later });
	return { f, doc, calls, c, st, change: () => listeners.fullscreenchange?.forEach((fn) => fn()), button: f.button as unknown as El };
}

test("the full-screen control is shown only where the browser can, toggles the page, and its label follows the state", async () => {
	const r = fsRig();
	assert.equal(r.button.hidden, false);
	assert.equal(r.button.getAttribute("aria-label"), "Full screen");
	r.button.click();
	await Promise.resolve();
	r.change();
	assert.deepEqual(r.calls, ["request"]);
	assert.equal(r.button.getAttribute("aria-label"), "Exit full screen");
	assert.equal(r.button.getAttribute("aria-pressed"), "true");
	r.button.click();
	await Promise.resolve();
	r.change();
	assert.deepEqual(r.calls, ["request", "exit"]);
	assert.equal(r.button.getAttribute("aria-label"), "Full screen");
	assert.equal(fsRig({ enabled: false }).button.hidden, true, "an iPhone's Safari has no API: hidden");
});

test("where full screen is not offered, a touch device that is not an installed app is told once, quietly, to add the page to the Home Screen", () => {
	const r = fsRig({ enabled: false, touch: true });
	assert.ok(r.f.hint, "the hint shows");
	assert.equal((r.f.hint as unknown as El).textContent, "For full screen, add this page to your Home Screen.");
	assert.equal(r.st.get(HINT_KEY), "1", "and is remembered");
	assert.equal(r.c.pending(), 1);
	r.c.advance(20_000);
	assert.equal(r.c.pending(), 0, "it goes by itself");
	assert.equal(fsRig({ enabled: false, touch: true, seen: true }).f.hint, undefined, "never twice");
	assert.equal(fsRig({ enabled: false, touch: true, standalone: true }).f.hint, undefined, "an installed app needs none");
	assert.equal(fsRig({ enabled: false, touch: false }).f.hint, undefined, "a desktop has no Home Screen to suggest");
	assert.equal(fsRig({ enabled: true, touch: true }).f.hint, undefined, "where full screen works, no hint");
});

test("the deck shows every line once, in a random order, before any repeats, and a new round never starts with the last one", () => {
	let seed = 7;
	const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
	const d = deck(LINES.length, random);
	let last = -1;
	for (let round = 0; round < 20; round++) {
		const seen = new Set<number>();
		for (let i = 0; i < LINES.length; i++) {
			const n = d.next();
			assert.ok(!seen.has(n), "no repeat inside a round");
			if (i === 0) assert.notEqual(n, last, "the new round does not open with the old round's last");
			seen.add(n);
			last = n;
		}
		assert.equal(seen.size, LINES.length);
	}
	assert.equal(deck(0).next(), -1);
});

test("every line is short, attributed, and sourced in a comment", () => {
	assert.equal(LINES.length, 14);
	for (const l of LINES) {
		assert.ok(l.by.length > 0 && l.zh.length > 0 && l.en.length > 0);
		assert.ok([...l.zh.replace(/[，。、；！？]/g, "")].length <= 16, `short: ${l.zh}`);
	}
	const source = readFileSync(new URL("../gui/zenlines.ts", import.meta.url), "utf8");
	assert.equal([...source.matchAll(/^\t\/\/ .*zh: (published|our translation)/gm)].length, LINES.length, "a source and the zh note above each entry");
});

test("the line fades to the next every 45 s, stays still under calm or reduced motion, and stops with the layer", () => {
	const c = clock();
	let still = false, n = 0;
	const lines = [{ zh: "甲", en: "a", by: "x" }, { zh: "乙", en: "b", by: "y" }, { zh: "丙", en: "c", by: "z" }];
	const l = mountLine(c.later, () => still, () => ((n = (n + 1) % 7) / 7), lines);
	const el = l.el as unknown as El, shown = () => el.textContent;
	const first = shown();
	assert.ok(first.length > 0 && el.kids.length === 2, "a line and its source");
	c.advance(LINE_MS - 1);
	assert.equal(shown(), first);
	c.advance(1);
	assert.equal(el.dataset.fading, "", "it fades first");
	c.advance(FADE_MS);
	assert.notEqual(shown(), first);
	assert.equal(el.dataset.fading, undefined);
	still = true;
	const held = shown();
	c.advance(LINE_MS * 5);
	assert.equal(shown(), held, "calm and reduced motion keep it as it is");
	still = false;
	l.stop();
	assert.equal(c.pending(), 0, "stop cancels the timer");
});

test("the words: the new keys exist in both languages with the boss's copy, and zen_nothing is gone", () => {
	const read = (f: string) => JSON.parse(readFileSync(new URL(`../gui/messages/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
	const zh = read("zh-TW"), en = read("en");
	const want: Record<string, string> = { zen_back_title: "回到禪", zen_leave_title: "回到標準畫面（Esc Esc）", zen_esc_hint: "再按一次 Esc 回到標準", zen_asks: "{name} 想問你", zen_not_now: "晚點再說", zen_open_terminal: "開啟終端機", zen_term_esc_hint: "再按一次 Esc 回到禪", zen_elsewhere: "已經在別處回好了", zen_pause: "吸一口氣", zen_fullscreen: "全螢幕", zen_fullscreen_exit: "離開全螢幕", zen_add_home: "想全螢幕，可以把這頁加入主畫面。" };
	for (const [k, v] of Object.entries(want)) {
		assert.equal(zh[k], v, k);
		assert.ok(en[k] && en[k] !== v, `${k} has its English`);
	}
	for (const k of ["zen_menu"]) assert.ok(zh[k] && en[k]);
	assert.equal(zh.zen_nothing, undefined);
	assert.equal(en.zen_nothing, undefined);
	assert.ok(!/[\u4e00-\u9fff]/.test(Object.entries(en).filter(([k]) => k.startsWith("zen_")).map(([, v]) => v).join("")), "the English words are English");
});

test("Zen's Esc table: the menu first, then a field with text, an item, an empty field, and last the pair that leaves", async () => {
	const { escStep, ESC_MS } = await import("../gui/zenkeys.ts");
	assert.equal(ESC_MS, 600);
	const none = { menu: false, field: "none", item: false, armed: false } as const;
	assert.equal(escStep({ ...none, menu: true, field: "text", item: true, armed: true }), "menu", "an open menu takes it before anything");
	assert.equal(escStep({ ...none, field: "text", item: true }), "blur", "text in a field comes before the card");
	assert.equal(escStep({ ...none, field: "empty", item: true }), "item", "an empty field does not stand in a card's way");
	assert.equal(escStep({ ...none, item: true, armed: true }), "item", "on a card the pair never forms");
	assert.equal(escStep({ ...none, field: "empty" }), "blur", "on the companion an empty field is let go of");
	assert.equal(escStep(none), "hint");
	assert.equal(escStep({ ...none, armed: true }), "leave");
	assert.equal(escStep({ ...none, armed: true, repeat: true }), "none", "a held key is nothing");
	assert.equal(escStep({ ...none, menu: true, repeat: true }), "none");
});

test("an open menu redraws Sound and Volume when another tab changes them; a closed one is left alone", () => {
	const c = clock(), told: (() => void)[] = [];
	let sound = false, volume = 60;
	const m = mountMenu({ sound: { on: () => sound, volume: () => volume, set: () => {}, setVolume: () => {}, try: () => {}, onChange: (fn) => void told.push(fn) } }, () => {}, c.later);
	page.body.replaceChildren(m.el as unknown as El);
	const host = m.el as unknown as El, on = host.all((e) => e.getAttribute("class") === "zen-opt")[0]!;
	const vol = host.all((e) => e.tagName === "input")[0]!;
	m.button.click();
	assert.equal(on.getAttribute("aria-pressed"), "false");
	[sound, volume] = [true, 25];
	told.forEach((f) => f());
	assert.equal(on.getAttribute("aria-pressed"), "true");
	assert.equal(vol.value, "25");
	m.close();
	[sound, volume] = [false, 80];
	told.forEach((f) => f());
	assert.equal(on.getAttribute("aria-pressed"), "true", "closed: not redrawn (the next open does)");
});
