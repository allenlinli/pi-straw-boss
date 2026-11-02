import { h } from "./dom.ts";
import { createPrefs, KEYS } from "./prefs.ts";
import { m } from "./paraglide/messages.js";

// Zen's full-screen control (docs/specs/2026-11-01-zen-view.md): the corner button asks the browser to show the page full screen and back. Where the browser cannot (an iPhone's Safari has no
// Fullscreen API for a page) the button is hidden, and a touch device that is not an installed app is told once, quietly, that adding the page to the Home Screen gives a full-screen one.

interface Root { requestFullscreen?(): Promise<void>; webkitRequestFullscreen?(): Promise<void> | void }
export interface FsDoc {
	fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean; fullscreenElement?: unknown; webkitFullscreenElement?: unknown;
	exitFullscreen?(): Promise<void>; webkitExitFullscreen?(): Promise<void> | void;
	addEventListener(type: string, fn: () => void): void;
	documentElement: Root;
}
export interface FsEnv { doc: FsDoc; /** An installed app (the Home Screen, a PWA window) already has no browser bar. */ standalone(): boolean; touch(): boolean; seen: Pick<Storage, "getItem" | "setItem">; later(fn: () => void, ms: number): () => void }
export const HINT_KEY = KEYS.zenHint, HINT_MS = 9000;
export const domFs = (later: FsEnv["later"]): FsEnv => ({
	doc: document as unknown as FsDoc, // SAFETY: FsDoc names the few optional members of Document (and its WebKit-prefixed twins) this file reads

	standalone: () => (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) || (navigator as { standalone?: boolean }).standalone === true,
	touch: () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
	seen: localStorage, later,
});

export function mountFullscreen(env: FsEnv) {
	const { doc } = env, root = doc.documentElement;
	const request = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root), exit = doc.exitFullscreen?.bind(doc) ?? doc.webkitExitFullscreen?.bind(doc);
	const can = Boolean((doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled) && request && exit);
	const button = h("button", { type: "button", class: "zen-fs" }), on = () => Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
	const draw = () => {
		const words = on() ? m.zen_fullscreen_exit() : m.zen_fullscreen();
		button.setAttribute("aria-label", words);
		button.setAttribute("aria-pressed", String(on()));
		button.title = words;
	};
	button.hidden = !can;
	draw();
	button.onclick = () => void Promise.resolve(on() ? exit?.() : request?.()).catch(() => {}); // refused (a frame, a policy): the page stays as it is
	for (const type of ["fullscreenchange", "webkitfullscreenchange"]) doc.addEventListener(type, draw);
	let hint: HTMLElement | undefined;
	const seen = createPrefs(env.seen);
	let told = seen.get("zenHint"); // storage refused: no hint, it could not be remembered
	if (!can && !told && env.touch() && !env.standalone()) {
		hint = h("p", { class: "zen-hint", role: "status" }, m.zen_add_home());
		seen.set("zenHint", true); // storage refused: the hint shows this time only
		const gone = hint;
		env.later(() => gone.remove(), HINT_MS);
	}
	return { button, hint, draw };
}
