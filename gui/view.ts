import { createPrefs, KEYS } from "./prefs.ts";

// The page's view: Standard (the Tokyo Night palette with its motion), Geek (black, monospace, AAA contrast, nothing moves; style.css `[data-view="geek"]`), or Zen (ink; one waiting item at a time, docs/specs/2026-11-01-zen-view.md; until its layer lands a Zen page shows Standard's page).
// The choice is the device's: Auto, Standard, Geek, or Zen in localStorage `sb.view`. An explicit Standard or Geek wins; Auto (also a missing or invalid value)
// follows the server's default when the boss set one (`/boss gui view`: Standard, Geek, or Zen), else the OS, Geek when it asks for more contrast (prefers-contrast: more).
// The server's default is not the device's to write: it comes in the page's `<meta name="sb-view">` (read here before the first paint, so a following page shows it with
// no flash), in each stream's `hello`, and in a `view` event (main.ts hands them to `setServer`), and is never stored on the device. `data-view` goes on <html> as the first
// thing main.ts does, before any render, and the browser's theme-color follows it, so an installed app's bar matches.

export type Choice = "auto" | "standard" | "geek" | "zen";
export type View = "standard" | "geek" | "zen";
/** What moved the view: the person chose one (`pick`: here or on another page of this device), or the page's own Auto followed the server's default or the screen (`follow`). */
export type Cause = "pick" | "follow";
export const KEY: string = KEYS.view;
/** The theme-color of the Geek and Zen views (Zen: the ink ground); Standard keeps the color the page came with (index.html). */
export const THEME = { geek: "#000000", zen: "#14110e" } as const;

/** The stored value as a choice: only the three views are choices of their own, anything else (missing, invalid) is Auto. */
export const choiceOf = (stored: string | null | undefined): Choice => (stored === "standard" || stored === "geek" || stored === "zen" ? stored : "auto");
/** What Auto means now: the server's default when it names a view, else what the screen asks for. */
export const autoView = (contrast: boolean, server: Choice = "auto"): View => (server === "auto" ? (contrast ? "geek" : "standard") : server);
export const resolve = (choice: Choice, contrast: boolean, server: Choice = "auto"): View => (choice === "auto" ? autoView(contrast, server) : choice);

/** What the view reads and writes, as plain parts so a test can stand in for the page. */
export interface ViewEnv {
	root: { dataset: Record<string, string | undefined> };
	/** `<meta name="theme-color">`, when the page has one. */
	meta?: { content: string } | null;
	/** `<meta name="sb-view">`, the server's default as it wrote it into the page (absent from a page an older server or the demo serves: Auto). */
	server?: { content: string } | null;
	/** The `(prefers-contrast: more)` query. */
	media: { matches: boolean; addEventListener(type: "change", listener: () => void): void };
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function domEnv(): ViewEnv {
	return {
		root: document.documentElement,
		meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
		server: document.querySelector<HTMLMetaElement>('meta[name="sb-view"]'),
		media: matchMedia("(prefers-contrast: more)"),
		storage: localStorage,
	};
}

export function mountView(env: ViewEnv = domEnv()) {
	const listeners: ((view: View, cause: Cause) => void)[] = [], serverListeners: ((server: Choice) => void)[] = [], standard = env.meta?.content ?? "";
	const prefs = createPrefs(env.storage), read = () => choiceOf(prefs.get("view")); // storage refused: the OS decides
	let choice = read(), server = choiceOf(env.server?.content), shown: View | undefined;
	/** A `pick` tells the listeners every time, even when the view it resolves to is the one shown (a Zen page that was left comes back); a `follow` only when the view changed. */
	function apply(cause?: Cause) {
		const view = resolve(choice, env.media.matches, server), face = view === "zen" && env.root.dataset.zenAway !== undefined ? "standard" : view; // a page that left Zen (main.ts) shows Standard
		env.root.dataset.view = face;
		if (env.meta) env.meta.content = face === "standard" ? standard : THEME[face];
		const told = cause === "pick" || (cause === "follow" && shown !== undefined && shown !== view);
		shown = view; // before the listeners, which may draw the view again (viewface.ts)
		if (told) for (const fn of listeners) fn(view, cause!);
	}
	apply();
	env.media.addEventListener("change", () => apply("follow"));
	return {
		choice: () => choice,
		view: () => resolve(choice, env.media.matches, server),
		/** The server's default, as the page last heard it. */
		server: () => server,
		/** The server named a default (hello, a `view` event): a page that follows it switches at once, one with a choice of its own stays; nothing is stored. */
		setServer(next: unknown) {
			const value = choiceOf(typeof next === "string" ? next : undefined);
			if (value === server) return;
			server = value;
			for (const fn of serverListeners) fn(server);
			apply("follow");
		},
		/** Switches at once and keeps the choice for this device; a refused storage still switches this page. */
		set(next: Choice) {
			choice = next;
			prefs.set("view", next); // storage refused: the choice holds until the page closes
			apply("pick");
		},
		/** Draws the view again (the page left Zen or came back, viewface.ts) without reading the storage, and tells no one. */
		refresh: () => apply(),
		/** Another tab of this device chose: read the stored value again. */
		reread() {
			choice = read();
			apply("pick");
		},
		/** Another tab of this device wrote the choice. */
		onStored: (fn: () => void) => prefs.on("view", fn),
		onChange: (fn: (view: View, cause: Cause) => void) => void listeners.push(fn),
		/** Told when the server's default changed (the settings' Auto button names it). */
		onServer: (fn: (server: Choice) => void) => void serverListeners.push(fn),
	};
}
export type PageView = ReturnType<typeof mountView>;

/** The settings' four-way control: buttons `[data-choice]` in `group`, the chosen one `aria-pressed`. `label` words the Auto button for the server's default (Follow server (geek)); without one it keeps its text. */
export function mountPick(group: HTMLElement, view: PageView, label?: (server: Choice) => string) {
	const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-choice]")];
	const auto = buttons.find((b) => b.dataset.choice === "auto");
	// With a server default the Auto button reads "Follow server (…)" and is too long for the row it shares: `data-following` gives it a row of its own.
	const words = () => {
		if (auto && label) auto.textContent = label(view.server());
		if (group.dataset) group.toggleAttribute("data-following", view.server() !== "auto");
	};
	words();
	view.onServer(words);
	const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.choice === view.choice())));
	for (const b of buttons) b.addEventListener("click", () => (view.set(choiceOf(b.dataset.choice)), sync()));
	view.onStored(() => (view.reread(), sync()));
	sync();
}

/** Back to Zen: the mark that this page left it goes, and the view is read again, which shows Zen (a pick: viewface.ts). */
export const enterZen = (view: Pick<PageView, "reread">, root: { dataset: Record<string, string | undefined> }) => (delete root.dataset.zenAway, view.reread());

/** The header's Zen button: shown only when the device's view is Zen and the Zen layer was left (`data-zen-away` on <html>); a click returns to it. Returns the sync. */
export function mountZenBack(button: HTMLElement, view: PageView, root: { dataset: DOMStringMap }, enter = () => enterZen(view, root)) {
	const sync = () => (button.hidden = view.view() !== "zen" || root.dataset.zenAway === undefined);
	view.onChange(sync);
	button.addEventListener("click", () => (enter(), sync()));
	sync();
	return sync;
}
