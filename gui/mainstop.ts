import type { MainCard, UnitCard } from "./linkmodel.ts";
import { m } from "./sentences.ts";
import { type Answer, post } from "./post.ts";
import { choose } from "./quit.ts";

// The Stop of a main on an ally card (docs/specs/2026-11-07-link-remote-stop.md §6): the page's confirm with two ways to stop (quit, or interrupt and quit), then the same `link/unit-stop` that `/boss link stop` posts.
// The box decides, so a sent request only says "stopping…" until the box's next status carries `stopping` (or the main gone); a refusal says why in the page's dialog. `io` is the seam a test replaces (the page's confirm and post). Both modules are the page's own (quit.ts and post.ts load with it), so this chunk adds no import of its own.

export const io = { choose, post: (path: string, body: Record<string, unknown>): Promise<Answer> => post(path, body) };

/** How long a request this page sent reads as "stopping…" before the box's own status has to say so. */
const ASKED_MS = 120_000;
const asked = new Map<string, number>();
const keyOf = (u: Pick<UnitCard, "device">, c: Pick<MainCard, "handle">) => `${u.device}/${c.handle}`;
/** Whether this page asked for this main's stop lately: its row reads "stopping…" with no Stop while the box has not yet said so. */
export const requested = (u: Pick<UnitCard, "device">, c: Pick<MainCard, "handle">, now = Date.now()): boolean => now - (asked.get(keyOf(u, c)) ?? -Infinity) < ASKED_MS;

/** Asks the boss how to stop `c` of box `box`, and posts it. Resolves whether a request went (the box was asked, or the relay holds it); a refusal is said in the dialog. */
export async function stopMain(u: Pick<UnitCard, "device">, c: Pick<MainCard, "handle" | "name" | "team">, box: string): Promise<boolean> {
	const mode = await io.choose(m.link_main_stop_ask({ box, name: c.name }), [{ label: m.link_main_stop(), value: "quit" }, { label: m.link_main_interrupt(), value: "interrupt", tone: "danger" }]);
	if (!mode) return false;
	const answer = await io.post("link/unit-stop", { team: c.team, device: u.device, handle: c.handle, mode, reason: "" }).catch((): Answer => ({ ok: false, status: 0, body: {} }));
	if (answer.ok) return (asked.set(keyOf(u, c), Date.now()), true);
	await io.choose(m.link_main_refused({ box, reason: answer.body.reason ?? (answer.status ? m.refused({ status: answer.status }) : m.no_answer()) }), []);
	return false;
}
