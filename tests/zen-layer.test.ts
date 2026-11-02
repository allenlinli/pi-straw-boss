import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Pending } from "../src/ask.ts";
import { El, page, stored } from "./zen-dom.ts";
import { alertsOf } from "../gui/alerts.ts";
import type { Chat, HistoryEvent } from "../gui/chat.ts";
import type { Answer } from "../gui/post.ts";
import type { With } from "../gui/zenwith.ts";

// The Zen layer (gui/zen.ts) as the page drives it: the net's snapshots go in, the card, the pause, or the companion comes out, and every answer goes through the same panels
// and routes as Standard (ask.ts, trust.ts, the composer), which are the real ones here on a fake document. The composer and the log are stand-ins that record what they are given.
const { DRAFT_MS, mountZen, real } = await import("../gui/zen.ts");
type Exit = import("../gui/zen.ts").Exit;

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = [], tower = true): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", head: true, tower: tower ? { name: "tower", mark: "idle", key: "t", control: true, subs: [] } : null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust }) as Net;
const SELECT = (hereOnly = false) => ({ title: "Robot Hand: deploy", choices: ["Type it in a pane", "Copy it", "No thanks"].map((label) => ({ label, ...(hereOnly ? { hereOnly: true as const } : {}) })) });
const select = (o: { hereOnly?: boolean; cancel?: boolean; dialog?: string } = {}): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: o.dialog ?? "d1", digest: "0".repeat(64), select: SELECT(o.hereOnly), ...(o.cancel ? { cancel: true as const } : {}) } });
const questions = (): Pending => ({ callId: "c2", tool: "ask_user_question", answer: { dialog: "q1", digest: "1".repeat(64), cancel: true, questions: [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }] } });
const secret = (): Pending => ({ callId: "c3", tool: "secret_drop", why: "It waits for a secret." });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });
const TRUST = { id: "tr", digest: "d".repeat(64), folder: "/work/harbor", found: [{ kind: "skills", path: ".pi/skills", items: ["deploy"], more: 0 }], agents: [{ pane: "1", base: "Harbor", role: "member", at: 5 }] };

function rig(o: { offline?: boolean; ripple?: Record<string, unknown>; remote?: boolean | null; stored?: With; latest?: () => Promise<{ items: Item[]; before?: string }> } = {}) {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { sound: [] as string[], leave: [] as Exit[], watch: [] as (string | null)[], remind: [] as string[], posts: [] as { key: string; action: string; body: Record<string, unknown> }[], trust: [] as Record<string, unknown>[], applied: [] as HistoryEvent[], composers: [] as { key: string; box: El; updates: unknown[]; post: (a: never, b: Record<string, unknown>) => Promise<Answer> }[], logs: [] as string[] };
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
		remind: (a: { key: string }) => void calls.remind.push(a.key), sound: (s: string) => void calls.sound.push(s), leave: (e: Exit) => void calls.leave.push(e), watch: (k: string | null) => void calls.watch.push(k),
		remote: o.remote === null ? undefined : (o.remote ?? false), now: () => t, stored: () => o.stored,
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

test("an answerable select draws through the dialog's own panel: Send, Cancel where the owner takes one, and Not now; the first option takes the focus", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select({ cancel: true }) })]));
	r.z.show();
	await r.settle();
	assert.equal(r.root.hidden, false);
	assert.deepEqual(r.calls.sound, ["bowl"], "the bowl as the item takes the screen");
	assert.ok(r.text().includes("ops-main") && r.text().includes("Harbor"), "who asks, and from which base");
	assert.ok(r.text().includes("I need a decision."), "what it last said");
	for (const label of ["Send answer", "Cancel", "Maybe later"]) assert.ok(r.button(label), label);
	assert.equal(r.button("Show terminal"), undefined);
	assert.equal(page.focused, r.by((el) => el.getAttribute("role") === "radio")[0], "the focus goes to the first answer control");
	assert.equal(r.by((el) => el.getAttribute("aria-live") === "polite")[0]!.textContent, "ops-main wants to ask you");
	assert.ok(!r.button("Cancel")!.disabled);
	r.by((el) => el.getAttribute("role") === "radio")[2]!.click();
	r.button("Send answer")!.click();
	assert.deepEqual(r.calls.posts.map((p) => [p.key, p.action, p.body.choice, p.body.dialog]), [["a", "answer", 2, "d1"]], "the same route and body as Standard");
});

test("a questionnaire has Send and Cancel; no Cancel without an owner that takes one", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	assert.ok(r.button("Send answer") && r.button("Cancel") && r.button("Maybe later"));
	const again = rig();
	again.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	again.z.show();
	await again.settle();
	assert.equal(again.button("Cancel"), undefined, "the owner did not say it takes a cancel");
	assert.ok(again.button("Maybe later"), "Not now is on every card");
});

const several = (): Pending => ({ callId: "c5", tool: "ask_user_question", answer: { dialog: "q2", digest: "2".repeat(64), cancel: true, questions: [{ question: "Ship it?", header: "Ship", multiple: false, options: [{ title: "Yes" }, { title: "No" }] }, { question: "Which channels?", header: "Channels", multiple: false, options: [{ title: "email" }, { title: "chat" }] }] } });

test("a card with several questions puts them in one column with the first focused; one question stays as it was; the same dialog on a new snapshot keeps its scroller and the pick", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: several() })]));
	r.z.show();
	await r.settle();
	const scrollers = () => r.by((el) => el.getAttribute("class") === "zen-qs");
	assert.equal(scrollers().length, 1);
	const blocks = scrollers()[0]!.children, radios = r.by((el) => el.getAttribute("role") === "radio");
	assert.deepEqual(blocks.map((b) => b.dataset.dim !== undefined), [false, true], "the first is focused, the other faded");
	assert.equal(page.focused, radios[0], "the keyboard focus lands inside the focused question");
	assert.ok(r.button("Send answer") && !scrollers()[0]!.all((el) => el.textContent === "Send answer").length, "Send is outside the scroller");
	const note = r.by((el) => el.getAttribute("aria-label") === "Note")[0]!;
	note.focus();
	note.bubble("keydown", { key: "Tab", shiftKey: false });
	assert.deepEqual(blocks.map((b) => b.dataset.dim !== undefined), [true, false], "Tab moves the focus to the second question");
	assert.equal(page.focused, radios[2]);
	radios[0]!.click();
	r.feed(net([unit("a", "waiting", { since: 5, pending: several() })]));
	await r.settle();
	assert.equal(scrollers().length, 1);
	assert.equal(scrollers()[0], blocks[0]!.parent, "the same scroller");
	assert.equal(r.by((el) => el.getAttribute("role") === "radio")[0]!.getAttribute("aria-checked"), "true", "the pick survived the snapshot");
	const one = rig();
	one.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	one.z.show();
	await one.settle();
	assert.equal(one.by((el) => el.getAttribute("class") === "zen-qs").length, 0, "a single question is not wrapped");
});

test("on a paired device a hereOnly choice is disabled and Cancel needs a choice the device may give; on this computer both are offered", async () => {
	const paired = rig({ remote: true });
	paired.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })]));
	paired.z.show();
	await paired.settle();
	assert.ok(paired.button("Cancel"), "some choice is the device's to give");
	const here = rig({ remote: true });
	here.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, hereOnly: true }) })]));
	here.z.show();
	await here.settle();
	assert.equal(here.button("Cancel"), undefined, "every choice is hereOnly: a cancel would be refused as well");
	const radios = here.by((el) => el.getAttribute("role") === "radio");
	assert.ok(radios.every((o) => o.disabled), "the hereOnly choices are shown, disabled");
	const local = rig({ remote: false });
	local.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, hereOnly: true }) })]));
	local.z.show();
	await local.settle();
	assert.ok(local.by((el) => el.getAttribute("role") === "radio").every((o) => !o.disabled), "this computer's page may give them");
	assert.ok(local.button("Cancel"));
});

test("a secret_drop is read-only on every page with no Open in Standard; any other read-only dialog offers Open in Standard, which leaves for the unit's terminal", async () => {
	for (const remote of [false, true]) {
		const r = rig({ remote });
		r.feed(net([unit("a", "waiting", { since: 5, pending: secret() })]));
		r.z.show();
		await r.settle();
		assert.equal(r.button("Send answer"), undefined);
		assert.equal(r.button("Handle it in Standard"), undefined, "a secret is entered in the terminal only");
		assert.equal(r.button("Show terminal"), undefined);
		assert.ok(r.button("Maybe later"));
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: readonly() })]));
	r.z.show();
	await r.settle();
	assert.equal(r.button("Send answer"), undefined);
	assert.equal(r.button("Show terminal"), undefined, "Zen words it Open in Standard");
	r.button("Handle it in Standard")!.click();
	assert.deepEqual(r.calls.leave, [{ route: { view: "session", ws: "w", key: "a" }, terminal: "a" }]);
});

test("a trust question draws the trust panel with its three choices, answers through trust/answer, and has Not now", async () => {
	const r = rig();
	r.feed(net([], [TRUST]));
	r.z.show();
	await r.settle();
	assert.ok(r.text().includes("Trust this folder?") && r.text().includes("/work/harbor"));
	for (const label of ["Trust", "Trust this time", "Don't trust", "Maybe later"]) assert.ok(r.button(label), label);
	r.button("Trust this time")!.click();
	assert.equal(r.calls.trust.length, 1);
	assert.deepEqual([r.calls.trust[0]!.id, r.calls.trust[0]!.choice], ["tr", "once"]);
	await r.reply(ok);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
});

test("a unit that waits with no dialog has its last line, Not now, and Open in Standard, with no composer", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	assert.ok(r.text().includes("I need a decision."));
	assert.equal(r.calls.composers.length, 0);
	assert.ok(r.button("Maybe later"));
	r.button("Handle it in Standard")!.click();
	assert.deepEqual(r.calls.leave, [{ route: { view: "session", ws: "w", key: "a" }, terminal: "a" }]);
});

test("an accepted answer plays the knock, shows its outcome for 1.2 s, then the pause, then the companion; the item does not come back at once", async () => {
	const r = rig();
	const n = net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })]);
	r.feed(n);
	r.z.show();
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.reply(ok);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Answered."), "the card stays with its outcome");
	assert.ok(r.button("Maybe later")!.disabled, "and takes no second answer");
	r.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })])); // the snapshot before the unit moved on
	await r.advance(1300);
	assert.equal(r.by((el) => el.getAttribute("role") === "img")[0]?.getAttribute("aria-label"), "Take a breath", "the pause is the breathing circle");
	const going = r.by((el) => el.dataset.gone !== undefined);
	assert.equal(going.length, 1, "the answered card dissolves like ink for a moment");
	assert.equal(going[0]!.getAttribute("inert"), "", "and takes no input meanwhile");
	await r.advance(1500);
	assert.equal(r.button("Maybe later"), undefined);
	assert.equal(r.by((el) => el.dataset.gone !== undefined).length, 0, "then it is gone");
	await r.advance(1600);
	assert.equal(r.calls.sound.length, 2, "no second bowl for the answered item");
	assert.ok(r.text().includes("tower") || r.calls.composers.length === 1, "the companion shows");
	assert.equal(r.calls.composers.at(-1)!.key, "t");
});

test("a refused answer plays the low bowl and keeps the card; the item's later exit is silent", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	await r.reply({ outcome: "rejected", reason: "digest" });
	assert.deepEqual(r.calls.sound, ["bowl", "low"]);
	assert.ok(r.text().includes("The question changed; read it again."), "the card says why");
	assert.ok(r.button("Send answer"), "and stays");
	r.feed(net([unit("a", "working", { since: 9 })])); // the stale item leaves by itself
	assert.deepEqual(r.calls.sound, ["bowl", "low"], "that exit plays nothing");
});

test("Not now rests the item without a sound, a pause follows, and the item returns with the bowl after ten minutes", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.button("Maybe later")!.click();
	assert.deepEqual(r.calls.sound, ["bowl"]);
	await r.advance(3100);
	assert.equal(r.button("Maybe later"), undefined, "the companion shows, not the rested item");
	await r.advance(9 * 60_000);
	assert.equal(r.button("Maybe later"), undefined);
	await r.advance(60_000);
	assert.ok(r.button("Maybe later"), "back, in its place by age");
	assert.deepEqual(r.calls.sound, ["bowl", "bowl"]);
});

test("an item that stops waiting by itself plays the knock and says it was answered elsewhere", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.feed(net([unit("a", "working", { since: 9 })]));
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Already answered elsewhere"));
});

test("the page never says how many items wait or that more do: what it draws is the same with one, two, and five waiting, and names no other unit", async () => {
	const NAMES = ["alpha", "bravo", "charlie", "delta", "echo"];
	const shots = new Map<number, { card: string; pause: string }>();
	for (const count of [1, 2, 5]) {
		const r = rig();
		r.feed(net(NAMES.slice(0, count).map((name, i) => unit(name, "waiting", { name, since: 5 + i, pending: select() }))));
		r.z.show();
		await r.settle();
		const card = [r.root.dump(), r.text()].join(" ");
		for (const other of NAMES.slice(1, count)) assert.ok(!card.includes(other), `${other} is not on the screen`);
		assert.ok(!/queue|more|also|others|waiting/i.test(card), `no queue word (${count})`);
		r.button("Maybe later")!.click();
		await r.settle();
		shots.set(count, { card, pause: [r.root.dump(), r.text()].join(" ") });
		await r.advance(3100);
		if (count > 1) assert.ok(r.root.dump().includes("bravo"), "the next one comes by itself, with nothing said about it before");
	}
	assert.equal(shots.get(2)!.card, shots.get(1)!.card, "the card is the same with another waiting behind it");
	assert.equal(shots.get(5)!.card, shots.get(1)!.card);
	assert.equal(shots.get(2)!.pause, shots.get(1)!.pause, "so is the pause");
	assert.equal(shots.get(5)!.pause, shots.get(1)!.pause);
});

/** An Esc as the page gives it to the layer; `held` makes it a repeat of a key held down. */
const esc = (r: { z: { escape(e: { preventDefault(): void; repeat?: boolean }): boolean } }, held = false) => {
	let prevented = 0;
	const took = r.z.escape({ preventDefault: () => void prevented++, repeat: held });
	return { took, prevented };
};

test("Esc on an item cancels its question when it can be cancelled (the card's own Cancel), else it is Not now: the next card; it never leaves", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() }), unit("b", "waiting", { since: 9, name: "bravo", pending: select() })]));
	r.z.show();
	await r.settle();
	const out = esc(r);
	assert.deepEqual([out.took, out.prevented], [true, 1], "Zen takes it and the page goes nowhere");
	assert.deepEqual(r.calls.posts.map((p) => [p.key, p.action, p.body.cancel, p.body.dialog]), [["a", "answer", true, "q1"]], "the same body as the Cancel button");
	await r.reply(ok);
	assert.deepEqual(r.calls.leave, []);
	await r.advance(1300);
	await r.advance(3100);
	assert.ok(r.text().includes("bravo"), "the next card");
	assert.equal(r.button("Cancel"), undefined, "this one has no Cancel");
	esc(r);
	assert.equal(r.calls.posts.length, 1, "so Esc is Not now: nothing is sent");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the item rests and the pause starts");
	assert.deepEqual(r.calls.leave, [], "Esc on an item never leaves");
});

test("Esc on a card whose answer is on its way, or with its outcome showing, is not a second cancel: it counts toward leaving instead", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	esc(r);
	await r.reply(ok);
	assert.equal(r.calls.posts.length, 1);
	esc(r);
	assert.equal(r.calls.posts.length, 1, "the outcome is showing: no second cancel");
	assert.deepEqual(r.calls.leave, [], "one Esc is only the hint");
	assert.equal(r.by((el) => el.dataset.on !== undefined && el.getAttribute("class") === "zen-esc").length, 1, "the quiet line shows");
});

test("a field with text takes the first Esc as a blur (the text stays); an empty one is let go of on the companion's screen, and on a card Esc goes on to the card", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	const own = r.by((el) => el.tagName === "textarea")[0]!;
	own.focus();
	own.type("and the on-call");
	esc(r);
	assert.notEqual(page.focused, own, "blurred");
	assert.equal(own.value, "and the on-call", "the text stays");
	assert.deepEqual([r.calls.leave, r.calls.posts], [[], []], "nothing else happened");
	own.focus(); // an empty field on a card does not stand in the way
	own.value = "";
	esc(r);
	assert.equal(r.calls.posts.length, 1, "the card's question is cancelled");
	const idle = rig();
	idle.feed(net([unit("m", "working")]));
	idle.z.show();
	await idle.settle();
	const box = idle.calls.composers[0]!.box;
	box.focus();
	esc(idle);
	assert.notEqual(page.focused, box, "an empty box is let go of");
	assert.equal(idle.by((el) => el.getAttribute("class") === "zen-esc" && el.dataset.on !== undefined).length, 0, "and no hint: the key was taken");
	box.focus();
	box.type("half a thought");
	esc(idle);
	assert.notEqual(page.focused, box);
	assert.equal(box.value, "half a thought");
	assert.deepEqual(idle.calls.leave, []);
});

test("on the companion, the empty state, and the pause one Esc does nothing but show the line; a second within 600 ms leaves, a later one starts again", async () => {
	const idle = rig();
	idle.feed(net([unit("m", "working")]));
	idle.z.show();
	await idle.settle();
	const hint = () => idle.by((el) => el.getAttribute("class") === "zen-esc")[0]!;
	assert.equal(hint().textContent, "");
	esc(idle);
	assert.deepEqual(idle.calls.leave, [], "one Esc does not leave");
	assert.equal(hint().textContent, "Press Esc again for Standard");
	assert.notEqual(hint().dataset.on, undefined);
	await idle.advance(599);
	esc(idle);
	assert.deepEqual(idle.calls.leave, [{ route: { view: "session", ws: "w", key: "t" } }], "the second within 600 ms leaves for the companion's session");
	assert.equal(hint().textContent, "", "the line goes");
	const slow = rig();
	slow.feed(net([unit("m", "working")]));
	slow.z.show();
	await slow.settle();
	esc(slow);
	await slow.advance(601);
	assert.equal(slow.by((el) => el.getAttribute("class") === "zen-esc")[0]!.dataset.on, undefined, "the line fades with the window");
	await slow.advance(400);
	assert.equal(slow.by((el) => el.getAttribute("class") === "zen-esc")[0]!.textContent, "", "and its words go after the fade");
	esc(slow);
	assert.deepEqual(slow.calls.leave, [], "a second after the window is a first again");
	const empty = rig();
	empty.feed(net([unit("m", "working")], [], false));
	empty.z.show();
	await empty.settle();
	esc(empty);
	esc(empty);
	assert.deepEqual(empty.calls.leave, [{}], "the empty state leaves for the page");
	const pause = rig();
	pause.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	pause.z.show();
	await pause.settle();
	pause.button("Maybe later")!.click();
	esc(pause);
	assert.deepEqual(pause.calls.leave, []);
	esc(pause);
	assert.deepEqual(pause.calls.leave, [{}], "a pause just returns to the page");
});

test("a held Esc repeats into nothing; another key taken between two Esc breaks the pair; Esc in the menu closes the menu only", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	esc(r);
	assert.deepEqual([esc(r, true).took, r.calls.leave], [true, []], "a repeat is no second press");
	const box = r.calls.composers[0]!.box;
	box.focus();
	esc(r);
	esc(r);
	assert.deepEqual(r.calls.leave, [], "a blur between the two took one of them: the pair starts over");
	const menu = r.by((el) => el.getAttribute("class") === "zen-menubtn")[0]!;
	menu.click();
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-menu")[0]!.hidden, true, "the menu closed");
	assert.deepEqual(r.calls.leave, [], "and nothing else");
	esc(r);
	esc(r);
	assert.equal(r.calls.leave.length, 1, "the next two leave");
});

test("Esc is Zen's only while it shows: a hidden layer lets the page have it", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	assert.equal(esc(r).took, false, "not yet shown");
	r.z.show();
	await r.settle();
	r.z.hide();
	assert.equal(esc(r).took, false, "hidden again");
});

test("a hidden page's pause ends when the page is shown; a tap ends the pause", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.button("Maybe later")!.click();
	r.z.visible(false);
	await r.advance(5000);
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "still the pause: no one was there to breathe");
	r.z.visible(true);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "shown: it ends at once");
	const tap = rig();
	tap.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	tap.z.show();
	await tap.settle();
	tap.button("Maybe later")!.click();
	assert.ok(tap.by((el) => el.getAttribute("role") === "img").length);
	tap.root.bubble("pointerdown");
	assert.equal(tap.by((el) => el.getAttribute("role") === "img").length, 0, "a tap skips it");
});

test("a reminder goes out only for the item that takes the screen while the page is hidden or unfocused, never for the ones behind it", async () => {
	const r = rig();
	page.hidden = true;
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 6, pending: select({ dialog: "d2" }) }), unit("c", "waiting", { since: 7, pending: select({ dialog: "d3" }) })]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.remind, ["a"]);
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() }), unit("b", "waiting", { since: 6, pending: select({ dialog: "d2" }) }), unit("d", "waiting", { since: 8, pending: select({ dialog: "d4" }) })]));
	assert.deepEqual(r.calls.remind, ["a"], "a later arrival behind the current item raises nothing");
	const seen = rig();
	page.hidden = false;
	seen.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	seen.z.show();
	await seen.settle();
	assert.deepEqual(seen.calls.remind, [], "a page that is in front needs no reminder");
	page.hidden = false;
});

test("the companion: the tower by fallback, its log and composer, the stream watching its key, history for its key only; an item waits while the boss types", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.sound, [], "the companion comes in silently");
	assert.equal(r.calls.composers.at(-1)!.key, "t");
	assert.equal(r.calls.watch.at(-1), "t", "the stream is asked for the companion's session");
	assert.equal(r.calls.logs.length, 1);
	r.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	r.z.history({ key: "other", items: [] } as HistoryEvent);
	assert.deepEqual(r.calls.applied.map((e) => e.key), ["t", "t"], "the fetched newest page, then the stream's event; none for the other key");
	// The boss types in the companion's box: an item that becomes eligible waits.
	const box = r.calls.composers.at(-1)!.box;
	box.focus();
	box.value = "half a sentence";
	box.bubble("keydown");
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.button("Maybe later"), undefined, "the item waits");
	assert.deepEqual(r.calls.sound, []);
	box.value = "";
	box.bubble("input");
	await r.advance(10);
	assert.ok(r.button("Maybe later"), "it takes the screen when the box empties");
	assert.deepEqual(r.calls.sound, ["bowl"]);
	assert.equal(r.calls.watch.at(-1), null, "and the stream stops watching the companion");
});

/** Time passes in the half seconds the layer polls a held screen at. */
const wait = async (r: { advance(ms: number): Promise<void> }, ms: number) => {
	for (let left = ms; left > 0; left -= 500) await r.advance(Math.min(500, left));
};

test("scrolling and tapping the log change nothing: a draft in the box keeps holding the screen through a tap (the box loses the focus), a wheel, a drag, and a touch", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
	box.focus();
	box.type("half a sentence");
	box.bubble("keydown"); // typing is keys
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await wait(r, 600);
	assert.equal(r.button("Maybe later"), undefined, "the item waits while he types");
	box.blur(); // a tap, or a click on the scroll bar, takes the focus off the box
	log.bubble("pointerdown");
	await wait(r, 1000);
	assert.equal(r.button("Maybe later"), undefined, "a tap on the log does not hand the screen over");
	for (let i = 0; i < 8; i++) {
		for (const type of ["wheel", "touchstart", "pointerdown"]) log.bubble(type);
		await wait(r, DRAFT_MS / 4);
	}
	assert.equal(r.button("Maybe later"), undefined, "scrolling it, for longer than the hold, keeps the hold");
	assert.deepEqual(r.calls.sound, [], "and makes no sound");
	assert.equal(box.value, "half a sentence", "the draft is where he left it");
	assert.deepEqual(r.calls.leave, [], "nothing is left or opened");
	await wait(r, DRAFT_MS + 1000);
	assert.ok(r.button("Maybe later"), "left alone for the hold, the draft lets the waiting item take the screen");
});

test("a focused box with text and no input for 20 s: the waiting item takes the screen", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box;
	box.focus();
	box.type("walked away");
	box.bubble("keydown");
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await wait(r, 600);
	assert.equal(r.button("Maybe later"), undefined, "held while he has just typed");
	await wait(r, DRAFT_MS + 1000);
	assert.ok(r.button("Maybe later"), "no input for DRAFT_MS: the item takes the screen though the box has the focus");
});

test("keydown every 5 s for 60 s keeps holding a focused draft", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box;
	box.focus();
	box.type("still typing");
	box.bubble("keydown");
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	for (let i = 0; i < 12; i++) {
		box.bubble("keydown");
		await wait(r, 5000);
	}
	assert.equal(r.button("Maybe later"), undefined, "typing keeps renewing the hold");
});

test("with no draft in the box a tap on the log is nothing: no item is waiting to take the screen, and the screen does not change", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
	box.focus();
	box.blur();
	for (const type of ["pointerdown", "wheel", "scroll", "touchstart"]) log.bubble(type); // a scroll alone is nothing
	await wait(r, 2000);
	assert.equal(r.by((el) => el.getAttribute("class") === "zen-company").length, 1, "still the companion");
	assert.deepEqual([r.calls.sound, r.calls.leave], [[], []]);
});

test("the stored companion wins while the net lists it live; without one, nothing waits shows the circle and the line", async () => {
	const r = rig({ stored: { key: "m", ws: "w", at: 1 } });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.equal(r.calls.composers.at(-1)!.key, "m");
	const alone = rig();
	alone.feed(net([unit("m", "working")], [], false));
	alone.z.show();
	await alone.settle();
	assert.ok(alone.by((el) => el.getAttribute("class") === "zen-line").length === 1, "one quiet line under the circle");
	assert.ok(!alone.text().includes("Nothing waits"), "no headline");
	assert.equal(alone.calls.composers.length, 0);
	assert.equal(alone.calls.watch.at(-1), null);
});

test("the companion always has its log: the newest page is fetched and applied as a reset when no history event came, and not when one did (Z3R-F001)", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	assert.deepEqual(r.calls.applied.map((e) => [e.key, e.reset, e.items?.length]), [["t", true, 1]], "the stream already watched this key: no reset came, so the log loads itself");
	const fed = rig();
	fed.feed(net([unit("m", "working")]));
	fed.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	fed.z.show();
	fed.z.history({ key: "t", reset: true, items: [] } as HistoryEvent);
	await fed.settle();
	assert.deepEqual(fed.calls.applied.map((e) => e.reset), [true], "a reset from the stream is the log; nothing is fetched on top of it");
});

test("Enter and Space end the pause wherever the focus is, the circle takes it, and Enter on the corner control leaves instead (Z3R-F002)", async () => {
	for (const key of ["Enter", " "]) {
		const r = rig();
		r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
		r.z.show();
		await r.settle();
		r.button("Maybe later")!.click();
		const circle = r.by((el) => el.getAttribute("role") === "img")[0]!;
		assert.equal(page.focused, circle, "the focus lands on the layer for the pause");
		assert.equal((circle as unknown as { tabIndex: number }).tabIndex, -1, "focusable by script, out of the tab order");
		page.focused!.bubble("keydown", { key });
		assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, `${JSON.stringify(key)} ends it`);
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.button("Maybe later")!.click();
	const corner = r.by((el) => el.getAttribute("class") === "zen-leave")[0]!;
	corner.focus();
	let prevented = 0;
	corner.bubble("keydown", { key: "Enter", preventDefault: () => void prevented++ });
	assert.equal(prevented, 0, "the button keeps its Enter");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the pause stands");
});

test("a words-only item is a pane blocked on a terminal prompt: it says to answer in its terminal, opens it, and has no composer (Z3RR-F001)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	assert.equal(r.calls.composers.length, 0, "no box to type into: the server refuses input to a blocked pane");
	assert.ok(r.text().includes("answer it in its terminal"));
	r.button("Handle it in Standard")!.click();
	assert.deepEqual(r.calls.leave.at(-1), { route: { view: "session", ws: "w", key: "a" }, terminal: "a" });
});

test("a live append that arrives while the newest page is in flight is not lost; a page for a companion that was left is dropped (Z3RR-F002, M3)", async () => {
	let release!: (p: { items: Item[] }) => void;
	const r = rig({ latest: () => new Promise((done) => (release = done)) });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const added = { key: "t", items: [{ id: "n1", kind: "assistant", text: "new" }] } as unknown as HistoryEvent;
	r.z.history(added);
	release({ items: [] });
	await r.settle();
	assert.deepEqual(r.calls.applied.map((e) => [e.reset ?? false, e.items?.length]), [[false, 1], [true, 0], [false, 1]], "the append is applied again after the page replaced the log");
	const gone = rig({ latest: () => new Promise((done) => (release = done)) });
	gone.feed(net([unit("m", "working")]));
	gone.z.show();
	await gone.settle();
	gone.z.hide();
	release({ items: [] });
	await gone.settle();
	assert.equal(gone.calls.applied.length, 0, "the turn moved on: the page is stale");
});

test("without an injected remote the dialog decides by the host: a paired device's hereOnly choices are disabled, this computer's are not (Z3R-F006)", async () => {
	for (const [host, disabled] of [["192.168.1.7", true], ["127.0.0.1", false]] as const) {
		Object.assign(globalThis, { location: { hostname: host } });
		const r = rig({ remote: null });
		r.feed(net([unit("a", "waiting", { since: 5, pending: select({ hereOnly: true }) })]));
		r.z.show();
		await r.settle();
		assert.equal(r.by((el) => el.getAttribute("role") === "radio").every((o) => o.disabled), disabled, host);
	}
});

test("a streaming companion keeps scrolling its own log: scroll events alone never renew the hold, so a waiting item takes the screen after DRAFT_MS (UR-F001)", async () => {
	const r = rig();
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
	box.focus();
	box.type("half a sentence");
	box.bubble("keydown"); // typing is keys
	log.bubble("pointerdown");
	box.blur();
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await wait(r, 1000);
	assert.equal(r.button("Maybe later"), undefined, "held right after the tap");
	for (let i = 0; i < 6; i++) {
		log.bubble("scroll");
		await wait(r, 5000);
	}
	assert.ok(r.button("Maybe later"), "30 s of nothing but auto-scroll: the item is in");
});

test("Esc while an answer is on its way does nothing to the card: no cancel, no rest, and the outcome shows (UR-F002)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	assert.equal(r.calls.posts.length, 1, "the answer is on its way");
	esc(r);
	assert.equal(r.calls.posts.length, 1, "no cancel is posted");
	assert.deepEqual(r.calls.leave, [], "one Esc is only the hint toward leaving, not a rest");
	assert.equal(r.by((el) => el.dataset.on !== undefined && el.getAttribute("class") === "zen-esc").length, 1, "the quiet line shows");
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	await r.reply({ outcome: "rejected", reason: "digest" });
	assert.ok(r.button("Maybe later"), "the card is still there with its outcome");
});

test("Esc on a secret_drop whose snapshot carries answer.cancel posts nothing: read-only stays read-only, Esc is Not now (UR-F003)", async () => {
	const r = rig();
	const p = { callId: "c3", tool: "secret_drop", why: "x", answer: { dialog: "s1", digest: "2".repeat(64), cancel: true, questions: [{ question: "Token?", header: "T", multiple: false, options: [{ title: "a" }] }] } } as unknown as Pending;
	r.feed(net([unit("a", "waiting", { since: 5, pending: p })]));
	r.z.show();
	await r.settle();
	assert.equal(r.button("Cancel"), undefined);
	esc(r);
	assert.deepEqual(r.calls.posts, [], "nothing is posted");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "Not now");
});

test("hiding the layer stops the ripples and disarms a first Esc (M29, M30)", async () => {
	let cancelled = 0, frames = 0;
	const r = rig({ ripple: { now: () => r.now(), frame: () => (frames++, () => void cancelled++), still: () => false, idle: () => false, size: () => ({ w: 100, h: 100, dpr: 1 }) } });
	r.feed(net([unit("m", "working")]));
	r.z.show();
	await r.settle();
	r.root.bubble("pointerdown", { clientX: 5, clientY: 5, pointerType: "mouse" });
	assert.ok(frames > 0, "a ripple was started");
	r.z.hide();
	assert.ok(cancelled > 0, "hide stops the ripples");
	r.z.show();
	await r.settle();
	await r.advance(100);
	esc(r);
	await r.advance(100);
	r.z.hide();
	r.z.show();
	await r.settle();
	esc(r);
	assert.deepEqual(r.calls.leave, [], "an Esc armed before hide does not pair with one after");
});

for (const type of ["pointerdown", "wheel", "input"]) {
	test(`${type} alone, every 5 s for 60 s, keeps holding an unfocused draft (UR2-F002, UR2-F003)`, async () => {
		const r = rig();
		r.feed(net([unit("m", "working")]));
		r.z.show();
		await r.settle();
		const box = r.calls.composers.at(-1)!.box, log = r.by((el) => el.getAttribute("class") === "zen-log")[0]!;
		box.type("half a sentence");
		(type === "input" ? box : log).bubble(type);
		r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
		for (let i = 0; i < 12; i++) {
			(type === "input" ? box : log).bubble(type);
			await wait(r, 5000);
		}
		assert.equal(r.button("Maybe later"), undefined, `${type} renews the hold`);
		await wait(r, DRAFT_MS + 1000);
		assert.ok(r.button("Maybe later"), "and 20 s without it lets the item in");
	});
}

test("Esc on a card whose unit is offline is Not now: Cancel is disabled, so it is not pressed (UR2-F002, M04)", async () => {
	const r = rig({ offline: true });
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	assert.equal(r.button("Cancel")?.disabled, true);
	esc(r);
	assert.deepEqual(r.calls.posts, [], "no cancel is posted");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "Not now");
});

test("Esc while a trust answer is on its way does not rest the card: the refusal shows (UR2-F001)", async () => {
	const r = rig();
	r.feed(net([], [TRUST]));
	r.z.show();
	await r.settle();
	r.button("Trust this time")!.click();
	assert.equal(r.calls.trust.length, 1);
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	await r.reply({ outcome: "stale" });
	assert.ok(r.button("Maybe later"), "the card is still there");
});

test("Esc while an answer is on its way, after a second dialog replaced the panel, does not rest the card (UR2-F001)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	r.by((el) => el.getAttribute("role") === "radio")[0]!.click();
	r.button("Send answer")!.click();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true, dialog: "d2" }) })]));
	await r.settle();
	esc(r);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "no pause screen");
	assert.deepEqual(r.calls.posts.length, 1, "no cancel is posted");
});
