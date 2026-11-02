import type { Net } from "../src/net.ts";
import type { Post } from "./composer.ts";
import { createPrefs, KEYS } from "./prefs.ts";
import { locate } from "./scene.ts";

// The session this device last talked to, for Zen's companion: kept in `sb.zen.with` once the server accepted a message sent from a composer (a dialog answer is not talking).
export interface With { key: string; ws: string; at: number }
export const WITH = KEYS.zenWith;
type Store = Pick<Storage, "getItem" | "setItem">;

export function recall(store: Store = localStorage): With | undefined {
	try {
		const v = JSON.parse(createPrefs(store).get("zenWith") ?? "null") as With | null;
		return v && typeof v.key === "string" && typeof v.ws === "string" && typeof v.at === "number" ? v : undefined;
	} catch {
		return undefined;
	}
}
/** `target` is the unit a send reaches: the composer's own, or for a route with no unit (an ally or event run) the tower of its base. */
export const remember = (target: { key: string; ws: string }, at = Date.now(), store: Store = localStorage) => {
	createPrefs(store).set("zenWith", JSON.stringify({ key: target.key, ws: target.ws, at })); // no storage: the companion falls back to the tower
};
/** The composer's `Post`, recording an accepted `input` and nothing else. */
export const recording = (send: Post, target: () => { key: string; ws: string } | undefined, now: () => number = Date.now, store?: Store): Post => async (action, body) => {
	const r = await send(action, body), t = action === "input" && r.ok ? target() : undefined;
	if (t) remember(t, now(), store);
	return r;
};
/** The unit a send from the route `key` in base `ws` reaches: that unit when the net lists it, else (an ally or event run) the base's tower. */
export const sendTarget = (net: Net | undefined, key: string, ws: string) => ((hit) => (hit ? { key, ws: hit.base.id } : ((t) => (t ? { key: t.key, ws } : undefined))(net?.bases.find((b) => b.id === ws)?.tower)))(locate(net, key));
