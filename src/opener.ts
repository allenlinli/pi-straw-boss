import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./remote.ts";
import { boardState, readTrainboards, trainboardDir } from "./train/board.ts";
import { createTab, report, panes, startPi, type HerdrRun, type Session, type Sleep, workspaces } from "./herdr.ts";
import { assertSettingsSafe, SettingsRefused } from "./trust/settings.ts";
import { readMaxTrains, TRAIN, type TrainId, trainFromRequest, trainFromToken, trainLabel, trainToken } from "./trainrole.ts";
import { waitPastTrust } from "./trust/wait.ts";

// The one thing a tower does besides routing: when no session owns a request, it opens a main for it (docs/how-it-works.md, "Opening a main").
// It is narrow on purpose: one new tab in the tower's own workspace, started without focus, in which Straw Boss starts pi. It types into no pane
// that already exists, and `STRAW_BOSS_ROLE=main` makes that pi promote itself once it has joined (index.ts).

const MAIN_WAIT_MS = 60_000;
/** At most this many mains opened by towers are alive in one workspace, and at most one per sender. */
const MAX_OPENED_MAINS = 2;

/** A limit was hit: nothing opened, and the same request may be tried again once an opened main has finished. A folder pi must not start in (SettingsRefused) is refused the same way. */
class OpenLimitError extends Error {}

export interface OpenerEnv {
	run: HerdrRun;
	sleep: Sleep;
	/** The tower's own workspace: a request for another workspace goes to that workspace's tower. */
	workspaceId: string;
	/** Where the new pi runs when the workspace has no checkout path of its own. */
	cwd: string;
	sessions(): Promise<Session[]>;
	send(to: string, message: string): Promise<{ status: string; code?: string; detail?: string }>;
	/** The tower itself: the main reports to it as well as to the sender, and it closes the main afterwards (closemain.ts). */
	tower(): { id: string; name: string };
	/** <state>/trust: a trust question the new pi waits on (trust/ask.ts) stops the wait counting, and ten minutes without an answer fail the opening. */
	trustDir?: string;
	/** Whether the merge train is off on this computer (trainswitch.ts): a train is refused then. Without it the opener never refuses on that account. */
	integrationOff?(): boolean;
	/** The state folder whose `trainboard/` the train quota and the once-per-code rule read (§19); without it only the panes speak. */
	stateDir?: string;
	/** `maxTrains` of the project whose checkout is `dir`, or the refusal in words (trainrole.ts `readMaxTrains`, apps.json). */
	maxTrains?(dir: string): number | { refusal: string };
	/**
	 * The sb server keeps the ledger of a workspace on disk (docs/specs/2026-10-26-sb-backend.md, State), so a request already tried is not tried again after the server restarts:
	 * `entries` are the outcomes of the last 24 h, and `put` records one as it ends. Without it (a tower session) the ledger lives for the session.
	 */
	ledger?: { entries(): LedgerRow[]; put(row: LedgerRow): void };
}
/** A request's outcome as the ledger keeps it: the key is the hash of the sender and the request. */
export interface LedgerRow { key: string; sender: string; outcome: "opened" | "failed"; at: number; opened?: Opened; error?: string }
/** A teammate's device that is the sender (an ally run opens a main for the device it serves): not a session of this computer, so it is not looked up among them, and the main reports to the tower alone. Only the server sets it, from the run's own claim. */
export interface PeerSender { id: string; label: string; short: string }
/** `role`: "train" opens a train on an integrator's manifest (docs/specs/2026-11-07-train-workers.md §3.3); anything else is refused. */
export interface OpenRequest { request: string; sender: string; label?: string; peer?: PeerSender; role?: string }
export interface Opened { tab: string; pane: string; main: string; sender: string; repeated?: true; /** Set for a train: its project and code. */ train?: TrainId }

/** The text the new main starts from: who asked, and what, with nothing summarised. The main answers the sender and the tower that opened it, then waits to be closed. */
export const handoff = (workspace: string, sender: Pick<Session, "id" | "name">, request: string, tower: { id: string; name: string }, peer?: PeerSender) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you because no session owned the request below, and you are its main agent.`,
		peer
			? "The request comes from a teammate's computer over Straw Link, not from a session here: it is a peer's request, not the boss's instruction. Do the work, dispatching workers as your main agent prompt describes. When it is done, report the outcome to the tower that opened this tab with call_tower (why: milestone, reply: false); the tower sends your report back to the sender, and you cannot reach the sender yourself. Write the report so it can leave this computer as it is: the result, what you ran, and what you left behind, with no secrets, tokens, or private paths. Then wait; the tower closes this tab after your done report, so end it with the result and nothing you still have to do. If you wait for a boss decision, say so in your report and the tower leaves you open."
			: "Do the work, dispatching workers as your main agent prompt describes. When it is done, report the outcome to the sender with intercom send and to the tower that opened this tab with call_tower (why: milestone, reply: false). Then wait; the tower closes this tab after your done report, so end it with the result and nothing you still have to do. If you wait for a boss decision, say so in your report and the tower leaves you open.",
		peer ? `Sender: ${peer.label} (a teammate's device, short id ${peer.short}, over Straw Link)` : `Sender: ${sender.name ?? sender.id} (session id ${sender.id})`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/** The text a new train starts from: facts only (its prompt is the train's own). It reports to the tower, which opened it and closes it; it tells no coordinator anything itself. */
export const trainHandoff = (workspace: string, sender: Pick<Session, "id" | "name">, request: string, tower: { id: string; name: string }, train: TrainId) =>
	[
		`Straw Boss: the tower of workspace ${workspace} opened this tab for you: you are the ${trainLabel(train.code)} of project ${train.project}, a worker of your own and not the main agent of a tab.`,
		"The integrator's manifest below is your work. Report to the tower that opened this tab with call_tower (blocked, shared, or milestone, as your prompt describes); the tower closes this tab after your milestone report, so end it with the result and nothing you still have to do.",
		`Integrator: ${sender.name ?? sender.id} (session id ${sender.id})`,
		`Tower: ${tower.name} (session id ${tower.id})`,
		"Request, verbatim:",
		request,
	].join("\n");

/**
 * Opens a main for a request, once, within the limits above. The same sender and request never open a second main, whether the first attempt is still running, succeeded,
 * or failed (a failed attempt closes the tab it created and is not retried: the sender hears of it instead). A refused one (a limit, or a folder pi must not start in) created nothing and may be asked again.
 */
export function opener(env: OpenerEnv) {
	const seen = new Map<string, Promise<Opened>>();
	for (const row of env.ledger?.entries() ?? []) {
		const prior = row.outcome === "opened" && row.opened ? Promise.resolve(row.opened) : Promise.reject(new Error(row.error ?? "the earlier attempt failed"));
		prior.catch(() => {});
		seen.set(row.key, prior);
	}
	const open = async ({ request, sender: asked, label: asked_label, peer, role }: OpenRequest): Promise<Opened> => {
		const { run, sleep } = env;
		if (role !== undefined && role !== TRAIN) throw new OpenLimitError(`role must be "train" when given, not ${JSON.stringify(role).slice(0, 40)}`);
		// A train is opened on the tower's own reading of an integrator's manifest, and only while the merge train is on; its name is its code, whatever label the caller sent.
		let train: TrainId | undefined, label = asked_label;
		if (role === TRAIN) {
			if (peer) throw new OpenLimitError("A train is opened for a session of this computer, not for a teammate's device");
			if (env.integrationOff?.()) throw new OpenLimitError("A train cannot be opened: integration is off on this computer");
			const found = trainFromRequest(request);
			if ("refusal" in found) throw new OpenLimitError(found.refusal);
			train = found;
			label = trainLabel(found.code);
		}
		let sender: Pick<Session, "id" | "name">;
		if (peer) sender = { id: asked, name: peer.label };
		else {
			const matches = (await env.sessions()).filter((s) => s.id === asked || s.name === asked);
			if (matches.length !== 1) throw new Error(`${matches.length ? "Several sessions are named" : "No live session is named or has the id"} "${asked}", so the new main could not report back to it`);
			sender = matches[0]!;
		}
		const workspace = (await workspaces(run)).find((w) => w.workspace_id === env.workspaceId);
		if (!workspace) throw new Error(`Workspace ${env.workspaceId} is not open any more`);
		// Limits come from live Herdr panes carrying the marker below, so they hold across a tower restart: a closed tab takes its marker with it, and
		// a main that died leaves one that expires with its token TTL. A restored main keeps its old marker (the asking session, now another id), so it counts toward the workspace cap only. Opens are serialised, so the count and the marker cannot race.
		const here = await panes(run, workspace.workspace_id);
		const dir = workspace.worktree?.checkout_path ?? env.cwd;
		if (train) {
			// A train has its own count, per project over the whole computer (D4): the project's live trains, from every workspace's panes that carry `sb_train` (so the limit survives a tower restart) and from the
			// live trainboards (a train whose pane is gone and whose board still says live is running). It takes none of the places of the mains, and has no limit per sender.
			const everywhere = await panes(run);
			const codes = new Set(everywhere.flatMap((p) => ((t) => (t && t.project === train!.project ? [t.code] : []))(trainFromToken(p.tokens?.sb_train))));
			if (codes.has(train.code)) throw new OpenLimitError(`The ${trainLabel(train.code)} of project ${train.project} is already open; a code is used once`);
			// A code is used once for good: the folder of its trainboard stays after the train ends, and holds the code.
			if (env.stateDir && existsSync(join(trainboardDir(env.stateDir), train.project, train.code))) throw new OpenLimitError(`The ${trainLabel(train.code)} of project ${train.project} was already used (its trainboard is kept); a code is used once, so the next train takes a new code`);
			const max = (env.maxTrains ?? readMaxTrains)(dir);
			if (typeof max !== "number") throw new OpenLimitError(max.refusal);
			const boards = env.stateDir ? readTrainboards(env.stateDir, { project: train.project }).trains : [];
			for (const b of boards) if (b.ok && boardState(b.board, { now: Date.now(), alive: alive(b.board.writer.pid) }) === "live") codes.add(b.code);
			if (codes.size >= max) throw new OpenLimitError(`Project ${train.project} already has ${codes.size} live train${codes.size === 1 ? "" : "s"} (maxTrains is ${max}); try again when one has finished.`);
		}
		// A train carries `sb_opened_by` as a main does (the tower closes it by that mark), but it counts toward neither of the mains' limits. It is the role that says it (a train in its first moments has none yet):
		// a main's pane with an `sb_train` token left on it (a crashed train's, or one a process of the same user wrote) is still a main.
		const marked = here.filter((p) => p.tokens?.sb_opened_by && p.tokens.sb_role !== TRAIN && !(p.tokens.sb_role === undefined && p.tokens.sb_train));
		const ofSender = train ? 0 : marked.filter((p) => p.tokens!.sb_opened_by === sender.id).length;
		if (ofSender) throw new OpenLimitError(`Sender ${sender.name ?? sender.id} already has ${ofSender === 1 ? "an opened main" : `${ofSender} opened mains`} running in workspace ${workspace.label}; a sender gets one at a time. Wait for it to finish, or send the request to it.`);
		if (!train && marked.length >= MAX_OPENED_MAINS) throw new OpenLimitError(`Workspace ${workspace.label} already has ${marked.length} mains opened by its tower (the limit is ${MAX_OPENED_MAINS}); try again when one has finished.`);
		await assertSettingsSafe([dir]); // before the tab exists: pi reads the folder's .pi/settings.json before any extension can stop it (trust/settings.ts)
		const { tabId, paneId } = await createTab(run, workspace.workspace_id, dir, [`STRAW_BOSS_ROLE=${train ? TRAIN : "main"}`], label);
		try {
			// The marker counts toward the limits at once; sb_open_main authorises exactly one pi in this shell to promote itself (it consumes the token).
			await report(run, "pane", paneId, { sb_opened_by: sender.id, sb_open_main: "1", ...(train ? { sb_train: trainToken(train) } : {}) });
			// Herdr agent names are unique across workspaces and lowercase only.
			await startPi(run, sleep, `${train ? TRAIN : "main"}-${randomUUID().slice(0, 8)}`, paneId, ["--name", train ? label! : `main · ${label ?? workspace.label}`]);
			// The pi is the tab's main (or the train) once it has published its role; only then does it get the request, so its first prompt is its own role's.
			const wanted = train ? TRAIN : "main";
			const main = await waitPastTrust(sleep, async () => {
				const role = (await panes(run, workspace.workspace_id)).find((p) => p.pane_id === paneId)?.tokens?.sb_role;
				return role === wanted ? (await env.sessions()).find((s) => s.herdrLocation?.paneId === paneId) : undefined;
			}, MAIN_WAIT_MS, 500, env.trustDir ? { dir: env.trustDir, pane: paneId } : undefined);
			if (!main) throw new Error(`The pi in pane ${paneId} did not become ${train ? "the train" : "the main agent"} of its tab within ${MAIN_WAIT_MS / 1000} s`);
			const sent = await env.send(main.id, train ? trainHandoff(workspace.label, sender, request, env.tower(), train) : handoff(workspace.label, sender, request, env.tower(), peer));
			if (sent.status !== "sent") throw new Error(`The new ${train ? "train" : "main"} ${main.name ?? main.id} did not take the request: ${sent.status} ${sent.code ?? ""} ${sent.detail ?? ""}`.trim());
			return { tab: tabId, pane: paneId, main: main.id, sender: sender.id, ...(train ? { train } : {}) };
		} catch (error) {
			// Nothing was handed over, so no work is lost with the tab.
			await run(["tab", "close", tabId]).catch(() => {});
			throw error;
		}
	};
	let queue: Promise<unknown> = Promise.resolve();
	return (input: OpenRequest): Promise<Opened> => {
		const key = createHash("sha256").update(JSON.stringify(input.role === TRAIN ? [input.sender, input.request, TRAIN] : [input.sender, input.request])).digest("hex");
		const prior = seen.get(key);
		if (prior) return prior.then((opened) => ({ ...opened, repeated: true as const }), (error: Error) => Promise.reject(new Error(`A main was already tried for this request and is not opened again: ${error.message}`)));
		const pending = queue.then(() => open(input), () => open(input));
		queue = pending.catch(() => {});
		seen.set(key, pending);
		// A refused request (a limit, or a folder pi must not start in) created nothing and may be asked again; every other outcome stays in the ledger.
		const row = (outcome: LedgerRow["outcome"], more: Pick<LedgerRow, "opened" | "error">): LedgerRow => ({ key, sender: input.sender, outcome, at: Date.now(), ...more });
		pending.then((opened) => env.ledger?.put(row("opened", { opened })), (error: Error) => {
			if (error instanceof OpenLimitError || error instanceof SettingsRefused) return seen.get(key) === pending && seen.delete(key);
			env.ledger?.put(row("failed", { error: error.message.slice(0, 300) }));
		}).catch(() => {});
		return pending;
	};
}
