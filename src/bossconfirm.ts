import { terminalOnlyOpts } from "./intercept.ts";

// The head pane's own confirm of a staged `on` (docs/specs/2026-11-09-auto-mode.md, §2, D9): drawn in the terminal where the boss typed the turn, never relayed, and answered with a session request (a run's token may not confirm).
// It lives as long as the request does: it times out at the request's expiry, and closes when the request was confirmed elsewhere (the GUI's button), replaced, or cleared, so `boss_auto` never holds the head's turn for a dialog that no longer matters (AMC-F003).

export interface Staged { id: string; said: string; /** When the server drops the request, in ms. */ expires?: number }
export interface ConfirmDeps {
	/** ctx.ui.confirm, drawn through the terminal-only mark. */
	draw(title: string, body: string, opts: { signal: AbortSignal; timeout?: number }): Promise<boolean | undefined>;
	/** A token-less request to the server. */
	ask(request: Record<string, unknown>): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;
	now(): number;
	who: Record<string, unknown>;
	/** How often the request is looked at while the dialog is open. */
	pollMs?: number;
}
const MIN_TIMEOUT_MS = 1000;

export async function confirmStaged(pending: Staged, d: ConfirmDeps): Promise<string> {
	const ac = new AbortController();
	let gone: string | undefined;
	// The server's view of the request: on, or no longer this id (expired, replaced, cleared), closes the dialog.
	const look = async () => {
		const asked = await d.ask({ cmd: "auto-state" }).catch(() => undefined), state = asked?.ok ? (asked.state as { on?: boolean; pending?: { id?: string } } | undefined) : undefined;
		if (!state || gone) return;
		if (state.on) gone = "Auto mode is on: it was confirmed elsewhere (the GUI).";
		else if (state.pending?.id !== pending.id) gone = "The request expired or was replaced, so auto mode did not start: ask again.";
		if (gone) ac.abort();
	};
	let checking = false;
	const timer = setInterval(() => { if (!checking) { checking = true; void look().finally(() => (checking = false)); } }, d.pollMs ?? 3000);
	timer.unref?.();
	try {
		const left = pending.expires === undefined ? undefined : Math.max(MIN_TIMEOUT_MS, pending.expires - d.now());
		const yes = await d.draw("Start auto mode?", `You said: ${pending.said}\n\nWhile auto mode is on, agents cannot ask you: questions that wait are refused or cancelled. Only you or the head tower end it.`, { signal: ac.signal, ...(left !== undefined ? { timeout: left } : {}) });
		if (gone) return gone;
		if (yes !== true) return "The boss did not confirm in the pane; the request stays for 10 minutes (the GUI has the button).";
		const done = await d.ask({ cmd: "auto-confirm", id: pending.id, name: "the head pane", ...d.who }).catch((error: Error) => ({ ok: false, error: error.message }));
		if (done.ok) return "The boss confirmed in the pane: auto mode is on.";
		// A late yes after the request closed elsewhere reports where things stand now.
		const state = (await d.ask({ cmd: "auto-state" }).catch(() => undefined))?.state as { on?: boolean } | undefined;
		return state?.on ? "Auto mode is on: it was confirmed elsewhere (the GUI)." : `Auto mode did not start: ${String(done.error)}`;
	} finally {
		clearInterval(timer);
	}
}
/** The options of the terminal confirm: the wrap counts it and relays it nowhere. */
export const drawOpts = (opts: { signal: AbortSignal; timeout?: number }) => ({ ...terminalOnlyOpts(), ...opts });
