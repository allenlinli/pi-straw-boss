import type { Net } from "../src/net.ts";
import { type Alert, alertsOf, arrivals } from "./alerts.ts";
import { RULES, rulesOf } from "./faces.ts";
import { type Route, watchOf } from "./router.ts";
import { CONNECTING, type Status } from "./stream.ts";
import { unitsOf, waitingOf } from "./units.ts";
import type { PageView } from "./view.ts";
import { mountFace } from "./viewface.ts";

// What the page decides, apart from what it draws: the face (Zen or Standard), the route, the stream's state and watch, and where each snapshot goes. main.ts builds the parts (DOM, chunks, the stream) and hands them in;
// this module holds the state and the rules over them, so tests/pagecore.test.ts can run the page's wiring with plain fakes (Z3R-F006). No events and no registry: the page calls these functions, and they call the parts it gave.
/** The Zen layer, as the page drives it. */
export interface ZenFace { net(alerts: Map<string, Alert>, net: Net): void; show(): void; hide(): void; refresh(): void }
export interface PageIo {
	view: Pick<PageView, "view" | "refresh" | "onChange">;
	/** `<html>`: `data-zen-away` is on it while this page has left Zen. */
	root: { dataset: Record<string, string | undefined> };
	/** The Zen layer's box. */
	zenEl: Pick<HTMLElement, "hidden">;
	/** The Zen layer once its chunk is here, or none yet. */
	zen(): ZenFace | undefined;
	/** The Zen layer, fetching its chunk first when it is not here. */
	withZen(call: (z: ZenFace) => void): void;
	hidden(): boolean;
	/** The header's Zen button follows the face. */
	back(): void;
	/** The settings page's own Back. */
	leaveSettings(): void;
	/** The stream asked for another watch; nothing before the stream has started. */
	restart(): void;
	/** The tab icon shows `n` waiting (none: the plain icon). */
	icon(n: number): void;
	link(link: Net["link"]): void;
	/** The clips and reminders for what arrived. */
	signal(fresh: Alert[]): void;
	/** Standard's page for a snapshot while it is shown: the header, the alert queue (`fresh` arrived), the timeline, and the focus views. */
	draw(net: Net, fresh: Alert[], now: Map<string, Alert>): void;
	/** The map, drawn while its route is the page's. */
	map(net: Net): void;
	/** A route change's DOM: the views shown, hidden, and entered. */
	navigate(next: Route, before: Route): void;
	/** The map laid out again after it comes back in view. */
	layout(): void;
}

export function createPage(io: PageIo) {
	let current: Route = { view: "map" }, latest: Net | undefined, pending: Net | undefined, shown: Net | undefined, status: Status = CONNECTING;
	let known: Map<string, Alert> | undefined, heard: Map<string, Alert> | undefined, zenKey: string | null = null, watching: string | null = null;
	// `rules()`: the face the page shows. Zen is on while the device's view is Zen, this page has not left it (Esc or the corner control: `data-zen-away`), and the route is not the settings page, which Zen never covers.
	const rules = () => rulesOf(io.view.view(), io.root.dataset.zenAway !== undefined || current.view === "settings"), zenOn = () => rules() === RULES.zen;
	/** What the stream is asked to watch: the companion's session while Zen shows one, else the route's. */
	const watch = () => (zenOn() && zenKey) || watchOf(current);
	function rewatch() {
		const next = watch();
		if (next === watching) return;
		watching = next;
		io.restart();
	}
	/** The tab icon carries the count of units waiting on an answer, and every project trust question; Zen shows none. */
	const badge = (net: Net) => io.icon(rules().count ? waitingOf(unitsOf(net).map((r) => r.unit)).length + (net.trust?.length ?? 0) : 0);
	/** Shows Zen or Standard to match `zenOn()`: Zen draws the newest snapshot when it comes on, and Standard draws it again on leaving. */
	function sync() {
		const on = zenOn();
		io.zenEl.hidden = !on;
		if (on) io.withZen((z) => zenOn() && (latest && z.net(alertsOf(latest, Date.now()), latest), z.show()));
		else io.zen()?.hide();
		latest && badge(latest);
		rewatch();
	}
	// Where the page's face moves when the view does (viewface.ts): a pick shows at once, a followed default waits on the settings page, Esc and the corner control leave this page for Standard.
	const face = mountFace({ view: io.view, root: io.root, settings: () => current.view === "settings", leaveSettings: io.leaveSettings, draw: () => (io.back(), sync()) });
	// Reminders and sounds follow every snapshot, a hidden page's above all: `heard` is apart from `known`, which the alert queue advances only while the page is shown, so a page that comes back still queues what arrived while it was hidden.
	function snapshot(net: Net) {
		latest = pending = net;
		badge(net);
		io.link(net.link);
		const now = alertsOf(net, Date.now()), r = rules();
		if (r.announce === "current") return void ((heard = now), io.withZen((z) => z.net(now, net))); // Zen makes no clip and counts nothing: it takes the alerts, and Standard draws this snapshot on leaving
		if (heard && r.signal) io.signal(arrivals(heard, now)); // what was already waiting when the page opened is no news
		heard = now;
		if (io.hidden()) return;
		const fresh = arrivals(known, now);
		known = now;
		io.draw(net, fresh, now);
		if (current.view !== "map") return;
		io.map(net);
		shown = net;
		pending = undefined;
	}
	return {
		/** The route and the newest snapshot. */
		get current() { return current },
		get latest() { return latest },
		/** The alert a unit raised in the snapshot Standard last drew, by key. */
		alertOf: (key: string) => known?.get(key),
		rules, zenOn, watch, face, snapshot, sync,
		/** A card answers only while the stream is live. */
		online: () => status.state === "live",
		/** The stream's state changed. */
		status(next: Status) {
			status = next;
			io.zen()?.refresh();
		},
		/** The stream opens (again): what it is asked to watch from now on. */
		opened: () => (watching = watch()),
		/** The page is visible again: it draws the newest snapshot it kept back. */
		wake: () => void (pending && snapshot(pending)),
		/** A route change: show its view and watch what it needs (one connection serves one page). */
		route(next: Route) {
			const before = current;
			current = next;
			if ((next.view === "settings") !== (before.view === "settings")) face.route(next.view === "settings"); // the settings page is never covered by a drift into Zen; leaving it shows Zen again
			io.navigate(next, before);
			if (next.view === "map" && latest && latest !== shown) (snapshot(latest), io.layout());
			rewatch();
		},
		/** The Zen companion's session whose log the stream sends (none: the route's). */
		watchLog(key: string | null) {
			zenKey = key;
			rewatch();
		},
	};
}
