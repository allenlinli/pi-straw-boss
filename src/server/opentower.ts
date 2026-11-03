import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { type HerdrRun, isSub, panes, report, result, TOWER_LABEL, workspaces } from "../herdr.ts";
import { inside } from "../link/routing.ts";
import type { Ensured } from "./towers.ts";

// Opening a tower for a controller of an unattended device (docs/specs/2026-10-26-sb-backend.md, Unattended devices): the link holder asks for it when a `dispatch` sender's message finds no tower for the team's
// project. The holder has checked the level and that the device is unattended; this checks the folder again, by real path, and does the Herdr part: it takes a workspace of the project that has no tower yet, or
// makes one at the project root, and gives it its tower through `ensure-tower`. Every Herdr call is an argument array through `run`.

export interface OpenTowerDeps {
	run: HerdrRun;
	ensure(request: { workspace: string; pane?: string; cwd?: string; made?: { pane: string; at: number } }): Promise<Ensured>;
	now(): number;
}

/** A label Herdr takes as the value of `--label` whatever the folder is called (a name that starts with `-` would read as an option). */
const labelOf = (root: string) => {
	const name = basename(root) || "project";
	return name.startsWith("-") ? `w${name}` : name;
};

/**
 * Gives the project a tower. A workspace of Herdr with a pane inside the project (and, when the sender named a workspace, that label) is the one to open; none is made for a named workspace, because its label would be
 * the sender's. With none, a workspace is made at the project's real path, its root pane marked as the tower's, and `ensure-tower` is told that pane is a shell nobody has used.
 */
export async function openTowerFor(d: OpenTowerDeps, project: string, toWorkspace?: string): Promise<{ workspace: string; created: boolean }> {
	let root: string;
	try {
		root = realpathSync.native(project);
	} catch {
		throw new Error(`The project ${project} does not exist`);
	}
	if (!inside(root, project)) throw new Error(`${root} is not inside the project ${project}`);
	const [all, here] = await Promise.all([workspaces(d.run), panes(d.run)]);
	const found = all.find((w) => !isSub(w) && (!toWorkspace || w.label === toWorkspace) && here.some((p) => p.workspace_id === w.workspace_id && p.cwd !== undefined && inside(p.cwd, root)));
	if (found) {
		await d.ensure({ workspace: found.workspace_id, cwd: root });
		return { workspace: found.workspace_id, created: false };
	}
	if (toWorkspace) throw new Error(`No workspace labelled "${toWorkspace}" is open inside ${project}; the server makes none for a name the sender chose`);
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

/** What the link holder's `openTower` seam does in the server (main.ts): the tower service may not be built yet when the first message comes. */
export async function openTower(d: { run: HerdrRun; towers: () => { ensure: OpenTowerDeps["ensure"] } | undefined; now(): number }, project: string, toWorkspace?: string): Promise<void> {
	const towers = d.towers();
	if (!towers) throw new Error("the tower service is not running yet");
	await openTowerFor({ run: d.run, ensure: (r) => towers.ensure(r), now: d.now }, project, toWorkspace);
}
