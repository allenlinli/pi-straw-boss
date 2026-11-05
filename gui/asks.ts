import type { Answer } from "./post.ts";

// What the boss's answers have in common, decided once for every view (docs/specs/2026-11-01-zen-view.md, Answering): how a reply to an answer reads. The routes say it in their own words: a dialog or trust answer has an `outcome`, a message to a tower
// (the session's `input`) says `accepted: true`, and the tower memory route (a dismissed wait) answers the memory it now holds. A view reads them through `outcome` and acts on one of three: Standard closes its dialog, Zen's model knocks or plays the low bowl.

export type Outcome = "accepted" | "unknown" | "refused";
/** What a reply meant: the owner took it, did not say (Check again), or it was refused. A reply with an `outcome` is judged by it alone. */
export const outcome = (r: Pick<Answer, "ok" | "status" | "body">): Outcome => {
	const said = r.body.outcome;
	if (said !== undefined) return said === "accepted" ? "accepted" : said === "unknown" ? "unknown" : "refused";
	if (r.status === 504) return "unknown";
	return r.ok && (r.body.accepted === true || Array.isArray(r.body.entries)) ? "accepted" : "refused";
};
