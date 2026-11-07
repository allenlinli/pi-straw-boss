import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENDING } from "./ending.ts";
import { lineMac, NONCE } from "./runs.ts";

// What Enter would submit from a session's own editor, for the key pad's Enter guard (keys.ts). The bridge (bridge.ts) answers the GUI
// server's probe with a class and at most a command name: the draft itself never leaves the session. The rule for which commands end or
// replace the session lives here, once, for the composer's typed text (control.ts) and the key pad's Enter alike. For a `command` draft (and only that class), and only when the server gave a nonce with the probe (the
// Enter of a one-tap run, runs.ts), it also tells HMAC-SHA-256(nonce, line), so the server can tell the line an answer put there from an edited one; a probe with no nonce, and a draft of any other class, tells nothing of
// the line, and the text itself never leaves.

export { ENDING };
/** `command`: a draft that starts with `/` and is no ending command: with pi's command menu open (tab, backspace), Enter completes it and
 *  runs the result at once, so it may become any command, an ending one included. A `!` draft is one too: Enter runs it as a shell
 *  command, and `up` recalls earlier ones from history. */
export interface Editor { editor: "empty" | "text" | "command" | "unknown"; ending?: string; mac?: string; /** Only when the probe asked for the flags (an operate session's, docs/specs/2026-11-07-link-operate.md §7), and only on a `command` draft: it is a `!` shell line, or a `/boss` command. */ shell?: boolean; boss?: boolean }
const EDITORS = ["empty", "text", "command", "unknown"];

/** A draft pi runs as a shell command, and a `/boss` command (and not `/bossy`): the two lines an operate session never submits. */
const SHELL = /^\s*!/, BOSS = /^\s*\/boss(\s|$)/;

/** The session's editor as a class: empty, an ending command (by name), another slash command, other text, or unknown without a UI. With `flags`, a `command` draft also says which kind (`shell`, `boss`); without them nothing of the kind is told, so an older bridge's answer has none and the server then cannot tell. */
export function probeEditor(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, nonce?: unknown, flags?: unknown): Editor {
	let text: unknown;
	try {
		text = ctx?.hasUI ? ctx.ui.getEditorText() : undefined;
	} catch {} // a UI that cannot say is unknown
	if (typeof text !== "string") return { editor: "unknown" };
	const ending = ENDING.exec(text)?.[1];
	return !text.trim() ? { editor: "empty" } : ending ? { editor: "text", ending } : /^\s*[/!]/.test(text) ? { editor: "command", ...(typeof nonce === "string" && NONCE.test(nonce) && { mac: lineMac(nonce, text) }), ...(flags === true && { shell: SHELL.test(text), boss: BOSS.test(text) }) } : { editor: "text" };
}

/** A bridge's answer as the server takes it: one of the classes, and an ending only when it names one of the commands above. */
export function checkProbe(p: Record<string, unknown> | undefined): Editor | undefined {
	if (!p || !EDITORS.includes(p.editor as string)) return undefined;
	const mac = p.editor === "command" && typeof p.mac === "string" && /^[0-9a-f]{64}$/.test(p.mac) ? { mac: p.mac } : {};
	const kind = p.editor === "command" ? { ...(typeof p.shell === "boolean" && { shell: p.shell }), ...(typeof p.boss === "boolean" && { boss: p.boss }) } : {};
	if (p.ending === undefined) return { editor: p.editor as Editor["editor"], ...mac, ...kind };
	return p.editor === "text" && typeof p.ending === "string" && ENDING.test(`/${p.ending}`) && /^[a-z]+$/.test(p.ending) ? { editor: "text", ending: p.ending } : undefined;
}

export type OperateWhy = "shell" | "boss-command" | "command" | "unread" | "draft";

/**
 * Why an operate session's Enter (or the composer's text) may not go, from what the probe says of the draft, or nothing when it may: a `!` shell line, a `/boss` command, any other `/` draft (see below), or an editor that cannot be read well enough to tell
 * (no answer, no UI, or a `command` whose bridge did not tell the flags, which an older bridge never does). The confirms a paired device may give do not lift any of them.
 */
export function operateRefusal(e: Editor | undefined): { why: OperateWhy; reason: string } | undefined {
	if (!e || e.editor === "unknown" || (e.editor === "command" && (typeof e.shell !== "boolean" || typeof e.boss !== "boolean"))) return { why: "unread", reason: "The session's editor could not be read well enough to tell what Enter would run, so nothing is sent from here." };
	if (e.shell) return { why: "shell", reason: "A shell line (`!`) is not run from here: the box takes no arbitrary shell over the link." };
	if (e.boss) return { why: "boss-command", reason: "A /boss command is not run from here: on the box it reaches other teams' sessions and the box's own settings." };
	// A `/` draft is refused whole, not only `/boss`: with the command menu open (a bare `/`, `/b`, `/bos`), Enter applies the highlighted completion and runs it, so the draft as typed does not say what runs.
	if (e.editor === "command") return { why: "command", reason: "A slash command is not run from here: Enter would apply the command menu's highlighted choice, which this page cannot tell from the draft." };
	return undefined;
}

/**
 * Why the composer's text may not be sent: the Enter's refusals above, and any draft already in the editor. The text is pasted at the cursor and submitted with the draft (docs/specs/2026-11-07-link-operate.md §7.2), so a draft
 * the pad left there (`/`, `boss`, a `/bos` the text completes) would join it into a line this page never looked at; under operate it goes only into an empty editor.
 */
export function operateTextRefusal(e: Editor | undefined): { why: OperateWhy; reason: string } | undefined {
	return operateRefusal(e) ?? (e?.editor === "empty" ? undefined : { why: "draft", reason: "The session's editor holds a draft, and the text would join it; clear the draft first, or send from an empty editor." });
}
