import type { LanReply } from "./lanface.ts";

// The mark a `/boss` command holds while a screen waits that only this computer may answer (hereOnly: `link confirm`, `link answer`, `link create`, `link join`, `link leave`, `link invite cancel|show`, `link decide`, `gui rotate`,
// `gui unpair all`, `server stop|restart`). hereOnly keeps the page's relay from carrying such a screen to a paired device, but a paired device can also write into the pane (the key pad's Enter, `y`), and pi's own dialog takes the key as its
// answer. The server already has the one mark that tells the key pad, the composer, and the take-backs to send Escape only to a pane (lan/faces.ts, the `/boss gui lan` overlay's); this opens one of those the same way
// (`gui-lan-face`), renews it while the screen waits (`gui-lan-pending`, the overlay's own 1 s poll against the 5 s lease), and drops it on every way out. The state comes from this command, which owns the screen, never from reading the terminal.
// A GUI that is not running (stopped on purpose, or no sb server) takes no paired device's keys, so nothing is marked and the screen opens as before. Any other refusal refuses the screen: asking where a paired device could answer is the failure.

/** Runs `fn` (the screen) with the pane marked for a paired device's keys; the mark is dropped when `fn` returns, throws, or is cut off. */
export type Here = <T>(fn: () => Promise<T>) => Promise<T>;
export interface HereDeps {
	/** One control request (never starting a server: the command already found it). */
	ask(request: Record<string, unknown>): Promise<LanReply>;
	/** `HERDR_PANE_ID`, or null outside Herdr. */
	pane: string | null;
	/** Runs `fn` every `ms` until the returned function is called. */
	every(fn: () => void, ms: number): () => void;
}
const POLL_MS = 1000;
/** Answers of the server that mean no GUI listens, so no paired device can write. */
const NO_GUI = ["no server", "stopped"];

export function createHereMark({ ask, pane, every }: HereDeps): Here {
	const open = () => ask({ cmd: "gui-lan-face", pane, open: true });
	return async function here<T>(fn: () => Promise<T>): Promise<T> {
		const first = await open();
		if (!first.ok && NO_GUI.includes(String(first.error))) return fn();
		if (!first.ok || typeof first.face !== "string") throw new Error(`This asks on this computer only, and the pane could not be marked as local-only (${String(first.reason ?? first.error ?? "no answer")}); nothing was asked. Run it again, or in a pi terminal on the computer that runs the sb server.`);
		let face = first.face, over = false, polling = false;
		const renew = async () => {
			if (polling || over) return;
			polling = true;
			try {
				const r = await ask({ cmd: "gui-lan-pending", face });
				if (r.ok || r.error !== "unknown_face") return;
				// The server restarted or the lease lapsed: a new mark, unless the screen ended meanwhile.
				const again = await open();
				if (typeof again.face !== "string") return;
				if (over) await ask({ cmd: "gui-lan-face", face: again.face, open: false }).catch(() => {});
				else face = again.face;
			} catch {
				// Unanswered: the lease runs on and lapses by itself.
			} finally {
				polling = false;
			}
		};
		const stop = every(() => void renew(), POLL_MS);
		try {
			return await fn();
		} finally {
			over = true;
			stop();
			await ask({ cmd: "gui-lan-face", face, open: false }).catch(() => {});
		}
	};
}
