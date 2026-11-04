import type { Towers } from "./towers.ts";

// The control commands behind `/boss head` (docs/specs/2026-11-04-head-tower.md, Reaching it): the same functions the head page's routes reach through the tower panel. They are the boss's: a run's token is refused them (rungate.ts).

const NOT_OPEN = "The head tower is not open: its first message opens it.";
/** `head-open` makes the head workspace when there is none and names its tab; `head-event` is the boss's words (a boss event with `present`); `head-leave`, `head-new`, and `head-close` are the conversation's buttons. */
export async function headCommand(t: Towers, cmd: string, text: string | undefined): Promise<Record<string, unknown>> {
	if (cmd === "head-open") {
		const got = await t.head.ensure();
		return { workspace: got.workspace, tab: got.tab, pane: got.pane, label: got.label, opened: got.opened };
	}
	if (cmd === "head-event") {
		if (!text) throw new Error("head-event needs text");
		return { queued: (await t.head.event(text)).id };
	}
	if (cmd === "head-close") return { closed: Boolean(await t.head.close()) };
	const workspace = t.head.status()?.workspace;
	if (!workspace) throw new Error(NOT_OPEN);
	return { ...(cmd === "head-leave" ? await t.runs.leave(workspace) : await t.runs.fresh(workspace)) };
}
