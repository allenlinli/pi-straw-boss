import type { Then } from "../src/owners.ts";
import { m } from "./paraglide/messages.js";

// The one rule of the page: an outcome that needs the terminal opens the terminal card. When the server accepts an answer whose choice leaves a step in a terminal, its reply carries `then`
// (src/control.ts; owners.ts `Then`): the session's own terminal (the prompt it filled waits for Enter) or a new Herdr pane the answer opened (a grant, src/answerpane.ts). Every view
// reaches this through the same call, `openThen`, from the answer's outcome (ask.ts does, for Standard, Geek, and Zen alike); the page registers once how a step opens (`onStep`, main.ts),
// whichever view the user is in, and a view decides only how the card looks (the dock's, Zen's own layer).

/** `kind`: a `prompt` (the command waits in the session's prompt) or a `pane` (a Herdr pane the answer opened); `key`: the terminal's, a session's or `grant:<id>`; `asker`: the unit whose dialog was answered, which names the card; `command`: what the dialog put there. */
export interface StepOpen { kind: "prompt" | "pane"; key: string; asker: string; command?: string; /** The answer id the server holds a one-tap grant for (`then.run`): the card's Run names it on its Enter. */ run?: string }
let open: ((step: StepOpen) => void) | undefined;
/** The page's way to show a step's card (main.ts). */
export const onStep = (fn: ((step: StepOpen) => void) | undefined) => void (open = fn);
/**
 * Opens what `then` says as a card: `terminal` is the session `at.key` (its prompt waits for Enter), a pane grant a pane. A pane the server could not tell apart (`pane: null`) has nothing to open: the words to show instead come back.
 */
export function openThen(then: Then, at: { key: string; command?: string; answerId?: string }): string | undefined {
	if ("terminal" in then) return void (at.key && open?.({ kind: "prompt", key: at.key, asker: at.key, command: at.command, ...(then.run && at.answerId ? { run: at.answerId } : {}) }));
	if (then.pane === null) return m.pane_elsewhere();
	open?.({ kind: "pane", key: `grant:${then.pane}`, asker: at.key, command: at.command });
}
