// The Raven Keep theme (鴉閣, docs/specs/2026-11-07-raven-view/spec.md §1.5): a gothic skin of Standard. Its stylesheet (raven.css: the palette, the fog, flicker, bats, and raven of the head page's backdrop, all CSS), its
// ten role icons (sprite.svg, ids `raven-<role>`), its role nouns, and its three sounds load together the first time a page shows the view (gui/themes/registry.ts), or boot.js links the stylesheet before the first frame.
// The backdrop and the sounds are files in this folder (the stylesheet and the sound URLs name them), fetched when first drawn or played.
import "./raven.css";
import sprite from "./sprite.svg?raw";
import bell from "./sounds/bell.mp3";
import caw from "./sounds/caw.mp3";
import door from "./sounds/door.mp3";
import type { ThemeParts } from "../theme.ts";
import { NOUNS } from "./nouns.ts";
import { SENTENCES } from "./sentences.ts";

export const theme: ThemeParts = {
	sprite,
	nouns: NOUNS,
	sentences: SENTENCES,
	// A question for the boss rings the bell (boss, 2026-11-08: the bell sounds like something that wants an answer), a finish is the crow's caw, a failure the door.
	sounds: { waiting: bell, done: caw, error: door },
	// The waiting badge over the crest: candle gold on the keep's ground.
	badge: { dot: "#e3b04b", ring: "#0d0a10", text: "#0d0a10" },
};
