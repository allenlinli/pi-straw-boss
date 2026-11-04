import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";

// `herdr agent start` is admitted a few ms after the tower prompt's process exits, while zsh does not read yet, and the command's Enter is lost (the pane sits on an unexecuted line until Herdr's 30 s timeout).
// The prompt saying it is gone is not its process gone: a run's start waits for the pid to exit, then a settle.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.herdr.shellPids = true;
});
afterEach(() => world.close());

const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");
const agentStarts = () => world.herdr.calls.filter((a) => a[0] === "agent" && a[1] === "start");
const msg = { id: "m1", content: { text: "hi" } };
const PID = 6200;

/** A prompt that polls until told to leave, announces it (`prompt-gone`) at once, and whose process stays alive (`world.live`) until the test ends it. */
async function setup() {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => world.herdr.typed.length === 1, "the first typing");
	const pane = String(ensured.pane);
	world.live.add(PID);
	world.herdr.pane(pane).processes = [{ name: "node", argv0: "node", pid: PID, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` }];
	let gone = false;
	const timer = setInterval(() => void (async () => {
		if (gone) return;
		const r = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: PID }).catch(() => undefined);
		if (r?.leave) {
			gone = true;
			world.herdr.pane(pane).processes = [];
			await ask(s, { cmd: "prompt-gone", workspace: "wA", pid: PID }).catch(() => {});
		}
	})(), 20);
	return { s, pane, stop: () => clearInterval(timer) };
}

test("a run's start waits for the prompt's process to exit, not for the prompt to say it is leaving, and then for the settle", async () => {
	world.standingTimers = { exitMs: 2000, settleMs: 200 };
	const { pane, stop } = await setup();
	try {
		world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, msg);
		await until(() => /run-start/.test(logText()), "the run to begin");
		await until(() => !world.herdr.pane(pane).processes?.length, "the prompt to announce it leaves");
		await new Promise((r) => setTimeout(r, 300));
		assert.deepEqual(agentStarts(), [], "the prompt's pid is still alive: no start");
		const exitedAt = Date.now();
		world.live.delete(PID);
		await until(() => agentStarts().length === 1, "the start after the exit");
		assert.ok(Date.now() - exitedAt >= 150, `the settle was honoured (${Date.now() - exitedAt} ms)`);
	} finally {
		stop();
	}
});

test("a prompt that does not exit within the bound is named in the log, and the run goes on", async () => {
	world.standingTimers = { exitMs: 150, settleMs: 10 };
	const { stop } = await setup();
	try {
		world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, msg);
		await until(() => /run-yield[^\n]*did not exit/.test(logText()), "the yield error");
	} finally {
		stop();
	}
});

test("the crash note starts with Herdr's code and stderr, ahead of the command line", async () => {
	const { stop } = await setup();
	try {
		world.live.delete(PID);
		world.herdr.onAgentStart = () => {
			throw Object.assign(new Error("herdr agent start --pane p --timeout 30000 failed: timeout: timed out waiting for agent startup"), { stderr: '{"error":{"code":"timeout","message":"timed out waiting for agent startup"}}' });
		};
		world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, msg);
		await until(() => /run-end[^\n]*crashed/.test(logText()), "the crash");
		assert.match(logText(), /error code=run-start text="[0-9a-f]+: herdr timeout: \{/);
		assert.match(logText(), /run-end[^\n]*detail="herdr timeout: /);
	} finally {
		stop();
	}
});
