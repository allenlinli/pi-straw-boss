import { getKeybindings, matchesKey } from "@earendil-works/pi-tui";
import type { Report } from "./probe.ts";

// The bridge's half of an operate session's key guard (docs/specs/2026-11-07-link-operate.md §7.3): which keys of the pad pi's live keybindings, the user's own included, bind to an action outside the editor. It runs inside pi and
// reads the live manager, so a keybindings.json that moves `app.editor.external` (which hands the terminal to $EDITOR) or any other app action onto a key the pad sends shows up here and nowhere else. Keys are compared as pi compares them,
// by the bytes the pad sends (`manager.matches(bytes, id)`), never by the spelling of an id: `esc`, `escape` and `ctrl+[` are one key, and so are `enter`, `return` and `ctrl+m`.

/** The bytes Herdr's key of that name puts on the terminal (Home, End, Page Up and Down as keys.ts's SEQUENCES), more than one where pi reads another spelling of the same press (Alt+Left and Alt+Right as the legacy Alt+B and Alt+F). Every key an operate session can send is here; tests/operate-rr3.test.ts holds the table to keys.ts. */
export const BYTES: Record<string, string[]> = {
	esc: ["\x1b"], enter: ["\r"], up: ["\x1b[A"], down: ["\x1b[B"], right: ["\x1b[C"], left: ["\x1b[D"], tab: ["\t"], "shift+tab": ["\x1b[Z"], space: [" "], backspace: ["\x7f", "\b"], delete: ["\x1b[3~"],
	pageup: ["\x1b[5~"], pagedown: ["\x1b[6~"], home: ["\x1b[H"], end: ["\x1b[F"],
	...Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => [d, [d]])),
	...Object.fromEntries([..."abefkuwyc"].map((l) => [`ctrl+${l}`, [String.fromCharCode(l.charCodeAt(0) - 96)]])),
	...Object.fromEntries([..."bdfy"].map((l) => [`alt+${l}`, [`\x1b${l}`]])),
	"alt+enter": ["\x1b\r"], "alt+backspace": ["\x1b\x7f"], "ctrl+left": ["\x1b[1;5D"], "ctrl+right": ["\x1b[1;5C"], "alt+left": ["\x1b[1;3D", "\x1bb"], "alt+right": ["\x1b[1;3C", "\x1bf"],
};

/** The actions reported apart, by key (`holds`): each is allowed only on the key its guard is written for (`HOME` in probe.ts). */
export const GUARDED: Record<string, "submit" | "followUp" | "clear" | "interrupt"> = { "tui.input.submit": "submit", "app.message.followUp": "followUp", "app.clear": "clear", "app.interrupt": "interrupt" };

/**
 * The actions a pad key may hold, which neither leave the editor nor hand the terminal to another program:
 * - the editor's and the prompt's own (`tui.editor.*`, `tui.input.*` for Tab and the new line);
 * - the transcript view's scrolling and search (`tui.altScreen.*`) and the thinking-level cycle (Shift+Tab), which change what is shown or a setting, not who has the keyboard;
 * - the keys of a selector or dialog (`tui.select.*`, `app.tree.*`, `app.models.*`, and the session picker's own): they act only while that dialog is open, and none of the pad's keys opens one (the actions that do are not in this list).
 * The four of `GUARDED` are reported apart, by key (`holds`).
 */
const LOCAL = /^(?:tui\.(?:editor|input|select|altScreen)\..+|app\.(?:thinking\.cycle|tree\..+|models\..+|session\.(?:toggleNamedFilter|togglePath|toggleSort|rename|delete|deleteNoninvasive)))$/;
/** App actions that only pi itself defines: where the manager has none of them it is pi-tui's own default, which says nothing of pi's keys. */
const PROOF = ["app.editor.external", "app.interrupt"];

type Manager = Pick<ReturnType<typeof getKeybindings>, "getDefinition" | "getResolvedBindings" | "getUserBindings" | "matches">;

/**
 * The report of the live manager, or undefined when it is not pi's (it lacks its app actions) or cannot say. A key id in the user's keybindings that pi does not define (an extension's shortcut, such as pi-mcp-adapter's `mcp.panel.open`) is
 * taken as foreign: pi runs an extension's shortcut before every binding, and it has no seam that lists them (docs/specs/2026-11-07-link-operate.md §11.3).
 */
export function bindingReport(manager?: Manager, stdin: { isTTY?: boolean; isRaw?: boolean } = process.stdin): Report | undefined {
	try {
		const m = manager ?? getKeybindings();
		if (PROOF.some((id) => m.getDefinition(id as never) === undefined)) return undefined;
		const resolved = m.getResolvedBindings() as Record<string, unknown>, user = m.getUserBindings() as Record<string, unknown>;
		const ids: [string, string][] = Object.keys(resolved).map((id) => [id, GUARDED[id] ?? (LOCAL.test(id) ? "local" : "foreign")]);
		for (const id of Object.keys(user)) if (!(id in resolved)) ids.push([id, "foreign"]); // a shortcut of an extension
		const keys = new Set<string>(), holds: Record<string, Set<string>> = {};
		for (const [id, kind] of ids) {
			if (kind === "local") continue;
			const spelled = (Array.isArray(user[id]) ? (user[id] as unknown[]) : [user[id]]).filter((k): k is string => typeof k === "string");
			const takes = (bytes: string) => (id in resolved ? m.matches(bytes, id as never) : spelled.some((k) => matchesKey(bytes, k as never)));
			for (const [name, spellings] of Object.entries(BYTES)) {
				if (!spellings.some(takes)) continue;
				if (kind === "foreign") keys.add(name);
				else (holds[kind] ??= new Set()).add(name);
			}
		}
		return { keys: [...keys], holds: Object.fromEntries(Object.entries(holds).map(([k, v]) => [k, [...v]])), raw: stdin.isTTY === true && stdin.isRaw === true };
	} catch {
		return undefined;
	}
}
