import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeHerdr } from "./fakes.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { HEAD_LABEL, headTowerOf, isHead, TOWER_LABEL, type Workspace } from "../src/herdr.ts";
import { fileOf, slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { headDir, listServices, readQueue, readService } from "../src/server/towerstore.ts";

// The head service (docs/specs/2026-11-04-head-tower.md, H1; src/server/head.ts): a tower service of its own kind in a Herdr workspace the server makes on first use, with its state in `head/`.
// A fake Herdr and fake pi-intercom clients, as the tower service's tests have (tests/server-towers.test.ts). No run is started: runs, the gate, and forwards are H2.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.env.LANG = "en_US.UTF-8"; // the head workspace's label is by the server's locale: the machine's own must not decide it
	world.setFlag(true);
});
afterEach(() => world.close());

const started = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	return s;
};
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const head = () => world.expose!.head;
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");
const folder = () => join(world.env.PI_CODING_AGENT_DIR!, "straw-boss-head");
const createCalls = () => world.herdr.commands("workspace", "create");
const mode = (path: string) => statSync(path).mode & 0o777;

test("nothing is made before the head is first needed: a server with the tower service on shows no head workspace, no identity, no folder", async () => {
	await started();
	assert.deepEqual(createCalls(), []);
	assert.equal(head().status(), undefined);
	assert.equal(world.client("sb-head"), undefined);
	assert.equal(existsSync(folder()), false);
	assert.equal(existsSync(headDir(world.slot)), false);
});

test("ensure makes the head workspace: its folder, a label by locale, the crown tab, the marks, the token, first place, and the identity sb-head named `head tower` with its own cwd", async () => {
	await started();
	const got = await head().ensure();
	assert.deepEqual(createCalls(), [["workspace", "create", "--cwd", folder(), "--label", "Head tower", "--no-focus"]]);
	assert.equal(got.opened, true);
	assert.equal(got.id, "sb-head");
	assert.equal(got.live, true);
	assert.equal(mode(folder()), 0o700, "an empty folder only the server makes");
	assert.deepEqual(readdirSync(folder()), []);
	// The crown tab, the pane's marks, and the workspace's token.
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === got.tab)?.label, HEAD_LABEL);
	assert.equal(HEAD_LABEL, "\u{f01a5}", "Nerd Font md-crown (checked against Hack Nerd Font's glyph names: U+F01A5 is md-crown, U+F043B md-radio_tower)");
	const pane = world.herdr.pane(got.pane);
	assert.equal(pane.tokens.sb_role, "head");
	assert.equal(pane.tokens.sb_order, "000.0");
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, "sb-head");
	assert.equal(world.herdr.workspace(got.workspace).tokens.tower, undefined, "it is no workspace tower");
	assert.deepEqual(world.herdr.workspaceMoves, [{ workspace_id: got.workspace, insert_index: 0 }], "moved to the first place");
	assert.equal(world.herdr.workspaces[0]!.workspace_id, got.workspace);
	assert.deepEqual(world.herdr.commands("tab", "focus"), [], "without focus");
	const client = world.client("sb-head")!;
	assert.equal(client.registered?.name, "head tower");
	assert.equal(client.registered?.cwd, headDir(world.slot));
	assert.equal(client.registered?.herdrPaneId, got.pane);
	assert.equal(world.client("sb-tower-" + got.workspace.toLowerCase()), undefined, "no tower identity for the head workspace");
	// head/ and its service record.
	assert.equal(mode(headDir(world.slot)), 0o700);
	assert.equal(mode(join(headDir(world.slot), "service.json")), 0o600);
	const record = readService(world.slot, got.workspace)!;
	assert.deepEqual({ workspace: record.workspace, id: record.id, name: record.name, pane: record.pane, tab: record.tab, label: record.label, kind: record.kind }, { workspace: got.workspace, id: "sb-head", name: "head tower", pane: got.pane, tab: got.tab, label: "Head tower", kind: "head" });
	assert.deepEqual(listServices(world.slot), [], "head/ is no workspace tower's folder: the tower listing does not find it");
	assert.equal(head().status()?.state, "live");
});

test("the label is 主塔台 when the server's locale says zh_TW, zh_HK, zh_MO, or zh-Hant (LC_ALL first), else Head tower", async () => {
	world.env.LC_ALL = "zh_TW.UTF-8";
	await started();
	await head().ensure();
	assert.equal(createCalls()[0]![5], "主塔台");
	assert.equal(world.herdr.workspace(world.herdr.workspaces[0]!.workspace_id).label, "主塔台");
});

test("ensure is idempotent: a second ask finds the workspace, and concurrent asks make one", async () => {
	await started();
	const [a, b] = await Promise.all([head().ensure(), head().ensure()]);
	assert.equal(a.workspace, b.workspace);
	const again = await head().ensure();
	assert.deepEqual({ workspace: again.workspace, opened: again.opened, tab: again.tab }, { workspace: a.workspace, opened: false, tab: a.tab });
	assert.equal(createCalls().length, 1);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 1);
});

test("a failed workspace.move is a warning: the head is made all the same", async () => {
	world.herdr.failWorkspaceMove = true;
	await started();
	const got = await head().ensure();
	assert.equal(got.live, true);
	assert.match(logText(), /workspace-move/);
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, "sb-head");
});

test("a workspace of the boss's with the same label is never taken for the head: it keeps its tokens and its tabs, and a head is made beside it", async () => {
	world.herdr.workspaces.unshift({ workspace_id: "wH", label: "Head tower", tokens: {} });
	world.herdr.addTab("wH:t1", HEAD_LABEL, "wH:p1", "shell");
	const s = await started();
	assert.equal(head().status(), undefined, "known by its record and token, never by label");
	const got = await head().ensure();
	assert.notEqual(got.workspace, "wH");
	assert.deepEqual(world.herdr.workspace("wH").tokens, {});
	assert.deepEqual(world.herdr.pane("wH:p1").tokens, {});
	assert.deepEqual(world.herdr.commands("tab", "rename").filter((c) => c[2]?.startsWith("wH:")), []);
	// The same for a restart of the server: only the recorded workspace is adopted.
	await s.handle.shutdown(0);
	const again = await started();
	await until(() => head().status()?.state === "live", "the head to be adopted");
	assert.equal(head().status()?.workspace, got.workspace);
	assert.equal(createCalls().length, 1);
	void again;
});

test("headTowerOf and isHead: the workspace that carries sb_head, nothing else; the first workspace is not it", () => {
	const all: Workspace[] = [{ workspace_id: "w1", label: "Head tower", tokens: {} }, { workspace_id: "w2", label: "Beta", tokens: { sb_head: "sb-head" } }, { workspace_id: "w3", label: "Gamma", tokens: { tower: "sb-tower-w3" } }];
	assert.equal(headTowerOf(all)?.workspace_id, "w2");
	assert.equal(isHead(all[1]!), true);
	assert.equal(isHead(all[0]!), false);
	assert.equal(isHead(all[2]!), false);
	assert.equal(headTowerOf([all[0]!, all[2]!]), undefined, "undefined until the head exists");
	assert.equal(isHead({ workspace_id: "w4", label: "x" }), false, "a workspace with no tokens");
});

test("close ends the service and keeps the conversation, the memory, the asks, and the chapters; the next ensure makes the workspace again in the same head/ and resumes", async () => {
	await started();
	const first = await head().ensure();
	const kept = ["boss-session.json", "chapters.json", "asks.json", "memory.json"];
	for (const name of kept) writeFileSync(join(headDir(world.slot), name), JSON.stringify({ name }));
	const client = world.client("sb-head")!;
	const closed = await head().close();
	assert.deepEqual(closed, { workspace: first.workspace, id: "sb-head" });
	assert.deepEqual(world.herdr.commands("tab", "close"), [["tab", "close", first.tab]]);
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(head().status(), undefined);
	assert.equal(client.connected, false, "the identity left the broker");
	assert.equal(world.herdr.workspace(first.workspace)?.tokens.sb_head, undefined);
	for (const name of kept) assert.deepEqual(JSON.parse(readFileSync(join(headDir(world.slot), name), "utf8")), { name }, `${name} stays`);
	assert.equal((await head().close()), undefined, "closing a head that is not there is nothing");
	// Made again: a new workspace, the same state folder.
	const second = await head().ensure();
	assert.equal(second.opened, true);
	assert.notEqual(second.workspace, first.workspace);
	assert.equal(createCalls().length, 2);
	assert.equal(readService(world.slot, second.workspace)?.workspace, second.workspace);
	for (const name of kept) assert.equal(existsSync(join(headDir(world.slot), name)), true);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 2, "a new connection for the new service");
});

test("a head tab closed in Herdr ends the service as a tower's does: the identity leaves, service.json goes, the files stay", async () => {
	await started();
	const got = await head().ensure();
	writeFileSync(join(headDir(world.slot), "memory.json"), "{}");
	await world.herdr.runFor("x")(["tab", "close", got.tab]);
	world.herdr.emit("tab.closed", "tab_closed", { tab_id: got.tab });
	await until(() => head().status() === undefined, "the service to end");
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(existsSync(join(headDir(world.slot), "memory.json")), true);
	assert.match(logText(), /tower-closed/);
});

test("the head is adopted from head/service.json when the server starts again: the same workspace, no new one, the identity registers again", async () => {
	const s = await started();
	const got = await head().ensure();
	await s.handle.shutdown(0);
	await started();
	await until(() => head().status()?.state === "live", "the head to register again");
	assert.equal(head().status()?.workspace, got.workspace);
	assert.equal(createCalls().length, 1);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 2);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").at(-1)!.registered?.cwd, headDir(world.slot), "the adopted service's folder is head/ too");
	assert.equal(existsSync(join(world.slot.dir, "tower", got.workspace)), false, "and nothing is made under tower/ for it");
	assert.equal((await head().ensure()).opened, false);
});

test("the tokens are written again at the refresh: a lapsed token comes back, on the workspace and the pane", async () => {
	world.refreshMs = 60;
	await started();
	const got = await head().ensure();
	const ws = world.herdr.workspace(got.workspace), pane = world.herdr.pane(got.pane);
	delete ws.tokens.sb_head;
	delete pane.tokens.sb_order;
	await until(() => ws.tokens.sb_head === "sb-head" && pane.tokens.sb_order === "000.0", "the refresh to write the marks again");
});

test("after a Herdr restart the head is seated only in a tab with the crown: the crown tab is marked again, a tab with the radio tower glyph is a stranger's and ends the service", async () => {
	const s = await started();
	const got = await head().ensure();
	world.herdr.restart();
	for (const cb of world.takeovers) cb();
	await until(() => world.herdr.workspace(got.workspace).tokens.sb_head === "sb-head", "the tokens to be written again in the crown tab");
	assert.equal(world.herdr.pane(got.pane).tokens.sb_role, "head");
	// The restored session names the same ids for a tab that is not the head's: the radio tower glyph is a tower's.
	world.herdr.restart();
	world.herdr.tabs.find((t) => t.tab_id === got.tab)!.label = TOWER_LABEL;
	for (const cb of world.takeovers) cb();
	await sleep(250); // the minute a restore needs (150 ms in this world) is over: a tab that is not found now is lost
	world.herdr.emit("workspace.moved", "workspace_moved", {});
	await until(() => head().status() === undefined, "the stranger's tab to end the service");
	assert.deepEqual(world.herdr.pane(got.pane).tokens, {}, "nothing is marked in a pane that is not the head's");
	void s;
});

test("a message to the head identity is refused in H1: nothing is queued, nothing wakes, and the sender gets a receipt that is not `queued`", async () => {
	await started();
	const got = await head().ensure();
	const client = world.client("sb-head")!;
	client.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "do the thing" } } as never);
	await until(() => client.receipts.length === 1, "a receipt");
	assert.notEqual(client.receipts[0]!.status, "queued");
	assert.deepEqual(readQueue(world.slot, got.workspace), []);
	assert.match(logText(), /head-refused/);
	assert.equal(logText().includes("do the thing"), false, "no text in the log");
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
});

test("the head workspace has no workspace tower: ensure-tower for it is refused, and the tower listing does not list the head", async () => {
	const s = await started();
	const got = await head().ensure();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: got.workspace });
	assert.equal(reply.ok, false);
	assert.match(String(reply.error), /head tower/i);
	assert.equal(world.client("sb-tower-" + got.workspace.toLowerCase()), undefined);
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.deepEqual(((await ask(s, { cmd: "status" })).towers as { workspace: string }[]).map((t) => t.workspace), ["wA"]);
	assert.equal(world.expose!.owns("sb-head"), true, "the session id is a service's identity: it is ended, not asked to quit");
});

test("the head's standing pane gets the tower prompt's command typed once, as a tower's does", async () => {
	await started();
	const got = await head().ensure();
	await until(() => world.herdr.typed.some((t) => t.pane === got.pane), "the prompt's command to be typed");
	assert.match(world.herdr.typed.find((t) => t.pane === got.pane)!.text, new RegExp(`^node "[^"]+cli\\.(ts|mjs)" prompt --workspace ${got.workspace} --state-dir "[^"]+"$`));
});

test("a secondary slot's head is sb-head-<slot8>, named `head tower · <slot8>`, with its state in that slot's head/", async () => {
	const second = slotOf(world.stateDir, { ...world.env, HERDR_SOCKET_PATH: join(world.root, "other-herdr.sock") });
	assert.equal(second.primary, false);
	const herdr2 = new FakeHerdr();
	await started();
	const b = await world.start({ slot: second, herdr: { run: herdr2.runFor("none"), events: herdr2.events, api: herdr2.api, watch: () => () => {} } });
	await b.handle.ready;
	// The expose seam is the last server's: the second slot's.
	const got = await world.expose!.head.ensure();
	assert.equal(got.id, `sb-head-${second.slot8}`);
	assert.equal(world.client(got.id)?.registered?.name, `head tower · ${second.slot8}`);
	assert.equal(world.client(got.id)?.registered?.cwd, headDir(second));
	assert.ok(headDir(second).includes("servers"));
	assert.equal(herdr2.workspace(got.workspace).tokens.sb_head, got.id);
	assert.equal(existsSync(headDir(world.slot)), false, "the primary slot has none");
});

test("with towerRuns.enabled off there is no head tower: ensure is refused with the sentence every channel gives, and nothing is made", async () => {
	world.setFlag(false);
	await started();
	await assert.rejects(head().ensure(), /The head tower needs the tower service \(towerRuns\)/);
	assert.deepEqual(createCalls(), []);
	assert.equal(world.clients.length, 1, "only the server's own session");
	assert.equal(existsSync(folder()), false);
	// The switch is read at each ask.
	world.setFlag(true);
	assert.equal((await head().ensure()).live, true);
});

test("turning the tower service off retires the head too: the identity leaves, the token goes, and service.json is purged with the queues; the conversation files stay", async () => {
	world.refreshMs = 60;
	await started();
	const got = await head().ensure();
	writeFileSync(join(headDir(world.slot), "memory.json"), "{}");
	mkdirSync(join(headDir(world.slot), "queue"), { recursive: true });
	writeFileSync(join(headDir(world.slot), "queue", "0000000000-aa.json"), JSON.stringify({ text: "old" }));
	world.setFlag(false);
	await until(() => head().status() === undefined, "the head to be retired at the next refresh");
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, undefined);
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(existsSync(join(headDir(world.slot), "queue")), false, "message text stays on disk with no time limit otherwise");
	assert.equal(existsSync(join(headDir(world.slot), "memory.json")), true);
});

test("the prompt's poll answers as the head's (head: true), and the stand-in is reported under the label `head`, not `tower`", async () => {
	const s = await started();
	const got = await head().ensure();
	const pid = 6100;
	world.herdr.pane(got.pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace ${got.workspace} --state-dir "/s"` }];
	let last: Record<string, unknown> = {};
	const timer = setInterval(() => void ask(s, { cmd: "prompt-poll", workspace: got.workspace, pid }).then((r) => (last = r), () => {}), 20);
	try {
		await until(() => world.herdr.pane(got.pane).agent === "head", "the stand-in under the head's label");
		assert.deepEqual({ ...last }, { ok: true, label: "Head tower", state: "standing", queued: 0, leave: false, head: true });
		assert.equal(world.herdr.pane(got.pane).standinMessage, "standing by");
		assert.deepEqual(world.herdr.agentCalls.filter((c) => c.method === "pane.report_agent").map((c) => c.params.agent), ["head"]);
	} finally {
		clearInterval(timer);
	}
});
