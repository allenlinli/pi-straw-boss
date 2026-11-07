import { m } from "./paraglide/messages.js";
import type { Choice, View } from "../src/views.ts";

/** A view's name as the page words it; every name of src/views.ts has one. */
export const NAME: Record<View, () => string> = { standard: m.view_standard, geek: m.view_geek, zen: m.view_zen };
/** The Auto button's label: Auto, or Follow server with the default's name. */
export const followLabel = (server: Choice) => (server === "auto" ? m.view_auto() : m.view_follow({ view: NAME[server]() }));
