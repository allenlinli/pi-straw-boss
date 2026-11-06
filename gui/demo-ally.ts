import type { LinkSummary } from "../src/link/holder.ts";

// The demo's states of an unattended device's ally base (`?ally=idle|crashed|stale|long|gone|units`), for the card of its units (gui/render.ts `fillAlly`): the fixture's own is a unit at work with two monitors,
// and every state is a change to that one. The times are relative to the page's load, so the card's clock reads as it would live.

export const ALLY_SCENES = ["idle", "crashed", "stale", "long", "gone", "units"] as const;
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

/** Turns the demo's link summary into the scene `name` (`?ally=`; anything else: the unit at work as the fixture has it, with its clock set to now; it has the fixture's ally base `t/d1/Harbor API` and its unit-status). */
export function allyDemo(link: LinkSummary, name: string | null, now = Date.now()): void {
	const scene = isAllyScene(name) ? name : undefined;
	const d1 = link.units[0]!, unit = d1.units[0]!;
	d1.at = now - 40_000;
	for (const a of link.alerts) if (a.kind === "notice") a.data.at = now - 4 * 60_000;
	if (scene === "idle") (Object.assign(unit, { state: "standing", monitors: [], report: "Nothing queued.\nThe ledger fix is merged and staging is on v1.2." }), link.alerts.forEach((a) => a.kind === "notice" && (a.data.at = now - 3 * 3600_000))); // the fixture's old crash notice is three hours old: it says nothing of the unit now
	if (scene === "crashed") Object.assign(unit, { state: "standing", monitors: [], report: "Applying migration 0042 on staging." });
	if (scene === "crashed") link.alerts.find((a) => a.kind === "notice")!.data.text = "An ally run crashed: pi exited without tower_done (exit 1). The last output was: Error: connect ECONNREFUSED 10.0.2.7:5432 while applying migration 0042";
	if (scene === "stale") (Object.assign(d1, { at: now - 8 * 60_000, stale: true as const }), Object.assign(unit, { state: "running" }));
	if (scene === "long") unit.report = LONG;
	if (scene === "gone") link.units = [];
	if (scene === "units") {
		link.allies.push({ id: "t/d2", team: "t", teamName: "moldplan", device: "d2", short: "b71e04", label: "build-mac", online: true, workspace: null, tower: "unknown", tabs: [{ label: "tower", state: "idle" }] });
		link.units.push({ team: "t", device: "d2", at: now - 15_000, units: [
			{ unit: "Quarry Tools", state: "running", monitors: ["cargo watch -x test"], report: "Running the nightly suite: 212 of 480 done." },
			{ unit: "Lighthouse Web", state: "standing", monitors: [], report: "Idle since the 14:10 build; nothing queued." },
			{ unit: "Orchard Data", state: "standing", monitors: [], report: "" },
		] });
	}
}
