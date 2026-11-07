import { getKeybindings } from "@earendil-works/pi-tui";

// The bridge's half of an operate session's key guard (docs/specs/2026-11-07-link-operate.md §7.3): which keys pi's live keybindings, the user's own included, bind to an action outside the editor. It runs inside pi and
// reads the live manager, so a keybindings.json that moves `app.editor.external` (which hands the terminal to $EDITOR) or any other app action onto a key the pad sends shows up here and nowhere else.

/**
 * The actions a pad key may hold, which neither leave the editor nor hand the terminal to another program:
 * - the editor's and the prompt's own (`tui.editor.*`, `tui.input.*` for Enter, Tab and the new line), the clear key, Escape's interrupt, and the follow-up key, which the pad probes like Enter;
 * - the transcript view's scrolling and search (`tui.altScreen.*`) and the thinking-level cycle (Shift+Tab), which change what is shown or a setting, not who has the keyboard;
 * - the keys of a selector or dialog (`tui.select.*`, `app.tree.*`, `app.models.*`, and the session picker's own): they act only while that dialog is open, and none of the pad's keys opens one (the actions that do are not in this list).
 */
const LOCAL = /^(?:tui\.(?:editor|input|select|altScreen)\..+|app\.(?:clear|interrupt|thinking\.cycle|message\.followUp|tree\..+|models\..+|session\.(?:toggleNamedFilter|togglePath|toggleSort|rename|delete|deleteNoninvasive)))$/;
/** App actions that only pi itself defines: where the manager has none of them it is pi-tui's own default, which says nothing of pi's keys. */
const PROOF = ["app.editor.external", "app.interrupt"];

type Manager = Pick<ReturnType<typeof getKeybindings>, "getDefinition" | "getResolvedBindings">;

/** The key ids (as pi names them) bound to any action that is not in `LOCAL`, or undefined when the live manager is not pi's (it lacks its app actions) or cannot say. */
export function foreignKeys(manager?: Manager): string[] | undefined {
	try {
		const m = manager ?? getKeybindings();
		if (PROOF.some((id) => m.getDefinition(id as never) === undefined)) return undefined;
		const out = new Set<string>();
		for (const [id, keys] of Object.entries(m.getResolvedBindings())) {
			if (LOCAL.test(id)) continue;
			for (const key of Array.isArray(keys) ? keys : [keys]) if (typeof key === "string") out.add(key);
		}
		return [...out];
	} catch {
		return undefined;
	}
}
