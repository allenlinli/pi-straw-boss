import type { Then } from "../src/owners.ts";
import { m } from "./paraglide/messages.js";

// The one rule of the page: an outcome that needs the terminal opens it. When the server accepts an answer whose choice leaves a step in a terminal, its reply carries `then`
// (src/control.ts; owners.ts `Then`): the session's own terminal (the prompt it filled waits for Enter) or a new Herdr pane the answer opened (a grant, src/answerpane.ts). Every view
// reaches this through the same call, `openThen`, from the answer's outcome (ask.ts does, for Standard, Geek, and Zen alike) and from anything else that ends in a terminal (Zen's blocked pane
// calls `openThen({ terminal: true }, …)`); a view decides only how the terminal looks: `terminal` is how it shows the session's (a tile, the session's terminal mode, Zen leaving for it),
// and the page registers once how a pane's tile opens (`onPane`, main.ts), whichever view the user is in.

let pane: ((grant: string) => void) | undefined;
/** The page's way to open the terminal tile of a granted pane, with the keyboard in it (main.ts). Zen's page leaves Zen first. */
export const onPane = (open: ((grant: string) => void) | undefined) => void (pane = open);
/**
 * Opens what `then` says: `terminal` shows the session's terminal (the caller's own way), a pane grant opens that pane's tile. A pane the server could not tell apart (`pane: null`) has nothing
 * to open: the words to show instead come back.
 */
export function openThen(then: Then, terminal?: () => void): string | undefined {
	if ("terminal" in then) return void terminal?.();
	if (then.pane === null) return m.pane_elsewhere();
	pane?.(then.pane);
}
