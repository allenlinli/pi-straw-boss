import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { type Alert, alertsOf, ownOpenings } from "../gui/alerts.ts";
import type { BossCard } from "../gui/cardalerts.ts";
import { blocks, createZen, OUTCOME_MS, PAUSE_MS, REST_MS, type Screen } from "../gui/zenmodel.ts";

const al = (key: string, mark: Mark, since?: number, extra: Partial<Alert> = {}): Alert => ({ key, ws: "w", name: key, role: "main", mark, at: 0, since, ...extra });
const map = (...a: Alert[]) => new Map(a.map((x) => [x.key, x]));
const dlg = (digest: string) => ({ callId: "c", tool: "ask_user", answer: { dialog: "d", digest } });
function rig(typing = false) {
	let t = 1_000_000, typed = typing, touch = false;
	const z = createZen({ now: () => t, typing: () => typed, touched: () => touch });
	return { z, at: (ms: number) => (t += ms), type: (on: boolean) => (typed = on), touch: (on: boolean) => (touch = on), now: () => t };
}
const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = []): Net => ({ bases: [{ id: "w", label: "w", mark: "idle", tower: { name: "tower", mark: "idle", key: "t", control: true, subs: [{ ...unit("sub", "waiting", { role: "subagent", since: 5 }) }] }, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust });

test("items are the rank 0 alerts: a waiting unit, a pending dialog, a tower's and a subagent's, a trust question; not an error, a failed monitor, a finished unit", () => {
	const n = net([unit("a", "waiting"), unit("b", "working", { pending: dlg("x") as never }), unit("e", "error"), unit("d", "done"), unit("m", "working", { monitors: [{ id: "1", status: "error", what: "w", at: 1 } as never] })], [{ id: "tr", digest: "g", folder: "/x/proj", found: [], agents: [{ pane: "p", role: "main", at: 7 }] }]);
	n.bases[0]!.tower!.mark = "waiting";
	const seen: string[] = [];
	for (let i = 0; i < 6; i++) {
		const { z, at } = rig(), all = alertsOf(n, 0);
		const r = z.update(all);
		assert.equal(r.screen.kind, "item");
		const order = [(r.screen as { item: Alert }).item.key];
		for (let k = 0; k < 5 + i; k++) { z.skip(); at(PAUSE_MS); const s = z.tick().screen; if (s.kind !== "item") break; order.push(s.item.key); }
		seen.splice(0, seen.length, ...order);
	}
	assert.deepEqual([...seen].sort(), ["a", "b", `trust\u001f/x/proj\u001fg`, "sub", "t"].sort());
});

test("an own opening is no item", () => {
	const n = net([]);
	n.bases[0]!.tower!.subs = [];
	const { z } = rig();
	ownOpenings.add("o");
	assert.equal(z.update(alertsOf({ ...n, trust: [{ id: "tr", digest: "g", folder: "/x", found: [], agents: [], opening: "o" }] }, 0)).screen.kind, "companion");
});

test("the order: since, then first seen, then key; a trust question by its earliest agent", () => {
	const { z } = rig();
	const r = z.update(map(al("c", "waiting", 30), al("b", "waiting", 10), al("a", "waiting", 10), al("n", "waiting")));
	assert.equal((r.screen as { item: Alert }).item.key, "a", "equal since goes by key; an item with no since is newest");
	const s = alertsOf({ bases: [], trust: [{ id: "t", digest: "d", folder: "/f", found: [], agents: [{ pane: "1", role: "m", at: 9 }, { pane: "2", role: "m", at: 4 }] }] }, 0);
	assert.equal([...s.values()][0]!.since, 4);
});

test("an item without since takes the time this page first saw it", () => {
	const { z, at } = rig();
	z.update(map(al("late", "waiting", 5_000_000)));
	z.accepted("late");
	at(OUTCOME_MS);
	z.tick();
	at(PAUSE_MS);
	z.update(map(al("zz", "waiting"), al("late2", "waiting", 5_000_000)));
	const r = z.update(map(al("zz", "waiting"), al("late2", "waiting", 5_000_000), al("aa", "waiting")));
	assert.equal((r.screen as { item: Alert }).item.key, "zz", "seen earlier than aa, older than late2's since? no: zz first seen now < 5e6, so it is older");
});

test("a current item is not replaced by an older arrival, which makes no sound and changes nothing visible", () => {
	const { z } = rig();
	const first = z.update(map(al("b", "waiting", 20)));
	assert.deepEqual([first.screen.kind, first.sound], ["item", "bowl"]);
	const r = z.update(map(al("b", "waiting", 20), al("a", "waiting", 1)));
	assert.deepEqual([JSON.stringify(r.screen), r.sound], [JSON.stringify(first.screen), undefined]);
});

test("the five exits: one sound at most, then the pause", () => {
	const exits: [string, (z: ReturnType<typeof rig>) => unknown, string | undefined, string | undefined][] = [
		["accepted", (r) => r.z.accepted("a"), "knock", "answered"],
		["stopped waiting", (r) => r.z.update(map(al("a", "working", 1))), "knock", "elsewhere"],
		["unit gone", (r) => r.z.update(map()), undefined, undefined],
		["pane closed", (r) => r.z.update(map(al("a", "idle", 1, { closed: true }))), undefined, undefined],
		["failed", (r) => r.z.update(map(al("a", "error", 1))), "low", "error"],
	];
	for (const [name, act, sound, outcome] of exits) {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1)));
		const got = act(r) as { screen: { kind: string; outcome?: string }; sound?: string };
		assert.equal(got.sound, sound, name);
		if (outcome) {
			assert.deepEqual([got.screen.kind, got.screen.outcome], ["item", outcome], name);
			r.at(OUTCOME_MS - 1);
			assert.equal(r.z.tick().screen.kind, "item", `${name}: outcome holds 1.2 s`);
			r.at(1);
		}
		assert.equal(r.z.tick().screen.kind, "pause", name);
	}
});

test("an error outcome keeps the card with the low bowl; the exit after it is silent", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	const bad = r.z.refused("a");
	assert.deepEqual([bad.screen.kind, bad.sound], ["item", "low"]);
	assert.equal(r.z.refused("a").sound, undefined, "one sound per thing the boss did");
	const gone = r.z.update(map(al("a", "working", 1)));
	assert.deepEqual([gone.screen.kind, gone.sound], ["item", undefined]);
	assert.equal((gone.screen as { outcome?: string }).outcome, "elsewhere");
});

test("a refusal then an accepted retry still knocks", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.refused("a");
	assert.equal(r.z.accepted("a").sound, "knock");
});

test("the pause lasts 3 s, then the next item takes the screen with the bowl", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.accepted("a");
	r.at(OUTCOME_MS);
	assert.equal(r.z.tick().screen.kind, "pause");
	r.at(PAUSE_MS - 1);
	assert.equal(r.z.tick().screen.kind, "pause");
	r.at(1);
	const next = r.z.tick();
	assert.deepEqual([next.screen.kind, next.sound, (next.screen as { item: Alert }).item.key], ["item", "bowl", "b"]);
});

test("after an accepted answer the item stays down while its snapshot lingers, then the next comes", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.accepted("a");
	r.at(OUTCOME_MS);
	r.z.tick();
	r.at(PAUSE_MS);
	const s = r.z.tick();
	assert.equal((s.screen as { item: Alert }).item.key, "b");
});

test("a tap skips the pause; the last item leaves the companion silently", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.skip();
	assert.equal(r.z.tick().screen.kind, "pause");
	const t = r.z.tap();
	assert.deepEqual([t.screen.kind, t.sound], ["companion", undefined], "the rested lone item leaves the companion");
});

test("Not now rests 10 minutes, then the item returns with the bowl", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	assert.equal(r.z.skip().sound, undefined, "no sound for Not now");
	r.z.tap();
	r.at(REST_MS - 1);
	assert.equal(r.z.update(map(al("a", "waiting", 1))).screen.kind, "companion");
	assert.equal(r.z.due(), 1_000_000 + REST_MS);
	r.at(1);
	const back = r.z.tick();
	assert.deepEqual([back.screen.kind, back.sound], ["item", "bowl"]);
});

test("a rest ends early on a new dialog, or when the unit stops waiting and waits again", () => {
	for (const change of [(z: ReturnType<typeof rig>["z"]) => z.update(map(al("a", "waiting", 1, { pending: dlg("two") as never }))), (z: ReturnType<typeof rig>["z"]) => (z.update(map(al("a", "working", 1))), z.update(map(al("a", "waiting", 9, { pending: dlg("one") as never }))))]) {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1, { pending: dlg("one") as never })));
		r.z.skip();
		r.z.tap();
		assert.equal(r.z.update(map(al("a", "waiting", 1, { pending: dlg("one") as never }))).screen.kind, "companion");
		const back = change(r.z);
		assert.deepEqual([back.screen.kind, back.sound], ["item", "bowl"]);
	}
});

test("a hidden page keeps a pause that nothing waits behind until it is shown, then ends it at once", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.skip();
	r.z.visible(false);
	r.at(PAUSE_MS * 5);
	assert.equal(r.z.tick().screen.kind, "pause", "no one is there to breathe, and nothing waits");
	const s = r.z.visible(true);
	assert.equal(s.screen.kind, "companion", "shown: the pause that would have ended ends at once");
});

test("a question that waits ends the pause of a hidden page at once, so its card is drawn and the page can remind (trial11: a box's question stayed off a Zen page that sat in a pause)", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.skip();
	const s = r.z.visible(false);
	assert.equal((s.screen as { item: Alert }).item.key, "b", "b was behind a, which rests: the pause ends as the page is hidden");
	assert.equal(s.sound, "bowl");
	r.at(PAUSE_MS * 5);
	assert.equal(r.z.tick().screen.kind, "item", "and the card stays");
	// A card that ended is a pause too: the next question lands while the page is hidden.
	const t = rig();
	t.z.update(map(al("c", "waiting", 1)));
	t.z.update(map());
	t.z.visible(false);
	assert.equal(t.z.tick().screen.kind, "pause");
	const arrived = t.z.update(map(al("d", "waiting", 5)));
	assert.deepEqual([(arrived.screen as { item: Alert }).item?.key, arrived.sound], ["d", "bowl"]);
	// A rested item is not what ends it.
	const u = rig();
	u.z.update(map(al("e", "waiting", 1)));
	u.z.skip();
	u.z.visible(false);
	assert.equal(u.z.update(map(al("e", "waiting", 1))).screen.kind, "pause");
});

test("an item waits while the boss types in the companion's box, and takes the screen when he stops", () => {
	const r = rig(true);
	assert.equal(r.z.update(map()).screen.kind, "companion");
	assert.equal(r.z.update(map(al("a", "waiting", 1))).screen.kind, "companion");
	r.type(false);
	const s = r.z.tick();
	assert.deepEqual([s.screen.kind, s.sound], ["item", "bowl"]);
});

test("the render input carries no count of what waits: the same with one other item as with many", () => {
	const view = (others: number) => {
		const r = rig();
		const out = r.z.update(map(al("a", "waiting", 1), ...Array.from({ length: others }, (_, i) => al(`o${i}`, "waiting", 10 + i))));
		const p = r.z.skip();
		return JSON.stringify([out.screen, p.screen, r.z.tap().screen]);
	};
	assert.equal(view(0).replace(/"key":"o\d"/g, ""), view(0));
	const [one, many] = [JSON.parse(view(1)), JSON.parse(view(9))];
	assert.equal(JSON.stringify(one[0]), JSON.stringify(many[0]), "the item screen is the same");
	assert.equal(JSON.stringify(one[1]), JSON.stringify(many[1]));
	assert.deepEqual(Object.keys(one[1]), ["kind"], "the pause carries nothing else");
	assert.equal(JSON.stringify(one[2]), JSON.stringify({ kind: "item", item: one[2].item }), "the next screen is an item or the companion, never a list");
	const typing = rig(true);
	typing.z.update(map());
	assert.deepEqual(typing.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2))).screen, { kind: "companion" }, "the companion carries nothing about what waits");
	assert.deepEqual(Object.keys(one[0]).sort(), ["item", "kind"]);
});

test("a trust question that is gone from the net was settled elsewhere: the knock and the line, not a silent exit; a unit that left stays silent", () => {
	const a = { ...al("trust\u001f/x\u001fg", "waiting", 5), name: "x", trust: { id: "t", digest: "g", folder: "/x", found: [], agents: [] } as Alert["trust"] };
	const { z, at } = rig();
	z.update(map(a));
	const r = z.update(map());
	assert.deepEqual([r.sound, (r.screen as { outcome?: string }).outcome], ["knock", "elsewhere"]);
	const unitGone = rig();
	unitGone.z.update(map(al("u", "waiting", 5)));
	assert.equal(unitGone.z.update(map()).sound, undefined, "a unit that left the net plays nothing");
	at(0);
});

test("due is the soonest moment ahead: a time that has passed is not due again, so the layer's one timer does not spin", () => {
	const { z, at } = rig();
	z.update(map(al("a", "waiting", 5, { pending: dlg("x") as never })));
	z.skip();
	assert.equal(z.due(), 1_000_000 + PAUSE_MS, "the pause ends first");
	at(PAUSE_MS + 1);
	z.tick();
	assert.equal(z.due(), 1_000_000 + REST_MS, "the pause is over: only the rest is ahead");
	at(REST_MS);
	z.tick();
	assert.equal(z.due(), undefined, "nothing ahead");
});

test("an answer's reply that comes after the snapshot that already dropped the item makes it answered, not answered elsewhere, and rings no second knock", () => {
	const { z } = rig();
	z.update(map(al("a", "waiting", 1, { card: { kind: "pair", request: { id: "a", label: "x", peer: "p", age: "" } } })));
	const gone = z.update(map());
	assert.deepEqual([gone.sound, (gone.screen as { outcome?: string }).outcome], ["knock", "elsewhere"]);
	const late = z.accepted("a");
	assert.deepEqual([late.sound, (late.screen as { outcome?: string }).outcome], [undefined, "answered"]);
});

test("T1: Zen shown again after Standard had the page: an item still on the screen from before that the snapshot no longer has is dropped with no outcome, no knock, and no pause; one it still has stays", () => {
	for (const card of [false, true]) {
		const { z } = rig(), gone = al(card ? "link-dialog\u001fd1" : "a", "waiting", 5, card ? { card: { kind: "dialog", device: "d", dialogId: "x", digest: "f", line: "" } as never, closed: false } : {});
		assert.equal(z.update(map(gone)).screen.kind, "item");
		const back = z.update(map(), true);
		assert.deepEqual(back, { screen: { kind: "companion" }, sound: undefined }, card ? "a card the link closed" : "a unit that was answered");
		assert.equal(z.due(), undefined, "no outcome and no pause to wait for");
	}
	const { z } = rig(), keep = al("a", "waiting", 5);
	z.update(map(keep));
	const still = z.update(map(keep), true);
	assert.equal(still.screen.kind, "item", "an item that still waits is still the screen");
	assert.equal(still.sound, undefined, "and is not announced a second time");
	const live = rig(), card = al("link-dialog\u001fd2", "waiting", 5, { card: { kind: "dialog", device: "d", dialogId: "y", digest: "f", line: "" } as never, closed: false });
	live.z.update(map(card));
	const settled = live.z.update(map());
	assert.equal(settled.screen.kind === "item" && settled.screen.outcome, "elsewhere", "a question that is settled while Zen shows is still the knock and the line");
	assert.equal(settled.sound, "knock");
});

// Z-D18 (docs/specs/2026-11-01-zen-view.md, Blocking first): a question that blocks an agent outranks a tower wait or a notice-type card, and takes the screen from one the boss has not touched.
const WAIT = (since = 1) => al(`wait\u001fw\u001fW1`, "waiting", since, { unit: "t", role: "tower", wait: { id: "W1", text: "Boss token needed" } });
const BOX = (since = 100, id = "d1") => al(`link-dialog\u001f${id}`, "waiting", since, { ws: "", role: "none", pending: dlg(id) as never, card: { kind: "dialog", device: "dev", dialogId: id, digest: id, line: "asks" } });
const CONFIRM = (since = 1) => al("link-confirm\u001fc1", "waiting", since, { ws: "", role: "none", card: { kind: "confirm", confirm: {} as never } });
const PAIR = (since = 1) => al("pair\u001fp1", "waiting", since, { ws: "", role: "none", card: { kind: "pair", request: {} as never } });
const PROPOSAL = (since = 1) => al("proposal\u001fw\u001fP1", "waiting", since, { unit: "t", role: "tower", card: { kind: "proposal", ws: "w", tower: "t", proposal: {} as never, rev: 1 } });
const keyOf = (r: { screen: Screen }) => (r.screen.kind === "item" ? r.screen.item.key : r.screen.kind);

test("Z-D18: a question that blocks an agent takes the screen from an untouched tower wait, with the bowl, and the wait goes back in line", () => {
	const { z, at } = rig();
	assert.equal(keyOf(z.update(map(WAIT()))), WAIT().key);
	const r = z.update(map(WAIT(), BOX()));
	assert.deepEqual([keyOf(r), r.sound], [BOX().key, "bowl"]);
	z.accepted(BOX().key);
	at(OUTCOME_MS);
	assert.equal(z.tick().screen.kind, "pause");
	at(PAUSE_MS);
	const back = z.update(map(WAIT())); // the box dialog is gone: answered
	assert.deepEqual([keyOf(back), back.sound], [WAIT().key, "bowl"], "the wait comes back by itself, not put aside for ten minutes");
});

test("Z-D18: every kind that blocks an agent preempts every kind that blocks none", () => {
	const blocking: [string, Alert][] = [
		["a waiting unit", al("u", "waiting", 100)],
		["a unit with a dialog", al("d", "working", 100, { pending: dlg("x") as never })],
		["a trust question", al("trust\u001f/x\u001fg", "waiting", 100, { ws: "", trust: { id: "t", digest: "g", folder: "/x", found: [], agents: [] } as never })],
		["a question a box forwarded", BOX()],
		["a teammate's confirm (its tool call waits up to ten minutes)", CONFIRM(100)],
	];
	const lower: [string, Alert][] = [["a tower wait", WAIT()], ["a pair request", PAIR()], ["a memory proposal", PROPOSAL()]];
	for (const [bn, b] of blocking) for (const [ln, l] of lower) {
		const { z } = rig();
		assert.equal(keyOf(z.update(map(l))), l.key, ln);
		assert.equal(keyOf(z.update(map(l, b))), b.key, `${bn} takes the screen from ${ln}`);
	}
});

test("Z-D18: a teammate's confirm is blocking: it keeps the screen against an older wait and takes it from an untouched one", () => {
	const a = rig();
	assert.equal(keyOf(a.z.update(map(CONFIRM(100)))), CONFIRM().key);
	assert.equal(keyOf(a.z.update(map(CONFIRM(100), WAIT(1)))), CONFIRM().key);
	const b = rig();
	b.z.update(map(WAIT(1)));
	assert.equal(keyOf(b.z.update(map(WAIT(1), CONFIRM(100)))), CONFIRM().key);
});

test("Z-D18: a lower item never preempts a blocking one, however old it is", () => {
	for (const l of [WAIT(1), PAIR(1), PROPOSAL(1)]) {
		const { z } = rig();
		assert.equal(keyOf(z.update(map(BOX()))), BOX().key);
		const r = z.update(map(BOX(), l));
		assert.deepEqual([keyOf(r), r.sound], [BOX().key, undefined], l.key);
	}
});

test("Z-D18: a touched card is not interrupted, and gives the screen up when the boss lets go of it", () => {
	const { z, touch, at } = rig();
	z.update(map(WAIT()));
	touch(true);
	const r = z.update(map(WAIT(), BOX()));
	assert.deepEqual([keyOf(r), r.sound, z.deferred()], [WAIT().key, undefined, true], "typing, a pick, a fold: the card stays");
	assert.equal(keyOf(z.tick()), WAIT().key);
	touch(false);
	at(500);
	assert.deepEqual([keyOf(z.tick()), z.deferred()], [BOX().key, false]);
});

test("Z-D18: a card whose answer was just accepted is not preempted; the blocking question follows the pause", () => {
	const { z, at } = rig();
	z.update(map(WAIT()));
	z.accepted(WAIT().key);
	assert.equal(keyOf(z.update(map(WAIT(), BOX()))), WAIT().key, "the outcome is on the screen");
	at(OUTCOME_MS);
	assert.equal(z.tick().screen.kind, "pause");
	at(PAUSE_MS);
	assert.equal(keyOf(z.tick()), BOX().key, "the wait is held for 30 s, so the question comes first either way");
});

test("Z-D18: a question that arrives during a pause waits for the pause, like any arrival", () => {
	const { z, at } = rig();
	z.update(map(PAIR()));
	z.skip();
	assert.equal(z.tick().screen.kind, "pause");
	at(1000);
	assert.equal(keyOf(z.update(map(PAIR(), BOX()))), "pause");
	at(PAUSE_MS);
	assert.equal(keyOf(z.tick()), BOX().key);
});

test("Z-D18: from the companion, blocking questions come oldest first and before an older wait; then the lower ones, oldest first", () => {
	const { z, at } = rig();
	const all = map(WAIT(1), BOX(60, "late"), BOX(50, "early"), PAIR(2));
	assert.equal(keyOf(z.update(all)), BOX(50, "early").key);
	z.skip();
	at(PAUSE_MS);
	assert.equal(keyOf(z.update(all)), BOX(60, "late").key);
	z.skip();
	at(PAUSE_MS);
	assert.equal(keyOf(z.update(all)), WAIT().key);
});

test("Z-D18: with a wait on the screen, two blocking questions arriving together take it oldest first", () => {
	const { z } = rig();
	z.update(map(WAIT(1)));
	assert.equal(keyOf(z.update(map(WAIT(1), BOX(60, "late"), BOX(50, "early")))), BOX(50, "early").key);
});

test("Z-D18: a question that waits behind a card being answered says so in why(), and the card that yielded is no resting item", () => {
	const { z, touch } = rig();
	z.update(map(WAIT()));
	touch(true);
	z.update(map(WAIT(), BOX()));
	assert.match(z.why(BOX().key) ?? "", /being answered/);
	touch(false);
	z.tick();
	assert.match(z.why(WAIT().key) ?? "", /is on the screen and was waiting first/, "behind the question now, not put aside");
});

test("Z-D18: every kind of card has a rank, and a kind nobody ranked blocks (a question that waits is not buried)", () => {
	const ranked: Record<BossCard["kind"], boolean> = { dialog: true, confirm: true, pair: false, proposal: false }; // a new kind in BossCard fails the type check here until it is ranked in `blocks`
	for (const [kind, rank] of Object.entries(ranked)) assert.equal(blocks({ ...al("k", "waiting"), card: { kind } as never }), rank, kind);
	assert.equal(blocks({ ...al("k", "waiting"), card: { kind: "from-the-future" } as never }), true, "unknown at run time: blocking");
	assert.equal(blocks(WAIT()), false);
	assert.equal(blocks(al("u", "waiting")), true);
});
