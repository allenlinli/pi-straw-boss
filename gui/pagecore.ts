import type { Net } from "../src/net.ts";
import { type Alert, alertsOf, arrivals, unitOf } from "./alerts.ts";
import { RULES, rulesOf } from "./faces.ts";
import type { Hotkey } from "./hotkeys.ts";
import { linkChime } from "./linkbar.ts";
import { type Route, upOf, watchOf } from "./router.ts";
import { CONNECTING, type Status } from "./stream.ts";
import type { StepOpen } from "./terminalthen.ts";
import { unitsOf, waitingOf } from "./units.ts";
import { enterZen, type PageView } from "./view.ts";
import { mountFace } from "./viewface.ts";
import type { Exit, Term } from "./zentypes.ts";

// What the page decides, apart from what it draws: the face (Zen or Standard), the route, the stream's state and watch, and where each snapshot goes. main.ts builds the parts (DOM, chunks, the stream) and hands them in;
// this module holds the state and the rules over them, so tests/pagecore.test.ts can run the page's wiring with plain fakes (Z3R-F006). No events and no registry: the page calls these functions, and they call the parts it gave.
/** An Escape keydown, as far as the page reads it. */
export interface Esc { key: string; defaultPrevented: boolean; isComposing: boolean; preventDefault(): void; stopPropagation(): void }
/** The Zen layer, as the page drives it. `escape` says whether it took the key. */
export interface ZenFace { net(alerts: Map<string, Alert>, net: Net): void; show(): void; hide(): void; refresh(): void; escape(e: Esc): boolean; /** The keymap's Enter and Space: ends the pause; false when none is shown or the terminal layer has the keys. */ tap(): boolean; /** H: expands or collapses the shown item's context; false when the screen has none. */ toggleHistory(): boolean; /** A terminal in the layer's own screen (zenterm.ts). */ terminal(t: Term): void; /** A step an answer left, as the layer's terminal card. */ step(s: StepOpen): void }
/** The overlay layer (the dialogs and tiles), as the page drives it. */
interface PanelsFace { /** A page key for the dialogs (layer.ts); false when it had nothing to do. */ hotkey(key: "next" | "zoom"): boolean; stack: { show(a: Alert): void; close(how?: "go"): boolean }; /** A step an answer left, as the dock's terminal card. */ step(s: StepOpen, net?: Net): void }
/** The focus views (the base, the session's comms and dossier). */
interface FocusFace { terminal(key: string): void }
export interface PageIo {
	view: Pick<PageView, "view" | "refresh" | "onChange" | "reread">;
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
	/** The overlay layer once its chunk is here, or none yet. */
	panels(): PanelsFace | undefined;
	/** The overlay layer, fetching its chunk first when it is not here. */
	withPanels(call: (p: PanelsFace) => void): void;
	/** The focus views; a call made before their chunk is here waits for it, in order. */
	withFocus(call: (f: FocusFace) => void): void;
	/** The router moves the page to a route. */
	go(route: Route): void;
	/** A modal (a confirmation, the lightbox, an open popover) holds the keyboard. */
	modal(): boolean;
	/** The finished-unit clip, when Sound is on. */
	chime(): void;
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
	/** The page is visible again, or Zen was left: it draws the newest snapshot it kept back. */
	const wake = () => void (pending && snapshot(pending));
	const openAlert = (a: Alert) => io.withPanels((p) => p.stack.show(a));
	/** A session's comms; with `mode: "term"` its terminal, and nothing queued opens over it. In Zen the terminal is the Zen layer's, with no route and no Standard. The route goes first: it starts the focus views' chunk, which the terminal's request then waits for. */
	function openSession(ws: string, key: string, { mode, at }: { mode?: "chat" | "term"; at?: string } = {}): void {
		if (mode === "term" && zenOn()) return io.withZen((z) => (zenOn() ? z.terminal({ key }) : openSession(ws, key, { mode, at })));
		if (mode === "term") io.panels()?.stack.close("go");
		io.go({ view: "session", ws, key, at });
		if (mode === "term") io.withFocus((f) => f.terminal(key));
	}
	/** The step an accepted answer left shows as the terminal card (terminalthen.ts): in Zen on the layer's own screen, else in the dock. The route does not change: an answer given in the session view keeps its chat. */
	function openStep(s: StepOpen): void {
		if (zenOn()) return io.withZen((z) => (zenOn() ? z.step(s) : openStep(s)));
		io.withPanels((p) => p.step(s, latest));
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
		wake,
		/** A route change: show its view and watch what it needs (one connection serves one page). */
		route(next: Route) {
			const before = current;
			current = next;
			if ((next.view === "settings") !== (before.view === "settings")) face.route(next.view === "settings"); // the settings page is never covered by a drift into Zen; leaving it shows Zen again
			io.navigate(next, before);
			if (next.view === "map" && latest && latest !== shown) (snapshot(latest), io.layout());
			rewatch();
		},
		openAlert, openSession,
		openStep,
		/** The way out of Zen (zen.ts): Standard first, then the item's dialog or the session's comms, and the newest snapshot. */
		leaveZen({ item, route }: Exit) {
			face.leave();
			item && openAlert(item);
			route && io.go(route);
			wake();
		},
		/** The header's Zen button: the mark that this page left Zen goes and the view is read again. */
		enterZen: () => enterZen(io.view, io.root),
		/** A click on a system notification: Zen tells its one item itself; a trust question opens its dialog, any other alert its session. */
		notified: (a: Alert) => rules().announce === "current" || (a.trust ? openAlert(a) : openSession(a.ws, unitOf(a))),
		/** The chime for new link notices: Zen makes no sound of its own accord. */
		news: linkChime(() => !rules().chime, io.chime),
		/** The keymap the page reads (hotkeys.ts), and whether a modal holds the keyboard. */
		keys: () => rules().keys,
		modal: () => io.modal(),
		/** A hotkey of the keymap, done: Enter and Space end Zen's pause, Space opens the next alert and F enlarges the top dialog. False when it had nothing to do (the key stays the browser's), as for the rows the page has no action for yet (Z4b). */
		hotkey: (hotkey: Hotkey) => (hotkey === "pause" ? io.zen()?.tap() ?? false : hotkey === "history" ? io.zen()?.toggleHistory() ?? false : hotkey === "next" || hotkey === "zoom" ? io.panels()?.hotkey(hotkey) ?? false : false),
		/** The phone's quick-switch drawer is off in Zen. */
		noDrawer: () => !rules().drawer,
		/** Escape closes the top dialog; with none open it goes up one route (the settings page steps back to where it was opened from); a modal takes it for itself. In Zen the layer takes it first, in the capture phase (so a field's own handler cannot keep it from the rule): one press closes the menu, lets go of a field, or cancels or skips the card, and two that nothing took, within 600 ms, leave (zenkeys.ts). */
		escape(e: Esc, capture: boolean) {
			if (e.key !== "Escape" || e.defaultPrevented || io.modal()) return;
			if (capture) return void (!e.isComposing && zenOn() && io.zen()?.escape(e) && e.stopPropagation());
			if (zenOn()) return; // the layer's in the capture phase, or the terminal's own: the page goes up no route from Zen
			e.preventDefault();
			if (io.panels()?.stack.close() || current.view === "map") return;
			current.view === "settings" ? io.leaveSettings() : io.go(upOf(current));
		},
		/** The Zen companion's session whose log the stream sends (none: the route's). */
		watchLog(key: string | null) {
			zenKey = key;
			rewatch();
		},
	};
}
