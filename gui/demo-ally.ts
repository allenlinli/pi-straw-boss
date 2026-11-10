import type { LinkSummary } from "../src/link/holder.ts";

// The demo's states of an unattended device's ally base (`?ally=idle|crashed|trust|held|closing|rerun|stale|long|gone|mate|units|teams|mains|admin|stopping|nostop`, a comma list applies each: `crashed,teams`), for the card of its units (gui/render.ts `fillAlly`): the fixture's own is a unit at work with two monitors,
// and every state is a change to that one. The times are relative to the page's load, so the card's clock reads as it would live.

export const ALLY_SCENES = ["idle", "crashed", "trust", "held", "closing", "rerun", "stale", "long", "gone", "mate", "units", "teams", "mains", "admin", "stopping", "nostop"] as const;
export type AllyScene = (typeof ALLY_SCENES)[number];
export const isAllyScene = (s: string | null): s is AllyScene => ALLY_SCENES.includes(s as AllyScene);

const LONG = `## Staging deploy: v1.2

Deployed **v1.2** to staging at 12:04. What changed since the last report:

- Migration \`0042\` applied (adds \`ledger.rounding_mode\`), no rollback needed
- Smoke tests green: 48 of 48, the credit-note case included
- The refund path still rounds half-cents down; a regression test is in the branch

\`\`\`
$ npm run smoke -- --env staging
ok  ledger/rounding   (212 ms)
ok  ledger/credit     (187 ms)
\`\`\`

Next: waiting for the review of the ledger fix. Nothing else is queued, and no question is open. If the review asks for changes I will take them on the same branch and run the smoke tests again before I report.`;

/** Turns the demo's link summary into the scene `name` (`?ally=`; anything else: the unit at work as the fixture has it, with its clock set to now; it has the fixture's ally base `t/d1/Harbor API` and its unit-status). `later` changes the summary after a while and sends it (the `rerun` scene needs the page to see the unit run first). `gone` is also the card of an unattended box that reports no units (its summary line); `mate` adds a teammate's own computer beside it, which lists its mains. `teams` goes last and puts every device of the demo's team in a second team too (`agent-tower-team`): one card each, naming both teams (gui/linkmodel.ts `mergeAllies`), the second team reporting a different set of units (a card with no workspace lists the union; with `units`, Quarry Tools is the first team's alone and Night Builds the second's). */
export function allyDemo(link: LinkSummary, name: string | null, now = Date.now(), later: (ms: number, change: (link: LinkSummary) => void) => void = () => {}): void {
	const scenes = new Set((name ?? "").split(",").filter(isAllyScene)), scene = (x: AllyScene) => scenes.has(x);
	const d1 = link.units[0]!, unit = d1.units[0]!;
	d1.at = now - 40_000;
	for (const a of link.alerts) if (a.kind === "notice") a.data.at = now - 4 * 60_000;
	if (scene("idle")) (Object.assign(unit, { state: "standing", monitors: [], report: "Nothing queued.\nThe ledger fix is merged and staging is on v1.2." }), link.alerts.forEach((a) => a.kind === "notice" && (a.data.at = now - 3 * 3600_000))); // the fixture's old crash notice is three hours old: it says nothing of the unit now
	if (scene("crashed")) Object.assign(unit, { state: "standing", monitors: [], report: "Applying migration 0042 on staging." });
	if (scene("crashed")) link.alerts.find((a) => a.kind === "notice")!.data.text = "An ally run crashed: pi exited without tower_done (exit 1). The last output was: Error: connect ECONNREFUSED 10.0.2.7:5432 while applying migration 0042";
	if (scene("trust")) (Object.assign(unit, { state: "standing", monitors: [], report: "" }), Object.assign(link.alerts.find((a) => a.kind === "notice")!.data, { what: "trust-unanswered", text: "An ally run crashed: No trust decision for /work/harbor-api after 10 minutes; the run was ended" }));
	if (scene("held")) (Object.assign(unit, { state: "held", monitors: [], report: "Three runs in 10 minutes ended in a crash; the tower stopped waking this unit." }), link.alerts.find((a) => a.kind === "notice")!.data.at = now - 6 * 60_000);
	if (scene("closing")) (Object.assign(unit, { state: "closing", report: "Handing over: the last report is written." }), link.alerts.forEach((a) => a.kind === "notice" && (a.data.at = now - 3 * 3600_000)));
	if (scene("rerun")) {
		// A crash ten minutes ago, the unit running now; a few seconds on it stands by again, and the old notice no longer says it crashed.
		Object.assign(unit, { state: "running", report: "Re-ran the migration on staging: applied." });
		link.alerts.find((a) => a.kind === "notice")!.data.at = now - 10 * 60_000;
		later(6_000, (l) => Object.assign(l.units[0]!.units[0]!, { state: "standing", monitors: [], report: "Re-ran the migration on staging: applied, smoke tests green." }));
	}
	if (scene("stale")) (Object.assign(d1, { at: now - 8 * 60_000, stale: true as const }), Object.assign(unit, { state: "running" }));
	if (scene("long")) unit.report = LONG;
	if (scene("gone")) link.units = [];
	if (scene("mate")) {
		link.units = [];
		link.allies.push({ id: "t/d3", team: "t", teamName: "moldplan", device: "d3", short: "c40d9e", label: "Mei's Mac", online: true, workspace: null, tower: "working", tabs: [{ label: "main \u00b7 docs", state: "working" }, { label: "worker \u00b7 scout", state: "idle" }] });
	}
	if (scene("units")) {
		link.allies.push({ id: "t/d2", team: "t", teamName: "moldplan", device: "d2", short: "b71e04", label: "build-mac", online: true, unattended: true, workspace: null, tower: "unknown", tabs: [{ label: "tower", state: "idle" }] });
		link.units.push({ team: "t", device: "d2", at: now - 15_000, units: [
			{ unit: "Quarry Tools", state: "running", monitors: ["cargo watch -x test"], report: "Running the nightly suite: 212 of 480 done." },
			{ unit: "Lighthouse Web", state: "standing", monitors: [], report: "Idle since the 14:10 build; nothing queued." },
			{ unit: "Orchard Data", state: "standing", monitors: [], report: "" },
		] });
	}
	// The Mains fold of the unit (docs/specs/2026-11-07-link-remote-stop.md §6): `mains` is a dispatcher's own two mains with Stop; `admin` adds teammates' mains, named by their dispatcher; `stopping` has one stop pending; `nostop` is a box whose build takes no stop request (the rows, no buttons).
	if (scene("mains") || scene("admin") || scene("stopping") || scene("nostop")) {
		// Each main carries the kind word the box read from its pane (`unit-status.kind`, docs/specs/2026-11-09-agent-kinds.md §12): a coordinator, a standing main, an integrator, and a train; `nostop` is a box of before, which sends none.
		const own = (handle: string, name: string, state: string, kind?: string) => ({ handle, unit: unit.unit, name, state, by: "d-me", stopping: false, ...(kind && !scene("nostop") ? { kind } : {}) });
		const theirs = (handle: string, name: string, state: string, by: string, kind?: string) => ({ handle, unit: unit.unit, name, state, by, stopping: false, ...(kind && !scene("nostop") ? { kind } : {}) });
		d1.mains = [own("0a1b2c3d4e5f6a7b", "docs · ledger fix", "working", "coordinator"), own("1b2c3d4e5f6a7b8c", "docs · release notes", "idle", "standing"), ...(scene("admin") ? [theirs("2c3d4e5f6a7b8c9d", "api · retries", "working", "d-mei", "integrator"), theirs("3d4e5f6a7b8c9d0e", "api · schema", "idle", "d-mei", "train")] : [])];
		if (scene("stopping")) d1.mains[0]!.stopping = true;
		d1.dispatchers = { "d-me": { label: "Boss Mac", self: true as const }, "d-mei": { label: "Mei's Mac" } };
		if (!scene("nostop")) d1.canStop = true;
	}
	if (scene("teams")) {
		const second = { team: "t2", teamName: "agent-tower-team" };
		link.allies.push(...link.allies.filter((a) => a.team === "t").map((a) => ({ ...structuredClone(a), ...second, id: a.id.replace(/^t\//, "t2/") })));
		link.units.push(...link.units.filter((u) => u.team === "t").map((u) => ({ ...structuredClone(u), team: "t2", units: [...(u.units.length > 1 ? u.units.slice(1) : u.units), { unit: "Night Builds", state: "standing", monitors: [], report: "Nothing queued until 02:00." }].map((x) => structuredClone(x)) }))); // a team reports only the units of its own project: the second team's set differs, and a card lists both
		link.alerts.push(...link.alerts.filter((a) => a.kind === "notice" && a.team === "t").map((a) => ({ ...structuredClone(a), ...second, id: `${a.id}/t2` })));
	}
}
