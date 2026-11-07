import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { callControl } from "../src/server/socket.ts";
import type { Towers } from "../src/server/towers.ts";
import { bundle, noLink, noTailscale } from "./gui-fakes.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// boss_open_main with role "train" in a tower run of the sb server (docs/specs/2026-11-07-train-workers.md §3.3, task 3): a local run's role reaches the opener, an ally run opens no train.

let world: TowerWorld;
let towers: Towers | undefined;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	towers = undefined;
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start({
		gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200, restart: () => ({ status: 202, body: { restarting: true } }) },
		towers: { ...world.options().options.towers, expose: (t: Towers) => (towers = t) },
	});
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const localToken = async (s: Running) => {
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m0", content: { text: "go" } });
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	return String(got!.token);
};
const tool = (s: Running, token: unknown, name: string, args: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args });

test("a local run's role reaches the opener: a role other than train is refused by it, a train without a manifest is refused with what is missing", async () => {
	const s = await started();
	const token = await localToken(s);
	world.sessions = [{ id: "main-1", name: "docs-main" }];
	const bad = await tool(s, token, "boss_open_main", { request: "x", sender: "docs-main", role: "main" });
	assert.equal(bad.ok, false);
	assert.match(String(bad.error), /role must be "train"/);
	const none = await tool(s, token, "boss_open_main", { request: "merge the cars", sender: "docs-main", role: "train" });
	assert.equal(none.ok, false);
	assert.match(String(none.error), /missing project and code/);
});

test("an ally run opens no train, before the gate asks the boss anything", async () => {
	const s = await started();
	const token = towers!.runs.mint("wA", { kind: "ally", device: "d1", level: "dispatch", team: "team-1" });
	for (const extra of [{}, { toolCallId: "tc-1" }]) {
		const got = await ask(s, { cmd: "run-tool", token, tool: "boss_open_main", args: { request: "project: a\ncode: 2026-11-06-m", sender: "x", role: "train" }, ...extra });
		assert.equal(got.ok, false);
		assert.match(String(got.error), /An ally run opens no train/);
	}
});
