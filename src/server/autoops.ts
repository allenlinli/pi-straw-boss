import { type By, requesterFrom } from "../autostate.ts";
import type { AutoPanel, Reply as Http } from "../control.ts";
import type { AutoMode, Outcome } from "./automode.ts";
import { STALE } from "./automode.ts";
import type { Reply, Request } from "./socket.ts";

// Auto mode's two doors on the server (docs/specs/2026-11-09-auto-mode.md, §2): the control socket's `auto-*` commands (a session's, no run token: rungate.ts refuses them) and the GUI's panel (control.ts, `auto` and
// `auto/confirm`: the page's token and CSRF, a paired phone too).

/** An unattended device has no boss at it (§10). */
export const UNATTENDED = "an unattended device has no boss at it; its waits go to its controllers";
const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The GUI's panel. A write is the boss's own act, so `on` switches at once (the page's two taps are its confirm) and a pending record from the head is confirmed by id. */
export function autoPanel(auto: AutoMode, unattended: () => boolean = () => false): AutoPanel {
	const by = (remote: boolean): By => ({ via: remote ? "phone" : "gui", name: remote ? "a paired phone" : "the page" });
	const none = (): Http | undefined => (unattended() ? { status: 409, body: { error: "unattended", reason: UNATTENDED } } : undefined);
	const answer = (out: Outcome) => (out.ok ? { status: 200, body: auto.view() } : { status: 409, body: { error: out.error === STALE ? "stale" : "refused", reason: out.error } });
	return {
		state: () => ({ status: 200, body: auto.view() }),
		set: (on, remote) => none() ?? answer(on ? auto.switchOn(by(remote)) : auto.switchOff(by(remote))),
		confirm: (id, remote) => none() ?? answer(auto.confirm(id, by(remote))),
	};
}

/** The socket commands. `auto-on` only stages (D9): nothing over the socket switches auto mode on in one step. */
export function autoReply(auto: AutoMode | undefined, request: Request, unattended: () => boolean = () => false): Reply | undefined {
	if (!["auto-state", "auto-on", "auto-off", "auto-confirm", "auto-check", "auto-note"].includes(request.cmd)) return undefined;
	if (!auto) return { ok: false, error: "auto mode is held by the primary server of this computer" };
	if (["auto-on", "auto-off", "auto-confirm"].includes(request.cmd) && unattended()) return { ok: false, error: UNATTENDED };
	const by: By = { via: "pi", name: text(request.name, 80) || "a session", ...((r) => (r ? { requester: r } : {}))(requesterFrom(request)) };
	const done = (out: Outcome): Reply => (out.ok ? { ...out, ok: true } : { ok: false, error: out.error });
	switch (request.cmd) {
		case "auto-state": return { ok: true, state: auto.view() };
		case "auto-on": return done(auto.stage(text(request.said, 200) || "/boss auto on", by));
		case "auto-off": return { ...done(auto.switchOff(by)), state: auto.view() };
		case "auto-confirm": return done(auto.confirm(request.id, by));
		case "auto-note": return done(auto.note(request));
		default: return { ok: true, own: auto.check(request.rev, request.hash), on: auto.view().on };
	}
}
