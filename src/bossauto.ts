import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { autoSummary, clock } from "./autostate.ts";
import { asBoss } from "./autoscope.ts";
import { terminalOnlyOpts } from "./intercept.ts";
import type { ServerLook } from "./server-look.ts";
import type { Kit } from "./state.ts";

// `/boss auto [on | off | confirm]` (docs/specs/2026-11-09-auto-mode.md, §2): the pi door, the first one. `on` stages a request on the server and the same handler then draws the confirm in this terminal (D9); the dialog is
// never relayed, so only the keyboard answers. Writes are refused without a screen, in a run, and in a Straw Link remote turn. The server is started first when it is down, as `/boss server` does.

const WARNING = "While auto mode is on, agents cannot ask you: questions that wait are refused or cancelled, and what needs you is parked. Only you or the head tower end it.";

export function createBossAuto({ pi, cfg, s, guiDir, me, tell }: Kit, server: ServerLook | undefined) {
	const who = () => ({ name: pi.getSessionName() || s.ownName || me().slice(0, 8) || "a session", session: me(), pane: cfg.env.HERDR_PANE_ID, pid: process.pid });
	const show = (): void => {
		const now = autoSummary(guiDir);
		tell(`${now.on ? `Auto mode is on since ${clock(now.since)} (${now.by ?? "?"}). /boss auto off ends it.` : "Auto mode is off."}${now.pending ? ` A request waits for your confirm (${Math.ceil(now.pending.expiresInS / 60)} min left): "${now.pending.said}". /boss auto confirm.` : ""}${!now.on && now.report ? ` Last time it ended at ${clock(now.report.until)}: ${now.report.parked} parked waits on ${now.report.towers} towers, ${now.report.cancels} cancels or refusals.` : ""}`);
	};
	/** The terminal confirm of a staged request; a yes sends the confirm with its id. */
	async function confirmHere(ctx: ExtensionCommandContext, pending: { id: string; said: string }): Promise<void> {
		const yes = await asBoss(() => ctx.ui.confirm("Start auto mode?", `${pending.said}\n\n${WARNING}`, terminalOnlyOpts()));
		if (yes !== true) return tell("Auto mode was not started. The request stays for 10 minutes: /boss auto confirm, or the button on the GUI.");
		const done = await server!.ask({ cmd: "auto-confirm", id: pending.id, ...who() }, { start: "never" });
		if (!done.ok) return tell(`Auto mode did not start: ${String(done.error)}`, "error");
		const now = autoSummary(guiDir);
		tell(`Auto mode is on${now.since ? ` since ${clock(now.since)}` : ""}. /boss auto off ends it.`);
	}
	return async function run(rest: string, ctx: ExtensionCommandContext): Promise<void> {
		const op = rest.trim();
		if (!op) return show();
		if (!["on", "off", "confirm"].includes(op)) return tell("Usage: /boss auto [on | off | confirm]", "warning");
		if (!ctx.hasUI) return tell("/boss auto needs a screen: it is the boss's own switch.", "warning");
		if (s.remoteOrigin) return tell("A teammate's turn cannot switch auto mode: it is the boss's own switch.", "warning");
		if (!server) return tell("The sb server is not available in this session.", "warning");
		if (op === "off") {
			const done = await server.ask({ cmd: "auto-off", ...who() }, { start: "boss" });
			return done.ok ? tell(String(done.report ?? "Auto mode is off.")) : tell(String(done.error), "error");
		}
		if (op === "confirm") {
			const asked = await server.ask({ cmd: "auto-state" }, { start: "boss" }), pending = (asked.state as { pending?: { id: string; said: string } } | undefined)?.pending;
			if (!asked.ok) return tell(String(asked.error), "error");
			return pending ? confirmHere(ctx, pending) : tell("No request waits for your confirm. /boss auto on asks for one.");
		}
		const staged = await server.ask({ cmd: "auto-on", said: "/boss auto on", ...who() }, { start: "boss" });
		if (!staged.ok) return tell(String(staged.error), "error");
		const pending = staged.pending as { id: string; said: string } | undefined;
		if (!pending) return show();
		return confirmHere(ctx, pending);
	};
}
