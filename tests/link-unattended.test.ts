import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readLinkConfig, type TeamPolicy } from "../src/link/config.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { joinFilePath, readJoinFile } from "../src/link/joinfile.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf } from "./link/holder-world.ts";

// An unattended device joins from `link/join.txt` (docs/specs/2026-10-25-straw-link.md, Storage and policy; src/link/joinfile.ts, admin.ts `joinFileTick`): an attended
// holder invites the unattended one's pinned id, the invite text lands in the file, and the unattended holder reads it, asks the relay, waits for approval, writes the team file
// (never config.json), and deletes the file. Two holders share one in-memory relay; the clock of each is its own skew, so a lapse is a step of the clock, not a wait.

let root = "";
let relay: FakeRelay;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-unattended-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

interface Computer { dir: string; stateDir: string; project: string; store: LinkStore; holder: LinkHolder; notices: string[]; clock: { skew: number }; policy: Map<string, TeamPolicy>; join: string }

/** An attended computer reads config.json; an unattended one takes the teams of `policy`, which a test fills in as the policy file would be. */
async function computer(name: string, label: string, o: { unattended?: boolean; start?: boolean } = {}): Promise<Computer> {
	const stateDir = join(root, name), home = join(root, `${name}-home`), project = join(home, "project"), dir = join(stateDir, "link");
	mkdirSync(project, { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const store = new LinkStore(dir, { alive: () => true }), notices: string[] = [], clock = { skew: 0 }, policy = new Map<string, TeamPolicy>();
	const agentDir = join(home, ".pi", "agent");
	const config = o.unattended ? () => ({ teams: new Map(policy), trust: new Map(), problems: [] }) : () => readLinkConfig(stateDir, { home, agentDir });
	const holder = new LinkHolder({
		store, isHolder: () => true, config, stateDir, home, agentDir, net: async () => netOf([]), relay: clientFor(relay), attended: () => !o.unattended,
		offer: () => {}, notify: (text) => void notices.push(text), now: () => Date.now() + clock.skew, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000,
	});
	await store.withLock(() => (store.enable(), store.ensureDevice()));
	const file = JSON.parse(readFileSync(join(dir, "device.json"), "utf8")) as { label: string };
	writeFileSync(join(dir, "device.json"), JSON.stringify({ ...file, label }), { mode: 0o600 });
	if (o.start !== false) {
		await holder.start();
		stops.push(() => holder.stop());
	}
	return { dir, stateDir, project, store, holder, notices, clock, policy, join: joinFilePath(dir) };
}

const TOKEN = "srt1_test";
/** A makes a team and invites B's pinned id (any device when `pinned` is false); B's policy names the team unless `named` is false. Returns the invite text. */
async function invited(a: Computer, b: Computer, o: { named?: boolean; pinned?: boolean } = {}) {
	relay.tokens.add(TOKEN);
	const made = await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: TOKEN, project: a.project, label: "alice-mac" });
	assert.ok(made.ok, made.ok ? "" : made.error);
	if (o.named !== false) b.policy.set(made.team, { project: b.project, share: "presence", name: "project" });
	const invite = await a.holder.admin.invite({ team: made.team, ...(o.pinned === false ? {} : { forDevice: b.holder.deviceId! }) });
	assert.ok(invite.ok, invite.ok ? "" : invite.error);
	await until(() => relay.streams.some((s) => s.team === made.team && s.device === a.holder.deviceId), 3000, "A's stream");
	return { team: made.team, text: invite.text, hash: invite.hash };
}
const drop = (b: Computer, text: string) => writeFileSync(b.join, `${text}\n`, { mode: 0o600 });
const logOf = (c: Computer) => (existsSync(join(c.dir, "link.log")) ? readFileSync(join(c.dir, "link.log"), "utf8") : "");
const events = (c: Computer, event: string) => logOf(c).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; outcome?: string; why?: string; team?: string }).filter((e) => e.event === event);

test("an unattended device takes join.txt, its request is marked unattended, A approves, and the team file is written with config.json untouched", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const config = JSON.stringify({ towerModel: "keep-me" });
	writeFileSync(join(b.stateDir, "config.json"), config);
	const { team, text } = await invited(a, b);
	drop(b, text);
	const request = await until(() => a.holder.admin.joinRequests()[0], 3000, "the join request at A");
	assert.equal(request.unattended, true, "the request is marked unattended");
	assert.deepEqual(request.sets, [], "no words: the pinned id stands in for them");
	assert.equal(existsSync(b.join), true, "the file stays while the join is in flight");
	assert.equal(b.holder.admin.joinView()?.pinned, true);
	assert.deepEqual(await a.holder.admin.decide({ id: request.id, approve: true }), { ok: true, joined: true });
	await until(() => !existsSync(b.join), 3000, "the file deleted");
	assert.deepEqual(b.store.teamIds(), [team]);
	assert.equal(b.store.readTeam(team)?.relay, "http://127.0.0.1:9", "the relay is the invite's");
	assert.equal(readFileSync(join(b.stateDir, "config.json"), "utf8"), config, "config.json is not written");
	assert.deepEqual(events(b, "join-file").map((e) => [e.outcome, e.team]), [["joined", team]]);
	assert.equal(logOf(b).includes(text), false, "the invite text is never logged");
	assert.equal(b.notices.some((n) => n.includes(text)), false);
	// The team starts from the policy's project and share.
	await until(() => b.holder.view().teams[0]?.members.length === 2, 3000, "B's team running");
	assert.deepEqual([b.holder.view().teams[0]!.project, b.holder.view().teams[0]!.share], [b.project, "presence"]);
	assert.equal(a.holder.view().teams[0]!.members.find((m) => m.label === "ci-box")!.attended, false);
});

test("an invite for a team the policy does not name is refused, logged, and the file deleted before the relay hears of it", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { text, hash } = await invited(a, b, { named: false });
	drop(b, text);
	await until(() => !existsSync(b.join), 3000, "the file deleted");
	const [refused] = events(b, "join-file");
	assert.equal(refused?.outcome, "refused");
	assert.match(refused?.why ?? "", /policy file does not name team/);
	assert.equal(b.store.teamIds().length, 0);
	assert.equal(a.holder.admin.joinRequests().length, 0);
	assert.equal(relay.invites.get(hash)?.used, false, "the relay saw no join request");
	assert.equal(logOf(b).includes(text), false);
});

test("an invite that lapses before A approves ends the join: the file is deleted and the outcome logged", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { text } = await invited(a, b);
	drop(b, text);
	await until(() => a.holder.admin.joinRequests()[0], 3000, "the join request at A");
	b.clock.skew = 25 * 3600_000;
	await until(() => !existsSync(b.join), 6000, "the file deleted after the lapse");
	assert.deepEqual(events(b, "join-file").map((e) => e.outcome), ["lapsed"]);
	assert.equal(b.store.teamIds().length, 0);
	assert.equal(b.holder.admin.joinView()?.state, "failed");
});

test("a symlinked join.txt, a loose mode, and a file that is not an invite are refused and removed; a symlink's target is left alone", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { text } = await invited(a, b);
	const target = join(root, "elsewhere.txt");
	writeFileSync(target, text, { mode: 0o600 });
	symlinkSync(target, b.join);
	await until(() => !existsSync(b.join), 3000, "the symlink removed");
	assert.equal(readFileSync(target, "utf8"), text, "the target is not touched");
	writeFileSync(b.join, text, { mode: 0o600 });
	chmodSync(b.join, 0o644);
	await until(() => !existsSync(b.join), 3000, "the loose file removed");
	drop(b, "hello");
	await until(() => !existsSync(b.join), 3000, "the junk file removed");
	const refused = events(b, "join-file");
	assert.deepEqual(refused.map((e) => e.outcome), ["refused", "refused", "refused"]);
	assert.match(refused[0]!.why ?? "", /symlink/);
	assert.match(refused[1]!.why ?? "", /mode 644/);
	assert.match(refused[2]!.why ?? "", /no Straw Link invite/);
	assert.equal(a.holder.admin.joinRequests().length, 0, "none of them reached the relay");
	assert.equal(logOf(b).includes(text), false);
});

test("an invite for a team the device is in already is deleted and logged as already-member", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { team, text } = await invited(a, b);
	drop(b, text);
	const request = await until(() => a.holder.admin.joinRequests()[0], 3000, "the join request at A");
	await a.holder.admin.decide({ id: request.id, approve: true });
	await until(() => !existsSync(b.join), 3000, "the first file deleted");
	drop(b, text);
	await until(() => !existsSync(b.join), 3000, "the second file deleted");
	assert.deepEqual(events(b, "join-file").map((e) => [e.outcome, e.team]), [["joined", team], ["already-member", team]]);
});

test("an attended device never reads join.txt, and refuses a file join", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box");
	const { text } = await invited(a, b);
	drop(b, text);
	await b.holder.admin.joinFileTick();
	assert.equal(existsSync(b.join), true, "the file stays");
	const started = await b.holder.admin.joinStart({ text, unattended: true });
	assert.deepEqual(started, { ok: false, error: "Only an unattended device joins from a file" });
	assert.equal(a.holder.admin.joinRequests().length, 0);
	// And an unattended device does not take a pasted invite: its teams come from the policy file.
	const c = await computer("c", "pi-box", { unattended: true });
	assert.deepEqual(await c.holder.admin.joinStart({ text }), { ok: false, error: "This computer is unattended: its teams come from its infra's policy file" });
});

test("the file check wants a regular file of the own user at mode 600", () => {
	const path = join(root, "join.txt");
	assert.deepEqual(readJoinFile(path), { state: "absent" });
	writeFileSync(path, "x", { mode: 0o600 });
	assert.deepEqual(readJoinFile(path), { state: "text", text: "x" });
	const other = (process.getuid?.() ?? 0) + 1;
	assert.match(JSON.stringify(readJoinFile(path, { uid: other })), /not owned by this device's own user/);
	mkdirSync(join(root, "dir"));
	assert.match(JSON.stringify(readJoinFile(join(root, "dir"))), /mode|regular|cannot be read/);
});

test("an unattended device joins only with an invite pinned to its id: an open one is refused and the file deleted before the relay hears of it", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { text, hash } = await invited(a, b, { pinned: false });
	assert.deepEqual(await b.holder.admin.joinStart({ text, unattended: true }), { ok: false, error: "An unattended device joins only with an invite pinned to its id" });
	drop(b, text);
	await until(() => !existsSync(b.join), 3000, "the file deleted");
	const [refused] = events(b, "join-file");
	assert.equal(refused?.outcome, "refused");
	assert.match(refused?.why ?? "", /pinned to its id/);
	assert.equal(b.store.teamIds().length, 0);
	assert.equal(a.holder.admin.joinRequests().length, 0);
	assert.equal(relay.invites.get(hash)?.used, false, "the relay saw no join request");
	assert.equal(relay.joined.length, 0);
	assert.equal(logOf(b).includes(text), false);
});

test("a relay that fails for a moment at the join request keeps join.txt: it is tried again after a wait, and the join then completes", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	const { team, text } = await invited(a, b);
	relay.failJoins = 1;
	drop(b, text);
	await until(() => events(b, "join-file-retry").length === 1, 3000, "the retry logged");
	assert.equal(existsSync(b.join), true, "the file stays");
	assert.equal(events(b, "join-file").length, 0, "no outcome yet");
	assert.equal(logOf(b).includes(text), false);
	// Many ticks pass (20 ms each) inside the wait; none tries again.
	for (let i = 0; i < 5; i++) await b.holder.admin.joinFileTick();
	assert.equal(events(b, "join-file-retry").length, 1);
	assert.equal(relay.joined.length, 0);
	b.clock.skew += 31_000;
	const request = await until(() => a.holder.admin.joinRequests()[0], 3000, "the join request at A after the wait");
	assert.deepEqual(await a.holder.admin.decide({ id: request.id, approve: true }), { ok: true, joined: true });
	await until(() => !existsSync(b.join), 3000, "the file deleted");
	assert.deepEqual(b.store.teamIds(), [team]);
	assert.deepEqual(events(b, "join-file").map((e) => e.outcome), ["joined"]);
});

test("a join.txt that cannot be removed is told once, not at every tick; a new file after it is taken", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box", { unattended: true });
	await invited(a, b);
	// A folder where the file should be: refused as not a regular file, and unlink cannot remove it.
	mkdirSync(b.join);
	await until(() => events(b, "join-file-stuck").length === 1, 3000, "the stuck line");
	for (let i = 0; i < 5; i++) await b.holder.admin.joinFileTick();
	assert.equal(events(b, "join-file-stuck").length, 1);
	assert.deepEqual(events(b, "join-file").map((e) => e.outcome), ["refused"]);
	assert.equal(b.notices.filter((n) => n.includes("join.txt")).length, 1, "one notice");
	// Gone and replaced: the new file is taken like any other.
	rmSync(b.join, { recursive: true });
	await b.holder.admin.joinFileTick();
	drop(b, "hello");
	await until(() => events(b, "join-file").length === 2, 3000, "the new file refused");
	assert.equal(existsSync(b.join), false);
});

test("a FIFO as join.txt is refused without being opened", () => {
	const path = join(root, "join.txt");
	execFileSync("mkfifo", [path]);
	assert.match(JSON.stringify(readJoinFile(path)), /not a regular file/);
});
