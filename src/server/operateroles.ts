// The roles a unit of the net has, as the transcript ledger (operateledger.ts) keeps one and the controller reads one back (operatesanitize.ts): the same list on both sides, so a role is a word of the list and never free text.
export const UNIT_ROLES = ["main", "member", "train", "subagent", "outside", "tower", "ally", "run", "head"] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];
