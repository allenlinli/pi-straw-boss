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
const { mountZen, real } = await import("../gui/zen.ts");
type Exit = import("../gui/zen.ts").Exit;

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = [], tower = true): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", head: true, tower: tower ? { name: "tower", mark: "idle", key: "t", control: true, subs: [] } : null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust }) as Net;
const SELECT = (hereOnly = false) => ({ title: "Robot Hand: deploy", choices: ["Type it in a pane", "Copy it", "No thanks"].map((label) => ({ label, ...(hereOnly ? { hereOnly: true as const } : {}) })) });
const select = (o: { hereOnly?: boolean; cancel?: boolean; dialog?: string } = {}): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: o.dialog ?? "d1", digest: "0".repeat(64), select: SELECT(o.hereOnly), ...(o.cancel ? { cancel: true as const } : {}) } });
const questions = (): Pending => ({ callId: "c2", tool: "ask_user_question", answer: { dialog: "q1", digest: "1".repeat(64), cancel: true, questions: [{ question: "When?", header: "Window", multiple: false, options: [{ title: "Tonight" }, { title: "Tomorrow" }] }] } });
const secret = (): Pending => ({ callId: "c3", tool: "secret_drop", why: "It waits for a secret." });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });
const TRUST = { id: "tr", digest: "d".repeat(64), folder: "/work/harbor", found: [{ kind: "skills", path: ".pi/skills", items: ["deploy"], more: 0 }], agents: [{ pane: "1", base: "Harbor", role: "member", at: 5 }] };

function rig(o: { remote?: boolean | null; stored?: With } = {}) {
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
		data: () => ({ older: async () => ({ items: [] }), latest: async () => ({ items }), entry: async () => undefined }),
		recent: async () => items,
		post: (key: string) => (action: string, body: Record<string, unknown>) => (calls.posts.push({ key, action, body }), new Promise<Answer>((resolve) => replies.push(resolve))),
		trust: (body: Record<string, unknown>) => (calls.trust.push(body), new Promise<Answer>((resolve) => replies.push(resolve))),
		label: (ws: string) => (ws === "w" ? "Harbor" : ws), online: () => true,
		remind: (a: { key: string }) => void calls.remind.push(a.key), sound: (s: string) => void calls.sound.push(s), leave: (e: Exit) => void calls.leave.push(e), watch: (k: string | null) => void calls.watch.push(k),
		remote: o.remote === null ? undefined : (o.remote ?? false), now: () => t, stored: () => o.stored,
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
	for (const label of ["Send answer", "Cancel", "Not now"]) assert.ok(r.button(label), label);
	assert.equal(r.button("Show terminal"), undefined);
	assert.equal(page.focused, r.by((el) => el.getAttribute("role") === "radio")[0], "the focus goes to the first answer control");
	assert.equal(r.by((el) => el.getAttribute("aria-live") === "polite")[0]!.textContent, "ops-main asks");
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
	assert.ok(r.button("Send answer") && r.button("Cancel") && r.button("Not now"));
	const again = rig();
	again.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	again.z.show();
	await again.settle();
	assert.equal(again.button("Cancel"), undefined, "the owner did not say it takes a cancel");
	assert.ok(again.button("Not now"), "Not now is on every card");
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
		assert.equal(r.button("Open in Standard"), undefined, "a secret is entered in the terminal only");
		assert.equal(r.button("Show terminal"), undefined);
		assert.ok(r.button("Not now"));
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: readonly() })]));
	r.z.show();
	await r.settle();
	assert.equal(r.button("Send answer"), undefined);
	assert.equal(r.button("Show terminal"), undefined, "Zen words it Open in Standard");
	r.button("Open in Standard")!.click();
	assert.deepEqual(r.calls.leave, [{ route: { view: "session", ws: "w", key: "a" }, terminal: "a" }]);
});

test("a trust question draws the trust panel with its three choices, answers through trust/answer, and has Not now", async () => {
	const r = rig();
	r.feed(net([], [TRUST]));
	r.z.show();
	await r.settle();
	assert.ok(r.text().includes("Trust this folder?") && r.text().includes("/work/harbor"));
	for (const label of ["Trust", "Trust this time", "Don't trust", "Not now"]) assert.ok(r.button(label), label);
	r.button("Trust this time")!.click();
	assert.equal(r.calls.trust.length, 1);
	assert.deepEqual([r.calls.trust[0]!.id, r.calls.trust[0]!.choice], ["tr", "once"]);
	await r.reply(ok);
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
});

test("a unit that waits with no dialog has its last line, a reply composer (which keeps its own rule for a pane that waits on a dialog), and Open in Standard; a reply the server took is the answer", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	assert.ok(r.text().includes("I need a decision."));
	assert.equal(r.calls.composers.length, 1);
	assert.equal(r.calls.composers[0]!.key, "a");
	assert.ok(r.button("Not now"));
	assert.deepEqual((r.calls.composers[0]!.updates.at(-1) as { mark: string }).mark, "waiting", "the composer is told the unit's real state, so its own blocked rule applies");
	r.button("Open in Standard")!.click();
	assert.deepEqual(r.calls.leave, [{ route: { view: "session", ws: "w", key: "a" }, terminal: "a" }]);
	const sent = r.calls.composers[0]!.post("input" as never, { text: "go ahead" });
	await r.reply(ok);
	await sent;
	assert.deepEqual(r.calls.sound, ["bowl", "knock"], "the accepted reply ends the item");
	assert.equal(JSON.parse(stored.get("sb.zen.with")!).key, "a", "and is where the companion will be");
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
	assert.ok(r.button("Not now")!.disabled, "and takes no second answer");
	r.feed(net([unit("a", "waiting", { since: 5, pending: select({ cancel: true }) })])); // the snapshot before the unit moved on
	await r.advance(1300);
	assert.equal(r.by((el) => el.getAttribute("role") === "img")[0]?.getAttribute("aria-label"), "Breathe", "the pause is the breathing circle");
	assert.equal(r.button("Not now"), undefined);
	await r.advance(3100);
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
	r.button("Not now")!.click();
	assert.deepEqual(r.calls.sound, ["bowl"]);
	await r.advance(3100);
	assert.equal(r.button("Not now"), undefined, "the companion shows, not the rested item");
	await r.advance(9 * 60_000);
	assert.equal(r.button("Not now"), undefined);
	await r.advance(60_000);
	assert.ok(r.button("Not now"), "back, in its place by age");
	assert.deepEqual(r.calls.sound, ["bowl", "bowl"]);
});

test("an item that stops waiting by itself plays the knock and says it was answered elsewhere", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.feed(net([unit("a", "working", { since: 9 })]));
	assert.deepEqual(r.calls.sound, ["bowl", "knock"]);
	assert.ok(r.text().includes("Answered elsewhere"));
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
		r.button("Not now")!.click();
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

test("Esc: a field with text takes the first as a blur and the next leaves; the corner control leaves; each leaves for its screen", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: questions() })]));
	r.z.show();
	await r.settle();
	const own = r.by((el) => el.tagName === "textarea")[0]!;
	own.focus();
	own.type("and the on-call");
	let prevented = 0;
	assert.equal(r.z.escape({ preventDefault: () => void prevented++ }), true);
	assert.deepEqual(r.calls.leave, [], "the first Esc is a blur");
	assert.notEqual(page.focused, own);
	assert.equal(own.value, "and the on-call", "the text stays");
	r.z.escape({ preventDefault() {} });
	assert.equal((r.calls.leave as Exit[]).length, 1);
	assert.equal((r.calls.leave as Exit[])[0]!.item?.key, "a", "the item's dialog opens in Standard");
	const corner = r.by((el) => el.getAttribute("class") === "zen-leave")[0]!;
	corner.click();
	assert.equal((r.calls.leave as Exit[]).length, 2, "the corner control leaves on any screen");
	const idle = rig();
	idle.feed(net([unit("m", "working")]));
	idle.z.show();
	await idle.settle();
	idle.z.escape({ preventDefault() {} });
	assert.deepEqual(idle.calls.leave, [{ route: { view: "session", ws: "w", key: "t" } }], "the companion's session");
	const pause = rig();
	pause.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	pause.z.show();
	await pause.settle();
	pause.button("Not now")!.click();
	pause.z.escape({ preventDefault() {} });
	assert.deepEqual(pause.calls.leave, [{}], "a pause just returns to the page");
});

test("a hidden page's pause ends when the page is shown; a tap ends the pause", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.button("Not now")!.click();
	r.z.visible(false);
	await r.advance(5000);
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "still the pause: no one was there to breathe");
	r.z.visible(true);
	assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, "shown: it ends at once");
	const tap = rig();
	tap.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	tap.z.show();
	await tap.settle();
	tap.button("Not now")!.click();
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
	r.feed(net([unit("m", "working"), unit("a", "waiting", { since: 5, pending: select() })]));
	await r.advance(600);
	assert.equal(r.button("Not now"), undefined, "the item waits");
	assert.deepEqual(r.calls.sound, []);
	box.value = "";
	box.bubble("input");
	await r.advance(10);
	assert.ok(r.button("Not now"), "it takes the screen when the box empties");
	assert.deepEqual(r.calls.sound, ["bowl"]);
	assert.equal(r.calls.watch.at(-1), null, "and the stream stops watching the companion");
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
	assert.ok(alone.text().includes("Nothing waits for you."));
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
		r.button("Not now")!.click();
		const circle = r.by((el) => el.getAttribute("role") === "img")[0]!;
		assert.equal(page.focused, circle, "the focus lands on the layer for the pause");
		page.focused!.bubble("keydown", { key });
		assert.equal(r.by((el) => el.getAttribute("role") === "img").length, 0, `${JSON.stringify(key)} ends it`);
	}
	const r = rig();
	r.feed(net([unit("a", "waiting", { since: 5, pending: select() })]));
	r.z.show();
	await r.settle();
	r.button("Not now")!.click();
	const corner = r.by((el) => el.getAttribute("class") === "zen-leave")[0]!;
	corner.focus();
	let prevented = 0;
	corner.bubble("keydown", { key: "Enter", preventDefault: () => void prevented++ });
	assert.equal(prevented, 0, "the button keeps its Enter");
	assert.ok(r.by((el) => el.getAttribute("role") === "img").length, "the pause stands");
});

test("a words-only item gets an unlocked reply composer; the composer of a companion does not (Z3R words)", async () => {
	const r = rig();
	r.feed(net([unit("a", "waiting", { name: "docs-main", since: 5 })]));
	r.z.show();
	await r.settle();
	assert.equal((r.calls.composers[0]!.updates.at(-1) as { unlocked?: boolean }).unlocked, true, "no dialog open: the reply may be typed");
	const c = rig();
	c.feed(net([unit("m", "working")]));
	c.z.show();
	await c.settle();
	assert.notEqual((c.calls.composers.at(-1)!.updates.at(-1) as { unlocked?: boolean }).unlocked, true);
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
