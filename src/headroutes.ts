import type { Reply, TowerPanel } from "./control.ts";
import { HEAD_KEY, HEAD_NEEDS_SERVICE } from "./headkey.ts";

// The head tower's routes (docs/specs/2026-11-04-head-tower.md, The GUI channel, Posting): the composer of its session key and `POST api/head/<action>` run the tower panel's functions with the head's key, so a paired
// device may do exactly what it may do for a tower (control.ts has checked the origin, the CSRF secret, and the body before it gets here). The panel makes the head workspace when a message finds none.

const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });
const STANDING = "The head tower is standing by: no run is live, so there is no terminal. Write to it in the composer; that wakes it.";
const done = (r: { ok: boolean; error?: string }, ok: Reply, refused = "The head tower refused it."): Reply => (r.ok ? ok : no(409, "refused", r.error ?? refused));

/**
 * One request on the head: `scope` is `head` (the buttons, `head/<action>`) or `sessions` on the head's key (`sessions/<key>/<action>`). The reply is the route's own, or undefined for a session action the generic route takes
 * from here (the keys, mirror, focus, and commands of a live run's pane). `text` is control.ts's check of a composer's text.
 */
export async function headRoutes(tower: TowerPanel | undefined, [scope, key = "", action = ""]: string[], json: Record<string, unknown>, text: (value: unknown) => string | Reply): Promise<Reply | undefined> {
	if (!tower?.has(HEAD_KEY)) return no(409, "refused", HEAD_NEEDS_SERVICE);
	if (scope === "sessions") {
		if (action === "input") {
			const typed = text(json.text);
			if (typeof typed !== "string") return typed;
			// The conversation's two commands, as at a tower's composer: exactly `/quit` leaves it and `/new` starts over.
			const command = typed.trim() === "/quit" ? "leave" : typed.trim() === "/new" ? "new" : undefined;
			if (command && tower.conversation) return done(await tower.conversation(HEAD_KEY, command), { status: 200, body: { accepted: true, command } });
			return done(await tower.event(HEAD_KEY, typed), { status: 200, body: { accepted: true, woke: true } }, "The head tower did not take it.");
		}
		if (action === "dequeue") return no(409, "server_queue", "These messages wait in the sb server's queue for the head tower's next run; they are taken when it runs.");
		return ["keys", "mirror", "focus"].includes(action) && !tower.live(HEAD_KEY) ? no(409, "standing", STANDING) : undefined;
	}
	if (action) return no(404, "not_found", "No such action.");
	if (key === "memory") return tower.memory ? tower.memory(HEAD_KEY, json) : no(404, "not_found", "No such action.");
	if (key === "close") return tower.close ? done(await tower.close(HEAD_KEY), { status: 200, body: {} }) : no(404, "not_found", "No such action.");
	if (key === "leave" || key === "new") {
		if (!tower.conversation) return no(404, "not_found", "No such action.");
		const said = await tower.conversation(HEAD_KEY, key);
		return done(said, { status: 200, body: { ...(said.left !== undefined ? { left: said.left } : {}), ...(said.fresh ? { fresh: true } : {}) } });
	}
	if (key !== "retry" && key !== "deliver" && key !== "drop") return no(404, "not_found", "No such action.");
	const id = typeof json.id === "string" && json.id.length <= 64 ? json.id : undefined;
	if (key !== "retry" && !id) return no(400, "bad_request", "Name the parked event.");
	return done(await tower.act(HEAD_KEY, key, id), { status: 200, body: {} });
}
