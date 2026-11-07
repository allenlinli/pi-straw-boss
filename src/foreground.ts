import { nestedShells, programName, programProcs } from "./server/standing.ts";

// Whether pi alone holds a pane's foreground, from Herdr's `pane.process_info` (docs/specs/2026-11-07-link-operate.md §7.3). Herdr labels a pane `pi` for as long as pi's own integration says so, and an external editor that pi starts
// (its `app.editor.external` key, or an app action a user's keybindings put on a pad key) runs below pi and keeps that label; only the process list shows it. Operate writes keys, text and pastes into the pane only while this holds.

/** True only when the foreground lists exactly one program that is no shell, its executable is `pi`, and no shell other than the pane's own stands beside it. An empty or missing list, a program besides pi, and a list that cannot prove the absence of children (Windows lists the shell alone) are all false. */
export function piAlone(info: { shell_pid?: unknown; foreground_processes?: unknown } | undefined): boolean {
	const programs = programProcs(info);
	return programs.length === 1 && programName(programs[0]!) === "pi" && nestedShells(info).length === 0;
}
