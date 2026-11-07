import { programName, programProcs } from "./server/standing.ts";

// Whether pi is in a pane's foreground, from Herdr's `pane.process_info` (docs/specs/2026-11-07-link-operate.md §7.3). Herdr labels a pane `pi` for as long as pi's own integration says so, and an external editor that pi starts
// (its `app.editor.external` key, or an app action a user's keybindings put on a pad key) runs below pi and keeps that label; only the process list shows it. Operate writes keys, text and pastes into the pane only while this holds.
// Helper children of a running pi (pi-claude-bridge's `claude`, stdio MCP servers, build tools) share pi's process group, so the list says nothing against them; what says that pi still holds the terminal is the bridge's report of raw mode (probe.ts).

/** True only when the foreground lists exactly one `pi` among its programs. An empty or missing list, no pi, two of them, and a list that cannot show pi (Windows lists the shell alone) are all false. */
export function piInForeground(info: { shell_pid?: unknown; foreground_processes?: unknown } | undefined): boolean {
	return programProcs(info).filter((p) => programName(p) === "pi").length === 1;
}
