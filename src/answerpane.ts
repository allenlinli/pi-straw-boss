import { randomBytes } from "node:crypto";
import { HerdrError, type HerdrCall, type Pane } from "./herdr.ts";

// A pane an accepted answer opened (robot_hand's "Type it into a new Herdr pane" and "Run it in a new Herdr pane"): the server notes the panes of the session's tab before the
// answer goes out, and after it is accepted looks for the one that is new. Exactly one new pane that does not run pi is granted: the page may then mirror it and key into it
// (`/api/panes/<grant>/mirror|keys`, control.ts) like a session's terminal, for as long as that pane lives with the same terminal. Two new panes, none within the window, or a layout
// that cannot be read grant nothing: the page says a pane opened and leaves it to Herdr. A grant is an unguessable id, never a pane id from the browser; a reused pane id under
// another terminal is refused.

export const MAX_GRANTS = 8, GRANT_MS = 6 * 3_600_000, CLAIM_MS = 3000, CLAIM_STEP_MS = 250;
export interface Grant { id: string; session: string; pane: string; terminal?: string; at: number }
export interface GrantDeps { call: HerdrCall; now?(): number; sleep?(ms: number): Promise<void>; id?(): string }
export type Grants = ReturnType<typeof createGrants>;
const no = (status: number, error: string, reason: string) => ({ status, body: { error, reason } });

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
					if (got && got.agent !== "pi") {
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
			return pane;
		},
	};
}
