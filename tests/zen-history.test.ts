import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Pending } from "../src/ask.ts";
import { El, page, stored } from "./fake-dom.ts";
import { alertsOf } from "../gui/alerts.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import type { With } from "../gui/zenmodel.ts";

// The Zen layer (gui/zen.ts) as the page drives it: the net's snapshots go in, the card, the pause, or the companion comes out, and every answer goes through the same panels
// and routes as Standard (ask.ts, trust.ts, the composer), which are the real ones here on a fake document. The composer and the log are stand-ins that record what they are given.
const { mountZen, real } = await import("../gui/zen.ts");
const { m } = await import("../gui/paraglide/messages.js");
type Exit = import("../gui/zen.ts").Exit;

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = [], tower = true): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", tower: tower ? { name: "tower", mark: "idle", key: "t", control: true, subs: [] } : null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust }) as Net;
const SELECT = (hereOnly = false) => ({ title: "Robot Hand: deploy", choices: ["Type it in a pane", "Copy it", "No thanks"].map((label) => ({ label, ...(hereOnly ? { hereOnly: true as const } : {}) })) });
const select = (o: { hereOnly?: boolean; cancel?: boolean; dialog?: string } = {}): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: o.dialog ?? "d1", digest: "0".repeat(64), select: SELECT(o.hereOnly), ...(o.cancel ? { cancel: true as const } : {}) } });
const questions = (): Pending => ({ callId: "c2", tool: "ask_user_question", answer: { dialog: "q1", digest: "1".repeat(64), cancel: true, questions: [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }] } });
const secret = (): Pending => ({ callId: "c3", tool: "secret_drop", why: "It waits for a secret." });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });
const TRUST = { id: "tr", digest: "d".repeat(64), folder: "/work/harbor", found: [{ kind: "skills", path: ".pi/skills", items: ["deploy"], more: 0 }], agents: [{ pane: "1", base: "Harbor", role: "member", at: 5 }] };

function rig(o: { offline?: boolean; ripple?: Record<string, unknown>; remote?: boolean | null; start?: With; latest?: () => Promise<{ items: Item[]; before?: string }> } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], leave: [] as Exit[], watch: [] as (string | null)[], remind: [] as string[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[], trust: [] as Record<string, unknown>[], applied: [] as HistoryEvent[], composers: [] as { key: string; box: El; updates: unknown[]; post: (a: never, b: Record<string, unknown>) => Promise<Answer> }[], logs: [] as string[], embeds: [] as string[] };
	const replies: ((r: Answer) => void)[] = [];
	const items: Item[] = [{ id: "a1", kind: "assistant", text: "I need a decision." } as Item];
	const mounts = {
		...real,
		composer: ((root: El, key: string, post: never) => {
			const box = new El("textarea");
			root.replaceChildren(box);
			const c = { key, box, updates: [] as unknown[], post };
			calls.composers.push(c);
			return { box, update: (u: unknown) => c.updates.push(u) };
		}) as never,
		chat: async () => (root: El, _data: unknown, _deps: unknown) => (calls.logs.push("mounted"), { apply: (e: HistoryEvent) => calls.applied.push(e), setLive() {}, reveal() {} } as unknown as Chat),
	};
	const deps = {
		data: () => ({ older: async () => ({ items: [] }), latest: o.latest ?? (async () => ({ items })), entry: async () => undefined }),
		recent: async () => items,
		post: (key: string) => (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), new Promise<Answer>((resolve) => replies.push(resolve))),
		trust: (body: Record<string, unknown>) => (calls.trust.push(body), new Promise<Answer>((resolve) => replies.push(resolve))),
		label: (ws: string) => (ws === "w" ? "Harbor" : ws), online: () => !o.offline,
		remind: (a: { key: string }) => void calls.remind.push(a.key), sound: (s: string) => void calls.sound.push(s), leave: (e: Exit) => void calls.leave.push(e), terminals: async () => ({ embed: (key: string) => (calls.embeds.push(key), () => {}), watch: () => ({ conn: {}, stop() {} }), post: () => async () => ({ ok: true, status: 200, body: {} }), stream: () => "st" }), watch: (k: string | null) => void calls.watch.push(k),
		remote: o.remote === null ? undefined : (o.remote ?? false), now: () => t, start: () => o.start ?? { key: "t", ws: "w" }, // a session for company: a card still takes the screen by itself; on the breathing circle it waits for Enter (Z-D19, zen-layer.test.ts)
		
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} }, // no full screen here: the control hides
		still: () => false, random: () => 0, ...(o.ripple ? { ripple: o.ripple } : {}),
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
	return {
		z, root, calls, advance, settle, items, now: () => t,
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		reply: async (body: Record<string, unknown>, status = 200) => (replies.shift()!({ ok: status < 400, status, body }), await settle()),
		button: (text: string) => root.all((el) => el.tagName === "button" && el.textContent === text)[0],
		by: (match: (el: El) => boolean) => root.all(match),
		text: () => root.textContent,
	};
}
const ok = { outcome: "accepted" };

// Zen Z4d: an item's card has a 「Context」 link that expands the unit's session log inside the card (lazy), H toggles it, Esc collapses it first.
const link = (r: ReturnType<typeof rig>) => r.by((el) => el.tagName === "button" && el.getAttribute("aria-keyshortcuts") === "H" && !el.hidden)[0];
const esc = (r: ReturnType<typeof rig>) => r.z.escape({ preventDefault() {} });
const waiting = (o: Partial<Unit> = {}) => net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }), ...o })]);

test("the card has a Context link that names its key; nothing of the log is fetched, mounted, or watched until it is tapped", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	assert.ok(link(r), "the link");
	assert.equal(link(r)!.textContent, m.zen_history());
	assert.match(link(r)!.textContent, /H/);
	assert.equal(link(r)!.getAttribute("aria-expanded"), "false");
	assert.deepEqual(r.calls.logs, []);
	assert.ok(!r.calls.watch.includes("a"));
});

test("tapping it mounts the log, watches the unit, and shows the history; tapping again collapses it and stops the watch", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	assert.deepEqual(r.calls.logs, ["mounted"]);
	assert.equal(r.calls.watch.at(-1), "a");
	assert.equal(link(r)!.getAttribute("aria-expanded"), "true");
	assert.equal(link(r)!.textContent, m.zen_history_hide());
	r.z.history({ key: "a", items: [], reset: true } as unknown as HistoryEvent);
	r.z.history({ key: "other", items: [], reset: true } as unknown as HistoryEvent);
	assert.equal(r.calls.applied.filter((e) => e.key === "a").length >= 1, true);
	assert.equal(r.calls.applied.some((e) => e.key === "other"), false, "only the unit's own events");
	link(r)!.click();
	await r.settle();
	assert.equal(r.calls.watch.at(-1), null);
	assert.equal(link(r)!.getAttribute("aria-expanded"), "false");
});

test("opening it scrolls the box into view, and closing it does not (Z7-F002)", async () => {
	const seen: unknown[] = [];
	const proto = El.prototype as unknown as { scrollIntoView: (o?: unknown) => void };
	const orig = proto.scrollIntoView;
	proto.scrollIntoView = function (o?: unknown) { seen.push(o); };
	try {
		const r = rig();
		r.feed(waiting());
		r.z.show();
		await r.settle();
		link(r)!.click();
		await r.settle();
		assert.deepEqual(seen, [{ block: "nearest" }]);
		link(r)!.click();
		await r.settle();
		assert.equal(seen.length, 1, "closing scrolls nothing");
	} finally {
		proto.scrollIntoView = orig;
	}
});

test("a new snapshot while it is open keeps the watch", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	const n = r.calls.watch.length;
	r.feed(waiting());
	await r.settle();
	assert.notEqual(r.calls.watch.at(-1), null);
	assert.ok(r.calls.watch.length >= n);
});

test("the answer stays possible while the history is open", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	assert.equal(r.calls.posts.length, 1);
});

test("Esc collapses the history first; the next Esc is the card's own", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	esc(r);
	await r.settle();
	assert.equal(link(r)!.getAttribute("aria-expanded"), "false");
	assert.equal(r.calls.watch.at(-1), null);
	assert.equal(r.calls.posts.length, 0);
	assert.equal(r.calls.leave.length, 0);
});

test("H toggles it through toggleHistory(); false when the card has no link", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	assert.equal(r.z.toggleHistory(), true);
	await r.settle();
	assert.equal(link(r)!.getAttribute("aria-expanded"), "true");
	assert.equal(r.z.toggleHistory(), true);
	assert.equal(link(r)!.getAttribute("aria-expanded"), "false");
	const none = rig();
	none.feed(net([], [TRUST]));
	none.z.show();
	await none.settle();
	assert.equal(none.z.toggleHistory(), false);
});

test("no link for a trust question or a tower with no run; an outside pi pane has its session file, so it has the link (Z4D-F003, M4)", async () => {
	const tower = rig();
	tower.feed({ bases: [{ id: "w", label: "Harbor", mark: "waiting", tower: { name: "tower", mark: "waiting", key: "t", control: true, subs: [], since: 5, pending: select({ cancel: true }) }, tabs: [], outposts: [], outside: [] }], trust: [] } as unknown as Net);
	tower.z.show();
	await tower.settle();
	assert.equal(link(tower), undefined, "a tower with no run");
	const trust = rig();
	trust.feed(net([], [TRUST]));
	trust.z.show();
	await trust.settle();
	assert.equal(link(trust), undefined);
	const outside = rig();
	outside.feed(waiting({ role: "outside" }));
	outside.z.show();
	await outside.settle();
	assert.ok(link(outside), "an outside pane");
});

test("a card that leaves while its context is open or loading mounts and fetches nothing (Z4D-F004, M3)", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click(); // open, the chunk not yet arrived
	r.feed(net([]));
	await r.settle();
	assert.deepEqual(r.calls.logs, [], "no mount for a card that is gone");
	assert.equal(r.calls.watch.at(-1), null);
	const swap = rig();
	swap.feed(waiting());
	swap.z.show();
	await swap.settle();
	link(swap)!.click();
	swap.feed(net([unit("b", "waiting", { name: "b", since: 6, pending: select({ cancel: true }) })]));
	await swap.settle();
	assert.deepEqual(swap.calls.logs, [], "swapped for another card");
});

test("Esc collapses the history before a field with text, which keeps its text (Z4D-F008, M1)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	const box = r.by((el) => el.tagName === "textarea" || el.tagName === "input")[0];
	if (box) {
		(box as unknown as { value: string }).value = "draft";
		page.focused = box as never;
		esc(r);
		await r.settle();
		assert.equal(link(r)!.getAttribute("aria-expanded"), "false", "history first");
		assert.equal((box as unknown as { value: string }).value, "draft");
	}
});

test("H does nothing while the corner menu or the terminal layer is open (Z4D-F005, M6, M7)", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	const menu = r.by((el) => el.getAttribute("class") === "zen-menubtn")[0]!;
	menu.click();
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-menu")[0]!.hidden, false, "the menu is open");
	assert.equal(r.z.toggleHistory(), false);
	assert.equal(link(r)!.getAttribute("aria-expanded"), "false");
	menu.click();
	assert.equal(r.z.toggleHistory(), true, "with the menu closed it acts");
	assert.equal(r.z.toggleHistory(), true);
	const term = rig();
	term.feed(waiting());
	term.z.show();
	await term.settle();
	term.z.terminal({ key: "a" } as never);
	await term.settle();
	await term.settle();
	assert.equal(term.z.toggleHistory(), false, "the terminal layer has the keys");
	assert.equal(link(term)!.getAttribute("aria-expanded"), "false");
});

test("closing the context from inside it returns the focus to its link (Z4D-F006, M8)", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	const region = r.by((el) => el.getAttribute("class") === "zen-history")[0]!;
	const inside = new El("button");
	region.append(inside);
	inside.focus();
	assert.equal(page.focused, inside);
	esc(r);
	assert.equal(page.focused, link(r), "Esc");
	link(r)!.click();
	await r.settle();
	const again = new El("button");
	region.append(again);
	again.focus();
	assert.equal(r.z.toggleHistory(), true);
	assert.equal(page.focused, link(r), "H");
});

test("a card that leaves for another, while its unit stays in the net, closes its context (Z4D-F004)", async () => {
	const r = rig();
	const both = (a: Mark) => net([unit("a", a, { name: "a", since: 5, ...(a === "waiting" ? { pending: select({ cancel: true }) } : {}) }), unit("b", "waiting", { name: "b", since: 6, pending: select({ cancel: true, dialog: "d2" }) })]);
	r.feed(both("waiting"));
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	const region = r.by((el) => el.getAttribute("class") === "zen-history")[0]!;
	assert.equal(region.hidden, false);
	r.feed(both("idle"));
	await r.advance(5000);
	assert.equal(region.hidden, true, "the old card's context is closed");
	assert.equal(r.calls.watch.at(-1), null);
});

test("the link points at the region it opens (Z4D-F006)", async () => {
	const r = rig();
	r.feed(waiting());
	r.z.show();
	await r.settle();
	const id = link(r)!.getAttribute("aria-controls");
	assert.ok(id);
	assert.equal(r.by((el) => el.getAttribute("id") === id).length, 1);
});

test("history that arrives while the page is fetched is applied again after it (Z3RR-F002, M5)", async () => {
	let release!: (v: { items: Item[] }) => void;
	const r = rig({ latest: () => new Promise((done) => (release = done)) });
	r.feed(waiting());
	r.z.show();
	await r.settle();
	link(r)!.click();
	await r.settle();
	const ev = { key: "a", items: [{ id: "x", kind: "assistant", text: "later" }] } as unknown as HistoryEvent;
	r.z.history(ev);
	release({ items: [] });
	await r.settle();
	const at = r.calls.applied.map((e) => (e === ev ? "ev" : e.reset ? "reset" : "?"));
	assert.equal(at.at(-1), "ev");
	assert.ok(at.includes("reset"));
	assert.ok(at.lastIndexOf("ev") > at.indexOf("reset"));
});

test("both languages say it and name the key", async () => {
	const en = JSON.parse((await import("node:fs")).readFileSync(new URL("../gui/messages/en.json", import.meta.url), "utf8"));
	const zh = JSON.parse((await import("node:fs")).readFileSync(new URL("../gui/messages/zh-TW.json", import.meta.url), "utf8"));
	for (const k of ["zen_history", "zen_history_hide"]) for (const l of [en, zh]) assert.match(l[k], /H/);
	assert.equal(zh.zen_history, "前情（H）");
});
