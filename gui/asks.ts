import type { SessionPost } from "./answer.ts";
import { type Answer, post } from "./post.ts";
import type { NetRoute } from "./router.ts";
import { towerRoute } from "./towermodel.ts";

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
/** A plain English reason after "did not take it:" starts in lower case; an acronym or other script stays. */
export const joined = (reason: string) => reason.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());

/** The wait the actions are about: its workspace, its id in the tower's memory, and the tower's session key (where the boss's words go). */
export interface WaitTarget { ws: string; id: string; tower: string }
export interface WaitActions {
	/** The boss's words to the tower: the session's `input`, the route Standard's composer sends to (`send` is `answerPost` of the tower's key, or the demo fixture's stand-in). */
	tell(text: string): Promise<Answer>;
	/** Dismiss: the server drops the wait from the tower's memory. */
	dismiss(): Promise<Answer>;
	/** The tower's comms: the one action that navigates, offered as a link. */
	goto: NetRoute;
}
/** What the boss can do with a wait the tower recorded on them, as plain functions every view draws (waitpanel.ts, towernotes.ts); a view differs only in what it does after `outcome` of the reply. */
export const waitActions = (w: WaitTarget, send: SessionPost): WaitActions => ({
	tell: (text) => send("input", { text, as: "send", answers: w.id }), // `answers`: the server marks this wait answered once the tower took the message, so no view raises it again
	dismiss: () => post(`${towerRoute(w.ws)}/memory`, { op: "drop", id: w.id }), // the head's waits go to `head/memory`
	goto: { view: "session", ws: w.ws, key: w.tower },
});
