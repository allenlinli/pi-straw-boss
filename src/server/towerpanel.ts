import type { TowerPanel } from "../control.ts";
import { HEAD_KEY } from "../headkey.ts";
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
	// The head tower's stand-in for a workspace id is `HEAD_KEY` (headroutes.ts): its service is under the Herdr workspace it stands in now, and a message makes that workspace when there is none.
	const at = (t: Towers, workspace: string) => {
		if (workspace !== HEAD_KEY) return workspace;
		const ws = t.head.status()?.workspace;
		if (!ws) throw new Error("The head tower is not open: its first message opens it.");
		return ws;
	};
	return {
		view: (workspace) => (serving(workspace) ? towers()?.runs.view(workspace) : undefined),
		has: (workspace) => (workspace === HEAD_KEY ? towers() !== undefined : serving(workspace) && towers()?.runs.view(workspace) !== undefined),
		// The head is a tower service under its Herdr workspace, yet only api/head/… reaches it (review HH3-F003): the tower routes ask this to refuse its key and its workspace.
		isHead: (workspace) => workspace === HEAD_KEY || (towers()?.head.status()?.workspace === workspace),
		owns: (id) => towers()?.owns(id) ?? false,
		close: (workspace) => asked(async (t) => (await (workspace === HEAD_KEY ? t.head.close() : t.close(at(t, workspace))), {})),
		live: (workspace) => Boolean(towers() && (workspace !== HEAD_KEY || towers()!.head.status()) && towers()!.runs.status(at(towers()!, workspace))?.run),
		// The composer is the boss at a keyboard: the same boss event as the tower prompt's (`present`), so a conversation starts or goes on (docs/how-it-works.md, The boss conversation).
		event: (workspace, text) => asked(async (t) => (workspace === HEAD_KEY ? await t.head.event(text) : t.runs.boss(workspace, text, "the boss (GUI)", { present: true }), {})),
		conversation: (workspace, what) => asked((t) => (what === "leave" ? t.runs.leave(at(t, workspace)) : t.runs.fresh(at(t, workspace)))),
		memory: (workspace, json) => towers()!.memory(workspace, json),
		act: (workspace, what, id) => asked((t) => ((ws) => (what === "retry" ? t.runs.retry(ws) : what === "deliver" ? t.runs.deliverAgain(ws, id!) : t.runs.dropParked(ws, id!), {}))(at(t, workspace))),
	};
}
