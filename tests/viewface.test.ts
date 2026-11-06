import assert from "node:assert/strict";
import { test } from "node:test";
import { type Choice, mountView, resolve, type View, type ViewEnv } from "../gui/view.ts";
import { type Face, faceAfter, mountFace } from "../gui/viewface.ts";

// The page's face when the view moves (gui/viewface.ts): every control that moves it (the settings page's picks, Zen's menu, the header's Zen button, Esc and the corner control, the settings route,
// a new server default, the OS) walked from every start, against a plain statement of what the person should see.

const CHOICES: Choice[] = ["auto", "standard", "geek", "zen"];
const SERVERS: Choice[] = ["auto", "standard", "geek", "zen"];

/** The page as the main module wires it: a real view on a fake storage and root, the face coordinator, and a route that is settings or not. */
function page(stored: Choice, server: Choice, start: Face, contrast = false) {
	const root: ViewEnv["root"] = { dataset: start.away ? { zenAway: "" } : {} };
	let listener: (() => void) | undefined, store: string = stored;
	const env: ViewEnv = {
		root, meta: { content: "#1a1b26" }, server: { content: server },
		media: { matches: contrast, addEventListener: (_: "change", fn: () => void) => (listener = fn) },
		storage: { getItem: () => store, setItem: (_k: string, v: string) => void (store = v) },
	};
	const view = mountView(env), world = { settings: start.settings, draws: 0, left: 0 };
	const face = mountFace({
		view, root, settings: () => world.settings,
		leaveSettings: () => ((world.left += 1), (world.settings = false), face.route(false)), // the page's Back, then the router's navigate
		draw: () => void (world.draws += 1),
	});
	const away = () => root.dataset.zenAway !== undefined;
	return {
		view, face, world, away, root, stored: () => store, flip: (v: boolean) => ((env.media.matches = v), listener?.()),
		/** What the page shows: the Zen layer only while the device's view is Zen, this page has not left it, and it is not on the settings route (main.ts `zenOn`). */
		zenOn: () => view.view() === "zen" && !away() && !world.settings,
		/** The settings page's pick, or Zen's menu: both call `view.set`. */
		pick: (c: Choice) => view.set(c),
	};
}

const starts = (): { stored: Choice; server: Choice; away: boolean; settings: boolean }[] =>
	CHOICES.flatMap((stored) => SERVERS.flatMap((server) => [false, true].flatMap((away) => [false, true].map((settings) => ({ stored, server, away, settings })))));
const label = (s: { stored: Choice; server: Choice; away: boolean; settings: boolean }) => `choice ${s.stored}, server ${s.server}, ${s.away ? "away" : "here"}, ${s.settings ? "on settings" : "on a page"}`;
/** A start the page can be in: a page that is away or on settings only means something for a device whose view is Zen, and a Zen device on the settings page is away (it was put there on entering). */
const reachable = (s: { stored: Choice; server: Choice; away: boolean; settings: boolean }) => resolve(s.stored, false, s.server) === "zen" ? !(s.settings && !s.away) : !s.away;

test("a pick shows that view at once, from anywhere: away is cleared, a Zen pick leaves the settings page, and the other views show at once", () => {
	let cells = 0;
	for (const s of starts().filter(reachable)) {
		for (const c of CHOICES) {
			const p = page(s.stored, s.server, s);
			p.pick(c);
			const want: View = resolve(c, false, s.server), at = `${label(s)} → pick ${c}`;
			cells++;
			assert.equal(p.root.dataset.view, want, `${at}: the page shows ${want}`);
			assert.equal(p.away(), false, `${at}: no away mark`);
			assert.equal(p.zenOn(), want === "zen", `${at}: the Zen layer shows exactly for Zen`);
			assert.equal(p.world.settings, want === "zen" ? false : s.settings, `${at}: the settings page is left for Zen only`);
			assert.equal(p.stored(), c, `${at}: the choice is the device's`);
		}
	}
	assert.ok(cells > 100, `${cells} cells walked`);
});

test("choosing the view already chosen still applies it: a Zen page that was left comes back, from Zen's menu or the settings page", () => {
	const p = page("zen", "auto", { away: true, settings: false });
	assert.equal(p.root.dataset.view, "standard");
	p.pick("zen");
	assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn()], ["zen", false, true]);
	const s = page("zen", "auto", { away: true, settings: true });
	s.pick("zen");
	assert.deepEqual([s.root.dataset.view, s.away(), s.world.settings, s.world.left, s.zenOn()], ["zen", false, false, 1, true], "and the settings page is left");
	const geek = page("geek", "auto", { away: false, settings: true });
	geek.pick("geek");
	assert.deepEqual([geek.root.dataset.view, geek.world.settings], ["geek", true], "a pick of the view shown changes nothing else");
});

test("Auto follows the server's default at once from Zen's menu and the settings page, a followed default that arrives on the settings page waits there", () => {
	for (const server of SERVERS) {
		for (const settings of [false, true]) {
			// Zen's menu (the page is on a page, and shows Zen): Auto means the server's default now.
			const menu = page("zen", server, { away: false, settings: false });
			menu.pick("auto");
			const want = resolve("auto", false, server);
			assert.equal(menu.root.dataset.view, want, `Zen's menu → Auto with server ${server}`);
			assert.equal(menu.zenOn(), want === "zen");
			// The settings page picking Auto from a Zen or Standard device.
			const set = page("standard", server, { away: false, settings });
			set.pick("auto");
			assert.equal(set.root.dataset.view, want, `settings → Auto with server ${server}`);
			assert.equal(set.zenOn(), want === "zen");
			assert.equal(set.world.settings, want === "zen" ? false : settings);
		}
	}
	// A server default that changes while the settings page is open: Zen waits (away) until the page is left; the others show. One that changes under a page showing Zen never moves it out (R3).
	const open = page("auto", "standard", { away: false, settings: true });
	open.view.setServer("zen");
	assert.deepEqual([open.away(), open.root.dataset.view, open.world.settings, open.zenOn()], [true, "standard", true, false], "a followed Zen does not cover the settings page");
	open.world.settings = false;
	open.face.route(false);
	assert.deepEqual([open.away(), open.root.dataset.view, open.zenOn()], [false, "zen", true], "leaving it shows Zen");
	open.view.setServer("geek");
	assert.deepEqual([open.root.dataset.view, open.away(), open.zenOn()], ["zen", false, true], "a page that is showing Zen stays in it when the server's default moves (Z-D20, never interrupted): it applies at the next load");
	const own = page("standard", "auto", { away: false, settings: true });
	own.view.setServer("zen");
	assert.deepEqual([own.root.dataset.view, own.away()], ["standard", false], "a device with a choice of its own ignores the server");
});

test("Esc and the corner control leave this page for Standard and keep the device's choice; the header's Zen button and the next pick bring Zen back", () => {
	for (const server of SERVERS) {
		const p = page("auto", server, { away: false, settings: false });
		if (resolve("auto", false, server) !== "zen") continue;
		p.face.leave();
		assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn(), p.view.choice(), p.view.view()], ["standard", true, false, "auto", "zen"]);
		p.face.back();
		assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn()], ["zen", false, true]);
		p.face.leave();
		p.pick("zen");
		assert.deepEqual([p.root.dataset.view, p.zenOn()], ["zen", true], "a pick of Zen shows it");
		p.face.leave();
		p.pick("geek");
		assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn()], ["geek", false, false], "a pick of Geek from a page that left Zen shows Geek");
	}
});

test("the settings route: a Zen device's page is Standard on it, and shows Zen on leaving; a device of another view is not touched", () => {
	const z = page("zen", "auto", { away: false, settings: false });
	z.world.settings = true;
	z.face.route(true);
	assert.deepEqual([z.root.dataset.view, z.away(), z.zenOn()], ["standard", true, false]);
	z.world.settings = false;
	z.face.route(false);
	assert.deepEqual([z.root.dataset.view, z.away(), z.zenOn()], ["zen", false, true]);
	const g = page("geek", "auto", { away: false, settings: false });
	g.world.settings = true;
	g.face.route(true);
	assert.deepEqual([g.root.dataset.view, g.away()], ["geek", false]);
	g.world.settings = false;
	g.face.route(false);
	assert.deepEqual([g.root.dataset.view, g.away()], ["geek", false]);
});

test("ZNR-F004: a page held in Zen (the server's default moved away under it) that opens the settings page shows Zen again on leaving it; leaving Zen itself, or picking a view, still lets Auto follow the server", () => {
	const held = () => {
		const p = page("auto", "zen", { away: false, settings: false });
		p.view.setServer("standard"); // held: the page shows Zen, the default is Standard
		assert.deepEqual([p.view.view(), p.zenOn()], ["zen", true]);
		return p;
	};
	const p = held();
	p.world.settings = true;
	p.face.route(true);
	assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn()], ["standard", true, false], "the settings page is Standard");
	p.world.settings = false;
	p.face.route(false);
	assert.deepEqual([p.root.dataset.view, p.away(), p.zenOn()], ["zen", false, true], "leaving it shows Zen, as the route row says");
	p.face.leave();
	assert.deepEqual([p.view.view(), p.root.dataset.view], ["standard", "standard"], "leaving Zen lets Auto follow the server again");
	const q = held();
	q.pick("auto");
	assert.deepEqual([q.view.view(), q.root.dataset.view], ["standard", "standard"], "a pick lets it follow, too");
	const r = held();
	r.world.settings = true;
	r.face.route(true);
	r.pick("auto");
	assert.deepEqual([r.view.view(), r.root.dataset.view], ["standard", "standard"], "a pick on the settings page too");
});

test("another page of this device choosing (a storage event) is a pick; the OS's contrast follows only a page whose choice is Auto", () => {
	const p = page("standard", "auto", { away: false, settings: false });
	p.view.reread();
	assert.equal(p.root.dataset.view, "standard");
	const other = page("zen", "auto", { away: true, settings: false });
	other.view.reread();
	assert.deepEqual([other.root.dataset.view, other.away()], ["zen", false], "the device's Zen is the page's again: another page picked it");
	const auto = page("auto", "auto", { away: false, settings: false });
	auto.flip(true);
	assert.equal(auto.root.dataset.view, "geek");
	const settings = page("auto", "auto", { away: false, settings: true });
	settings.flip(true);
	assert.deepEqual([settings.root.dataset.view, settings.world.settings], ["geek", true]);
});

test("the table itself: every move from every face, stated", () => {
	const at: Face = { away: false, settings: true };
	assert.deepEqual(faceAfter({ on: "pick" }, "zen", at), { away: false, settings: true, leaveSettings: true });
	assert.deepEqual(faceAfter({ on: "pick" }, "geek", { away: true, settings: true }), { away: false, settings: true, leaveSettings: false });
	assert.deepEqual(faceAfter({ on: "follow" }, "zen", at), { away: true, settings: true, leaveSettings: false });
	assert.deepEqual(faceAfter({ on: "follow" }, "zen", { away: true, settings: false }).away, true, "a followed Zen keeps a page that left it away");
	assert.deepEqual(faceAfter({ on: "follow" }, "standard", { away: true, settings: false }).away, false);
	assert.deepEqual(faceAfter({ on: "leave" }, "zen", { away: false, settings: false }).away, true);
	assert.deepEqual(faceAfter({ on: "back" }, "zen", { away: true, settings: false }).away, false);
	assert.deepEqual(faceAfter({ on: "route", settings: true }, "zen", { away: false, settings: false }), { away: true, settings: true, leaveSettings: false });
	assert.deepEqual(faceAfter({ on: "route", settings: false }, "zen", { away: true, settings: true }), { away: false, settings: false, leaveSettings: false });
	assert.deepEqual(faceAfter({ on: "route", settings: true }, "geek", { away: false, settings: false }).away, false);
});
