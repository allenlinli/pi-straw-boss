// The page's views, named once: the server (the stored default, `/boss gui view`, the gui.json record), the page (gui/view.ts, the settings control, Zen's menu, the palette, the demo fixture) and the build (the theme map) all read this list.
// Names only: no theme code or asset belongs here, since the sb server imports this file. A new view is one more name here and a folder under gui/themes/.

/** The views a page can show; Standard is the base the page entry carries, the others are themes (gui/themes/). Raven Keep (鴉閣) is the gothic one. */
export const VIEWS = ["standard", "geek", "zen", "raven"] as const;
export type View = (typeof VIEWS)[number];
/** What a device or the server can choose: Auto leaves it to the screen (or, for a device, to the server's default). */
export const CHOICES = ["auto", ...VIEWS] as const;
export type Choice = (typeof CHOICES)[number];
export const isChoice = (value: unknown): value is Choice => typeof value === "string" && (CHOICES as readonly string[]).includes(value);
/** The view this value names, `undefined` for anything else (Auto included). */
export const viewOf = (value: unknown): View | undefined => (typeof value === "string" && (VIEWS as readonly string[]).includes(value) ? (value as View) : undefined);
/** The names as prose for an error text: `standard, geek, zen, or raven`. */
export const said = (names: readonly string[]) => `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
