import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Net } from "../src/net.ts";
import { El, page } from "./card-dom.ts";

// The terminal card's place in Standard and Geek (gui/stepslot.ts): the dock's other box, one at a time, replaced by a newer step, closed by its own rules, handing over to today's full terminals, and giving the focus back.
const { mountStepSlot } = await import("../gui/stepslot.ts");
const { m } = await import("../gui/paraglide/messages.js");
const { termHold } = await import("../gui/towerturns.ts");

type W = { rows(rows: string[]): void; state(s: string, c: unknown): void; end(): void; taken(): void };
const unit = (key: string, name: string, extra: object = {}) => ({ id: key, key, control: true, name, role: "main", mark: "idle", subs: [], ...extra });
const net = (...units: object[]): Net => ({ bases: [{ id: "ws1", label: "Harbor", mark: "idle", tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust: [] }) as never;

function rig() {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	page.fine = true;
	page.focus = undefined;
	const dock = new El("div"), dialog = new El("section");
	dialog.setAttribute("class", "dialog");
	dock.append(dialog);
	page.root.replaceChildren(dock);
	const calls = { watches: [] as { key: string; name: string; w: W }[], stops: [] as string[], shows: [] as string[], panes: [] as string[], posts: [] as { key: string; body: Record<string, unknown> }[] };
	const kit = {
		embed: () => () => {},
		watch: (key: string, name: string, w: W) => (calls.watches.push({ key, name, w }), { conn: { key, rows: [] as string[], cols: 80, phase: "live", why: "", stale: () => false }, stop: () => void calls.stops.push(key), retry: () => {} }),
		post: (key: string) => async (_a: string, body: Record<string, unknown>) => (calls.posts.push({ key, body }), { ok: true, status: 200, body: {} }),
		stream: () => "st",
	};
	const slot = mountStepSlot({ dock: dock as never, kit: kit as never, showTerminal: (ws, key) => void calls.shows.push(`${ws}:${key}`), openPane: (key, name) => void calls.panes.push(`${key}:${name}`) });
	const cards = () => dock.kids.filter((k): k is El => k instanceof El && k.classes.has("tcard"));
	return { dock, dialog, calls, slot, cards, done: () => mock.timers.reset() };
}
const N = net(unit("a", "ops-main"));

test("a step puts the card in the dock beside the dialogs, named for the unit that asked, and the card takes the focus", () => {
	const r = rig();
	try {
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a", command: "sudo apt update" }, N);
		assert.equal(r.cards().length, 1);
		assert.equal(r.dock.kids[0], r.cards()[0], "the card is the dock's first box and the dialog stays in the dock");
		assert.ok(r.dock.kids.includes(r.dialog));
		assert.deepEqual(r.calls.watches.map((x) => [x.key, x.name]), [["grant:g1", "ops-main"]]);
		assert.equal(r.cards()[0]!.byClass("tcard-cmd")!.textContent, "sudo apt update");
		assert.equal(page.focus, r.cards()[0]!.byClass("tcard-input"), "the pane's line");
		assert.equal(r.cards()[0]!.getAttribute("aria-modal"), "false", "not modal: nothing is trapped");
	} finally { r.done(); }
});

test("a newer step replaces the card and lets go of the old connection; there is never more than one", () => {
	const r = rig();
	try {
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		r.slot.step({ kind: "prompt", key: "a", asker: "a", command: "! ls" }, N);
		assert.deepEqual([r.cards().length, r.calls.stops, r.calls.watches.map((x) => x.key)], [1, ["grant:g1"], ["grant:g1", "a"]]);
		assert.equal(r.cards()[0]!.byClass("tcard-cmd")!.textContent, "! ls");
	} finally { r.done(); }
});

test("the card ends by its own rules and gives the focus back to where it was; the route is no one's here", () => {
	const r = rig();
	try {
		const before = new El("button");
		r.dock.append(before);
		before.focus();
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, N);
		assert.notEqual(page.focus, before);
		r.calls.watches[0]!.w.taken();
		assert.deepEqual([r.cards().length, r.calls.stops, page.focus], [0, ["a"], before], "a prompt's own Enter, taken");
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		r.calls.watches[1]!.w.taken();
		assert.equal(r.cards().length, 1, "a pane's card stays when an Enter is taken");
		r.calls.watches[1]!.w.end();
		assert.deepEqual([r.cards().length, page.focus], [0, before], "the pane is gone");
	} finally { r.done(); }
});

test("× and Esc inside the card close it; a focus that is gone is not restored", () => {
	const r = rig();
	try {
		const before = new El("button");
		r.dock.append(before);
		before.focus();
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, N);
		r.cards()[0]!.byClass("tcard-x")!.onclick!({ isTrusted: true });
		assert.deepEqual([r.cards().length, page.focus], [0, before]);
		before.remove();
		page.focus = undefined;
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, N);
		assert.equal(r.cards()[0]!.fire("keydown", { key: "Escape" }), true);
		assert.deepEqual([r.cards().length, page.focus], [0, undefined]);
	} finally { r.done(); }
});

test("Full terminal hands over to today's terminals: a prompt to the session's terminal mode in its base, a pane to its tile with the keyboard; the card is gone", () => {
	const r = rig();
	try {
		const before = new El("button");
		r.dock.append(before);
		before.focus();
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, N);
		r.cards()[0]!.byClass("tcard-full")!.onclick!({ isTrusted: true });
		assert.deepEqual([r.calls.shows, r.cards().length], [["ws1:a"], 0]);
		assert.notEqual(page.focus, before, "the full terminal takes the focus; the card does not give it back over it");
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		r.cards()[0]!.byClass("tcard-full")!.onclick!({ isTrusted: true });
		assert.deepEqual([r.calls.panes, r.cards().length, r.calls.shows.length], [["grant:g1:ops-main"], 0, 1]);
	} finally { r.done(); }
});

test("a snapshot renames the card and ends a tower's held sentence: the connection is made when a run is live", () => {
	const r = rig();
	try {
		const tower = (service: object): Net => { const n = net(); n.bases[0]!.tower = { name: "tower", mark: "idle", key: "a", control: true, subs: [], service } as never; return n; };
		const standing = tower({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] }), running = tower({ state: "running", queued: 0, allyRuns: [], notices: [], parked: [], run: { id: "r1", kind: "local", startedAt: "" } });
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, standing);
		assert.equal(r.calls.watches.length, 0, "nothing to attach to");
		assert.equal(r.cards()[0]!.byClass("tcard-status")!.textContent, termHold({ state: "standing" } as never));
		r.slot.follow(running);
		assert.equal(r.calls.watches.length, 1, "the run is live");
		r.slot.follow(net(unit("a", "renamed")));
		assert.equal(r.cards()[0]!.all().find((e) => e.tag === "h2")!.textContent, m.terminal_title({ name: "renamed" }));
	} finally { r.done(); }
});

test("focus() gives the card the focus a closing dialog took", () => {
	const r = rig();
	try {
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		page.focus = undefined;
		r.slot.focus();
		assert.equal(page.focus, r.cards()[0]!.byClass("tcard-input"));
	} finally { r.done(); }
});

test("the card writes to the terminal it shows: a pane step's keys go to its grant and a prompt step's to the session, never to the unit that asked, and the connection and the writes name the same key", async () => {
	const r = rig();
	try {
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		r.cards()[0]!.byClass("tcard-go")!.onclick!({ isTrusted: true });
		await Promise.resolve();
		assert.deepEqual(r.calls.posts.map((p) => p.key), ["grant:g1"], "the pane's grant, not the asker");
		assert.equal(r.calls.watches[0]!.key, r.calls.posts[0]!.key);
		r.slot.step({ kind: "prompt", key: "sess", asker: "a" }, N);
		r.cards()[0]!.byClass("tcard-go")!.onclick!({ isTrusted: true });
		await Promise.resolve();
		assert.deepEqual(r.calls.posts.map((p) => p.key), ["grant:g1", "sess"], "the session the prompt is in");
		assert.equal(r.calls.watches[1]!.key, "sess");
	} finally { r.done(); }
});

test("a replaced card's late reply closes nothing of the card that took its place", async () => {
	const r = rig();
	try {
		r.slot.step({ kind: "prompt", key: "a", asker: "a" }, N);
		const old = r.cards()[0]!;
		old.byClass("tcard-go")!.onclick!({ isTrusted: true });
		r.slot.step({ kind: "pane", key: "grant:g1", asker: "a" }, N);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(r.calls.posts.length, 1, "the old Enter was answered 200 (taken) after the new card stood");
		assert.equal(r.cards().length, 1, "and the pane's card stands");
		assert.notEqual(r.cards()[0], old);
	} finally { r.done(); }
});

test("a step of a unit on an unreachable or ended remote base is off in the slot, with the reason, and follows the box back to live; a local base is unchanged", () => {
	const r = rig();
	try {
		const remote = (state: string, can: string[] = ["input"]): Net => { const n = net(unit("a", "ops-main")); (n.bases[0] as never as { box: object }).box = { state, can }; return n; };
		const go = () => r.cards()[0]!.byClass("tcard-go")!, say = () => r.cards()[0]!.byClass("tcard-status")!.textContent;
		r.slot.step({ kind: "prompt", key: "a", asker: "a", command: "! ls" }, N);
		assert.ok(!go().disabled, "local: Run is on");
		r.slot.step({ kind: "prompt", key: "a", asker: "a", command: "! ls" }, remote("unreachable"));
		assert.ok(go().disabled, "unreachable: Run is off");
		assert.equal(say(), m.box_keys_blocked());
		r.slot.follow(remote("live"));
		assert.ok(!go().disabled, "back with the box");
		r.slot.follow(remote("ended"));
		assert.ok(go().disabled);
		r.slot.follow(remote("live", []));
		assert.ok(go().disabled, "a box that lets no input through");
		r.slot.follow(remote("live"));
		assert.ok(!go().disabled);
		assert.equal(say(), "");
	} finally { r.done(); }
});
