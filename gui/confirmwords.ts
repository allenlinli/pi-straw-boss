import { ENDING } from "../src/probe.ts";
import { m } from "./paraglide/messages.js";

// The key pad's confirm (src/keys.ts) names what it asks about by a token and says it in English. The page says it in its own language by the token, and shows the server's words only for a token it does not know.
const WORDS: Record<string, () => string> = { unread: m.confirm_unread, command: m.confirm_command, "double-esc": m.confirm_double_esc, "ctrl-d": m.confirm_ctrl_d, "double-ctrl-c": m.confirm_double_ctrl_c };
/** The reason for `token`: the table's words, or the ending command's (the server names it as the token), or `said`. */
export const confirmReason = (token: string, said: string) => WORDS[token]?.() ?? (ENDING.test(`/${token}`) ? m.confirm_ending({ command: `/${token}` }) : said);
