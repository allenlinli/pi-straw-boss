import type { TowerPanel } from "../control.ts";
import type { TowerView } from "../net.ts";
import type { Towers } from "./towers.ts";

/** What the server's own closes need of the service (closer.ts): the tower it runs has no pi to ask, so its Quit tower is the boss closing it. */
export interface TowerEnd {
	/** Whether the session id is the identity of a service tower (it has no bridge: a squad or a base is closed without asking it). */
	owns(id: string): boolean;
	/** The boss closes the tower (towers.ts `close`): its tab goes and the service ends, the base's mains becoming members again. */
	close(workspace: string): Promise<{ ok: boolean; error?: string }>;
}
/**
 * The page's way to the tower service (guihost.ts `tower`): the service's state and queue in the net, the composer, the notices' buttons, and the boss conversation's Leave and New. Every one is a function the pi interface
 * reaches too (`/boss tower <prompt>`, `retry`, `deliver`, `drop`, `leave`, `new`): the GUI adds none of its own. `towers` is read at each call, since the service is built after the GUI host and may be absent.
 */
export function towerPanel(towers: () => Towers | undefined): { view(workspace: string): TowerView | undefined } & TowerPanel & TowerEnd {
	const asked = async (run: (t: Towers) => object | Promise<object>): Promise<{ ok: boolean; error?: string; left?: boolean; fresh?: boolean; already?: boolean }> => {
		try {
			return { ok: true, ...(await run(towers()!)) };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	};
	// A service that waits for a resident tower is not the workspace's tower yet (the runs hold it from the moment it is adopted): the page shows the resident as it did before the service, with its own bridge, terminal, and composer.
	const serving = (workspace: string) => towers()?.stateOf(workspace) !== "waiting";
	return {
		view: (workspace) => (serving(workspace) ? towers()?.runs.view(workspace) : undefined),
		has: (workspace) => serving(workspace) && towers()?.runs.view(workspace) !== undefined,
		owns: (id) => towers()?.owns(id) ?? false,
		close: (workspace) => asked(async (t) => (await t.close(workspace), {})),
		live: (workspace) => Boolean(towers()?.runs.status(workspace)?.run),
		// The composer is the boss at a keyboard: the same boss event as the tower prompt's (`present`), so a conversation starts or goes on (docs/how-it-works.md, The boss conversation).
		event: (workspace, text) => asked((t) => (t.runs.boss(workspace, text, "the boss (GUI)", { present: true }), {})),
		conversation: (workspace, what) => asked((t) => (what === "leave" ? t.runs.leave(workspace) : t.runs.fresh(workspace))),
		memory: (workspace, json) => towers()!.memory(workspace, json),
		act: (workspace, what, id) => asked((t) => (what === "retry" ? t.runs.retry(workspace) : what === "deliver" ? t.runs.deliverAgain(workspace, id!) : t.runs.dropParked(workspace, id!), {})),
	};
}
