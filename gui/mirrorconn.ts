import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// A page's connection to one terminal's mirror (the server's `mirror` frames, src/mirror.ts, on this tab's one stream), without a screen: the attach
// queue (one request at a time, so an off sent right after an on reaches the server after it), the attach again on a new stream's `hello`, the park 5 s
// after the tab is hidden, the stale check (a frame comes at least once a second), the refusals and the `ended` frame that end it, and the rows the
// frames set. Whoever shows the mirror (the tile, the embedded terminal, a card) joins the key with a `Watch`; the first to join attaches and the last
// to leave detaches, so one key is one attach however many watch it.

export interface Frame { key: string; seq?: number; rows?: number; cols?: number; whole?: boolean; set?: [number, string][]; hidden?: boolean; ended?: string }
export type Post = (action: "mirror" | "keys", body: Record<string, unknown>) => Promise<Answer>;
/** `state` is what the pad may do: send keys (`live`), only Escape (`hidden`, a secret), or nothing (`off`: stale, ended, parked, connecting). */
export type TermState = "live" | "hidden" | "off";
/** What the connection last had to say: no frame yet, rows, a secret, the tab hidden, or a refusal (`why`: the server's reason, or the end of the mirror). */
export type Phase = "connecting" | "live" | "hidden" | "paused" | "refused";
export interface Conn { key: string; post: Post; rows: string[]; cols: number; seen: number; phase: Phase; why: string; hidden: boolean; ended: boolean; parked: boolean; watchers: Set<Watch>; state(): TermState; stale(): boolean }
/** Who listens. `rows`: a frame's rows were applied (`f` the frame, `size` its width changed or it is whole); `state`: the phase or the staleness may have changed (also once a second); `end`: the pane is gone (an `ended` frame, or an attach refused as not found or closed); `entered`: a pad sent an Enter (true) or the server refused it (false). */
export interface Watch { rows?(rows: string[], f: Frame, size: boolean): void; state?(s: TermState, c: Conn): void; end?(): void; entered?(sent: boolean): void }
export const MAX_ROWS = 120;
const AWAY_MS = 5000, STALE_MS = 3000;
interface C extends Conn { queue: Promise<unknown>; away?: ReturnType<typeof setTimeout> }

export function mountConns({ post, stream }: { post(key: string): Post; stream(): string }) {
	const conns = new Map<string, C>();
	let tick: ReturnType<typeof setInterval> | undefined;
	const id = () => { try { return String(JSON.parse(stream()).stream ?? ""); } catch { return ""; } };
	const tell = (c: C) => c.watchers.forEach((w) => w.state?.(c.state(), c));
	const say = (c: C, phase: Phase, why = "") => (Object.assign(c, { phase, why }), tell(c));
	const refuse = (c: C, why: string) => ((c.ended = true), say(c, "refused", why));
	const end = (c: C) => c.watchers.forEach((w) => w.end?.());
	const attach = (c: C, on: boolean, s = id()) => s && void (c.queue = c.queue.then(() => c.post("mirror", { stream: s, on }).then((r) => on && !r.ok && (refuse(c, r.body.reason ?? m.refused({ status: r.status })), (r.status === 404 || r.body.error === "pane_closed") && end(c)), () => on && refuse(c, m.unreachable()))));
	/** A refused or failed attach ends the mirror, so joining or opening it again tries again. */
	const retry = (c: C) => c.ended && void ((c.ended = false), say(c, "connecting"), attach(c, true));
	// The check runs only while a connection is held and the tab shows.
	const watching = () => (clearInterval(tick), (tick = conns.size && !document.hidden ? setInterval(() => conns.forEach(tell), 1000) : undefined));
	document.addEventListener("visibilitychange", () => (watching(), conns.forEach((c) => {
		clearTimeout(c.away);
		if (document.hidden) c.away = setTimeout(() => ((c.parked = true), attach(c, false), say(c, "paused")), AWAY_MS);
		else if (c.parked) void ((c.parked = false), attach(c, true));
	})));
	return {
		id,
		retry: (c: Conn) => retry(c as C),
		/** A pad on `c` sent an Enter (true) or the server refused it (false). */
		entered: (c: Conn, sent: boolean) => c.watchers.forEach((w) => w.entered?.(sent)),
		/** `w` joins the connection of `key` (made and attached by the first); `stop` leaves it (the last to leave detaches). */
		join(key: string, w: Watch): { conn: Conn; stop(): void } {
			let c = conns.get(key);
			if (c) retry(c);
			else {
				const conn: C = { key, post: post(key), rows: [], cols: 0, seen: 0, phase: "connecting", why: "", hidden: false, ended: false, parked: false, watchers: new Set(), queue: Promise.resolve(), state: () => (conn.parked || conn.ended || conn.stale() ? "off" : conn.hidden ? "hidden" : "live"), stale: () => Date.now() - conn.seen > STALE_MS };
				conns.set(key, (c = conn));
				attach(c, true);
			}
			const at = c;
			at.watchers.add(w);
			watching();
			return { conn: at, stop: () => at.watchers.delete(w) && !at.watchers.size && void (clearTimeout(at.away), attach(at, false), conns.delete(key), watching()) };
		},
		/** A new stream said hello: every connection attaches to it. */
		hello: () => conns.forEach((c) => !c.parked && !c.ended && attach(c, true)),
		/** One `mirror` event from the stream. */
		frame(raw: string) {
			let f: Frame;
			try { f = JSON.parse(raw) as Frame; } catch { return; }
			const c = conns.get(f.key);
			if (!c) return;
			c.hidden = Boolean(f.hidden || f.ended);
			if (f.ended) return (refuse(c, m.mirror_ended({ why: f.ended })), end(c));
			[c.seen, c.ended] = [Date.now(), false];
			if (f.hidden) return void ((c.rows.length = 0), c.watchers.forEach((w) => w.rows?.(c.rows, { key: c.key, rows: 0 }, false)), say(c, "hidden"));
			const n = Math.min(Math.max(0, Number(f.rows) || 0), MAX_ROWS);
			while (c.rows.length < n) c.rows.push("");
			c.rows.length = n;
			for (const [i, row] of Array.isArray(f.set) ? f.set : []) if (Number.isInteger(i) && i >= 0 && i < n && typeof row === "string") c.rows[i] = row;
			const size = Boolean(f.whole || (f.cols && f.cols !== c.cols));
			if (size) c.cols = f.cols || c.cols;
			c.watchers.forEach((w) => w.rows?.(c.rows, f, size));
			say(c, "live");
		},
	};
}
