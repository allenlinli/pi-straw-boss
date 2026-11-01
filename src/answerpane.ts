import { randomBytes } from "node:crypto";
import type { createKeys } from "./keys.ts";
import { HerdrError, type HerdrCall, type Pane } from "./herdr.ts";
import type { createMirrors } from "./mirror.ts";
import type { Next, Then } from "./owners.ts";

// A pane an accepted answer opened (robot_hand's "Type it into a new Herdr pane" and "Run it in a new Herdr pane"): the server notes the panes of the session's tab before the
// answer goes out, and after it is accepted looks for the one that is new. Exactly one new pane that runs no agent and has no `sb_role` is granted; it ends if either shows later: the page may then mirror it and key into it
// (`/api/panes/<grant>/mirror|keys`, control.ts) like a session's terminal, for as long as that pane lives with the same terminal. Two new panes, none within the window, or a layout
// that cannot be read grant nothing: the page says a pane opened and leaves it to Herdr. A grant is an unguessable id, never a pane id from the browser; a reused pane id under
// another terminal is refused.

/** A pane that is, or is becoming, a pi session or a tower: Herdr reports an agent on it, or it carries an `sb_role` token. A grant never reaches one, and ends the moment its pane turns into one. */
export const isPiPane = (pane: Pick<Pane, "agent" | "tokens">): boolean => Boolean(pane.agent) || Boolean(pane.tokens?.sb_role);
export const MAX_GRANTS = 8, GRANT_MS = 6 * 3_600_000, CLAIM_MS = 3000, CLAIM_STEP_MS = 250;
export interface Grant { id: string; session: string; pane: string; terminal?: string; at: number }
export interface GrantDeps { call: HerdrCall; now?(): number; sleep?(ms: number): Promise<void>; id?(): string }
export type Grants = ReturnType<typeof createGrants>;
const no = (status: number, error: string, reason: string) => ({ status, body: { error, reason } });
interface Reply { status: number; body: unknown }

export function createGrants({ call, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), id = () => randomBytes(16).toString("hex") }: GrantDeps) {
	const grants = new Map<string, Grant>();
	/** The ids of the panes in the tab of `pane`, or undefined when Herdr cannot say. */
	const panesOf = async (pane: string): Promise<Set<string> | undefined> => {
		try {
			const { layout } = (await call("pane.layout", { pane_id: pane })) as { layout: { panes: { pane_id: string }[] } };
			return new Set(layout.panes.map((p) => p.pane_id));
		} catch {
			return undefined;
		}
	};
	return {
		/** The tab's panes now, noted before an answer goes out. */
		before: panesOf,
		/** The pane the answer opened: the one pane in the tab that was not in `before` and does not run pi, within the window; undefined when none or when it is not the only one. */
		async claim(session: string, pane: string, before: Set<string>): Promise<Grant | undefined> {
			for (let waited = 0; ; waited += CLAIM_STEP_MS) {
				const now_ = await panesOf(pane), fresh = now_ ? [...now_].filter((p) => !before.has(p) && p !== pane) : [];
				if (fresh.length > 1) return undefined;
				if (fresh.length === 1) {
					const got = await call("pane.get", { pane_id: fresh[0]! }).then((r) => (r as { pane: Pane }).pane, () => undefined);
					if (got && !isPiPane(got)) {
						const made = { id: id(), session, pane: got.pane_id, ...(got.terminal_id ? { terminal: got.terminal_id } : {}), at: now() };
						grants.set(made.id, made);
						while (grants.size > MAX_GRANTS) grants.delete(grants.keys().next().value!);
						return made;
					}
					if (got) return undefined;
				}
				if (waited >= CLAIM_MS) return undefined;
				await sleep(CLAIM_STEP_MS);
			}
		},
		get(grant: string): Grant | undefined {
			const g = grants.get(grant);
			if (g && now() - g.at > GRANT_MS) grants.delete(grant);
			return grants.get(grant);
		},
		drop: (grant: string) => void grants.delete(grant),
		/** The pane as Herdr has it now, or a refusal (and the grant gone) when it closed or its id belongs to another terminal. */
		async live(g: Grant): Promise<Pane> {
			const gone = () => (grants.delete(g.id), no(409, "pane_closed", "That pane has closed."));
			let pane: Pane;
			try {
				pane = ((await call("pane.get", { pane_id: g.pane })) as { pane: Pane }).pane;
			} catch (error) {
				throw error instanceof HerdrError && error.code === "pane_not_found" ? gone() : error;
			}
			if (g.terminal && pane.terminal_id !== g.terminal) throw gone();
			if (isPiPane(pane)) throw gone(); // the pane turned into a pi session or a tower: its guards, not a bare key, stand in front of it
			return pane;
		},
	};
}

/** What an accepted answer to a choice with `next` leaves to open: the session's terminal, or the pane it opened (a grant id; null when none could be told apart). `noted`: the tab's panes before the answer went out. */
export async function thenOf(grants: Pick<Grants, "claim"> | undefined, next: Next, session: string, pane: string, noted: Set<string> | undefined): Promise<Then> {
	return next === "terminal" ? { terminal: true } : { pane: (noted && (await grants?.claim(session, pane, noted))?.id) || null };
}

/** POST /api/panes/<grant>/mirror {stream, on} and /keys: a pane an answer opened, reached by its grant alone and mirrored and keyed like a session's terminal (mirror.ts `Bare`, keys.ts `bare`), after control.ts's write guards. Detaching needs no live grant: the pane may be gone. */
export async function panes(
	{ grants, mirrors, pad, call, busy, refused }: { grants?: Pick<Grants, "get" | "live">; mirrors?: Pick<ReturnType<typeof createMirrors>, "toggle">; pad: ReturnType<typeof createKeys>; call?: HerdrCall; busy: Set<string>; refused(error: unknown): Reply },
	grant: string, action: string, json: Record<string, unknown>, remote: boolean,
): Promise<Reply> {
	const g = grants?.get(grant), id = `grant:${grant}`;
	if (!grants || (action !== "mirror" && action !== "keys")) return no(404, "not_found", "No such action.");
	if (action === "mirror") {
		if (!mirrors) return no(503, "unavailable", "This server shows no terminals.");
		if (json.on === false) return mirrors.toggle(id, json);
		return g ? mirrors.toggle(id, json, { pane: g.pane, ...(g.terminal ? { terminal: g.terminal } : {}) }) : no(404, "not_found", "That pane is not open here any more.");
	}
	if (!g) return no(404, "not_found", "That pane is not open here any more.");
	if (!call) return no(503, "unavailable", "This server cannot reach Herdr.");
	if (busy.has(id)) return no(429, "busy", "Another key to this pane is still on its way.");
	const asked = pad.check(id, json, remote);
	if ("status" in asked) return asked;
	busy.add(id);
	try {
		const plan = pad.bare(id, (await grants.live(g)).pane_id, asked);
		for (const [i, [method, params]] of plan.calls.entries()) (i && (await new Promise((r) => setTimeout(r, 60))), await call(method, params, 15_000));
		return { status: 200, body: { accepted: true } };
	} catch (error) {
		return (error as Reply).status ? (error as Reply) : refused(error);
	} finally {
		busy.delete(id);
	}
}
