import type { Net } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import { answerPost } from "./answer.ts";
import { type Unit as Facts, wakeOf } from "./composer.ts";
import { liveMark, liveNote } from "./render.ts";
import { closed } from "./scene.ts";
import { recording, sendTarget } from "./zenwith.ts";

// The facts a session's composer and live line read, decided once for the session view and Zen's companion. `u` is the net's unit (or the history header's who); none for an ally or event run, which `role` names.
type U = { control?: boolean; ended?: boolean; note?: string; agent?: "claude" | "codex"; pending?: { answer?: unknown }; service?: Parameters<typeof wakeOf>[0] };
export const composerUnit = (u: U | undefined, { name, mk, state, online, role }: { name: string; mk: Mark; state?: string; online: boolean; role?: string }): Facts => ({ name, control: Boolean(u?.control), agent: u?.agent, live: !closed(u, state), mark: mk, online, answerable: Boolean(u?.pending?.answer), ...wakeOf(u?.service), ally: !u && (role === "ally" || role === "run"), run: !u && role === "run" });
/** The live line's words and the mark of its badge (a finished subagent keeps no working mark). */
export const liveOf = (u: U | undefined, state: string | undefined, mk: Mark): [string, Mark] => [liveNote(u, state, mk), liveMark(u, state, mk)];
/** The composer's post for `key`: the fixture's route or the session's, remembering an accepted input as the companion. */
export const sendFor = (key: string, fixture: Parameters<typeof answerPost>[1], at: () => { net: Net | undefined; ws: string }, now?: () => number, store?: Parameters<typeof recording>[3]) => recording(answerPost(key, fixture), () => ((a) => sendTarget(a.net, key, a.ws))(at()), now, store);
