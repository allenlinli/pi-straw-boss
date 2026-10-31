import type { Tile } from "./layer.ts";
import type { Section } from "./router.ts";

// The settings page's sections that need the server (route `settings`, index.html): Phone & devices, Teams, and Server, each a `<details>` that fills with its panel when it opens and
// drops it when it closes or the page is left, so nothing polls or mints behind a closed section (a pairing code is minted only by opening Phone). The panels are the ones that were tiles
// beside the map (pair.ts, link.ts, server.ts): what each does and who may use it are unchanged. `phone` and `server` say whether this page may have them (main.ts): a paired device has
// neither, and a desk window has no Phone; their sections stay hidden and a route that names them opens nothing. This device's own choices are markup, mounted by notify.ts, view.ts, and i18n.ts.

export type Part = "phone" | "teams" | "server";
export type Tab = "tailscale" | "lan";
export type Panel = Tile & { select?(tab: Tab): void };
const PARTS: Part[] = ["phone", "teams", "server"];
/** Each part's panel; Phone opens on the tab asked for when it has loaded. */
export const MAKE: Record<Part, (tab: () => Tab) => Promise<Panel>> = {
	phone: (tab) => import("./pair.ts").then((x) => x.pairTile(tab())),
	teams: () => import("./link.ts").then((x) => x.linkTile()),
	server: () => import("./server.ts").then((x) => x.serverTile()),
};
/** The part a section opens, and the tab of Phone it shows. */
const PART_OF = (section: Section): [Part, Tab] => (section === "wifi" ? ["phone", "lan"] : [section, "tailscale"]);

export function mountSettings(root: HTMLElement, allowed: { phone: boolean; server: boolean }, make: typeof MAKE = MAKE) {
	const state = PARTS.map((name) => {
		const box = root.querySelector<HTMLDetailsElement>(`#set-${name}`)!, body = box.querySelector<HTMLElement>(".set-body")!;
		box.hidden = name !== "teams" && !allowed[name];
		return { name, box, body, panel: undefined as Panel | undefined, loading: false, turn: 0, tab: "tailscale" as Tab };
	});
	const of = (name: Part) => state.find((s) => s.name === name)!;
	/** Builds a section's panel (once: an open one is moved to `tab`); `tab` is left alone when the section opened by hand. */
	function fill(name: Part, tab?: Tab) {
		const s = of(name);
		if (tab) s.tab = tab;
		if (s.panel) return void (tab && s.panel.select?.(tab));
		if (s.loading) return;
		const turn = ++s.turn;
		s.loading = true;
		void make[name](() => s.tab).then((panel) => {
			s.loading = false;
			if (turn !== s.turn) return; // closed while it loaded
			s.panel = panel;
			s.body.replaceChildren(panel.body());
		}, () => (s.loading = false));
	}
	/** Drops a section's panel: its polls stop with `closed`, and its content goes. */
	function drop(name: Part) {
		const s = of(name);
		s.turn++;
		s.loading = false;
		s.panel?.closed?.();
		s.panel = undefined;
		s.body.replaceChildren();
	}
	for (const s of state) s.box.addEventListener("toggle", () => (s.box.open ? fill(s.name) : drop(s.name)));
	return {
		/** The page is shown: opens `section` (Phone for Wi-Fi, on its Same Wi-Fi tab) and brings it into view. A section this page may not have opens nothing. */
		show(section?: Section) {
			if (!section) return;
			const [name, tab] = PART_OF(section), s = of(name);
			if (s.box.hidden) return;
			s.box.open = true;
			fill(name, tab);
			s.box.scrollIntoView({ block: "start" });
		},
		/** The page is left: every section closes, which stops what it was polling. */
		hide() {
			for (const s of state) (s.box.open = false, drop(s.name));
		},
	};
}
