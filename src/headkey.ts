/** What every channel answers when the tower service is off: the head tower is one of its services. */
export const HEAD_NEEDS_SERVICE = "The head tower needs the tower service (towerRuns)";
/** The key of the head tower's folder that is no Herdr id (a workspace id never starts with `@`): `towerDir(slot, HEAD_KEY)` is `head/` whether or not a head service stands (server/towerstore.ts). The panel, the memory command, and the net use it as the head's stand-in for a workspace id. */
export const HEAD_KEY = "@head";
