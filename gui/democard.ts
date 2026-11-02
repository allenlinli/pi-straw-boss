import type { Answer } from "./post.ts";
import type { StepOpen } from "./terminalthen.ts";

// The terminal card's demo (docs/specs/2026-11-02-terminal-card.md, section 12), for `npm run gui:dev` and the demo build: `?card=<state>` opens the card a moment after the page starts, with or without `?zen=`, and this script answers its
// terminal. `prompt`: billing-main's prompt waits for Enter (the server asks to confirm the command, then takes it). `reload`: the same with a /reload (an ending command). `type`: a pane waits at `$ sudo apt update`; Enter asks for a
// password, text and Enter print three rows, and the pane closes 4 s later. `run`: output scrolls for 8 s, then the pane closes. `secretmiss`: a prompt the rule cannot know (`Enter secret>`). `refused`: every key is refused. `stale`: the
// frames stop. `gone`: the attach is refused as not found. `hidden`: a session behind a secret_drop. `held`: a tower standing by. `second`: the page already shows two terminals, so the attach is refused (429 `too_many`) and keys are refused for lack of a mirror.

export const CARD_STATES = ["prompt", "reload", "type", "run", "secretmiss", "refused", "stale", "gone", "hidden", "held", "second"] as const;
export type CardState = (typeof CARD_STATES)[number];
export const isCard = (state: string | null): state is CardState => CARD_STATES.includes(state as CardState);
const PANE = "grant:demo-pane", COMMAND = "sudo apt update";
/** The step an accepted answer would leave, by the unit that asked (the demo net's billing-main `a1`, ops-main `a3`, and the harbor tower `t1`). */
export const stepOf = (state: CardState): StepOpen => {
	const pane = ["type", "run", "secretmiss", "stale", "gone"].includes(state), asker = pane ? "a3" : state === "held" ? "t1" : "a1";
	return { kind: pane ? "pane" : "prompt", key: pane ? PANE : asker, asker, command: state === "reload" ? "/reload" : COMMAND };
};
const ok = (body: Record<string, unknown> = {}): Answer => ({ ok: true, status: 200, body });
const no = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}): Answer => ({ ok: false, status, body: { error, reason, ...extra } });
const OUT = ["Hit:1 http://ports.ubuntu.com/ubuntu-ports noble InRelease", "Get:2 http://ports.ubuntu.com/ubuntu-ports noble-updates InRelease [126 kB]", "Reading package lists… Done"];

export function demoCard(state: CardState, send: (type: string, payload: unknown) => void) {
	const { key } = stepOf(state), pane = key === PANE;
	let stage = 0, seq = 0, beat: ReturnType<typeof setInterval> | undefined, began = 0, closeAt = Infinity;
	const rows = (): string[] => {
		if (state === "run") return ["$ sudo apt update", ...Array.from({ length: Math.min(40, Math.floor((Date.now() - began) / 1000) + 1) }, (_, i) => `Get:${i + 1} http://ports.ubuntu.com/ubuntu-ports noble-security/main arm64 Packages [${120 + i * 7} kB]`)];
		if (state === "secretmiss") return ["$ sudo apt update", "Reading package lists… Done", stage ? "Accepted." : "Enter secret>"];
		if (state === "stale") return ["$ sudo apt update", "Working…"];
		return ["$ sudo apt update", ...(stage > 0 ? ["[sudo] password for boss:"] : []), ...(stage > 1 ? OUT : [])];
	};
	const push = () => send("mirror", state === "hidden" ? { key, seq: ++seq, hidden: true } : { key, seq: ++seq, rows: rows().length, cols: 60, whole: true, set: rows().map((row, i) => [i, row]) });
	const stop = () => (clearInterval(beat), (beat = undefined));
	const tick = () => {
		if (Date.now() >= closeAt) return (stop(), send("mirror", { key, ended: "The pane closed." }));
		if (state === "stale" && seq > 0) return;
		push();
	};
	return {
		/** The terminal's mirror: attach or detach. Another key is not the card's. */
		mirror(at: string, on: boolean): Answer | undefined {
			if (at !== key) return undefined;
			stop();
			if (!on) return ok({ attached: false });
			if (state === "gone") return no(404, "not_found", "That pane is gone.");
			if (state === "second") return no(429, "too_many", "A page shows at most 2 terminals; close one first.");
			if (state === "run") closeAt = Date.now() + 8000;
			[began, beat] = [Date.now(), setInterval(tick, 1000)];
			setTimeout(tick, 50);
			return ok({ attached: true });
		},
		/** The terminal's keys: Enter for a session's prompt (the confirm, then taken), Enter and text for a pane. */
		keys(at: string, body: Record<string, unknown>): Answer | undefined {
			if (at !== key) return undefined;
			if (state === "refused" || state === "second") return no(409, "no_mirror", "Keys are sent only while this page shows the session's terminal live; open it again.");
			if (state === "hidden") return no(409, "blocked", "While it waits on a secret only Escape is sent from here.");
			if (body.key !== "enter") return ok();
			if (!pane) {
				const token = state === "reload" ? "reload" : "command";
				return body.confirmed === token ? ok({ accepted: true }) : no(409, "confirm", `Enter would run ${state === "reload" ? "/reload, which ends or replaces this session" : "a command"}; confirm to send it.`, { confirm: token });
			}
			stage++;
			if (state === "type" && stage === 2) closeAt = Date.now() + 4000;
			push();
			return ok();
		},
	};
}
