import assert from "node:assert/strict";
import { test } from "node:test";
import { BOSS_MARK } from "../src/eventmarks.ts";
import type { Item } from "../src/items.ts";
import type { Mark } from "../src/netdata.ts";
import type { HeadUnit } from "../src/nethead.ts";
import type { Net, TowerService, Unit } from "../src/net.ts";
import { alertsOf } from "../gui/alerts.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import { joined, quietForwards } from "../gui/zenhead.ts";
import { hotkeyOf } from "../gui/hotkeys.ts";
import "../gui/zenrows.ts"; // the Zen chunk registers the Zen rows
import { El, page } from "./fake-dom.ts";

// The strip under Zen's circle, as the page drives it (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle): the last lines of the head's conversation fading, the folded input that unfolds on a click or
// Enter, what a send and a refusal do, the draft that holds the screen, the history as a companion, and the keys. The layer is the real one on the fake document; the log and the composer are stand-ins that record.
const { mountZen, real, DRAFT_MS } = await import("../gui/zen.ts");
const { CLEAR_MS, FADE_MS } = await import("../gui/headlines.ts");
const { entriesOf } = await import("../gui/paletteentries.ts");

const at = (min: number) => new Date(Date.UTC(2026, 10, 4, 9, min)).toISOString();
const bossLine = (id: string, text: string, min = 0): Item => ({ id, kind: "notice", type: "straw-tower", event: "boss", text: `${BOSS_MARK}\n${text}`, at: at(min) });
const headLine = (id: string, text: string, min = 0): Item => ({ id, kind: "assistant", text, at: at(min) });
const service = (o: Partial<TowerService> = {}): TowerService => ({ state: "running", queued: 0, notices: [], parked: [], allyRuns: [], ...o });
const head = (o: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "running", service: service(), asks: [], ...o });
const waiting = (): Unit => ({ id: "a", key: "a", control: true, name: "ops-main", role: "main", mark: "waiting" as Mark, since: 5, subs: [], pending: { callId: "c1", tool: "robot_hand", answer: { dialog: "d1", digest: "0".repeat(64), select: { title: "Deploy", choices: [{ label: "Yes" }, { label: "No" }] } } } } as Unit);
const net = (h?: HeadUnit, units: Unit[] = []): Net => ({ bases: units.length ? [{ id: "w", label: "Harbor", mark: "idle", tower: null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }] : [], trust: [], ...(h ? { head: h } : {}) }) as Net;

function rig(o: { head?: HeadUnit | null; items?: Item[]; offline?: boolean; reply?: (action: string, body: Record<string, unknown>) => Promise<Answer> } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], leave: [] as unknown[], watch: [] as (string | null)[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[], composers: [] as { key: string; box: El }[], logs: [] as string[], applied: [] as HistoryEvent[] };
	let items = o.items ?? [];
	const mounts = {
		...real,
		composer: ((root: El, key: string) => {
			const box = new El("textarea");
			root.replaceChildren(box);
			calls.composers.push({ key, box });
			return { box, update() {} };
		}) as never,
		chat: async () => (_root: El, _data: unknown, _deps: unknown) => (calls.logs.push("mounted"), { apply: (e: HistoryEvent) => calls.applied.push(e), setLive() {}, reveal() {} } as unknown as Chat),
	};
	const deps = {
		data: (key: string) => ({ older: async () => ({ items: [] }), latest: async () => ({ items: key === "sb-head" ? items : [] }), entry: async () => undefined }),
		recent: async () => [],
		post: (key: string) => (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), (o.reply ?? (async () => ({ ok: true, status: 200, body: { accepted: true } })))(action, body)),
		label: (ws: string) => ws, online: () => !o.offline, remote: false, remind() {}, sound: (s: string) => void calls.sound.push(s), leave: (e: unknown) => void calls.leave.push(e),
		terminals: async () => ({}), watch: (key: string | null) => void calls.watch.push(key), start: () => undefined,
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} },
		still: () => false, random: () => 0, now: () => t,
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const root = new El("section");
	page.body.replaceChildren(root);
	[page.focused, page.hidden, page.focus] = [undefined, false, true];
	const z = mountZen(root as unknown as HTMLElement, deps as never, mounts as never);
	const settle = () => new Promise((done) => setImmediate(done));
	const advance = async (ms: number) => {
		t += ms;
		for (;;) {
			const due = timers.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers.splice(timers.indexOf(due), 1);
			due.fn();
		}
		await settle();
	};
	const by = (cls: string) => root.all((el) => el.classes.has(cls));
	const r = {
		z, root, calls, advance, settle, now: () => t, by,
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		put: (next: Item[]) => ((items = next), z.history({ key: "sb-head", reset: true, items: next })),
		strip: () => by("zen-head")[0],
		lines: () => by("zen-hl").map((el) => el.textContent),
		hint: () => by("zen-head-hint")[0]!,
		form: () => by("zen-head-form")[0]!,
		box: () => by("zen-head-box")[0]!,
		note: () => by("zen-head-note")[0]!.textContent,
		mind: () => by("zen-line")[0],
		start: async (n: Net | undefined = net(o.head === null ? undefined : (o.head ?? head()))) => (n && r.feed(n), z.show(), await settle()),
		/** A Zen key as the page routes it: the keymap's row for the face, then the layer's answer (hotkeys.ts, pagecore.ts). */
		press: (key: string, target: unknown = undefined, extra: object = {}) => {
			const hot = hotkeyOf({ key, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target, ...extra }, false, false, "zen");
			return hot ? z.key(hot) : false;
		},
		/** Types into the box as a keyboard does and presses a key in it. */
		typed: (text: string) => { r.box().value = text; r.box().bubble("input"); },
		enter: (extra: object = {}) => r.box().bubble("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...extra }),
		unfold: () => r.hint().click(),
		esc: () => z.escape({ preventDefault() {} }),
	};
	return r;
}

test("under the circle stand the mindfulness line and the folded input with its hint; the stream watches the head, nothing else is on show", async () => {
	const r = rig();
	await r.start();
	assert.equal(r.by("zen-circle").length, 1);
	assert.equal(r.mind()?.hidden, false, "a fresh head has no lines: the mindfulness line shows, as before");
	assert.equal(r.hint().textContent, "Enter to talk to the head tower");
	assert.equal(r.hint().tagName, "button", "the folded input is one control");
	assert.equal(r.form().hidden, true, "the box is folded");
	assert.deepEqual(r.lines(), []);
	assert.equal(r.calls.watch.at(-1), "sb-head", "the stream watches the head while the strip shows");
});

test("the last three lines show, the newest last, and the whole text is in the line (the page clamps it); the mindfulness line stays away while any is clear", async () => {
	const r = rig({ items: [bossLine("u1", "first", 1), headLine("a1", "second", 2), bossLine("u2", "third", 3), headLine("a2", "fourth\nwith a second line", 4)] });
	await r.start();
	await r.settle();
	assert.deepEqual(r.lines(), ["second", "third", "fourth with a second line"]);
	assert.deepEqual(r.by("zen-hl").map((el) => el.getAttribute("data-who")), ["head", "boss", "head"]);
	assert.deepEqual(r.by("zen-hl").map((el) => el.getAttribute("data-rank")), ["2", "1", "0"], "rank 0 is the newest");
	assert.equal(r.mind()?.hidden, true, "one thing is in paper at a time (Z-D15)");
});

test("a line is clear for 20 s from the moment it is first on screen, then fades over 3 minutes; the mindfulness line comes back only when every line has", async () => {
	const r = rig({ items: [bossLine("u1", "go", 1), headLine("a1", "ok", 2)] });
	await r.start();
	await r.settle();
	const delays = () => r.by("zen-hl").map((el) => el.style.animationDelay);
	assert.deepEqual(delays(), [`${CLEAR_MS / 1000}s`, `${CLEAR_MS / 1000}s`], "clear for 20 s, then the one CSS animation of opacity; no timer repaints");
	await r.advance(CLEAR_MS + FADE_MS - 1);
	assert.equal(r.mind()?.hidden, true);
	await r.advance(20); // the timer carries a little slack
	assert.equal(r.mind()?.hidden, false, "all at rest: the mindfulness line is back");
	r.put([bossLine("u1", "go", 1), headLine("a1", "ok", 2), bossLine("u2", "and again", 3), headLine("a2", "a new one", 4)]);
	await r.settle();
	assert.equal(r.mind()?.hidden, true, "a new line starts clear, whatever the time of its item");
	const [, , fresh] = r.by("zen-hl");
	assert.equal(fresh!.style.animationDelay, `${CLEAR_MS / 1000}s`);
});

test("a click on the hint unfolds the input, focused; Enter on the circle does the same when no control has the focus, and nothing else on the keyboard does", async () => {
	const r = rig();
	await r.start();
	assert.equal(r.press(" "), false, "Space is not Enter: it ends a pause, and there is none");
	assert.equal(r.press("a"), false, "typing anything else while it is folded does nothing");
	assert.equal(r.form().hidden, true);
	assert.equal(r.press("Enter", r.hint()), false, "a focused control keeps its own Enter (the button's click does it)");
	assert.equal(r.press("Enter"), true);
	assert.equal(r.form().hidden, false);
	assert.equal(r.hint().hidden, true, "the hint gives way to the box");
	assert.equal(page.focused, r.box(), "focused");
	assert.equal(r.box().getAttribute("placeholder"), "Tell the head tower what to do");
	const again = rig();
	await again.start();
	again.unfold();
	assert.equal(again.form().hidden, false, "a click unfolds it too");
});

test("Enter sends the text to the head's input as a send; Shift+Enter, an Enter that belongs to an input method, and an empty box send nothing", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.enter();
	assert.deepEqual(r.calls.posts, [], "an empty box sends nothing");
	r.typed("tell Harbor to fix the rounding");
	r.enter({ shiftKey: true });
	r.enter({ isComposing: true });
	r.enter({ keyCode: 229 });
	assert.deepEqual(r.calls.posts, []);
	r.enter();
	await r.settle();
	assert.deepEqual(r.calls.posts, [{ key: "sb-head", action: "input", body: { text: "tell Harbor to fix the rounding", as: "send" } }]);
});

test("a sent message shows at once as the boss's line; the box empties and stays open; the stream's copy of it takes the place of the local one", async () => {
	const r = rig({ items: [headLine("a1", "Ready.", 1)] });
	await r.start();
	r.unfold();
	r.typed("start MP-4129");
	r.enter();
	assert.equal(r.box().value, "", "emptied");
	assert.deepEqual(r.lines(), ["Ready.", "start MP-4129"], "his line, at once, before any answer");
	assert.equal(r.by("zen-hl").at(-1)!.getAttribute("data-who"), "boss");
	await r.settle();
	assert.equal(r.form().hidden, false, "the box stays open");
	r.put([headLine("a1", "Ready.", 1), bossLine("u9", "start MP-4129", 2)]);
	await r.settle();
	assert.deepEqual(r.lines(), ["Ready.", "start MP-4129"], "not twice");
});

test("a refusal shows the server's words under the box with the low bowl, takes the line back, and the draft stays; no answer at all says it could not reach the server", async () => {
	const r = rig({ reply: async () => ({ ok: false, status: 409, body: { error: "refused", reason: "The head tower is busy." } }) });
	await r.start();
	r.unfold();
	r.typed("do it");
	r.enter();
	await r.settle();
	assert.equal(r.note(), "The head tower did not take it: the head tower is busy.");
	assert.equal(r.box().value, "do it", "the draft stays");
	assert.deepEqual(r.calls.sound, ["low"]);
	assert.deepEqual(r.lines(), [], "his line is taken back");
	const down = rig({ reply: async () => Promise.reject(new Error("net")) });
	await down.start();
	down.unfold();
	down.typed("again");
	down.enter();
	await down.settle();
	assert.equal(down.note(), "Could not reach the server");
	assert.equal(down.box().value, "again");
	down.typed("again, more");
	assert.equal(down.note(), "", "typing clears the words");
});

test("Esc folds the input and does nothing else; the draft is kept for this visit and is there at the next unfold; an empty box folds when it loses the focus, one with text does not", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("half a thought");
	assert.equal(r.esc(), true);
	assert.equal(r.form().hidden, true, "folded");
	assert.equal(r.calls.leave.length, 0, "and nothing else: no hint, no leaving");
	assert.equal(r.by("zen-esc")[0]?.textContent, "", "the quiet line did not show");
	r.unfold();
	assert.equal(r.box().value, "half a thought", "the draft came back");
	r.typed("");
	r.box().blur();
	assert.equal(r.form().hidden, true, "a blur with an empty box folds it");
	r.unfold();
	r.typed("kept");
	r.box().blur();
	assert.equal(r.form().hidden, false, "a blur with text folds nothing");
});

test("Zen hiding drops the draft, and every visit starts at the circle with the input folded", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("secret draft");
	r.z.hide();
	r.z.show();
	await r.settle();
	assert.equal(r.form().hidden, true);
	r.unfold();
	assert.equal(r.box().value, "", "the draft did not survive hiding");
});

test("while the stream is down the box is disabled and says why; it comes back with the stream", async () => {
	const r = rig({ offline: true });
	await r.start();
	r.unfold();
	assert.equal(r.box().disabled, true);
	assert.equal(r.note(), "offline");
	const ok = rig();
	await ok.start();
	ok.unfold();
	assert.equal(ok.box().disabled, false);
});

test("with no tower service the folded line says so and does not unfold; before the first snapshot there is no strip", async () => {
	const r = rig({ head: null });
	await r.start();
	assert.equal(r.hint().textContent, "The head tower needs the tower service (towerRuns)");
	assert.equal(r.hint().disabled, true);
	r.unfold();
	assert.equal(r.press("Enter"), false);
	assert.equal(r.form().hidden, true);
	assert.equal(r.calls.watch.at(-1), null, "nothing to watch");
	const none = rig();
	none.z.show();
	await none.settle();
	assert.equal(none.strip()!.hidden, true, "no snapshot yet: the strip is not drawn");
});

test("an item takes the screen from the strip as today and the stream stops watching the head; what the head says meanwhile changes nothing until the circle is back, where the new line starts clear", async () => {
	const r = rig({ items: [headLine("a1", "old words", 1)] });
	await r.start();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(r.mind()?.hidden, false, "at rest");
	r.feed(net(head(), [waiting()]));
	await r.settle();
	assert.equal(r.by("zen-head").length, 0, "the card replaced the strip");
	assert.equal(r.calls.watch.at(-1), null, "nothing watches the head now");
	r.z.history({ key: "sb-head", reset: true, items: [headLine("a1", "old words", 1), bossLine("u2", "more", 4), headLine("a2", "new words", 5)] });
	assert.equal(r.root.textContent.includes("new words"), false, "the reply changes nothing on the card");
	r.feed(net(head()));
	await r.advance(5000); // the item is gone: the outcome, the pause, the circle
	await r.advance(5000);
	assert.equal(r.calls.watch.at(-1), "sb-head", "back at the circle the stream watches the head again");
	assert.ok(r.lines().includes("new words"));
	assert.equal(r.by("zen-hl").at(-1)!.style.animationDelay, `${CLEAR_MS / 1000}s`, "clear again");
	assert.ok(r.by("zen-hl")[0]!.style.animationDelay.startsWith("-"), "an old line carries on from where it was: its animation starts with a negative delay");
});

test("a draft in the box holds the screen against an item for DRAFT_MS after the last touch; sending or emptying the box lets it in", async () => {
	const r = rig();
	await r.start();
	r.unfold();
	r.typed("writing to the head");
	r.root.bubble("keydown", { key: "x" });
	r.feed(net(head(), [waiting()]));
	await r.advance(DRAFT_MS - 1000);
	assert.equal(r.by("zen-card").length, 0, "the item waits while he writes");
	await r.advance(2000);
	assert.equal(r.by("zen-card").length, 1, "20 s after his last touch it takes the screen");
	const s = rig();
	await s.start();
	s.unfold();
	s.typed("short");
	s.root.bubble("keydown", { key: "x" });
	s.feed(net(head(), [waiting()]));
	await s.advance(1000);
	assert.equal(s.by("zen-card").length, 0);
	s.typed("");
	await s.advance(1000);
	assert.equal(s.by("zen-card").length, 1, "an emptied box lets it in");
});

test("while the head runs the lines say it is on it, with no spinner, and the live region says its next reply once", async () => {
	const r = rig({ head: head({ mark: "working" }) });
	await r.start();
	assert.equal(r.by("zen-head-working")[0]!.hidden, false);
	assert.equal(r.by("zen-head-working")[0]!.textContent, "The head tower is on it…");
	r.feed(net(head()));
	assert.equal(r.by("zen-head-working")[0]!.hidden, true, "idle again");
	r.put([headLine("a1", "Done: sent to Harbor.", 3)]);
	await r.settle();
	assert.equal(r.by("zen-head-live")[0]!.textContent, "Done: sent to Harbor.");
	const quiet = rig({ items: [headLine("a0", "from before", 1)] });
	await quiet.start();
	await quiet.settle();
	assert.equal(quiet.by("zen-head-live")[0]!.textContent, "", "the lines that were already there are not announced");
});

test("a wait for the boss keeps the newest line clear and the mindfulness line away until he writes", async () => {
	const waits = service({ memory: { rev: 1, standing: 0, decisions: 0, waits: 1, bossWaits: [{ id: "w1", text: "orchard?", at: at(5) }], proposals: [] } });
	const r = rig({ head: head({ service: waits }), items: [headLine("a1", "Should I rerun the ETL tonight?", 5)] });
	await r.start();
	await r.advance(CLEAR_MS + FADE_MS + 60_000);
	assert.equal(r.mind()?.hidden, true, "held: the mindfulness line stays away");
	assert.equal(r.by("zen-hl")[0]!.getAttribute("data-held"), "", "and the newest line is marked held, which the page keeps clear");
	r.unfold();
	r.typed("tonight, yes");
	r.enter();
	await r.settle();
	assert.equal(r.by("zen-hl").at(-1)!.getAttribute("data-held"), null, "he wrote: nothing is held by the old question");
});

test("pointing at the strip or focusing it brightens the lines at once and lets them go 1.5 s after; a touch holds them for 10 s, and a touch elsewhere ends it", async () => {
	const r = rig({ items: [headLine("a1", "fading", 1)] });
	await r.start();
	await r.settle();
	const strip = r.strip()!;
	strip.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(strip.getAttribute("data-bright"), "");
	strip.bubble("pointerleave", { pointerType: "mouse" });
	await r.advance(1400);
	assert.equal(strip.getAttribute("data-bright"), "", "still bright 1.4 s after");
	await r.advance(200);
	assert.equal(strip.getAttribute("data-bright"), null, "back on its curve");
	r.hint().bubble("focusin");
	assert.equal(strip.getAttribute("data-bright"), "", "focus anywhere in the strip");
	r.hint().bubble("focusout");
	await r.advance(1600);
	assert.equal(strip.getAttribute("data-bright"), null);
	strip.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(strip.getAttribute("data-bright"), "", "a tap");
	await r.advance(9000);
	assert.equal(strip.getAttribute("data-bright"), "");
	await r.advance(1100);
	assert.equal(strip.getAttribute("data-bright"), null, "10 s");
	strip.bubble("pointerdown", { pointerType: "touch" });
	r.root.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(strip.getAttribute("data-bright"), null, "a tap elsewhere ends it");
});

test("lines at rest that a hover, a focus, or a tap makes clear are not at rest: the mindfulness line steps aside and the Whole conversation link shows, and both come back when the lines let go", async () => {
	const r = rig({ items: [headLine("a1", "fading", 1)] });
	await r.start();
	await r.settle();
	await r.advance(CLEAR_MS + FADE_MS + 20);
	const strip = r.strip()!, link = () => r.by("zen-head-history")[0]!;
	assert.equal(r.mind()?.hidden, false, "at rest");
	assert.equal(link().hidden, true);
	strip.bubble("pointerenter", { pointerType: "mouse" });
	assert.equal(r.mind()?.hidden, true, "pointed at: the line is clear, so it is the one thing in paper");
	assert.equal(link().hidden, false, "and the way to the whole conversation shows");
	strip.bubble("pointerleave", { pointerType: "mouse" });
	await r.advance(1600);
	assert.equal(r.mind()?.hidden, false, "let go: the breath's line is back");
	assert.equal(link().hidden, true);
	r.hint().bubble("focusin");
	assert.equal(r.mind()?.hidden, true, "focus in the strip brightens the lines too");
	r.hint().bubble("focusout");
	await r.advance(1600);
	strip.bubble("pointerdown", { pointerType: "touch" });
	assert.equal(r.mind()?.hidden, true, "a tap");
	await r.advance(10_100);
	assert.equal(r.mind()?.hidden, false, "10 s later");
});

// The history: the head as a companion, opened four ways and closed four ways.
const stage = (r: ReturnType<typeof rig>) => r.by("zen-stage")[0]!;
const open = (r: ReturnType<typeof rig>) => r.by("zen-company").length === 1;

test("the history opens by a wheel gesture up past 24 px, a swipe up over 40 px, H, and the Whole conversation link; its composer posts to the head", async () => {
	const ways: [string, (r: ReturnType<typeof rig>) => void][] = [
		["wheel", (r) => stage(r).bubble("wheel", { deltaY: -30, deltaMode: 0, timeStamp: 10 })],
		["swipe", (r) => (stage(r).bubble("touchstart", { touches: [{ clientY: 400 }], timeStamp: 10 }), stage(r).bubble("touchend", { changedTouches: [{ clientY: 340 }], timeStamp: 200 }))],
		["H", (r) => assert.equal(r.z.key("history"), true)],
		["link", (r) => r.by("zen-head-history")[0]!.click()],
	];
	for (const [name, go] of ways) {
		const r = rig({ items: [headLine("a1", "something", 1)] });
		await r.start();
		await r.settle();
		assert.equal(open(r), false);
		go(r);
		await r.settle();
		assert.equal(open(r), true, name);
		assert.equal(r.calls.watch.at(-1), "sb-head", `${name}: the log is the head's`);
		assert.deepEqual(r.calls.composers.map((c) => c.key), ["sb-head"], `${name}: the composer is the head's`);
		assert.equal(r.by("zen-who")[0]!.textContent, "Head tower");
	}
	const small = rig({ items: [headLine("a1", "something", 1)] });
	await small.start();
	stage(small).bubble("wheel", { deltaY: -10, deltaMode: 0, timeStamp: 10 });
	stage(small).bubble("wheel", { deltaY: 10, deltaMode: 0, timeStamp: 20 });
	assert.equal(open(small), false, "a short gesture is not one");
	stage(small).bubble("touchstart", { touches: [{ clientY: 400 }], timeStamp: 10 });
	stage(small).bubble("touchend", { changedTouches: [{ clientY: 370 }], timeStamp: 200 });
	assert.equal(open(small), false, "nor is a short swipe");
});

test("the link shows only while the lines are clear; the history closes by Esc, H again, Back to the breath, and a wheel gesture down past the bottom, each to the strip with the input folded", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	await r.settle();
	assert.equal(r.by("zen-head-history")[0]!.hidden, false, "shown while a line is clear");
	await r.advance(CLEAR_MS + FADE_MS + 20);
	assert.equal(r.by("zen-head-history")[0]!.hidden, true, "gone at rest: the wheel, swipe, and H still open it");
	for (const close of [
		(x: ReturnType<typeof rig>) => assert.equal(x.esc(), true),
		(x: ReturnType<typeof rig>) => assert.equal(x.z.key("history"), true),
		(x: ReturnType<typeof rig>) => x.by("zen-rest")[0]!.click(),
		(x: ReturnType<typeof rig>) => stage(x).bubble("wheel", { deltaY: 30, deltaMode: 0, timeStamp: 10, target: x.by("zen-log")[0] }),
	]) {
		const x = rig({ items: [headLine("a1", "something", 1)] });
		await x.start();
		await x.settle();
		x.unfold();
		x.typed("a draft");
		x.z.key("history");
		await x.settle();
		assert.equal(open(x), true);
		close(x);
		await x.settle();
		assert.equal(open(x), false);
		assert.equal(x.by("zen-head-hint").length, 1, "the strip is back");
		assert.equal(x.form().hidden, true, "with the input folded");
		assert.equal(x.calls.leave.length, 0, "and Zen was not left");
		assert.equal(x.calls.watch.at(-1), "sb-head");
	}
});

test("the history is not a step of [ and ]: the ring still wraps at the circle", async () => {
	const r = rig({ items: [headLine("a1", "something", 1)] });
	await r.start();
	r.z.key("history");
	await r.settle();
	assert.equal(open(r), true);
	assert.equal(r.z.cycle(1), false, "nothing to step to: no candidates");
	assert.equal(open(r), true);
});

test("the palette gains talk, the whole conversation, and the Standard page on the circle; they act through the layer", () => {
	const calls: string[] = [];
	const entries = entriesOf({ standard() {}, head: { talk: () => calls.push("talk"), history: () => calls.push("history"), page: () => calls.push("page") } }, {});
	assert.deepEqual(entries.filter((e) => e.id.startsWith("head")).map((e) => [e.id, e.label]), [["head-talk", "Talk to the head tower"], ["head-history", "The head tower's whole conversation"], ["head-page", "Open the head tower in Standard"]]);
	for (const e of entries.filter((x) => x.id.startsWith("head"))) e.run();
	assert.deepEqual(calls, ["talk", "history", "page"]);
	assert.equal(entriesOf({ standard() {} }, {}).some((e) => e.id.startsWith("head")), false, "no head, no entries");
});

test("the head page is one palette step away: its entry leaves Zen for the head route", async () => {
	const r = rig();
	await r.start();
	r.z.palette();
	const items = r.by("palette-item");
	const page = items.find((el) => el.textContent.includes("Open the head tower in Standard"));
	assert.ok(page, "listed");
	page!.click();
	assert.deepEqual(r.calls.leave.at(-1), { route: { view: "head" } });
});

test("nothing in the strip counts anything: no number for the asks, the queue, or the unread", async () => {
	const busy = head({ asks: [{ id: "H3", workspace: "w1", label: "Harbor", at: 1, open: true }, { id: "H2", workspace: "w2", label: "Lighthouse", at: 1, open: true }], service: service({ queued: 4 }), queued: [{ id: "q1" }, { id: "q2" }] as never, said: Date.now() });
	const r = rig({ head: busy, items: [headLine("a1", "Handed over.", 1)] });
	await r.start();
	await r.settle();
	assert.equal(/\d/.test(r.strip()!.textContent), false, `no digit in what the strip says: ${r.strip()!.textContent}`);
	assert.equal(r.by("zen-head-working")[0]!.hidden, true);
});

test("a refusal's reason reads after the colon in lower case when it is a plain English sentence, and an acronym or Chinese stays", () => {
	assert.equal(joined("The head tower is busy."), "the head tower is busy.");
	assert.equal(joined("API is down"), "API is down");
	assert.equal(joined("主塔台忙碌"), "主塔台忙碌");
});

test("the head's history in Zen reads a tower_send row as one quiet line, keeps every other row, and follows rows the log adds later", () => {
	const seen: { cb: () => void; on: boolean }[] = [], real = (globalThis as { MutationObserver?: unknown }).MutationObserver;
	(globalThis as { MutationObserver?: unknown }).MutationObserver = class { cb: () => void; entry = { cb: () => {}, on: true }; constructor(cb: () => void) { this.cb = cb; this.entry.cb = cb; seen.push(this.entry); } observe() {} disconnect() { this.entry.on = false; } };
	const row = (name: string, sum: string) => { const details = new El("details"), summary = new El("summary"), code = new El("code"), span = new El("span"); details.className = "act"; span.className = "sum"; code.textContent = name; span.textContent = sum; summary.append(code, span); details.append(summary); return { details, code, span }; };
	const root = new El("div"), forward = row("tower_send", "(workspace: Harbor API)"), other = row("bash", "(workspace: not a forward)");
	root.append(forward.details, other.details);
	const stop = quietForwards(root as unknown as HTMLElement);
	assert.equal(forward.span.textContent, "Sent to the Harbor API tower");
	assert.equal(forward.code.hidden, true, "the tool's name is not read");
	assert.ok(forward.details.classes.has("quiet"));
	assert.equal(other.span.textContent, "(workspace: not a forward)", "another tool's row is as it was");
	assert.equal(other.code.hidden, false);
	const later = row("tower_send", "(workspace: Lighthouse Web)");
	root.append(later.details);
	seen[0]!.cb();
	assert.equal(later.span.textContent, "Sent to the Lighthouse Web tower", "a row that comes with the stream is rewritten too");
	stop();
	assert.equal(seen[0]!.on, false);
	(globalThis as { MutationObserver?: unknown }).MutationObserver = real;
});
