import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import type { Alert } from "../gui/alerts.ts";
import { m } from "../gui/paraglide/messages.js";
import { createPage, type Esc, type PageIo, type ZenFace } from "../gui/pagecore.ts";
import type { Route } from "../gui/router.ts";
import type { Status } from "../gui/stream.ts";
import { type Choice, mountView, type ViewEnv } from "../gui/view.ts";

// The page's wiring (gui/pagecore.ts) run with plain fakes for its parts: which presenter a snapshot reaches in each face, the tab icon, the clips, a hidden page, the stream's watch, and the way the face moves (Z3R-F006).

const unit = (key: string, mark: Mark = "idle", o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (...units: Unit[]): Net => ({ bases: [{ id: "w", label: "w", mark: "idle" as Mark, head: true, outposts: [], outside: [], tower: null, tabs: [{ id: "t", label: "t", units }] }] });
const live: Status = { state: "live", attempt: 0 };

/** The page as main.ts builds it, with every part a recorder. `zenLoaded: false` is a Zen chunk that is not fetched yet (`load()` fetches it). */
function world(o: { stored?: Choice; away?: boolean; route?: Route; hidden?: boolean; zenLoaded?: boolean; modal?: boolean; dialogOpen?: boolean; zenTakesEscape?: boolean } = {}) {
	const root = { dataset: (o.away ? { zenAway: "" } : {}) as Record<string, string | undefined> }, store = o.stored ?? "standard";
	const env: ViewEnv = { root, meta: null, server: null, media: { matches: false, addEventListener: () => {} }, storage: { getItem: () => store, setItem: () => {} } };
	const view = mountView(env);
	const w = {
		view, root, hidden: o.hidden ?? false, zenEl: { hidden: true }, zenLoaded: o.zenLoaded ?? true, waiting: [] as ((z: ZenFace) => void)[],
		nets: [] as [Map<string, Alert>, Net][], shows: 0, hides: 0, refreshes: 0, icons: [] as number[], signals: [] as string[][], draws: [] as { net: Net; fresh: string[]; now: number }[], maps: [] as Net[],
		navigations: [] as [Route, Route][], layouts: 0, restarts: 0, backs: 0, links: 0, leftSettings: 0, modal: o.modal ?? false, dialogOpen: o.dialogOpen ?? false, chimes: 0, escapes: 0,
		/** The calls the overlay layer, the focus views, and the router received, in order. */
		calls: [] as string[],
		load() {
			w.zenLoaded = true;
			w.waiting.splice(0).forEach((call) => call(zen));
		},
	};
	const zen: ZenFace = { net: (a, n) => w.nets.push([a, n]), show: () => void w.shows++, hide: () => void w.hides++, refresh: () => void w.refreshes++, escape: () => (w.escapes++, o.zenTakesEscape ?? false), terminal: (t) => void w.calls.push(`zenterm:${JSON.stringify(t)}`) };
	const panels = {
		stack: { show: (a: Alert) => void w.calls.push(`show:${a.key}`), close: (how?: string) => (w.calls.push(`close:${how ?? ""}`), w.dialogOpen) },
		terminal: { open: (key: string, name: string, keys?: boolean) => void w.calls.push(`tile:${key}:${name}:${keys}`) },
	};
	const io: PageIo = {
		view, root, zenEl: w.zenEl, zen: () => (w.zenLoaded ? zen : undefined), withZen: (call) => (w.zenLoaded ? call(zen) : void w.waiting.push(call)), hidden: () => w.hidden,
		back: () => void w.backs++, leaveSettings: () => void w.leftSettings++, restart: () => void w.restarts++, icon: (n) => void w.icons.push(n), link: () => void w.links++,
		signal: (fresh) => void w.signals.push(fresh.map((a) => a.key)), draw: (n, fresh, now) => void w.draws.push({ net: n, fresh: fresh.map((a) => a.key), now: now.size }),
		map: (n) => void w.maps.push(n), navigate: (next, before) => void w.navigations.push([next, before]), layout: () => void w.layouts++,
		panels: () => panels, withPanels: (call) => call(panels), withFocus: (call) => call({ terminal: (key) => void w.calls.push(`terminal:${key}`) }),
		go: (route) => (w.calls.push(`go:${JSON.stringify(route)}`), core.route(route)), modal: () => w.modal, chime: () => void w.chimes++,
	};
	const core = createPage(io);
	if (o.route) core.route(o.route);
	return Object.assign(w, { core });
}

test("Standard: a snapshot draws the page and the map, counts the waiting units in the tab icon, and the clips tell what arrived after the first snapshot only", () => {
	const w = world(), a = net(unit("a", "waiting"), unit("b"));
	w.core.snapshot(a);
	assert.deepEqual([w.icons, w.signals, w.draws.map((d) => d.fresh), w.maps, w.links], [[1], [], [["a"]], [a], 1], "the first snapshot is no news to the clips (what waited already), but its waiting unit is new to the queue");
	const b = net(unit("a", "waiting"), unit("b", "waiting"));
	w.core.snapshot(b);
	assert.deepEqual([w.icons, w.signals, w.draws.at(-1)!.fresh, w.maps.at(-1)], [[1, 2], [["b"]], ["b"], b]);
	assert.equal(w.core.latest, b);
});

test("the tab icon counts every waiting unit and every trust question, and is plain (0) while Zen is shown", () => {
	const trust = { folder: "/p", digest: "d", agents: [] } as never;
	const n: Net = { ...net(unit("a", "waiting"), unit("b", "idle", { pending: { callId: "c" } as never })), trust: [trust] };
	const std = world();
	std.core.snapshot(n);
	assert.deepEqual(std.icons, [3], "a waiting unit, a unit with a dialog, and the trust question");
	const zen = world({ stored: "zen" });
	zen.core.snapshot(n);
	assert.deepEqual(zen.icons, [0], "no count in Zen");
	zen.root.dataset.zenAway = "";
	zen.view.refresh();
	zen.core.snapshot(n);
	assert.deepEqual(zen.icons, [0, 3], "a page that left Zen counts again");
});

test("Zen: a snapshot goes to the Zen layer alone: no clip, no Standard draw, no map, a plain icon; what waited is not news when Standard comes back", () => {
	const w = world({ stored: "zen" });
	w.core.snapshot(net(unit("a", "waiting")));
	w.core.snapshot(net(unit("a", "waiting"), unit("b", "waiting")));
	assert.equal(w.nets.length, 2, "Zen takes each snapshot's alerts and the net");
	assert.deepEqual([...w.nets[1]![0].keys()].sort(), ["a", "b"]);
	assert.deepEqual([w.signals, w.draws, w.maps, w.icons], [[], [], [], [0, 0]]);
	assert.equal(w.links, 2, "the link bar follows every face");
	w.core.face.leave(); // Esc: Standard draws the newest snapshot again
	assert.equal(w.core.zenOn(), false);
	assert.equal(w.hides, 1);
	assert.deepEqual(w.icons.at(-1), 2, "and the count comes back with it");
	w.core.snapshot(net(unit("a", "waiting"), unit("b", "waiting"), unit("c", "waiting")));
	assert.deepEqual(w.signals, [["c"]], "only c is news: the clips measure against what Zen heard");
});

test("a hidden page tells the clips but draws nothing; it keeps the newest snapshot, and coming back draws it with what arrived meanwhile as news to the queue", () => {
	const w = world();
	w.core.snapshot(net(unit("a")));
	w.hidden = true;
	w.core.snapshot(net(unit("a", "waiting")));
	assert.deepEqual([w.signals, w.draws.length, w.maps.length], [[["a"]], 1, 1], "the clips hear it, the page does not draw");
	w.core.snapshot(net(unit("a", "waiting"), unit("b", "waiting")));
	assert.deepEqual(w.signals, [["a"], ["b"]]);
	w.hidden = false;
	w.core.wake();
	assert.deepEqual([w.draws.length, w.draws.at(-1)!.fresh, w.maps.length], [2, ["a", "b"], 2], "the queue still gets both: it measures against what it drew last");
	w.core.wake();
	assert.equal(w.draws.length, 2, "nothing is kept back after that");
});

test("a snapshot on a route that is not the map is drawn without the map and kept; the map draws it when the route comes back, laid out again", () => {
	const w = world({ route: { view: "workspace", ws: "w" } });
	const n = net(unit("a", "waiting"));
	w.core.snapshot(n);
	assert.deepEqual([w.draws.length, w.maps.length], [1, 0]);
	w.core.route({ view: "map" });
	assert.deepEqual([w.maps, w.layouts], [[n], 1]);
	w.core.route({ view: "workspace", ws: "w" });
	w.core.route({ view: "map" });
	assert.deepEqual([w.maps.length, w.layouts], [1, 1], "the map already shows the newest snapshot");
});

test("the stream is asked to watch the route's session, and the companion's while Zen shows one; leaving Zen goes back to the route's", () => {
	const w = world({ stored: "zen" });
	assert.equal(w.core.opened(), null, "nothing on the map");
	w.core.watchLog("c");
	assert.deepEqual([w.core.opened(), w.restarts], ["c", 1], "Zen's companion");
	w.core.watchLog("c");
	assert.equal(w.restarts, 1, "the same key asks for nothing (an already-watched key sends no new reset; Zen fetches the log itself)");
	w.core.watchLog("d");
	assert.equal(w.restarts, 2);
	w.core.route({ view: "session", ws: "w", key: "s" });
	assert.equal(w.core.opened(), "d", "Zen keeps the companion over a route");
	w.core.face.leave();
	assert.deepEqual([w.core.opened(), w.restarts], ["s", 3], "Standard watches the route's session");
	const std = world({ route: { view: "workspace", ws: "w" } });
	assert.equal(std.core.opened(), "w:w");
	std.core.watchLog("c");
	assert.equal(std.core.opened(), "w:w", "a companion means nothing outside Zen");
	assert.equal(std.restarts, 1, "only the route's change restarted it");
});

test("a card answers only while the stream is live; a new state is told to Zen", () => {
	const w = world({ stored: "zen" });
	assert.equal(w.core.online(), false, "before the first state: connecting");
	w.core.status(live);
	assert.deepEqual([w.core.online(), w.refreshes], [true, 1]);
	for (const state of ["reconnecting", "offline", "replaced", "connecting"] as const) {
		w.core.status({ state, attempt: 1 });
		assert.equal(w.core.online(), false, state);
	}
	assert.equal(w.refreshes, 5);
	const early = world({ stored: "zen", zenLoaded: false });
	early.core.status(live);
	assert.equal(early.refreshes, 0, "a Zen layer that is not loaded is not fetched for a state");
});

test("the face: Zen is shown for a Zen device only, hidden once the page leaves it or sits on the settings route, and each move draws it from the newest snapshot", () => {
	const w = world({ stored: "zen", zenLoaded: false });
	const n = net(unit("a", "waiting"));
	w.core.snapshot(n);
	assert.equal(w.waiting.length, 1, "the first snapshot asks for the Zen chunk");
	w.core.sync();
	assert.equal(w.zenEl.hidden, false);
	w.load();
	assert.deepEqual([w.nets.length, w.shows], [2, 1], "Zen is handed the newest snapshot, then shown");
	w.core.route({ view: "settings" });
	assert.deepEqual([w.core.zenOn(), w.zenEl.hidden, w.hides], [false, true, 1], "the settings page is never covered");
	assert.equal(w.core.rules().count, true, "and it follows Standard's rules");
	w.core.route({ view: "map" });
	assert.deepEqual([w.core.zenOn(), w.zenEl.hidden, w.shows], [true, false, 2], "leaving the settings page shows Zen again");
	const std = world();
	std.core.sync();
	assert.deepEqual([std.zenEl.hidden, std.hides, std.waiting.length], [true, 1, 0], "a Standard page never fetches the Zen chunk");
});

test("a chunk that arrives after the face moved away does not show Zen", () => {
	const w = world({ stored: "zen", zenLoaded: false });
	w.core.snapshot(net(unit("a", "waiting")));
	w.core.sync();
	w.core.face.leave();
	w.load();
	assert.equal(w.shows, 0, "the call checks again that Zen is on");
	assert.equal(w.nets.length, 1, "the snapshot's alerts still reach the layer (it only holds them while hidden)");
});

test("while away, snapshots go to Standard alone; coming back hands Zen the newest of them (a card answered meanwhile is gone)", () => {
	const w = world({ stored: "zen" });
	w.core.snapshot(net(unit("a", "waiting")));
	w.core.face.leave();
	const before = w.nets.length;
	w.core.snapshot(net(unit("a", "idle")));
	assert.equal(w.nets.length, before, "Zen is not told while the page shows Standard");
	assert.deepEqual(w.draws.at(-1)!.fresh, [], "and Standard drew the new state");
	w.core.face.back();
	assert.deepEqual([w.core.zenOn(), w.backs > 0, w.nets.length, w.nets.at(-1)![0].get("a")?.mark], [true, true, before + 1, "idle"]);
});

const alert = (key: string, o: Partial<Alert> = {}): Alert => ({ key, ws: "w", name: key, role: "main", mark: "waiting", at: 1, ...o });
const key = (k: string, o: Partial<Esc> = {}) => {
	const e = { key: k, defaultPrevented: false, isComposing: false, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...o };
	return e;
};

test("openSession opens a session's comms by its route; in terminal mode nothing queued opens over it, the route goes first, and the focus views are asked for the terminal", () => {
	const w = world();
	w.core.openSession("w", "k");
	assert.deepEqual(w.calls, ['go:{"view":"session","ws":"w","key":"k"}'], "comms: the route alone");
	w.calls.length = 0;
	w.core.openSession("w", "k2", { mode: "term", at: "e9" });
	assert.deepEqual(w.calls, ["close:go", 'go:{"view":"session","ws":"w","key":"k2","at":"e9"}', "terminal:k2"]);
	assert.deepEqual(w.core.current, { view: "session", ws: "w", key: "k2", at: "e9" });
});

test("in Zen a session's terminal and a pane are the Zen layer's: no route change, no Standard, no tile; a page that left Zen, or a Zen that went away before its chunk came, keeps Standard's way", () => {
	const w = world({ stored: "zen", zenLoaded: false });
	w.core.sync();
	w.core.openSession("w", "k", { mode: "term", at: "e9" });
	w.core.openPane("g1");
	assert.deepEqual(w.calls, [], "the Zen chunk is not here: both wait for it");
	w.load();
	assert.deepEqual([w.calls, w.core.zenOn(), w.core.current, w.zenEl.hidden, w.navigations.length], [['zenterm:{"key":"k"}', 'zenterm:{"key":"grant:g1"}'], true, { view: "map" }, false, 0], "no close of the dialogs, no route, no tile, no leaving Zen");
	const chat = world({ stored: "zen" });
	chat.core.sync();
	chat.core.openSession("w", "k");
	assert.deepEqual(chat.calls, ['go:{"view":"session","ws":"w","key":"k"}'], "comms are Standard's even in Zen (the route alone)");
	const left = world({ stored: "zen", away: true });
	left.core.openSession("w", "k", { mode: "term" });
	left.core.openPane("g2");
	assert.deepEqual(left.calls, ["close:go", 'go:{"view":"session","ws":"w","key":"k"}', "terminal:k", `tile:grant:g2:${m.pane_name()}:true`], "away: Standard's session terminal and pane tile");
	const gone = world({ stored: "zen", zenLoaded: false });
	gone.core.sync();
	gone.core.openPane("g3");
	gone.core.face.leave();
	gone.load();
	assert.deepEqual(gone.calls, [`tile:grant:g3:${m.pane_name()}:true`], "Zen left before the chunk arrived: the pane opens as Standard's tile");
});

test("openAlert shows the alert's dialog through the overlay layer; openPane opens the answer's pane as a terminal tile with the keys", () => {
	const std = world();
	std.core.openAlert(alert("a"));
	std.core.openPane("g1");
	assert.deepEqual(std.calls, ["show:a", `tile:grant:g1:${m.pane_name()}:true`], "Standard stays where it is");
});

test("leaving Zen: Standard first, then the item's dialog or the session's comms, and the newest snapshot is drawn (a terminal is Zen's own and never leaves)", () => {
	const item = alert("a");
	const w = world({ stored: "zen" });
	w.core.snapshot(net(unit("a", "waiting")));
	assert.equal(w.draws.length, 0, "Standard draws nothing while Zen is shown");
	w.core.leaveZen({ item });
	assert.deepEqual([w.core.zenOn(), w.calls, w.draws.length, w.icons.at(-1)], [false, ["show:a"], 1, 1], "the dialog opens over Standard, which draws the snapshot it kept back");
	const comms = world({ stored: "zen" });
	comms.core.leaveZen({ route: { view: "session", ws: "w", key: "s" } });
	assert.deepEqual([comms.core.zenOn(), comms.calls], [false, ['go:{"view":"session","ws":"w","key":"s"}']]);
	const none = world({ stored: "zen" });
	none.core.leaveZen({});
	assert.deepEqual([none.core.zenOn(), none.calls], [false, []], "a pause just returns to the page");
});

test("coming back to Zen: the mark that the page left goes and the view is read again; from the settings page the page leaves it", () => {
	const w = world({ stored: "zen" });
	w.core.face.leave();
	assert.equal(w.core.zenOn(), false);
	w.core.enterZen();
	assert.deepEqual([w.core.zenOn(), w.root.dataset.zenAway, w.zenEl.hidden], [true, undefined, false]);
	const settings = world({ stored: "zen", route: { view: "settings" } });
	assert.equal(settings.core.zenOn(), false);
	settings.core.enterZen();
	assert.deepEqual([settings.leftSettings, settings.root.dataset.zenAway], [1, undefined], "an explicit return is a pick: the settings page is left, as Back would");
});

test("a click on a system notification: Zen changes nothing (it tells its item itself), a trust question opens its dialog, any other alert opens its session", () => {
	const std = world();
	std.core.notified(alert("a"));
	std.core.notified(alert("trust\u001f/p", { ws: "", trust: {} as never }));
	std.core.notified(alert("w\u001fmonitor:1:2", { unit: "m", mark: "error" }));
	assert.deepEqual(std.calls, ['go:{"view":"session","ws":"w","key":"a"}', "show:trust\u001f/p", 'go:{"view":"session","ws":"w","key":"m"}'], "a monitor's alert opens its unit");
	const zen = world({ stored: "zen" });
	zen.core.notified(alert("a"));
	zen.core.notified(alert("t", { trust: {} as never }));
	assert.deepEqual(zen.calls, []);
});

test("the link bar chimes for new notices in Standard and Geek, never in Zen, and not for none (M9)", () => {
	for (const [stored, away, rings] of [["standard", false, 1], ["geek", false, 1], ["zen", false, 0], ["zen", true, 1]] as const) {
		const w = world({ stored, away });
		w.core.news(0);
		w.core.news(2);
		assert.equal(w.chimes, rings, `${stored}${away ? " (left)" : ""}`);
	}
});

test("the keys and the drawer follow the face: Zen's layer owns the keys and no drawer shows; a modal holds the keys in every face", () => {
	const std = world(), zen = world({ stored: "zen" }), modal = world({ modal: true }), left = world({ stored: "zen", away: true });
	assert.deepEqual([std.core.owned(), std.core.noDrawer()], [false, false]);
	assert.deepEqual([zen.core.owned(), zen.core.noDrawer()], [true, true]);
	assert.deepEqual([modal.core.owned(), modal.core.noDrawer()], [true, false]);
	assert.deepEqual([left.core.owned(), left.core.noDrawer()], [false, false], "a page that left Zen has Standard's");
});

test("Escape, capture phase: in Zen the layer takes it and stops it only when it did; anything else (a modal, a composing key, another face) leaves it alone", () => {
	const took = world({ stored: "zen", zenTakesEscape: true }), e = key("Escape");
	took.core.escape(e, true);
	assert.deepEqual([took.escapes, e.stopped, e.prevented], [1, 1, 0]);
	const passed = world({ stored: "zen" }), p = key("Escape");
	passed.core.escape(p, true);
	assert.deepEqual([passed.escapes, p.stopped], [1, 0], "the layer had nothing to do with it");
	for (const [name, w, k] of [
		["Standard", world({ zenTakesEscape: true }), key("Escape")], ["a left page", world({ stored: "zen", away: true, zenTakesEscape: true }), key("Escape")],
		["a modal", world({ stored: "zen", modal: true, zenTakesEscape: true }), key("Escape")], ["composing", world({ stored: "zen", zenTakesEscape: true }), key("Escape", { isComposing: true })],
		["taken", world({ stored: "zen", zenTakesEscape: true }), key("Escape", { defaultPrevented: true })], ["another key", world({ stored: "zen", zenTakesEscape: true }), key("Enter")],
	] as const) {
		w.core.escape(k, true);
		assert.deepEqual([w.escapes, k.stopped], [0, 0], name);
	}
});

test("Escape, bubble phase: it closes the top dialog; with none open it goes up one level (session to workspace to map), the settings page steps back, the map keeps it; a modal takes it for itself", () => {
	const open = world({ dialogOpen: true, route: { view: "session", ws: "w", key: "k" } }), a = key("Escape");
	open.core.escape(a, false);
	assert.deepEqual([a.prevented, open.core.current.view, open.calls.filter((c) => c.startsWith("go"))], [1, "session", []], "a dialog was open: that was all");
	const up = world({ route: { view: "session", ws: "w", key: "k" } });
	up.core.escape(key("Escape"), false);
	assert.deepEqual(up.core.current, { view: "workspace", ws: "w" });
	up.core.escape(key("Escape"), false);
	assert.deepEqual(up.core.current, { view: "map" });
	const before = up.calls.length, top = key("Escape");
	up.core.escape(top, false);
	assert.deepEqual([up.calls.length, top.prevented], [before + 1, 1], "on the map it only asks the stack (nothing open) and goes nowhere");
	assert.equal(up.calls.at(-1), "close:");
	const settings = world({ route: { view: "settings" } });
	settings.core.escape(key("Escape"), false);
	assert.deepEqual([settings.leftSettings, settings.calls.filter((c) => c.startsWith("go"))], [1, []]);
	const modal = world({ modal: true, route: { view: "session", ws: "w", key: "k" } }), m = key("Escape");
	modal.core.escape(m, false);
	assert.deepEqual([m.prevented, modal.core.current.view, modal.calls], [0, "session", []], "an open popover closes itself");
	const inZen = world({ stored: "zen", route: { view: "session", ws: "w", key: "k" } }), z = key("Escape");
	inZen.core.escape(z, false);
	assert.deepEqual([z.prevented, inZen.core.current.view, inZen.calls], [0, "session", []], "in Zen the key is the layer's (capture phase): the bubble phase goes up no route, as when the terminal had the key and left it alone");
	const other = key("a"), taken = key("Escape", { defaultPrevented: true });
	up.core.escape(other, false);
	up.core.escape(taken, false);
	assert.deepEqual([other.prevented, taken.prevented], [0, 0]);
});
