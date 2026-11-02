import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import type { Alert } from "../gui/alerts.ts";
import { createPage, type PageIo, type ZenFace } from "../gui/pagecore.ts";
import type { Route } from "../gui/router.ts";
import type { Status } from "../gui/stream.ts";
import { type Choice, mountView, type ViewEnv } from "../gui/view.ts";

// The page's wiring (gui/pagecore.ts) run with plain fakes for its parts: which presenter a snapshot reaches in each face, the tab icon, the clips, a hidden page, the stream's watch, and the way the face moves (Z3R-F006).

const unit = (key: string, mark: Mark = "idle", o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (...units: Unit[]): Net => ({ bases: [{ id: "w", label: "w", mark: "idle" as Mark, head: true, outposts: [], outside: [], tower: null, tabs: [{ id: "t", label: "t", units }] }] });
const live: Status = { state: "live", attempt: 0 };

/** The page as main.ts builds it, with every part a recorder. `zenLoaded: false` is a Zen chunk that is not fetched yet (`load()` fetches it). */
function world(o: { stored?: Choice; away?: boolean; route?: Route; hidden?: boolean; zenLoaded?: boolean } = {}) {
	const root = { dataset: (o.away ? { zenAway: "" } : {}) as Record<string, string | undefined> }, store = o.stored ?? "standard";
	const env: ViewEnv = { root, meta: null, server: null, media: { matches: false, addEventListener: () => {} }, storage: { getItem: () => store, setItem: () => {} } };
	const view = mountView(env);
	const w = {
		view, root, hidden: o.hidden ?? false, zenEl: { hidden: true }, zenLoaded: o.zenLoaded ?? true, waiting: [] as ((z: ZenFace) => void)[],
		nets: [] as [Map<string, Alert>, Net][], shows: 0, hides: 0, refreshes: 0, icons: [] as number[], signals: [] as string[][], draws: [] as { net: Net; fresh: string[]; now: number }[], maps: [] as Net[],
		navigations: [] as [Route, Route][], layouts: 0, restarts: 0, backs: 0, links: 0, leftSettings: 0,
		load() {
			w.zenLoaded = true;
			w.waiting.splice(0).forEach((call) => call(zen));
		},
	};
	const zen: ZenFace = { net: (a, n) => w.nets.push([a, n]), show: () => void w.shows++, hide: () => void w.hides++, refresh: () => void w.refreshes++ };
	const io: PageIo = {
		view, root, zenEl: w.zenEl, zen: () => (w.zenLoaded ? zen : undefined), withZen: (call) => (w.zenLoaded ? call(zen) : void w.waiting.push(call)), hidden: () => w.hidden,
		back: () => void w.backs++, leaveSettings: () => void w.leftSettings++, restart: () => void w.restarts++, icon: (n) => void w.icons.push(n), link: () => void w.links++,
		signal: (fresh) => void w.signals.push(fresh.map((a) => a.key)), draw: (n, fresh, now) => void w.draws.push({ net: n, fresh: fresh.map((a) => a.key), now: now.size }),
		map: (n) => void w.maps.push(n), navigate: (next, before) => void w.navigations.push([next, before]), layout: () => void w.layouts++,
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
