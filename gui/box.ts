import type { LinkSummary } from "../src/link/holder.ts";
import type { Base } from "../src/net.ts";
import { endedKind, type RunRow, runRows, safeKey } from "./boxread.ts";
import type { AllyCard } from "./linkmodel.ts";
import { m } from "./sentences.ts";
import { aim, ago, allyEl, fillAlly, html, roleName, sync, text } from "./render.ts";

// A remote (operate) base's own parts on the map (docs/specs/2026-11-07-link-operate.md §8): the device badge and team, the greyed state with when the box was last seen, the one line an ended base gives, "Earlier runs" from the box's ledger (api/transcripts), and the
// box's ally card folded under it. The base's units, tabs and tower are drawn by render.ts as for a local base; what the box lets through (`box.can`) decides which ⋯ entries they get (boxmodel.ts). Every word here is the box's: it only ever becomes text, and the only links
// are routes the page builds from the controller's own `x<hex>` keys.

/** Reads a page of finished runs (`transcripts?base=…`); the live page reads `api/<path>`, the demo answers its own. */
type Load = (path: string) => Promise<unknown>;
let load: Load = (path) => fetch(`api/${path}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
export const useRuns = (reader: Load) => void (load = reader);

const REFRESH_MS = 10_000, RETRY_MS = 30_000;
interface Runs { rows: RunRow[]; base?: Base; before?: string; sig?: string; at: number; busy: boolean; failed: boolean }
const runs = new WeakMap<HTMLElement, Runs>();
const sigOf = (b: Base) => {
	const keys: string[] = [], walk = (us: { key: string; subs: { key: string; subs: never[] }[] }[]) => us.forEach((u) => (keys.push(u.key), walk(u.subs as never)));
	walk([...(b.tower?.subs ?? []), ...b.tabs.flatMap((t) => t.units), ...b.outside] as never);
	return keys.sort().join();
};
const rowEl = () => html(`<li class="box-run"><a class="box-open"><span class="name"></span><em class="role"></em><span class="when"><span class="age"></span><span class="post"></span></span></a></li>`);
const age = (el: HTMLElement, since: number) => ((el.dataset.since = String(since)), (el.textContent = ago(since)));

/** The roles of a tower's own runs (src/server/operateroles.ts): an ally run, an event run, and the tower itself. A finished one is the tower's work, not an agent that went away. */
const TOWER_ROLES: readonly string[] = ["ally", "run", "tower"];
function drawList(fold: HTMLElement, b: Base, rows: RunRow[], label: (count: number) => string) {
	fold.hidden = !rows.length;
	if (!rows.length) return;
	text(fold, "summary", label(rows.length));
	sync(fold.querySelector(".box-run-list")!, rows.map((row) => ({ ...row, id: row.key })), rowEl, (li, row) => {
		const hit = li.querySelector<HTMLElement>("a")!;
		aim(hit, { view: "session", ws: b.id, key: row.key }); // the existing read-only comms view, as a tower's earlier run opens
		hit.setAttribute("aria-label", m.box_run_aria({ name: row.name }));
		text(li, ".name", row.name);
		text(li, ".role", roleName(row.role));
		age(li.querySelector<HTMLElement>(".age")!, row.last);
		text(li, ".post", m.link_unit_ago());
	});
}
/**
 * Earlier runs, as two folds: the agents' sessions that ended, and the tower's own runs (an ally run a teammate's message drove, an event run), which come every few seconds on a busy box and are not agents that went away
 * (docs/specs/2026-11-09-agent-kinds.md §12). Both are closed until the boss opens them; Show more pages the one ledger and sits below both.
 */
function drawRuns(el: HTMLElement, b: Base, r: Runs) {
	const live = b.box?.state === "live", mine = live ? r.rows : [], more = el.querySelector<HTMLButtonElement>(".box-more")!;
	drawList(el.querySelector<HTMLElement>(".box-runs")!, b, mine.filter((row) => !TOWER_ROLES.includes(row.role)), (count) => m.box_runs({ count }));
	drawList(el.querySelector<HTMLElement>(".box-truns")!, b, mine.filter((row) => TOWER_ROLES.includes(row.role)), (count) => m.box_tower_runs({ count }));
	more.hidden = !live || !r.before;
	more.textContent = m.box_runs_more();
}
function ask(el: HTMLElement, b: Base, r: Runs, before?: string) {
	if (r.busy) return;
	r.busy = true;
	r.sig = sigOf(b);
	r.at = Date.now();
	load(`transcripts?base=${b.id}${before ? `&before=${encodeURIComponent(before)}` : ""}`).then((reply) => {
		const page = runRows(reply);
		r.failed = false;
		r.rows = before ? [...r.rows, ...page.rows.filter((row) => !r.rows.some((o) => o.key === row.key))] : page.rows;
		r.before = page.before;
	}, () => void (r.failed = true)).finally(() => ((r.busy = false), runs.get(el) === r && drawRuns(el, r.base ?? b, r)));
}
function fillRuns(el: HTMLElement, b: Base) {
	const r = runs.get(el) ?? (runs.set(el, { rows: [], at: 0, busy: false, failed: false }), runs.get(el)!), more = el.querySelector<HTMLButtonElement>(".box-more")!;
	r.base = b;
	more.onclick = () => r.before && ask(el, r.base ?? b, r, r.before);
	if (b.box?.state === "live" && safeKey(b.id)) {
		const stale = Date.now() - r.at >= (r.failed ? RETRY_MS : REFRESH_MS);
		if (!r.busy && (r.at === 0 || (stale && (r.failed || r.sig !== sigOf(b))))) ask(el, b, r);
	}
	drawRuns(el, b, r);
}

/** What the page's clock keeps current: "unreachable · last seen 2m ago". */
function fillSeen(el: HTMLElement, b: Base) {
	const seen = el.querySelector<HTMLElement>(".box-seen")!, x = b.box!, grey = x.state === "unreachable";
	seen.hidden = !grey;
	if (!grey) return;
	text(seen, ".bs-state", m.box_unreachable());
	const some = x.seen !== undefined && Number.isFinite(x.seen);
	seen.querySelector<HTMLElement>(".bs-when")!.hidden = !some;
	if (some) {
		text(seen, ".bs-pre", m.box_seen_pre());
		age(seen.querySelector<HTMLElement>(".age")!, x.seen!);
		text(seen, ".bs-post", m.link_unit_ago());
	}
}

/** The parts of a base card that only a remote base has (render.ts has already set `remote`, `data-box` and `data-can`, which the units read, and hidden what a remote base never has: its Quit menu and + Main, + Member and Stash, decision 9). */
export function fillBox(el: HTMLElement, b: Base, under: AllyCard[] = [], link?: LinkSummary) {
	const x = b.box, ended = x?.state === "ended";
	const q = <T extends HTMLElement = HTMLElement>(s: string) => el.querySelector<T>(s)!;
	q(".box-line").hidden = !x;
	if (x) {
		text(el, ".box-dev", `${x.label} · ${x.short}`);
		text(el, ".box-team", m.box_team({ team: x.team }));
		fillSeen(el, b);
	}
	const line = q(".box-ended");
	line.hidden = !ended;
	line.textContent = ended ? { revoked: m.box_ended_revoked, refused: m.box_ended_refused, other: m.box_ended_other }[endedKind(x.why)]() : "";
	// An ended base is its line alone; a box whose tower is not in scope has no tower line to give.
	q(".title .tstate").closest("p")!.hidden = ended || Boolean(x && !b.tower);
	for (const part of [".tower-subs", ".tower-notices", ".tabs", ".outposts"]) q(part).hidden = ended;
	const fold = q(".box-ally");
	fold.hidden = !x || !under.length;
	if (!fold.hidden) {
		text(fold, "summary", m.box_ally());
		sync(fold.querySelector(".box-ally-in")!, under.map((c) => ({ ...c, id: `ally/${c.id}` })), allyEl, (card, c) => fillAlly(card, c, link));
	}
	fillRuns(el, b);
}
