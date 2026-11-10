import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Pane, Session } from "./herdr.ts";
import { isName } from "./train/spec.ts";

// A project's integrator as the tower opens it (docs/how-it-works.md, "Hand-off and routing"; todo #151): the tower's own main, opened on a car slip and on nothing else, and never a second one for a project.
// The words and the small rules of that live here, so the opener and the server's door (server/runtools.ts) agree on them. No pi imports.

/** The role of an open that is a project's integrator. */
export const INTEGRATOR = "integrator";
/**
 * At most this many integrators opened by its tower are alive in one workspace. Measured 2026-11-10 from 40 days of the boss's logs: the busiest workspace ran two at once (integ FE2 and integ v3), and none ran three;
 * a third project in one workspace waits until one has closed.
 */
export const MAX_OPENED_INTEGRATORS = 2;
const MARK = "integ:";
/** The `sb_opened_by` marker of a main the tower opened as a project's integrator. It names the project and no sender: the main is the tower's own, so it counts toward no sender's one main and not toward the workspace's two. */
export const integMark = (project: string): string => `${MARK}${project}`;
/** The project a marker names; undefined for any other opener (a session id, `link:<device id>`). */
export const integratorOf = (token: unknown): string | undefined => {
	const project = typeof token === "string" && token.startsWith(MARK) ? token.slice(MARK.length) : undefined;
	return isName(project) ? project : undefined;
};

/**
 * The projects whose integrator keeps a ledger of `app` (`<state>/trains/<project>/<app>.json`, the index the Seam bindings name as the Record). The project is a word the tower gives, so this is what holds it to one name:
 * an app's cars go to the project that already runs its trains, and a tower that words the project differently opens no second integrator for it.
 */
export function ledgerProjects(stateDir: string, app: string): string[] {
	try { return readdirSync(join(stateDir, "trains")).filter((project) => isName(project) && existsSync(join(stateDir, "trains", project, `${app}.json`))); } catch { return []; }
}

/** The text a new integrator starts from: who it is and whose. The slip that opened it follows as the tower's forward, which the code stamps with its sender (server/runtools.ts). */
export const integratorHandoff = (workspace: string, project: string, tower: { id: string; name: string }) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you: you are the integrator of project ${project}, the tower's own main, of kind integrator and named integ ${project}.`,
		"Car slips reach you as the tower's forwards, the first right after this message; each names its sender (fwd-from). Report to the tower that opened this tab with call_tower as your prompt describes; when your queue is empty and no train waits to be opened, report idle (why: milestone, reply: false) and the tower closes this tab.",
		`Tower: ${tower.name} (session id ${tower.id})`,
	].join("\n");

/**
 * The one live integrator of a project among every pane and session of this computer; undefined when the project has none. A project never has two, so whatever leaves that in doubt is a refusal: a pane a tower marked for
 * the project whose pi has not joined (the marker counts from the moment the tab exists) or is of another kind now, and two mains that both answer as its integrator. An integrator is a main of kind integrator (`sb_duty`)
 * that a tower marked for the project, or that carries the project's name (`integ <project>`: one the boss opened, or one that took a broken one over). A main opened for a teammate's device (`link:<device id>`) is never one,
 * whatever it calls itself: a peer's main does not become a project's integrator by a name and a kind.
 */
export function liveIntegrator(everywhere: readonly Pane[], sessions: readonly Session[], project: string): { session: Session; pane: Pane } | { refusal: string } | undefined {
	const isIntegrator = (p: Pane) => p.tokens?.sb_role === "main" && p.tokens.sb_duty === INTEGRATOR, live = new Map<string, { session: Session; pane: Pane }>();
	for (const pane of everywhere.filter((p) => integratorOf(p.tokens?.sb_opened_by) === project)) {
		const session = sessions.find((s) => s.herdrLocation?.paneId === pane.pane_id);
		if (!session || pane.tokens?.sb_role !== "main") return { refusal: `The integrator of project ${project} (pane ${pane.pane_id}) has not joined yet or no longer answers; a project has one, so nothing opens. Try again when it has joined, or when its tab has closed.` };
		if (!isIntegrator(pane)) return { refusal: `The main opened as the integrator of project ${project} (${session.name ?? session.id}, session ${session.id}) is of kind ${pane.tokens.sb_duty ?? "none"} now; a project has one, so nothing opens and no slip goes to it. It calls boss_duty with integrator, or the boss closes it.` };
		live.set(session.id, { session, pane });
	}
	for (const session of sessions) {
		const pane = session.name === `integ ${project}` ? everywhere.find((p) => p.pane_id === session.herdrLocation?.paneId) : undefined;
		if (pane && isIntegrator(pane) && !pane.tokens?.sb_opened_by?.startsWith("link:")) live.set(session.id, { session, pane });
	}
	if (live.size > 1) return { refusal: `Project ${project} has ${live.size} integrators (${[...live.keys()].map((id) => `session ${id}`).join(", ")}); a project has one, so the slip goes to neither. The boss closes one.` };
	return [...live.values()][0];
}
