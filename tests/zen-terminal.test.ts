import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { El, page } from "./zen-dom.ts";
import { alertsOf } from "../gui/alerts.ts";
import { m } from "../gui/paraglide/messages.js";
import type { Pending } from "../src/ask.ts";

// The Zen terminal layer (gui/zenterm.ts, docs/specs/2026-11-01-zen-view.md, A terminal in Zen): the terminal an answer opens shows inside Zen, over the screen that was there, and goes back to it.
// The terminal itself (mirror.ts, the key pad) is the page's one; here `embed` is a recorder that puts a keyboard sink into the host, as the real tile does.
const { mountZen, real } = await import("../gui/zen.ts");
const { ESC_MS, termStep } = await import("../gui/zenkeys.ts");
const { termHold } = await import("../gui/towerturns.ts");

const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[]): Net => ({ bases: [{ id: "w", label: "Harbor", mark: "idle", head: true, tower: { name: "tower", mark: "idle", key: "t", control: true, subs: [] }, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust: [] }) as Net;
const select = (): Pending => ({ callId: "c1", tool: "robot_hand", answer: { dialog: "d1", digest: "0".repeat(64), select: { title: "Robot Hand: deploy", choices: [{ label: "Put it in my prompt" }, { label: "No thanks" }] } } });
const readonly = (): Pending => ({ callId: "c4", tool: "ask_user_question", why: "Two dialogs are open.", asks: [{ header: "A", question: "First?", options: [{ title: "x" }], multiple: false, freeform: false }] });

function rig() {
	let t = 1_000_000;
	const timers: { at: number; fn: () => void }[] = [];
	const calls = { leave: [] as unknown[], embeds: [] as { key: string; name: string; host: El; keys: boolean | undefined; end: (() => void) | undefined; entered: ((sent: boolean) => void) | undefined }[], off: [] as string[], sinks: [] as El[] };
	let resolveEmbed: (() => void) | undefined;
	const deps = {
		data: () => ({ older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined }),
		recent: async () => [],
		post: () => () => new Promise(() => {}), label: (ws: string) => ws, online: () => true,
		remind: () => {}, sound: () => {}, leave: (e: unknown) => void calls.leave.push(e), watch: () => {},
		remote: false, now: () => t, stored: () => undefined,
		fs: { doc: { addEventListener() {}, documentElement: {} }, standalone: () => false, touch: () => false, seen: { getItem: () => "1", setItem() {} }, later: () => () => {} },
		still: () => false, random: () => 0,
		embed: (key: string, name: string, host: El, o: { keys?: boolean; end?: () => void; entered?: (sent: boolean) => void } = {}) => {
			calls.embeds.push({ key, name, host, keys: o.keys, end: o.end, entered: o.entered });
			const sink = new El("textarea");
			sink.setAttribute("class", "term-sink");
			calls.sinks.push(sink);
			host.replaceChildren(new El("div"), sink);
			return new Promise<() => void>((done) => {
				const give = () => done(() => void calls.off.push(key));
				if (resolveEmbed === undefined) give();
				else resolveEmbed = give;
			});
		},
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			timers.push(e);
			return () => void (timers.includes(e) && timers.splice(timers.indexOf(e), 1));
		},
	};
	const mounts = { ...real, composer: ((root: El) => (root.replaceChildren(new El("textarea")), { box: new El("textarea"), update() {} })) as never, chat: async () => () => ({ apply() {}, setLive() {}, reveal() {} }) as never };
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
	/** An Escape the page hands the layer: `took` is the layer's answer, `prevented` whether it kept the key from the terminal's own handling. */
	const esc = (repeat = false) => {
		const e = { prevented: 0, repeat, preventDefault() { this.prevented++; } };
		return { took: z.escape(e), prevented: e.prevented };
	};
	const layer = () => root.all((el) => (el.getAttribute("class") ?? "").split(" ").includes("zen-term"))[0];
	const back = () => root.all((el) => el.tagName === "button" && el.textContent === m.zen_back_title())[0];
	const stage = () => root.all((el) => el.getAttribute("class") === "zen-stage")[0]!;
	return {
		z, root, calls, advance, settle, esc, layer, back, stage, now: () => t,
		feed: (n: Net) => z.net(alertsOf(n, t), n),
		hold: () => (resolveEmbed = () => {}),
		release: () => resolveEmbed?.(),
		text: () => root.textContent,
		key: (type: string, k: string, target: El) => {
			const e = { key: k, target, prevented: 0, preventDefault() { this.prevented++; } };
			for (const on of root.handlers[type] ?? []) on(e);
			return e.prevented;
		},
	};
}
const item = () => net([unit("a", "waiting", { name: "ops-main", since: 5, pending: select() })]);
const idle = () => net([unit("a", "idle", { name: "ops-main" })]);
const shown = async (n = item()) => {
	const r = rig();
	r.feed(n);
	r.z.show();
	await r.settle();
	return r;
};
const sinkOf = (r: ReturnType<typeof rig>) => r.calls.sinks.at(-1)!;

test("termStep: the terminal's keyboard keeps Esc for itself; outside it the first Esc shows the hint, a second within the window returns, a held key does nothing", () => {
	assert.equal(termStep({ typing: true, armed: false }), "pass");
	assert.equal(termStep({ typing: true, armed: true }), "pass", "an armed window does not make a key meant for pi leave");
	assert.equal(termStep({ typing: false, armed: false }), "hint");
	assert.equal(termStep({ typing: false, armed: true }), "leave");
	assert.equal(termStep({ typing: false, armed: false, repeat: true }), "none");
	assert.equal(termStep({ typing: true, armed: false, repeat: true }), "pass", "pi's own repeats are the terminal's");
});

test("a session's terminal opens as a layer inside Zen: the same terminal embedded in a full-screen host, the screen under it held still, and nothing leaves Zen", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.ok(r.layer(), "the layer is on the page");
	assert.deepEqual(r.calls.leave, [], "Standard is never visited");
	assert.deepEqual(r.calls.embeds.map((e) => [e.key, e.name, e.keys]), [["a", "ops-main", true]], "the session's key and name, the keyboard in it");
	assert.ok(r.layer()!.contains(r.calls.embeds[0]!.host), "the terminal sits in the layer");
	assert.equal(r.stage().getAttribute("inert"), "", "the card under it takes no focus and no tab");
	assert.ok(r.back(), "the way back is a button in the layer");
	assert.equal(r.back()!.parent!.getAttribute("class"), "zen-term-bar");
});

test("a granted pane's terminal is named for the pane, and a second open of the same terminal brings the one layer forward", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	assert.deepEqual(r.calls.embeds.map((e) => [e.key, e.name]), [["grant:g1", m.pane_name()]]);
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual([r.calls.off, r.calls.embeds.length], [["grant:g1"], 2], "another terminal replaces the first, which is let go");
});

test("Back to Zen returns to the screen that was there: the same card, the terminal let go, the layer gone, never Standard", async () => {
	const r = await shown();
	const card = r.stage().kids[0];
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.focus();
	r.back()!.click();
	await r.settle();
	assert.deepEqual([r.calls.off, r.calls.leave], [["a"], []]);
	assert.equal(r.layer(), undefined);
	assert.equal(r.stage().getAttribute("inert"), null);
	assert.equal(r.stage().kids[0], card, "the item's card is the same one: no redraw, no flash");
	assert.ok((card as El).contains(page.activeElement), "the card has the focus again (its first choice)");
});

test("hiding Zen (Esc, the corner control, a view pick) lets the terminal go with it", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.z.hide();
	assert.deepEqual([r.calls.off, r.layer()], [["a"], undefined]);
	const late = await shown();
	late.hold();
	late.z.terminal({ key: "a" });
	late.z.hide();
	late.release();
	await late.settle();
	assert.deepEqual([late.calls.off, late.layer()], [["a"], undefined], "an embed still on its way when the layer closes is let go the moment it lands");
});

test("Esc while the terminal has the keyboard goes to the terminal: not taken, not prevented, however often; the layer stays", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	sinkOf(r).focus();
	for (let i = 0; i < 4; i++) assert.deepEqual(r.esc(), { took: false, prevented: 0 });
	assert.ok(r.layer(), "pi's interrupt, vim's escape: the layer does not return on them");
	assert.equal(r.root.dump().includes(m.zen_term_esc_hint()), false, "and no hint");
});

test("Esc with the focus outside the terminal: the first shows the hint, a second within 600 ms returns to Zen, a later one starts again; a held key does nothing", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.focus();
	assert.deepEqual(r.esc(), { took: true, prevented: 1 }, "the layer's key");
	assert.ok(r.text().includes(m.zen_term_esc_hint()));
	assert.deepEqual(r.esc(true), { took: true, prevented: 1 }, "a held key neither returns nor starts");
	assert.ok(r.layer());
	await r.advance(ESC_MS + 50);
	r.esc();
	assert.ok(r.layer(), "a first again: the window had closed");
	await r.advance(200);
	r.esc();
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.off, r.calls.leave], [undefined, ["a"], []]);
	assert.equal(r.text().includes(m.zen_term_esc_hint()), false, "the hint goes with the layer");
});

test("Esc with the layer closed is Zen's own again: an item's Esc cancels or skips it and never meets the terminal's rule", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.back()!.click();
	assert.equal(r.esc().took, true);
	assert.equal(r.text().includes(m.zen_term_esc_hint()), false, "the terminal's hint is not Zen's");
});

test("a pane that closes or whose grant ends returns to Zen by itself; a session's terminal that ends does not", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	r.calls.embeds[0]!.end!();
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.off, r.calls.leave], [undefined, ["grant:g1"], []]);
	const s = await shown();
	s.z.terminal({ key: "a" });
	await s.settle();
	assert.equal(s.calls.embeds[0]!.end, undefined, "a session's mirror ending says the session left the pane, which the boss should read");
});

test("a session's terminal returns when the session starts working after it idled (the command was submitted); the first working of an answer being taken does not", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(r.layer(), "the tool's result reaches the agent, which works on: the command still waits in the prompt");
	r.feed(idle());
	r.feed(net([unit("a", "waiting", { name: "ops-main", since: 9 })]));
	assert.ok(r.layer(), "idle, then something else: still waiting for Enter");
	r.feed(idle());
	r.calls.embeds[0]!.entered!(true);
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.off, r.calls.leave], [undefined, ["a"], []], "Enter sent the command: pi works");
	const other = await shown();
	other.z.terminal({ key: "a" });
	await other.settle();
	other.feed(idle());
	other.feed(net([unit("a", "idle", { name: "ops-main" }), unit("b", "working")]));
	assert.ok(other.layer(), "another unit's work is no signal");
});

test("a terminal opened for a unit that waits at once (a blocked prompt) returns at its first working: `armed` says the wait is the terminal step", async () => {
	const r = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	r.z.terminal({ key: "a", armed: true });
	await r.settle();
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	await r.settle();
	assert.equal(r.layer(), undefined);
});

test("the card under the layer does not take the focus from the terminal when a snapshot gives Zen a new card", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	sinkOf(r).focus();
	r.feed(net([unit("a", "idle", { name: "ops-main" }), unit("b", "waiting", { name: "next", since: 6, pending: select() })]));
	for (let i = 0; i < 8; i++) await r.advance(1000); // the old card's "elsewhere", the pause, then the next card
	assert.ok(r.root.dump().includes("next"), "the next item's card is drawn under the layer");
	assert.equal(page.activeElement, sinkOf(r), "and the keyboard stays with the terminal");
});

test("the pause under the layer ignores the terminal's Enter and Space and its taps, so the keys reach the pane", async () => {
	const r = await shown();
	r.root.all((el) => el.tagName === "button" && el.textContent === m.zen_not_now())[0]!.click();
	await r.settle();
	assert.ok(r.root.dump().includes(m.zen_pause()), "the pause is on the page");
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.equal(r.key("keydown", "Enter", sinkOf(r)), 0, "not prevented");
	assert.equal(r.key("keydown", " ", sinkOf(r)), 0);
	for (const on of r.root.handlers.pointerdown ?? []) on({ target: sinkOf(r) });
	assert.ok(r.root.dump().includes(m.zen_pause()), "a tap in the terminal does not end the pause under it");
	r.back()!.click();
	await r.settle();
	assert.equal(r.key("keydown", "Enter", r.root), 1, "without the layer a key on the pause ends it (control)");
});

test("an Open terminal button (a unit blocked on a terminal prompt, a dialog shown read-only) opens the layer, not Standard", async () => {
	const words = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5 })]));
	const open = words.root.all((el) => el.tagName === "button" && el.textContent === m.zen_open_terminal())[0];
	assert.ok(open, "the button is worded for the terminal, not Standard");
	open.click();
	await words.settle();
	assert.deepEqual([words.calls.leave, words.calls.embeds.map((e) => e.key), Boolean(words.layer())], [[], ["a"], true]);
	words.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.equal(words.layer(), undefined, "the wait was the terminal step: it ended with the unit working");
	const ro = await shown(net([unit("a", "waiting", { name: "ops-main", since: 5, pending: readonly() })]));
	ro.root.all((el) => el.tagName === "button" && el.textContent === m.zen_open_terminal())[0]!.click();
	await ro.settle();
	assert.deepEqual([ro.calls.leave, ro.calls.embeds.map((e) => e.key)], [[], ["a"]]);
});

test("a terminal asked for while Zen is not shown is not drawn", async () => {
	const r = rig();
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual([r.layer(), r.calls.embeds.length], [undefined, 0]);
});

test("the layer's sheet is ink only: every rule is under the Zen view, takes its colours from the ink tokens (no colour of its own), and stills under reduced motion", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8"), rules = css.split("\n").filter((line) => /\.zen-term/.test(line) && !line.startsWith("/*"));
	assert.ok(rules.length >= 10, "the layer's rules are in the sheet");
	for (const line of rules.filter((l) => !l.startsWith("@media"))) {
		assert.ok(line.startsWith('[data-view="zen"] '), `scoped to Zen: ${line.slice(0, 50)}`);
		assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsl/i.test(line), false, `no colour of its own: ${line.slice(0, 50)}`);
	}
	assert.ok(rules.some((l) => /prefers-reduced-motion: reduce\)[^]*\.zen-term \{ animation: none/.test(l)), "reduced motion stills the layer's fade");
	assert.ok(/\.zen-term \{[^}]*position: fixed; inset: 0/.test(css), "full screen");
});

test("ZT-F001: a session's terminal returns on work after idle only when this layer sent an Enter since the idle; an intercom, a report, or a tower's wake keeps it", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.feed(idle());
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(r.layer(), "woken by something else: the command still waits in the prompt");
	r.feed(idle());
	r.calls.embeds[0]!.entered!(true);
	r.feed(idle());
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	await r.settle();
	assert.equal(r.layer(), undefined, "Enter went from this layer, then pi works");
});

test("ZT-F001: an Enter that the server refused (or asked to confirm) does not arm the return, and an Enter from before the idle does not count", async () => {
	const r = await shown();
	r.z.terminal({ key: "a" });
	await r.settle();
	r.feed(idle());
	r.calls.embeds[0]!.entered!(true);
	r.calls.embeds[0]!.entered!(false);
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(r.layer(), "refused");
	r.feed(idle());
	r.calls.embeds[0]!.entered!(true);
	r.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.equal(r.layer(), undefined);
	const old = await shown();
	old.z.terminal({ key: "a" });
	await old.settle();
	old.calls.embeds[0]!.entered!(true);
	old.feed(idle());
	old.feed(net([unit("a", "working", { name: "ops-main" })]));
	assert.ok(old.layer(), "the Enter came before the unit idled: it was not that one");
});

test("ZT-F002: Esc is the terminal's only while its pad can take it (live or hidden); a dead terminal releases Esc, so Esc Esc returns", async () => {
	const r = await shown();
	r.z.terminal({ key: "grant:g1" });
	await r.settle();
	sinkOf(r).focus();
	sinkOf(r).dataset.pad = "live";
	assert.deepEqual(r.esc(), { took: false, prevented: 0 });
	sinkOf(r).dataset.pad = "hidden";
	assert.deepEqual(r.esc(), { took: false, prevented: 0 }, "a secret's pad still takes Esc");
	sinkOf(r).dataset.pad = "off";
	assert.deepEqual(r.esc(), { took: true, prevented: 1 }, "a dead terminal: the layer's hint");
	assert.ok(r.text().includes(m.zen_term_esc_hint()));
	r.esc();
	await r.settle();
	assert.equal(r.layer(), undefined, "Esc Esc returns from a dead terminal");
});

test("ZT-F005: on a screen without a fine pointer the focus moves into the layer (Back to Zen) when it opens; with one the terminal's sink is the mirror's to focus", async () => {
	const g = globalThis as { matchMedia?: unknown }, was = g.matchMedia;
	try {
		g.matchMedia = () => ({ matches: false });
		const phone = await shown();
		phone.z.terminal({ key: "a" });
		await phone.settle();
		assert.equal(page.activeElement, phone.back(), "the back button holds the focus");
		g.matchMedia = () => ({ matches: true });
		const desk = await shown();
		desk.z.terminal({ key: "a" });
		await desk.settle();
		assert.notEqual(page.activeElement, desk.back(), "a desktop leaves the focus to the sink");
	} finally {
		g.matchMedia = was;
	}
});

test("ZT-F004: a standing or held tower's terminal shows the sentence, not an embed; it embeds when the tower runs again, and the sentence comes back when it stands by", async () => {
	const tower = (mark: Mark, service: object): Net => { const n = net([]); n.bases[0]!.tower = { name: "tower", mark, key: "a", control: true, subs: [], service } as never; return n; };
	const standing = () => tower("idle", { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] });
	const running = () => tower("working", { state: "running", queued: 0, allyRuns: [], notices: [], parked: [], run: { id: "r1", kind: "local", startedAt: "" } });
	const r = await shown(standing());
	r.z.terminal({ key: "a" });
	await r.settle();
	assert.deepEqual(r.calls.embeds, [], "nothing to attach to");
	assert.ok(r.text().includes(termHold({ state: "standing" } as never)!), "the hold sentence stands where the terminal would");
	r.feed(running());
	await r.settle();
	assert.equal(r.calls.embeds.length, 1, "the run is live: the terminal");
	r.feed(standing());
	await r.settle();
	assert.deepEqual(r.calls.off, ["a"], "the terminal is let go");
	assert.ok(r.text().includes(termHold({ state: "standing" } as never)!));
});
