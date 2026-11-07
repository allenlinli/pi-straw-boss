// The Raven Keep theme (鴉閣, docs/specs/2026-11-07-raven-view/spec.md §1.5): a gothic skin of Standard. Its stylesheet (raven.css: the palette, the fog, flicker, bats, and raven of the head page's backdrop, all CSS), its
// ten role icons (sprite.svg, ids `raven-<role>`), its role nouns, and its three sounds load together the first time a page shows the view (gui/themes/registry.ts), or boot.js links the stylesheet before the first frame.
// The backdrop and the sounds are files in this folder (the stylesheet and the sound URLs name them), fetched when first drawn or played.
import "./raven.css";
import sprite from "./sprite.svg?raw";
import ask from "./sounds/ask.mp3";
import done from "./sounds/done.mp3";
import error from "./sounds/error.mp3";
import type { ThemeParts } from "../theme.ts";
import { NOUNS } from "./nouns.ts";

export const theme: ThemeParts = {
	sprite,
	nouns: NOUNS,
	sounds: { waiting: ask, done, error },
	// The waiting badge over the crest: candle gold on the keep's ground.
	badge: { dot: "#e3b04b", ring: "#0d0a10", text: "#0d0a10" },
};
