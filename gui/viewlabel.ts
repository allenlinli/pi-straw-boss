import { m } from "./paraglide/messages.js";
import type { Choice } from "./view.ts";

/** The Auto button's label: Auto, or Follow server with the default's name. */
export const followLabel = (server: Choice) =>
	server === "auto" ? m.view_auto() : m.view_follow({ view: server === "geek" ? m.view_geek() : server === "zen" ? m.view_zen() : m.view_standard() });
