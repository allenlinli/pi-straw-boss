import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { type HerdrRun, isHead, isSub, panes, report, result, TOWER_LABEL, workspaces } from "../herdr.ts";
import { inside, projectProblem } from "../link/routing.ts";
import type { Ensured } from "./towers.ts";

// Opening a tower for a controller of an unattended device (docs/specs/2026-10-26-sb-backend.md, Unattended devices): the link holder asks for it when a `dispatch` sender's message finds no tower for the team's
// project. The holder has checked the level and that the device is unattended; this checks the folder again, by real path, and does the Herdr part: it takes a workspace of the project that has no tower yet, or
// makes one at the project root, and gives it its tower through `ensure-tower`. Every Herdr call is an argument array through `run`.
// An attended device only wakes (`existing`, No tower service for the team's project): it gives the tower to a workspace it already has, never makes a workspace, and says so when there is none.

export interface OpenTowerDeps {
	run: HerdrRun;
	ensure(request: { workspace: string; pane?: string; cwd?: string; made?: { pane: string; at: number } }): Promise<Ensured>;
	now(): number;
	/** The home folder and pi agent folder a project may not contain or be inside (the same rule a team's project meets when it is set: routing.ts `projectProblem`). */
	home: string;
	agentDir: string;
}

/** An open or wake that failed for a reason the boss has words for: `project` (its folder is gone, or may not hold a tower) and `service` (the tower service is not built yet). The link holder reads `code`; anything else is "other". */
export class OpenTowerError extends Error {
	code: "project" | "service";
	constructor(message: string, code: "project" | "service") {
		super(message);
		this.code = code;
	}
}

/** A label Herdr takes as the value of `--label` whatever the folder is called (a name that starts with `-` would read as an option). */
const labelOf = (root: string) => {
	const name = basename(root) || "project";
	return name.startsWith("-") ? `w${name}` : name;
};

/**
 * Gives the project a tower. A workspace of Herdr with a pane inside the project (and, when the sender named a workspace, that label) is the one to open; none is made for a named workspace, because its label would be
 * the sender's. With none, a workspace is made at the project's real path, its root pane marked as the tower's, and `ensure-tower` is told that pane is a shell nobody has used.
 * With `existing`, none is made for any name: the answer is `null`.
 */
export async function openTowerFor(d: OpenTowerDeps, project: string, toWorkspace?: string, existing = false): Promise<{ workspace: string; created: boolean } | null> {
	let root: string;
	try {
		root = realpathSync.native(project);
	} catch {
		throw new OpenTowerError(`The project ${project} does not exist`, "project");
	}
	// The folder is checked again by its real path, now: a policy project that became a link to the home folder or to ~/.pi gets no tower.
	const problem = projectProblem(root, { home: d.home, agentDir: d.agentDir });
	if (problem) throw new OpenTowerError(`${project} cannot be opened: ${problem}`, "project");
	const [all, here] = await Promise.all([workspaces(d.run), panes(d.run)]);
	// A name is a workspace id first (a reply to an ask a tower made for a main), else a label.
	const byId = !!toWorkspace && all.some((w) => w.workspace_id === toWorkspace);
	const found = all.find((w) => !isSub(w) && !isHead(w) && (!toWorkspace || (byId ? w.workspace_id === toWorkspace : w.label === toWorkspace)) && here.some((p) => p.workspace_id === w.workspace_id && p.cwd !== undefined && inside(p.cwd, root)));
	if (found) {
		await d.ensure({ workspace: found.workspace_id, cwd: root });
		return { workspace: found.workspace_id, created: false };
	}
	if (existing) return null;
	if (toWorkspace) throw new Error(`No workspace named "${toWorkspace}" (label or id) is open inside ${project}; the server makes none for a name the sender chose`);
	// The listing took a moment: the project must still lead to the same folder as when it was checked, or the workspace would be made in another one.
	if (realpathOr(project) !== root) throw new OpenTowerError(`The project ${project} moved while its tower was being opened`, "project");
	const made = await result(d.run, ["workspace", "create", "--cwd", root, "--label", labelOf(root), "--no-focus"]);
	const workspace: string = made.workspace.workspace_id;
	try {
		await d.run(["tab", "rename", made.tab.tab_id, TOWER_LABEL]);
		await report(d.run, "pane", made.root_pane.pane_id, { sb_role: "tower" });
		await d.ensure({ workspace, pane: made.root_pane.pane_id, cwd: root, made: { pane: made.root_pane.pane_id, at: d.now() } });
	} catch (cause) {
		await d.run(["workspace", "close", workspace]).catch(() => {});
		throw cause;
	}
	return { workspace, created: true };
}

const realpathOr = (path: string): string | undefined => {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
};

/** What the link holder's `openTower` seam does in the server (main.ts): the tower service may not be built yet when the first message comes. */
export async function openTower(d: { run: HerdrRun; towers: () => { ensure: OpenTowerDeps["ensure"] } | undefined; now(): number; home: string; agentDir: string }, project: string, toWorkspace?: string, existing = false): Promise<void | "no-workspace"> {
	const towers = d.towers();
	if (!towers) throw new OpenTowerError("the tower service is not running yet", "service");
	const opened = await openTowerFor({ run: d.run, ensure: (r) => towers.ensure(r), now: d.now, home: d.home, agentDir: d.agentDir }, project, toWorkspace, existing);
	if (!opened) return "no-workspace";
}

/**
 * The link holder's `openTower` seam for the server (main.ts): `open` (an unattended device) tells the controller whose message found no tower when it fails, through `failed`; `wake` (an attended device) tells nobody, because the boss hears
 * of a failed wake in the notice of the waiting message. The error goes on to the holder either way.
 */
export function towerOpener(d: Parameters<typeof openTower>[0] & { failed(from: string, project: string, error: Error): void }) {
	return async (project: string, toWorkspace: string | undefined, from: string, mode: "open" | "wake"): Promise<void | "no-workspace"> => {
		try {
			return await openTower(d, project, toWorkspace, mode === "wake");
		} catch (error) {
			if (mode === "open") d.failed(from, project, error as Error);
			throw error;
		}
	};
}
