import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// The refusals of a terminal's keys and mirror (src/keys.ts, src/mirror.ts, a pane's src/answerpane.ts, and the session routes of src/control.ts) name themselves by a code and say it in English. The page says it in its own language by the code,
// and shows the server's words only for a code it does not know. The mirror's `ended` frames carry only English text, so they are matched by it. Both the pad and the terminal card read here.
const CODE: Record<string, () => string> = {
	no_mirror: m.refuse_no_mirror, blocked: m.refuse_blocked, lan_overlay_open: m.refuse_lan_overlay_open, local_only: m.refuse_local_only, rate: m.refuse_rate, no_key: m.refuse_no_key, text: m.refuse_text, paste: m.refuse_paste,
	key: m.refuse_key, bad_request: m.refuse_bad_request, not_live: m.refuse_not_live, unavailable: m.refuse_unavailable, too_many: m.refuse_too_many,
	standing: m.refuse_standing, not_found: m.refuse_not_found, pane_closed: m.refuse_pane_closed, busy: m.refuse_busy, run_unknown: m.refuse_run_unknown, run_expired: m.refuse_run_expired, run_changed: m.refuse_run_changed, operate_refused: m.refuse_operate_refused,
};
/** An operate refusal says why by a word of its own beside the code; these are the ones with page words (src/keys.ts, src/probe.ts, src/operateseam.ts). */
const OPERATE_WHY: Record<string, () => string> = { binding: m.refuse_operate_binding, "binding-unread": m.refuse_operate_binding_unread, foreground: m.refuse_operate_foreground };
const ENDED: Record<string, () => string> = {
	"The session is no longer live in this pane.": m.ended_not_live, "The pane runs something else now.": m.ended_other, "The pane closed.": m.ended_closed, "The pane could not be read.": m.ended_unreadable, "The session moved to another pane.": m.ended_moved,
};
export const REFUSAL_CODES = Object.keys(CODE);
const say = (fn: (() => string) | undefined, locale?: string) => (fn as ((i: object, o?: object) => string) | undefined)?.({}, locale ? { locale } : undefined);
/** A refused write or attach in the page's words by the server's code; an unknown code shows the server's text, and none shows the status. */
export const refusalText = (r: Answer, locale?: string) => say(r.body.error === "operate_refused" ? OPERATE_WHY[String(r.body.why)] : undefined, locale) ?? say(CODE[String(r.body.error)], locale) ?? r.body.reason ?? m.refused({ status: r.status }, locale ? { locale: locale as "en" } : undefined);
/** The mirror's `ended` reason in the page's words, or as the server wrote it. */
export const endedWhy = (why: string, locale?: string) => say(ENDED[why], locale) ?? why;
