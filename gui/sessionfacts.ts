import type { Mark } from "../src/netdata.ts";
import { type Unit as Facts, wakeOf } from "./composer.ts";
import { liveMark, liveNote } from "./render.ts";
import { closed } from "./scene.ts";

// The facts a session's composer and live line read, decided once for the session view and Zen's companion. `u` is the net's unit (or the history header's who); none for an ally or event run, which `role` names.
type U = { control?: boolean; ended?: boolean; note?: string; agent?: "claude" | "codex"; pending?: { answer?: unknown }; service?: Parameters<typeof wakeOf>[0] };
export const composerUnit = (u: U | undefined, { name, mk, state, online, role }: { name: string; mk: Mark; state?: string; online: boolean; role?: string }): Facts => ({ name, control: Boolean(u?.control), agent: u?.agent, live: !closed(u, state), mark: mk, online, answerable: Boolean(u?.pending?.answer), ...wakeOf(u?.service), ally: !u && (role === "ally" || role === "run"), run: !u && role === "run" });
/** The live line's words and the mark of its badge (a finished subagent keeps no working mark). */
export const liveOf = (u: U | undefined, state: string | undefined, mk: Mark): [string, Mark] => [liveNote(u, state, mk), liveMark(u, state, mk)];
