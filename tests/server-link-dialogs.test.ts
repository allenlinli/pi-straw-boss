import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { guiNamespace } from "../src/bridgewire.ts";
import { aeadOpen } from "../src/link/crypto.ts";
import { buildEnvelope, encodeHeader } from "../src/link/envelope.ts";
import { decodePlaintext, encodePlaintext, type Kind } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import type { Net } from "../src/net.ts";
import { questionsDigest } from "../src/owners.ts";
import { fileOf, slotOf } from "../src/server/record.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { clientFor, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";
import { bundle, noTailscale } from "./gui-fakes.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";
import { assistant, call, header, lines, user } from "./sessions.ts";

// A unit's question on an unattended box reaches the controller, through the sb server's own wiring (docs/specs/2026-10-25-straw-link.md, Unattended devices: Asking back): the real link holder, hub, net reading and forwarder of the server,
// a policy file in a fake file system, a fake Herdr and broker, and the controller's side read from the envelopes the fake relay took. The box is `dave` (unattended, added by `alice`); `alice` founded the team, so she is its admin,
// and she is the one controller the policy trusts at `dispatch`: the shape of the 2026-11-05 box trial.

const { alice, dave } = DEVICES;
let world: TowerWorld, relay: FakeRelay;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	relay = new FakeRelay();
});
afterEach(() => world.close());

const QUESTIONS = [{ question: "Which env?", header: "Env", multiple: false, options: [{ title: "staging" }, { title: "production" }] }];
const PANE = "wB:p9", SESSION = "main-1";

/** The box's roster and policy: alice founded the team (admin, attended) and added dave unattended; the policy trusts alice at dispatch. */
function box() {
	const home = join(world.root, "home"), project = join(home, "project");
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link"));
	const entries: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	entries.push(addEntry({ state: view(entries), signer: alice, record: dave, label: LABELS.dave, attended: false, ...det("add-dave") }));
	writeDevice(store, dave, LABELS.dave);
	writeTeam(store, entries, dave);
	relay.addTeam(TEAM, [dave.id, alice.id], entries);
	const text = JSON.stringify({ unattended: true, trust: { [alice.id]: "dispatch" }, teams: { [TEAM_HEX]: { project: real, share: "status" } } });
	return { link: { tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home, policy: { read: () => text, stat: () => ({ uid: 0, symlink: false }), writable: () => false, uid: 1000 } }, entries };
}
/** What alice reads of the envelopes the box sent her of `kind` (opened with the team key, without the receive checks). */
function toAlice(kind: string, entries: RosterEntry[]) {
	const key = stateOf(entries, alice).keys.get(1)!, out: Record<string, unknown>[] = [];
	for (const stored of relay.stored) {
		const { header, nonce, ct } = stored.envelope;
		if (header.kind !== kind || !stored.to.has(alice.id)) continue;
		const plain = aeadOpen(key, nonce, ct, encodeHeader(header));
		const message = plain && decodePlaintext(kind as Kind, plain);
		if (message) out.push(message as unknown as Record<string, unknown>);
	}
	return out;
}
/** A main in workspace wB whose pi waits on an `ask_user_question` call, and the bridge message that relays its dialog to the server's hub. */
async function ask(s: Running, id = "dlg-1", toolCallId = "c1") {
	const dir = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026_${SESSION}.jsonl`);
	writeFileSync(file, lines([header(SESSION), user("u1", null, "go"), assistant("a1", "u1", [call(toolCallId, "ask_user_question", { questions: [{ question: "Which env?", header: "Env", multiSelect: false, options: [{ label: "staging" }, { label: "production" }] }] })])]));
	if (!world.herdr.panes.some((p) => p.pane_id === PANE)) {
		world.herdr.addTab("wB:t9", "work", PANE);
		Object.assign(world.herdr.pane(PANE), { tokens: { sb_role: "main" }, agent_session: { value: file } });
		world.sessions = [{ id: SESSION, name: "docs-main", herdrLocation: { paneId: PANE, workspace: { id: "wB" }, tab: { id: "wB:t9", label: "work" } } } as never];
	}
	const server = world.record()!.intercomId!, main = world.client(server)!;
	main.broker({ type: "extension_message", namespace: guiNamespace(server), fromSessionId: SESSION, payload: { version: 1, type: "dialogs", bridgeId: "B", pane: PANE, file, dialogs: [{ owner: "rpiv", id, toolCallId, digest: questionsDigest(QUESTIONS), questions: QUESTIONS }], closed: [] } } as never);
	void s;
}

test("a question one of the box's units asks reaches the founder-admin controller at dispatch", async () => {
	const b = box();
	const s = await world.start({ link: b.link, unitsMs: 20 });
	await s.handle.ready;
	await ask(s);
	await until(() => toAlice("dialog-open", b.entries).length > 0, "the dialog-open at the controller");
	assert.deepEqual(toAlice("dialog-open", b.entries).map((m) => [m.dialogId, m.digest]), [["dlg-1", questionsDigest(QUESTIONS)]]);
});

const serverLog = () => readFileSync(fileOf(world.slot, "log"), "utf8").split("\n").filter(Boolean);

test("the box's log says how a question went: the forwarder started, who it sees, the question it saw, and each controller it sent to, with no word of the question", async () => {
	const b = box();
	const s = await world.start({ link: b.link, unitsMs: 20 });
	await s.handle.ready;
	await ask(s);
	await until(() => toAlice("dialog-open", b.entries).length > 0, "the dialog-open at the controller");
	await until(() => serverLog().some((l) => l.includes("dialog-sent")), "the dialog-sent line");
	const lines = serverLog();
	const has = (...parts: string[]) => lines.some((l) => parts.every((p) => l.includes(p)));
	assert.ok(has("dialog-forwarder", "state=started"), lines.join("\n"));
	assert.ok(has("dialog-controllers", "count=1", "known=true"), "who the forwarder sees");
	assert.ok(has("dialog-seen", "dialog=dlg-1", "owner=rpiv"), "the question the hub offered");
	assert.ok(has("dialog-sent", "kind=dialog-open", "dialog=dlg-1", `to=${alice.id}`, `team=${TEAM_HEX}`), "the controller it was posted to");
	assert.equal(lines.filter((l) => l.includes("dialog-controllers")).length, 1, "one line until the count changes");
	assert.ok(!lines.some((l) => l.includes("Which env") || l.includes("staging")), "no word of the question in the log");
});

test("the question is told as the unit that asked, not as the package that opened it", async () => {
	const b = box();
	const s = await world.start({ link: b.link, unitsMs: 20 });
	await s.handle.ready;
	await ask(s);
	await until(() => toAlice("dialog-open", b.entries).length > 0, "the dialog-open at the controller");
	assert.deepEqual(toAlice("dialog-open", b.entries).map((m) => m.owner), ["main - docs-main"], "the session's name with its role, not rpiv");
});

test("a server that is not the default Herdr's says in its log that it runs no forwarder", async () => {
	const other = join(world.stateDir, "other-herdr.sock");
	const env = { ...world.env, HERDR_SOCKET_PATH: other }, s = await world.start({ env, slot: slotOf(world.stateDir, env) });
	await s.handle.ready;
	assert.equal(s.options.slot.primary, false);
	const lines = readFileSync(fileOf(s.options.slot, "log"), "utf8").split("\n");
	assert.ok(lines.some((l) => l.includes("dialog-forwarder") && l.includes("state=skipped") && l.includes("primary=false")), lines.join("\n"));
});

/** The controller (alice, attended) with the box (dave, unattended) in its team: what the box sent is forged here, and what the controller's page is given is read from its GUI. */
function controller() {
	const home = join(world.root, "home"), project = join(home, "project");
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link"));
	const entries: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	entries.push(addEntry({ state: view(entries), signer: alice, record: dave, label: "waydosoft", attended: false, ...det("add-dave") }));
	writeDevice(store, alice, LABELS.alice);
	writeTeam(store, entries, alice);
	relay.addTeam(TEAM, [alice.id, dave.id], entries);
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: real, share: "status" } } } }));
	return { link: { tickMs: 15, drainMs: 20, presenceMs: 60_000, relay: clientFor(relay), home }, entries };
}
/** What the GUI of the server streams first: the net snapshot the page draws, as the page gets it. */
const snapshot = (s: Running) => new Promise<Net>((resolve, reject) => {
	const { port, token } = world.record()!.gui!;
	void s;
	const req = get(`http://127.0.0.1:${port}/${token}/events`, (res) => {
		let buffer = "";
		res.setEncoding("utf8").on("data", (chunk: string) => {
			buffer += chunk;
			const block = buffer.split("\n\n").slice(0, -1).find((x) => !x.startsWith("event: "));
			if (block) (req.destroy(), resolve(JSON.parse(block.slice(6)) as Net));
		});
	});
	req.on("error", reject);
});

test("a question the box forwarded reaches the controller's page in the snapshot: one open dialog notice with the box's label, the unit's name, and the question as the card draws it", async () => {
	const c = controller();
	const s = await world.start({ link: c.link, gui: { bundle, tailscale: noTailscale, bindWaitMs: 200 } });
	await s.handle.ready;
	await until(() => Boolean(world.record()?.gui?.port), "the GUI");
	const digest = questionsDigest(QUESTIONS), dialog = JSON.stringify({ questions: QUESTIONS, cancel: true });
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: stateOf(c.entries, alice).head, from: dave, seq: 1, ts: Date.now(), kind: "dialog-open", to: [alice.id], plaintext: encodePlaintext("dialog-open", { dialogId: "dlg-1", digest, owner: "subagent - scout", dialog }) });
	await new RelayClient({ url: "http://relay.test", device: dave, fetch: relay.fetch }).postEnvelope(TEAM, envelope);
	await until(async () => (await snapshot(s)).link?.alerts.some((a) => a.kind === "dialog"), "the dialog in the snapshot");
	const alerts = (await snapshot(s)).link!.alerts.filter((a) => a.kind === "dialog");
	assert.deepEqual(alerts, [{ id: `dialog/${dave.id}/dlg-1`, kind: "dialog", level: "warning", team: TEAM_HEX, teamName: "project", data: { device: dave.id, dialogId: "dlg-1", digest, owner: "subagent - scout", dialog, label: "waydosoft", short: dave.shortId, answered: 0 } }]);
});
