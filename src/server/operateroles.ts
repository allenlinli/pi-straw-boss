// The roles a unit of the net has, as the transcript ledger (operateledger.ts) keeps one and the controller reads one back (operatesanitize.ts): the same list on both sides, so a role is a word of the list and never free text.
export const UNIT_ROLES = ["main", "member", "train", "subagent", "outside", "tower", "ally", "run", "head"] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];
/** The key the head tower has on a box (`headId` in record.ts: `sb-head`, or `sb-head-<slot8>` on a server that is not the primary one). The head tower is box-wide and no operate session's, so a key of this shape is refused on both ends whatever the registry says of it. */
export const isHeadKey = (key: string): boolean => /^sb-head(-[0-9a-f]{8})?$/.test(key);
