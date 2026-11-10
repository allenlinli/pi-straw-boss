import type { Net } from "../src/net.ts";
import type { BackReport } from "./autoback.ts";
import { cardWaits } from "./demo-waits.ts";

// The demo's auto mode (`?auto=on|back`, docs/specs/2026-11-09-auto-mode.md, section 7): `on` is auto mode running since the night before, three cards parked on the first tower (an action, a choice, a secret whose start button is hidden);
// `back` is the morning after: it is off, the same cards are open waits, and the page opens the return panel on load (the list is `auto/report`, answered by the fixture). The chip's taps are answered here too (`api/auto`), so a visitor can walk
// off -> on -> off in any state. Nothing else of the demo is touched.

const HOUR = 3_600_000, IDS = ["W1", "W3", "W4"];
const isState = (v: string | null): v is "on" | "back" => v === "on" || v === "back";
const tower = (net: Net) => net.bases[0]?.tower?.service?.memory;

/** The return list the morning after: the parked cards, what auto mode refused and cancelled, a tower's own answer, a dialog left waiting. */
const reportOf = (net: Net, now: number): BackReport => {
	const base = net.bases[0]!, waits = tower(net)?.bossWaits ?? [];
	return {
		v: 1, since: new Date(now - 8 * HOUR).toISOString(), until: new Date(now - 60_000).toISOString(), on: "gui: the page", off: "gui: the page",
		parked: [...waits.map((w) => ({ workspace: base.id, tower: base.label, id: w.id, text: w.text.slice(0, 160), type: w.card?.type ?? "legacy", ...(w.card?.from ? { from: w.card.from.name } : {}), at: w.at })), { workspace: base.id, tower: base.label, id: "W12", text: "Answered from the phone in the morning", type: "action", at: new Date(now - 7 * HOUR).toISOString() }],
		lines: [
			{ session: "ops-main", tool: "robot_hand", kind: "cancelled", count: 2, first: new Date(now - 7 * HOUR).toISOString(), gist: "Deploy needs your sudo password" },
			{ session: "billing-main", tool: "secret_drop", kind: "refused", count: 1, first: new Date(now - 6 * HOUR).toISOString(), gist: "(withheld)" },
			{ session: "checkout-main", tool: "ask_user_question", kind: "cancelled", count: 1, first: new Date(now - 5 * HOUR).toISOString(), gist: "Which branch to cut the release from?" },
		],
		decided: [{ at: new Date(now - 4 * HOUR).toISOString(), run: "r4", to: "ops-main", gist: "Go on with the staging check; the deploy waits for the boss", basis: "D3" }],
		stillWaiting: [{ session: "old-pi", tool: "robot_hand", kind: "still-waiting", count: 1, first: new Date(now - 7 * HOUR).toISOString(), gist: "A select with no way to cancel" }],
		boxes: [{ box: "ci-box", gist: "Deploy to staging?" }], foreign: [],
	};
};

/** Sets the demo net into the state `param` names and returns what the stand-in of the routes holds; `undefined` for any other value. */
export function autoDemo(net: Net, param: string | null, now: number): { report?: BackReport } | undefined {
	if (!isState(param)) return undefined;
	const memory = tower(net);
	if (memory) {
		const picked = cardWaits(now).filter((w) => IDS.includes(w.id)).map((w, i) => ({ ...w, at: new Date(now - (6 + i) * HOUR).toISOString(), ...(param === "on" ? { parked: true as const } : {}) }));
		Object.assign(memory, { bossWaits: picked, waits: picked.length });
	}
	if (param === "on") {
		net.auto = { on: true, since: new Date(now - 90 * 60_000).toISOString() };
		return {};
	}
	delete net.auto;
	return { report: reportOf(net, now) };
}

/** The chip's taps: on parks the open cards and says since when; off unparks them and builds the list. */
export function autoSwitch(net: Net, on: boolean, now: number): { status: number; body: Record<string, unknown>; report?: BackReport } {
	const waits = tower(net)?.bossWaits ?? [];
	if (on) {
		for (const w of waits) w.parked = true;
		net.auto = { on: true, since: new Date(now).toISOString() };
		return { status: 200, body: { on: true, since: net.auto.since } };
	}
	const report = reportOf(net, now);
	for (const w of waits) delete w.parked;
	delete net.auto;
	return { status: 200, body: { on: false }, report };
}

/**
 * `?auto=on|back` and the stand-in of the routes the chip and the panel call (`api/auto`, `api/auto/report`), installed on the page's fetch in every state, so a visitor can walk off, on, off. `held` is the net the fixture holds now (its
 * `net` is replaced by a clone at each change); `change` tells the open streams.
 */
export function installAutoDemo(param: string | null, now: number, held: { net(): Net; change(): void }): void {
	let state = autoDemo(held.net(), param, now) ?? {};
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url, path = /api\/auto(\/report)?$/.exec(url);
		if (!path) return real(input, init);
		const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		if (path[1]) return json({ report: state.report ?? null });
		const done = autoSwitch(held.net(), (JSON.parse(String(init?.body)) as { on: boolean }).on, Date.now());
		if (done.report) state = { report: done.report };
		held.change();
		return json(done.body);
	};
}
