import type { NounPack } from "../nouns.ts";

/** What a theme's entry module exports as `theme` besides its code: the parts the page takes from it (gui/themes/registry.ts). All optional: Geek and Zen add nothing yet, and a missing part is Standard's. */
export interface ThemeParts {
	/** The icon sprite's symbols, with ids prefixed by the view (`raven-tower`). */
	sprite?: string;
	/** The role nouns by locale. */
	nouns?: NounPack;
	/** The tab icon's waiting badge: the dot, its ring, and the count (Standard's by default). */
	badge?: { dot: string; ring: string; text: string };
}
