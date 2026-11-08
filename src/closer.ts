import type { Reply } from "./control.ts";
import { type HerdrRun, panes, type Session, type Sleep } from "./herdr.ts";
import { closeAll, nameOk, stashBase } from "./stash.ts";
import { trainFromToken, trainLabel } from "./trainrole.ts";
import { SettingsRefused } from "./trust/settings.ts";

// What the page's close buttons ask for. Closing is each session's own (index.ts): its bridge is asked to quit it as /boss close does, and its
// shutdown clears its tokens (a tower's clears the base's mains). One unit closes its own pane afterwards; for a squad or a base every agent
// of the net in it (mains, members, and the base's tower) quits first, then the tab or the workspace closes with what is left in it (shells,
// subagents). A session that refuses or does not answer stops the batch before anything closes, and so does one still running after EXIT_MS.
// The session that runs the server is asked last of all, through nothing: closing its tab or base ends it with the rest.
// A session that quit and closed is told to `forget`, so the route an ally run left for a main it opened for a device goes with the main (the operate page's close-unit and close-tab arrive here).
// The tower the sb server runs (a service) has no pi and no bridge: its Quit tower ends the service (towers.ts close: the tab goes, the base's mains become members), and a squad or base closes without asking its identity or the pi of a run in its pane, and ends the service when its tab closes with them.
//   POST /<token>/api/close/unit {key}                 that session quits and closes its pane
//   POST /<token>/api/close/tab {workspace, tab}       every agent in the tab quits, then the tab closes
//   POST /<token>/api/close/base {workspace}           every agent in the workspace quits, then the workspace closes
//   POST /<token>/api/close/stash {workspace, name?}   the base is checked and recorded first (stash.ts), then closed as above; no name: its label
//   POST /<token>/api/close/all {workspace} or {by}    that base, or the base of session `by`, is checked, then closes as above (stash.ts closeAll)
//   POST /<token>/api/close/pop {name}                 opens a stash again from the server's session (stash.ts popBase)

const EXIT_MS = 30_000, JOINED = new Set(["main", "member", "tower"]);
/** `check` and `stateDir` are a stash's: without them this closer stashes nothing. */
export interface CloserDeps { /** The sb server's own towers: `of` names the workspace whose service a unit key is the tower of, `owns` says an intercom id is a service's identity, `has` that the service stands in the workspace (every session in its standing pane is then its own: the identity and the pi of a live, event, or hand run), `end` closes the tower as the boss (a service has no pi to ask). */ tower?: { of(key: string): string | undefined; owns(id: string): boolean; has(workspace: string): boolean; end(workspace: string): Promise<{ ok: boolean; error?: string }> }; run: HerdrRun; sleep: Sleep; me(): string; sessions(): Promise<Session[]>; ask(key: string, keepPane: boolean, ifStashable?: boolean): Promise<{ accepted: boolean; reason?: string } | undefined>; check?(key: string): Promise<{ reason?: string } | undefined>; stateDir?: string; pop?(name: string): Promise<{ workspace: string; label: string; sessions: number }>; /** A session that accepted a close, or quit in a batch that closed: the server drops what it kept for it (an `opened` route of an ally run's main, allyroute.ts). It must not throw. */ forget?(session: string): void }
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

export function createCloser({ run, sleep, me, sessions, ask, check, stateDir, pop, tower, forget }: CloserDeps) {
	let busy = false;
	const name = (s: Session) => s.name ?? s.id.slice(0, 8);

	/** `ifStashable`: a stash's batch, where each session quits only while it can still be stashed. */
	async function batch(workspace: string, tab?: string, ifStashable = false): Promise<Reply> {
		const here = (await panes(run, workspace)).filter((p) => (!tab || p.tab_id === tab) && JOINED.has(p.tokens?.sb_role ?? ""));
		const trains = (await panes(run, workspace)).filter((p) => (!tab || p.tab_id === tab) && p.tokens?.sb_role === "train");
		// A train is not asked to quit and is not closed behind its back: only the tower closes it (boss_close_main, docs/specs/2026-11-07-train-workers.md §3.3).
		if (trains.length) return no(409, "refused", `Nothing was closed: a train runs here (${trains.map((p) => trainFromToken(p.tokens?.sb_train) ? trainLabel(trainFromToken(p.tokens?.sb_train)!.code) : p.pane_id).join(", ")}); only its tower closes it.`);
		if (!here.length && !(await panes(run, workspace)).some((p) => !tab || p.tab_id === tab)) return no(404, "not_found", tab ? "That squad is not open any more." : "That base is not open any more.");
		// A service stands in its pane with no bridge to ask, and the pi of one of its runs sits there too, under an id of its own: they end with the service, not by a quit.
		const standing = new Set(tower?.has(workspace) ? here.filter((p) => p.tokens?.sb_role === "tower").map((p) => p.pane_id) : []);
		const targets = (await sessions()).filter((s) => s.id !== me() && !tower?.owns(s.id) && !standing.has(s.herdrLocation?.paneId ?? "") && here.some((p) => p.pane_id === s.herdrLocation?.paneId));
		const answers = await Promise.all(targets.map(async (s) => ({ s, r: await ask(s.id, true, ifStashable) })));
		const stuck = answers.filter(({ r }) => !r?.accepted).map(({ s, r }) => `${name(s)}${r?.reason ? ` (${r.reason})` : " (no answer)"}`);
		if (stuck.length) return no(409, "refused", `Nothing was closed: ${stuck.join(", ")} cannot be closed from here. Close them in their terminals first.`);
		const ids = new Set(targets.map((s) => s.id));
		for (let waited = 0; waited < EXIT_MS && (await sessions()).some((s) => ids.has(s.id)); waited += 500) await sleep(500);
		const left = (await sessions()).filter((s) => ids.has(s.id));
		if (left.length) return no(504, "still_running", `${left.map(name).join(", ")} did not quit within ${EXIT_MS / 1000} s; the ${tab ? "squad" : "base"} stays open.`);
		if (standing.size) {
			const ended = await tower!.end(workspace).catch((e: Error) => ({ ok: false, error: e.message }));
			if (!ended.ok) return no(409, "refused", ended.error ?? "The tower did not close.");
		}
		await run(tab ? ["tab", "close", tab] : ["workspace", "close", workspace]).catch(() => {}); // it may have closed itself with its last pane
		for (const s of targets) forget?.(s.id);
		return { status: 200, body: { closed: targets.length } };
	}

	/** `refresh` reads the net again, so the hub learns of bridges that told it about themselves since (a stash's second round). */
	return async function handle(kind: string, json: Record<string, unknown>, refresh?: () => Promise<unknown>): Promise<Reply> {
		const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;
		if (kind === "unit") {
			if (!str(json.key)) return no(400, "bad_request", "A unit is named by its key.");
			const workspace = tower?.of(json.key), ended = workspace === undefined ? undefined : await tower!.end(workspace);
			if (ended) return ended.ok ? { status: 200, body: { closing: true } } : no(409, "refused", ended.error ?? "The tower did not close.");
			const r = await ask(json.key, false);
			if (r?.accepted) forget?.(json.key);
			return r?.accepted ? { status: 200, body: { closing: true } } : no(409, "refused", r?.reason ?? "The session did not answer (it may run an older pi-straw-boss, or be stuck); /reload it, or close it in its terminal.");
		}
		if (kind === "pop" && pop) {
			if (!nameOk(json.name)) return no(400, "bad_request", "A stash is named by its name.");
			if (busy) return no(429, "busy", "Another close or pop is still on its way.");
			busy = true;
			try {
				return { status: 200, body: await pop(json.name) };
			} catch (error) {
				// A folder pi must not start in (trust/settings.ts): nothing was opened, and the page words it from `settings`.
				if (error instanceof SettingsRefused) return { status: 409, body: { error: "settings_unsafe", reason: error.message, settings: error.refusal } };
				return no(409, "pop_failed", (error as Error).message);
			} finally {
				busy = false;
			}
		}
		if ((kind === "stash" && stateDir) || kind === "all") {
			if (!check) return no(404, "not_found", "No such action.");
			if (busy) return no(429, "busy", "Another close or pop is still on its way.");
			busy = true;
			try {
				const quit = (workspace: string) => batch(workspace, undefined, true);
				return await (kind === "all" ? closeAll({ run, sleep, sessions, check, ...(tower ? { service: tower.has } : {}) }, me(), quit, refresh, typeof json.by === "string" ? json.by : undefined, typeof json.workspace === "string" && json.workspace.length <= 200 ? json.workspace : undefined) : stashBase({ run, sleep, sessions, check, ...(tower ? { service: tower.has } : {}), stateDir: stateDir!, me: me() }, json, quit, refresh));
			} catch (error) {
				return no(502, "stash_failed", (error as Error).message);
			} finally {
				busy = false;
			}
		}
		if (kind !== "tab" && kind !== "base") return no(404, "not_found", "No such action.");
		if (!str(json.workspace) || (kind === "tab" && !str(json.tab))) return no(400, "bad_request", "A squad is named by its workspace and tab, a base by its workspace.");
		if (busy) return no(429, "busy", "Another close or pop is still on its way.");
		busy = true;
		try {
			return await batch(json.workspace, kind === "tab" ? (json.tab as string) : undefined);
		} catch (error) {
			return no(502, "close_failed", (error as Error).message);
		} finally {
			busy = false;
		}
	};
}
