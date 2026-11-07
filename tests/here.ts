import { createFaces } from "../src/lan/faces.ts";
import { createHereMark } from "../src/heremark.ts";

/**
 * The sb server's `gui-lan-face` and `gui-lan-pending` requests answered by the real marks (lan/faces.ts), and a `here` made over them: `marked()` says whether a paired device's key pad would be Escape only on `pane` now.
 * `tick()` runs the renewals the mark's timer would, so a test moves the clock itself.
 */
export function hereWorld(pane = "wA:p1", over: { reply?: (request: Record<string, unknown>) => { ok: boolean; error?: string } | undefined } = {}) {
	let clock = 0, ticks: (() => void)[] = [];
	const faces = createFaces(() => clock), asked: Record<string, unknown>[] = [], opened: string[] = [];
	const ask = async (request: Record<string, unknown>) => {
		asked.push(request);
		const forced = over.reply?.(request);
		if (forced) return forced;
		if (request.cmd === "gui-lan-face") {
			if (request.open === true) {
				const face = faces.open(request.pane);
				if (face) opened.push(face);
				return face ? { ok: true, face } : { ok: false, error: "bad_request" };
			}
			return { ok: true, closed: faces.close(request.face) };
		}
		if (request.cmd === "gui-lan-pending") return faces.renew(request.face) ? { ok: true } : { ok: false, error: "unknown_face" };
		return { ok: false, error: "bad_request" };
	};
	const here = createHereMark({ ask, pane, every: (fn) => (ticks.push(fn), () => void (ticks = ticks.filter((t) => t !== fn))) });
	return {
		here, ask, faces, asked, opened,
		/** Whether a paired device's key pad is Escape only on the pane right now. */
		marked: () => faces.marked(pane),
		/** Moves the lease clock by `ms` and runs the renewals that are due. */
		tick: async (ms = 1000) => { clock += ms; for (const fn of [...ticks]) fn(); await new Promise((r) => setImmediate(r)); },
		timers: () => ticks.length,
	};
}
export type HereWorld = ReturnType<typeof hereWorld>;
