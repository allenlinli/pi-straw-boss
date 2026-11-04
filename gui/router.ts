// The page's routes, below the server's <base href> (/<token>/): the net map, one workspace, one session, and the settings page. Ids are encoded in the path, so
// any session id or workspace id round-trips; real <a href> links work with middle-click and copy-link, and a plain click navigates without a reload.
// A session route may name an entry to open at (`?at=<entry id>`, the entry an alert was about); without it the comms log opens at the newest entry.
// The head route (`head`) is the head tower's page: the comms of its session key, which the net gives (net.head.key). The settings route (`settings`) may name a section to open (`settings/phone`; `settings/wifi` is the phone section on its Same Wi-Fi tab).

import { HEAD_KEY } from "../src/headkey.ts";

export const SECTIONS = ["phone", "wifi", "teams", "server"] as const;
export type Section = (typeof SECTIONS)[number];
/** The routes of the net itself, which the focus views (workspace, session) draw. */
export type NetRoute = { view: "map" } | { view: "workspace"; ws: string } | { view: "session"; ws: string; key: string; at?: string } | { view: "head" };
export type Route = NetRoute | { view: "settings"; section?: Section };

const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
};
// A segment of only dots would be read as a path step by the browser, so its dots are escaped too.
const enc = (part: string) => (/^\.+$/.test(part) ? part.replaceAll(".", "%2E") : encodeURIComponent(part));

/** The route for the part of the URL after the base ("", "w/<ws>", "w/<ws>/s/<key>", with "?at=<entry id>"); anything else is the map. */
export function parseRoute(rel: string): Route {
	const [path, query] = rel.split("#")[0]!.split("?"), [w, ws, s, key] = path!.replace(/^\/+|\/+$/g, "").split("/").map(decode);
	if (w === "head" && !ws) return { view: "head" };
	if (w === "settings") return SECTIONS.includes(ws as Section) ? { view: "settings", section: ws as Section } : { view: "settings" };
	if (w !== "w" || !ws) return { view: "map" };
	if (s !== "s" || !key) return { view: "workspace", ws };
	const at = new URLSearchParams(query).get("at");
	return at ? { view: "session", ws, key, at } : { view: "session", ws, key };
}
export const formatRoute = (r: Route) => (r.view === "map" ? "" : r.view === "head" || (r.view === "session" && r.ws === HEAD_KEY) ? "head" : r.view === "settings" ? (r.section ? `settings/${r.section}` : "settings") : r.view === "workspace" ? `w/${enc(r.ws)}` : `w/${enc(r.ws)}/s/${enc(r.key)}${r.at ? `?at=${encodeURIComponent(r.at)}` : ""}`);
/** One level up: session to workspace to map (the settings page goes to the map too; Escape on it steps back instead, main.ts). */
export const upOf = (r: Route): Route => (r.view === "session" && r.ws !== HEAD_KEY ? { view: "workspace", ws: r.ws } : { view: "map" });
/** The route the focus views are told: they draw the net's routes only, and the settings page is none of them (they see the map). */
export const netOf = (r: Route): NetRoute => (r.view === "settings" ? { view: "map" } : r);
/** What the stream is asked to watch on this route; the head page watches the head's session key, which only the net knows (`headKey`: none until the first snapshot). */
export const watchOf = (r: Route, headKey?: string) => (r.view === "session" ? r.key : r.view === "head" ? (headKey ?? null) : r.view === "workspace" ? `w:${r.ws}` : null);

/** How many of this page's own entries lie behind a history entry: `go` stamps each entry it pushes, the one the page loaded on has none. */
export const depthOf = (state: unknown) => Math.max(0, (state as { depth?: number } | null)?.depth || 0);

export interface Router { route(): Route; go(route: Route): void; href(route: Route): string }

/** History API routing: `go` pushes a state, Back and Forward call `onRoute`, and clicks on `a[data-route]` navigate in place.
 * A link marked `data-back` steps back through history when the page has an entry of its own behind this one, and goes to its route otherwise. */
export function createRouter(onRoute: (route: Route) => void, base = new URL(document.baseURI).pathname): Router {
	const route = () => parseRoute(location.pathname.slice(base.length) + location.search);
	const router: Router = {
		route,
		href: (r) => formatRoute(r) || "./",
		go(next) {
			const path = base + formatRoute(next);
			if (location.pathname + location.search !== path) history.pushState({ depth: depthOf(history.state) + 1 }, "", path);
			onRoute(next);
		},
	};
	addEventListener("popstate", () => onRoute(route()));
	document.addEventListener("click", (event) => {
		const link = (event.target as Element | null)?.closest?.("a[data-route]");
		if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		if (link.hasAttribute("data-back") && depthOf(history.state) > 0) history.back();
		else router.go(parseRoute(link.getAttribute("data-route")!));
	});
	return router;
}
