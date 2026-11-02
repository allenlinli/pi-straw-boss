import { parseSddl, SYSTEM_SID, type Sddl } from "./acl.ts";

// The grants `icacls <dir> /inheritance:r /grant:r <owner> <SYSTEM>` leaves on a folder: it turns the inherited ACEs explicit and replaces only the grants of the SIDs it names, so an elevated token's
// new folder (a GitHub windows runner's runneradmin) kept BUILTIN\Administrators, and the strict check (`folderProblems`) refused it. Those grants are taken off by SID. The check is not touched.

/** The SIDs SDDL writes as two-letter aliases, as `S-1-…` (what `icacls /remove:g *<SID>` takes). Domain-relative aliases (CA, DA, DU, LA, LG, …) are not here: they cannot be told from the owner alone. */
const ALIAS_SIDS: Record<string, string> = {
	WD: "S-1-1-0", CO: "S-1-3-0", CG: "S-1-3-1", NU: "S-1-5-2", IU: "S-1-5-4", SU: "S-1-5-6", AN: "S-1-5-7", PS: "S-1-5-10", AU: "S-1-5-11", RC: "S-1-5-12", ED: "S-1-5-9",
	LS: "S-1-5-19", NS: "S-1-5-20", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547", AO: "S-1-5-32-548", SO: "S-1-5-32-549", PO: "S-1-5-32-550",
	BO: "S-1-5-32-551", RE: "S-1-5-32-552", RU: "S-1-5-32-554", RD: "S-1-5-32-555", NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559", IS: "S-1-5-32-568",
};
/**
 * The explicit allow ACEs of a folder's SDDL that belong to neither the owner nor SYSTEM, as `S-1-…` SIDs (never a localized name): what `icacls /remove:g` must take off after `/inheritance:r /grant:r`
 * (which replaces only the grants of the SIDs it names, so BUILTIN\Administrators on an elevated token's new folder stays). A deny ACE, an inherited one, an alias that is not known here, and an SDDL
 * that cannot be read are NOT listed: `folderProblems` still refuses them, so nothing here loosens the check.
 */
export function strayGrants(sddl: string, owner: string): string[] {
	let parsed: Sddl;
	try {
		parsed = parseSddl(sddl);
	} catch {
		return [];
	}
	const want = new Set([owner.toUpperCase(), SYSTEM_SID]), found = new Set<string>();
	for (const ace of parsed.aces) {
		if (ace.type !== "A" || ace.flags.includes("ID")) continue;
		const sid = ace.sid.toUpperCase(), full = /^S-1-[0-9-]+$/.test(sid) ? sid : sid === "SY" ? SYSTEM_SID : ALIAS_SIDS[sid];
		if (full && !want.has(full)) found.add(full);
	}
	return [...found];
}
/** The icacls call that takes the grants of `sids` off a folder (by SID, so a localized group name cannot matter). */
export const removeArgs = (dir: string, sids: string[]) => [dir, "/remove:g", ...sids.map((sid) => `*${sid}`), "/L"];
