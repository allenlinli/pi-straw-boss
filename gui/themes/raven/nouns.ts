import type { NounPack } from "../../nouns.ts";

// Raven Keep's role nouns (docs/specs/2026-11-07-raven-view/spec.md §1.5): the boss is the Count, the head tower is the castle, stewards and bats work between the keep and the crypts. Only the strings that name a role;
// a sentence that embeds a role word is the theme's too, in sentences.ts. Original words only (nothing from a published setting's names).
export const NOUNS: NounPack = {
	en: {
		you: "the Count", head_tower: "Raven Keep", role_tower: "Steward", role_main: "Spawn", role_member: "Wolf", role_subagent: "Bat", spec_base: "Crypt",
		role_outpost: "Coffin chamber", outposts: "Coffin chambers", role_outside: "Ghost", outside_net: "Ghosts", comms: "Ravens", documents: "Tome",
	},
	"zh-TW": {
		you: "伯爵", head_tower: "鴉閣", role_tower: "管家", role_main: "血僕", role_member: "狼", role_subagent: "蝙蝠", spec_base: "墓穴",
		role_outpost: "棺室", outposts: "棺室", role_outside: "遊魂", outside_net: "遊魂", comms: "通信", documents: "典籍",
	},
};
