import { m } from "./paraglide/messages.js";
import { getLocale } from "./paraglide/runtime.js";

// The role nouns of the page: one chokepoint, `noun(key)`. The active theme's pack (gui/themes/<view>/ exports one per locale) names a role in its own words when it has the key, and every other string, and every
// sentence that embeds a role word, stays on the base messages. With no pack loaded (Standard, a theme still on its way) `noun` is the base message, so a page never waits on the network for a word.

/** The strings that name a role: the role words (`roleName`, render.ts), the head tower, the base's two groups, the comms, and the dossier's base row. A pack holds only these. */
export const NOUN_KEYS = ["role_ally", "role_run", "role_main", "role_member", "role_subagent", "role_tower", "role_outpost", "role_outside", "role_session", "head_tower", "outposts", "outside_net", "comms", "spec_base"] as const;
export type NounKey = (typeof NOUN_KEYS)[number];
/** A theme's words by locale (`en`, `zh-TW`). */
export type NounPack = Partial<Record<string, Partial<Record<NounKey, string>>>>;

const BASE: Record<NounKey, () => string> = {
	role_ally: m.role_ally, role_run: m.role_run, role_main: m.role_main, role_member: m.role_member, role_subagent: m.role_subagent, role_tower: m.role_tower, role_outpost: m.role_outpost,
	role_outside: m.role_outside, role_session: m.role_session, head_tower: m.head_tower, outposts: m.outposts, outside_net: m.outside_net, comms: m.comms, spec_base: m.spec_base,
};
let pack: NounPack | undefined;
/** The pack of the view the page shows now; none for Standard. */
export const usePack = (next: NounPack | undefined) => void (pack = next);
export const noun = (key: NounKey): string => pack?.[getLocale()]?.[key] ?? BASE[key]();
