import type { Cause, PageView, View } from "./view.ts";

// What the page's face does when the view moves (docs/specs/2026-11-01-zen-view.md, Leaving and coming back): the one place that knows. The device's view is Zen, Standard, or Geek (view.ts); a page
// shows Zen only while it has not left it (`away`: Esc, the corner control, or the settings page) and is not on the settings route. Everything that moves the face goes through `faceAfter`,
// so the rules are one table (tests/viewface.test.ts walks it for every state) and the views-core refactor can move it whole.
//
//   pick     the person chose a view, on the settings page, in Zen's menu, or on another page of this device: it shows at once, from anywhere. Away is cleared, and a Zen pick on the settings
//            page leaves the page (the settings route is never covered by itself, but an explicit pick is not a drift into Zen).
//   follow   Auto followed the server's default or the screen: it shows at once, except that a Zen arriving while the settings page is open waits there (away) until the page is left.
//   leave    Esc, the corner control, an item's or session's exit: this page shows Standard, the device's choice stays.
//   back     the header's Zen button: Zen shows again.
//   route    the page opened or left the settings route: a Zen device's page stays Standard on it, and shows Zen on leaving it.

export type Move = { on: "pick" } | { on: "follow" } | { on: "leave" } | { on: "back" } | { on: "route"; settings: boolean };
export interface Face {
	/** This page left Zen (`data-zen-away` on <html>). */
	away: boolean;
	/** The route is the settings page. */
	settings: boolean;
}
export interface Next extends Face {
	/** The page must go back off the settings route so the view can show (a Zen pick there). */
	leaveSettings: boolean;
}

/** The face after a move: `resolved` is the device's view now (view.view()), `at` where the page was. */
export function faceAfter(move: Move, resolved: View, at: Face): Next {
	const zen = resolved === "zen";
	switch (move.on) {
		case "pick":
			return { away: false, settings: at.settings, leaveSettings: zen && at.settings };
		case "follow":
			return { away: !zen ? false : at.settings ? true : at.away, settings: at.settings, leaveSettings: false };
		case "leave":
			return { away: true, settings: at.settings, leaveSettings: false };
		case "back":
			return { away: false, settings: at.settings, leaveSettings: false };
		case "route":
			return { away: zen ? move.settings : at.away, settings: move.settings, leaveSettings: false };
	}
}

/** The page's hooks, as plain parts so a test can stand in for it. */
export interface FaceDeps {
	view: Pick<PageView, "view" | "refresh" | "onChange">;
	root: { dataset: Record<string, string | undefined> };
	/** The route is the settings page now. */
	settings(): boolean;
	/** Go back off the settings page (the page's own Back). */
	leaveSettings(): void;
	/** Draw what the face now is: the header's Zen button, the Zen layer or Standard, the tab icon, the stream's watch. */
	draw(): void;
}

export function mountFace(d: FaceDeps) {
	const at = (): Face => ({ away: d.root.dataset.zenAway !== undefined, settings: d.settings() });
	function move(m: Move) {
		const before = at(), next = faceAfter(m, d.view.view(), before);
		if (next.away) d.root.dataset.zenAway = "";
		else delete d.root.dataset.zenAway;
		d.view.refresh();
		d.draw();
		if (next.leaveSettings) d.leaveSettings();
	}
	d.view.onChange((_view, cause: Cause) => move({ on: cause }));
	return {
		/** Esc, the corner control, or an item's or a session's exit: this page shows Standard. */
		leave: () => move({ on: "leave" }),
		/** The header's Zen button. */
		back: () => move({ on: "back" }),
		/** The route moved onto or off the settings page (`settings` is where it is now). */
		route: (settings: boolean) => move({ on: "route", settings }),
	};
}
