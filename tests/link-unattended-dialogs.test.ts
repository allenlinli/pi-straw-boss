import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Offer, Sent } from "../src/dialogs.ts";
import { DialogForwarder, OPEN_STALE_MS, REFRESH_MS, UNANSWERED_MS, UNKNOWN_RECHECK_MS } from "../src/link/dialogs-out.ts";
import { runNotice, STATUS_EVERY_MS, UnitReporter, type UnitFacts } from "../src/link/unitstatus.ts";
import { fakeClock } from "./fake-clock.ts";
import { buildEnvelope } from "../src/link/envelope.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import type { Answer, Answerable } from "../src/owners.ts";
import { selectDigest } from "../src/owners.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// Dialog forwarding (docs/specs/2026-10-25-straw-link.md, Unattended devices: Asking back). dave is the unattended device; alice (attended, at dispatch) and
// bob (attended, at reply) are teammates; eve is a second unattended device.

const { alice, bob, dave, eve } = DEVICES;
let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	skew = 0;
	root = mkdtempSync(join(tmpdir(), "psb-link-dialogs-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const [who, attended] of [["bob", true], ["dave", false], ["eve", false]] as const) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	return log;
})();
const world = () => relay.addTeam(TEAM, [alice.id, bob.id, dave.id, eve.id], entries);

type Who = "alice" | "bob" | "dave";
type Sink = NonNullable<ConstructorParameters<typeof LinkHolder>[0]["dialogAnswer"]>;
interface Rig { holder: LinkHolder; store: LinkStore; notices: string[]; answers: Parameters<Sink>[0][]; sink?: Sink }
/** `trust`: what the device gives the others (only dave's matters here: who may answer for it). */
/** Milliseconds the holders' clock runs ahead of the real one (a test moves it to let an ended dialog's card lapse). */
let skew = 0;
function rig(who: Who, trust: Record<string, "reply" | "forward" | "dispatch"> = {}): Rig {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const r = { store, notices: [], answers: [] } as unknown as Rig;
	r.holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who !== "dave", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(Object.entries(trust).map(([k, v]) => [k, v])), problems: [] }),
		offer: () => {}, notify: (text) => void r.notices.push(text), backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000,
		dialogAnswer: (a) => (r.answers.push(a), r.sink?.(a)), now: () => Date.now() + skew,
	});
	cleanup.push(() => r.holder.stop());
	return r;
}
const events = (r: Rig) => {
	try {
		return readFileSync(join(r.store.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const drops = (r: Rig, reason: string) => events(r).filter((e) => e.reason === reason).length;

const SELECT = { title: "Pick a flavor — the secret title", choices: [{ label: "Vanilla" }, { label: "Mint" }] };
const CONFIRM = { title: "Allow bash? ls", choices: [{ label: "Allow" }, { label: "Deny" }] };
const QUESTIONS = [{ question: "Which env?", header: "Env", multiple: false, options: [{ title: "staging" }, { title: "production" }] }, { question: "Which checks?", header: "Checks", multiple: true, options: [{ title: "unit" }, { title: "e2e" }] }];
const answerable = (id: string, over: Partial<Answerable> = {}): Answerable => ({ dialog: id, digest: selectDigest(SELECT), select: SELECT, ...over });

/** A hub as the forwarder sees it: the dialogs on offer, which are open, and what it was told to carry. */
function fakeHub() {
	const offers = new Map<string, Offer>(), closed = new Map<string, string>(), sent: { key: string; answer: Answer }[] = [];
	let change = () => {}, result = "accepted";
	const hub = {
		onChange: (cb: () => void) => ((change = cb), () => {}),
		answerable: () => [...offers.values()],
		outcome: (id: string) => (closed.has(id) ? { open: false as const, by: closed.get(id)! } : offers.has(id) ? { open: true as const } : { open: false as const, by: "gone" }),
		send: async (key: string, _t: unknown, answer: Answer): Promise<Sent> => (sent.push({ key, answer }), { status: 200, body: { outcome: result } }),
	};
	return {
		hub, sent, change: () => change(),
		/** What the session answers to the next answers it is carried (`accepted`, `rejected`, `busy`, `unknown`, ...). */
		answers: (outcome: string) => void (result = outcome),
		open: (id: string, a: Answerable = answerable(id), owner = "rpiv") => void offers.set(id, { key: "S", owner, target: { from: "S", bridgeId: "B", answer: a } }),
		close: (id: string, by = "remote") => void (closed.set(id, by), offers.delete(id)),
	};
}
function forwarder(dave: Rig, h: ReturnType<typeof fakeHub>, over: Partial<ConstructorParameters<typeof DialogForwarder>[0]> = {}) {
	const f = new DialogForwarder({ hub: h.hub, read: async () => {}, controllers: () => dave.holder.dialogControllers(), post: (t, d, k, p) => dave.holder.sendDialog(t, d, k, p), log: (e) => dave.store.log(e), ...over });
	f.start();
	return f;
}
/** A message built by hand from any device, with any seq. */
async function forge(from: typeof alice, seq: number, to: typeof alice, kind: "dialog-answer" | "dialog-open", fields: Record<string, string>) {
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: stateOf(entries, alice).head, from, seq, ts: Date.now(), kind, to: [to.id], plaintext: encodePlaintext(kind, fields as never) });
	await new RelayClient({ url: "http://relay.test", device: from, fetch: relay.fetch }).postEnvelope(TEAM, envelope);
}
const reply = (id: string, answerId: string, answer: unknown, digest = selectDigest(SELECT)) => ({ dialogId: id, digest, answer: JSON.stringify(answer), answerId });

describe("dialog forwarding", () => {
	async function start(trust: Record<string, "reply" | "forward" | "dispatch"> = { [alice.id]: "dispatch", [bob.id]: "reply" }) {
		world();
		const h = fakeHub(), d = rig("dave", trust), a = rig("alice"), b = rig("bob");
		const f = forwarder(d, h);
		d.sink = (a) => f.answer(a);
		await Promise.all([d.holder.start(), a.holder.start(), b.holder.start()]);
		return { h, d, a, b, f };
	}
	test("a select reaches the controller at dispatch only; its answer is carried to the session, and the close follows", async () => {
		const { h, d, a, b, f } = await start();
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		const v = a.holder.dialogRequests()[0]!;
		assert.deepEqual([v.device, v.dialogId, v.digest, v.owner, v.team], [dave.id, "D1", selectDigest(SELECT), "rpiv", TEAM_HEX]);
		assert.deepEqual(JSON.parse(v.dialog), { select: SELECT });
		const alert = a.holder.summary().alerts.find((x) => x.kind === "dialog")!;
		assert.deepEqual([alert.id, alert.data.device, alert.data.dialogId, alert.data.digest, alert.data.owner, alert.data.label, alert.data.answered], [`dialog/${dave.id}/D1`, dave.id, "D1", selectDigest(SELECT), "rpiv", "ci-box", 0]);
		assert.equal(b.holder.dialogRequests().length, 0, "bob is at reply: nothing is sent to him");
		assert.deepEqual(await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 1 })), { ok: true });
		await until(() => h.sent.length === 1, 3000, "the answer carried");
		assert.deepEqual([h.sent[0]!.key, h.sent[0]!.answer.id, h.sent[0]!.answer.choice, h.sent[0]!.answer.digest], ["S", "D1", 1, selectDigest(SELECT)]);
		assert.match(h.sent[0]!.answer.answerId, /^[0-9a-f]{32}$/);
		assert.equal((await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 0 }))).ok, false, "once per dialog from this device");
		h.close("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 0, 3000, "the close on alice");
		const ended = a.holder.summary().alerts.find((x) => x.kind === "dialog")!;
		assert.deepEqual([ended.level, ended.data.closed, ended.data.answered], ["info", "remote", 1], "the card stays to say how it ended, and that this device answered");
		assert.equal((await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 0 }))).ok, false, "an ended question takes no answer");
		skew = 3 * 60_000;
		assert.equal(a.holder.summary().alerts.some((x) => x.kind === "dialog"), false, "the card lapses two minutes after the close");
		assert.ok(!events(d).some((e) => JSON.stringify(e).includes("secret title")), "no dialog text in the log");
	});

	test("an answer with another digest is refused and leaves the question open for the right one", async () => {
		const { h, a, f } = await start();
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		const wrong = await a.holder.answerDialog(dave.id, "D1", "0".repeat(64), JSON.stringify({ choice: 1 }));
		assert.deepEqual(wrong, { ok: false, error: "The question changed; look at it again" });
		assert.equal(a.holder.summary().alerts.find((x) => x.kind === "dialog")!.data.answered, 0);
		assert.deepEqual(await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 1 })), { ok: true });
	});

	test("a confirm and an ask_user_question round trip", async () => {
		const { h, d, a, f } = await start();
		h.open("C1", answerable("C1", { digest: selectDigest(CONFIRM), select: CONFIRM }), "straw-link-gate");
		h.open("Q1", { dialog: "Q1", digest: "q".repeat(64), questions: QUESTIONS, cancel: true });
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 2, 3000, "both on alice");
		assert.deepEqual(await a.holder.answerDialog(dave.id, "C1", selectDigest(CONFIRM), JSON.stringify({ choice: 0 })), { ok: true });
		const replies = [{ choices: [1] }, { choices: [0, 1], note: "both" }];
		assert.deepEqual(await a.holder.answerDialog(dave.id, "Q1", "q".repeat(64), JSON.stringify({ answers: replies })), { ok: true });
		await until(() => h.sent.length === 2, 3000, "two answers carried");
		const byId = Object.fromEntries(h.sent.map((x) => [x.answer.id, x.answer]));
		assert.equal(byId.C1!.choice, 0);
		assert.deepEqual(byId.Q1!.answers, replies);
	});

	test("the first valid answer wins; a replayed id, a later answer, and a wrong digest are dropped", async () => {
		const { h, d, a, f } = await start();
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		await forge(alice, 50, dave, "dialog-answer", reply("D1", "a".repeat(32), { choice: 0 }, "0".repeat(64)));
		await until(() => d.answers.length === 1, 3000, "the first reached the forwarder");
		await until(() => drops(d, "dialog-answer-digest") === 1, 3000, "wrong digest dropped");
		assert.equal(h.sent.length, 0);
		await forge(alice, 51, dave, "dialog-answer", reply("D1", "b".repeat(32), { choice: 1 }));
		await until(() => h.sent.length === 1, 3000, "the right answer");
		await forge(alice, 52, dave, "dialog-answer", reply("D1", "c".repeat(32), { choice: 0 }));
		await until(() => drops(d, "dialog-answer-late") === 1, 3000, "a later answer dropped");
		await forge(alice, 53, dave, "dialog-answer", reply("D1", "b".repeat(32), { choice: 0 }));
		await until(() => drops(d, "dialog-answer-id") === 1, 3000, "a replayed id dropped");
		await forge(alice, 54, dave, "dialog-answer", reply("nothing-open", "d".repeat(32), { choice: 0 }));
		await until(() => drops(d, "dialog-answer-unknown") === 1, 3000, "an unknown dialog dropped");
		assert.deepEqual(h.sent.map((x) => x.answer.choice), [1]);
	});

	test("an answer outside the dialog's choices is refused and does not use the dialog up", async () => {
		const { h, d, a, f } = await start();
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		await forge(alice, 50, dave, "dialog-answer", reply("D1", "a".repeat(32), { choice: 7 }));
		await until(() => drops(d, "dialog-answer-invalid") === 1, 3000, "invalid dropped");
		await forge(alice, 51, dave, "dialog-answer", reply("D1", "b".repeat(32), { choice: 0 }));
		await until(() => h.sent.length === 1, 3000, "a valid one still wins");
	});

	test("a sender at reply is refused", async () => {
		const { h, d, f } = await start();
		h.open("D1");
		await f.poll();
		await forge(bob, 50, dave, "dialog-answer", reply("D1", "a".repeat(32), { choice: 0 }));
		await until(() => drops(d, "dialog-answer-level") === 1, 3000, "level drop");
		assert.deepEqual([d.answers.length, h.sent.length], [0, 0]);
	});

	test("an unattended sender is refused by the kind's rule and never reaches the forwarder", async () => {
		const { h, d, f } = await start({ [alice.id]: "dispatch", [eve.id]: "dispatch" });
		h.open("D1");
		await f.poll();
		await forge(eve, 50, dave, "dialog-answer", reply("D1", "a".repeat(32), { choice: 0 }));
		await until(() => drops(d, "kind-not-allowed") === 1, 3000, "kind drop");
		assert.deepEqual([d.answers.length, h.sent.length], [0, 0]);
	});

	test("an attended device never takes a dialog-answer, and a dialog-open from an attended device is dropped", async () => {
		const { a } = await start();
		await forge(bob, 50, alice, "dialog-answer", reply("D1", "a".repeat(32), { choice: 0 }));
		await until(() => drops(a, "dialog-answer-attended-device") === 1, 3000, "attended drop");
		assert.equal(a.answers.length, 0);
		await forge(bob, 51, alice, "dialog-open", { dialogId: "X", digest: "d", owner: "o", dialog: "{}" });
		await until(() => drops(a, "kind-not-allowed") === 1, 3000, "attended sender of dialog-open dropped");
		assert.equal(a.holder.dialogRequests().length, 0);
	});

	test("an oversize dialog is not sent, with one log line; the next one is", async () => {
		const { h, d, a, f } = await start();
		const big = { title: "x".repeat(70_000), choices: [{ label: "ok" }] };
		h.open("BIG", answerable("BIG", { digest: selectDigest(big), select: big }));
		await f.poll();
		await f.poll();
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the small one on alice");
		assert.deepEqual(a.holder.dialogRequests().map((v) => v.dialogId), ["D1"]);
		assert.equal(events(d).filter((e) => e.event === "dialog-oversize").length, 1);
		assert.ok(!events(d).some((e) => JSON.stringify(e).includes("xxxxxxxx")));
	});

	test("a choice only the device's own page may pick is not carried for a controller, nor a cancel where every choice is such; the card opens again and a Deny is carried", async () => {
		const { h, d, a } = await start();
		const HERE = { title: "Approve?", choices: [{ label: "Approve", hereOnly: true as const }, { label: "Deny" }] }, ALL = { title: "Approve it?", choices: [{ label: "Approve", hereOnly: true as const }, { label: "Allow once", hereOnly: true as const }] };
		const f = forwarder(d, h);
		d.sink = (x) => f.answer(x);
		h.open("H1", answerable("H1", { digest: selectDigest(HERE), select: HERE, cancel: true }));
		h.open("H2", answerable("H2", { digest: selectDigest(ALL), select: ALL, cancel: true }));
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 2, 3000, "both on alice");
		const answered = (id: string) => a.holder.summary().alerts.find((x) => x.id === `dialog/${dave.id}/${id}`)!.data.answered;
		assert.deepEqual(await a.holder.answerDialog(dave.id, "H1", selectDigest(HERE), JSON.stringify({ choice: 0 })), { ok: true });
		await until(() => drops(d, "dialog-answer-here-only") === 1, 3000, "the approve dropped");
		await until(() => answered("H1") === 0, 3000, "the card answerable again");
		assert.equal(h.sent.length, 0);
		// A cancel is a refusal: carried where some choice is a paired device's, not where every one is this computer's.
		assert.deepEqual(await a.holder.answerDialog(dave.id, "H2", selectDigest(ALL), JSON.stringify({ cancel: true })), { ok: true });
		await until(() => drops(d, "dialog-answer-here-only") === 2, 3000, "the cancel of H2 dropped");
		assert.equal(h.sent.length, 0);
		assert.deepEqual(await a.holder.answerDialog(dave.id, "H1", selectDigest(HERE), JSON.stringify({ cancel: true })), { ok: true });
		await until(() => h.sent.length === 1, 3000, "the cancel of H1 carried");
		await until(() => answered("H1") === 1, 3000, "answered");
		assert.deepEqual([h.sent[0]!.answer.id, "cancel" in h.sent[0]!.answer], ["H1", true]);
	});

	test("an answer the session turned down leaves the dialog open for the next one and opens the controller's card again; one it took keeps the dialog claimed", async () => {
		const { h, d, a } = await start();
		const f = forwarder(d, h);
		d.sink = (x) => f.answer(x);
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		const answered = () => a.holder.summary().alerts.find((x) => x.kind === "dialog")!.data.answered;
		for (const outcome of ["rejected", "busy"]) {
			h.answers(outcome);
			const before = h.sent.length;
			assert.deepEqual(await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 0 })), { ok: true });
			await until(() => h.sent.length === before + 1, 3000, `${outcome} answer carried`);
			await until(() => answered() === 0, 3000, `the card answerable again after ${outcome}`);
		}
		h.answers("accepted");
		assert.deepEqual(await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 1 })), { ok: true });
		await until(() => h.sent.length === 3, 3000, "the third carried and accepted");
		assert.equal(answered(), 1);
		await forge(alice, 90, dave, "dialog-answer", reply("D1", "e".repeat(32), { choice: 0 }));
		await until(() => drops(d, "dialog-answer-late") === 1, 3000, "an accepted dialog takes no more");
	});

	test("an answer no session confirmed is looked at again: a dialog still open a while later is taken as unanswered and sent to the controllers again", async () => {
		const { h, d, a } = await start();
		const clock = fakeClock(), f = forwarder(d, h, { now: clock.now });
		d.sink = (x) => f.answer(x);
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		h.answers("unknown");
		assert.deepEqual(await a.holder.answerDialog(dave.id, "D1", selectDigest(SELECT), JSON.stringify({ choice: 0 })), { ok: true });
		await until(() => h.sent.length === 1, 3000, "the answer carried");
		await f.tick();
		await forge(alice, 90, dave, "dialog-answer", reply("D1", "e".repeat(32), { choice: 1 }));
		await until(() => drops(d, "dialog-answer-late") === 1, 3000, "claimed while the answer may have landed");
		clock.advance(UNKNOWN_RECHECK_MS);
		h.answers("accepted");
		await f.tick();
		await until(() => a.holder.summary().alerts.find((x) => x.kind === "dialog")!.data.answered === 0, 3000, "the card answerable again");
		await forge(alice, 91, dave, "dialog-answer", reply("D1", "f".repeat(32), { choice: 1 }));
		await until(() => h.sent.length === 2, 3000, "the next valid answer wins");
	});

	test("an open dialog is sent again every ten minutes; a controller that lost dispatch is told it is withdrawn and gets it back with the level; a view not refreshed for 25 minutes lapses", async () => {
		const { h, d, a } = await start();
		const clock = fakeClock(), posts: string[] = [];
		let controllers = d.holder.dialogControllers();
		const f = forwarder(d, h, { now: clock.now, controllers: () => controllers, post: (t, dev, k, p) => (posts.push(`${k}:${p.dialogId}`), d.holder.sendDialog(t, dev, k, p)) });
		h.open("D1");
		await f.tick();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog on alice");
		clock.advance(REFRESH_MS - 1);
		await f.tick();
		assert.deepEqual(posts, ["dialog-open:D1"], "not yet");
		clock.advance(1);
		await f.tick();
		assert.deepEqual(posts, ["dialog-open:D1", "dialog-open:D1"], "ten minutes on");
		// Alice loses dispatch.
		controllers = [];
		await f.tick();
		assert.deepEqual(posts.at(-1), "dialog-close:D1");
		await until(() => a.holder.dialogRequests().length === 0, 3000, "the withdrawal on alice");
		assert.equal(a.holder.dialogRequests(true)[0]?.closed?.by, "withdrawn");
		controllers = d.holder.dialogControllers();
		await f.tick();
		await until(() => a.holder.dialogRequests().length === 1, 3000, "the dialog back on alice");
		// The device goes silent: the open view lapses on the controller.
		skew = OPEN_STALE_MS - 120_000;
		assert.equal(a.holder.dialogRequests().length, 1);
		skew = OPEN_STALE_MS + 1;
		assert.equal(a.holder.dialogRequests().length, 0);
	});

	test("a close reaches every controller that was sent the dialog", async () => {
		const { h, d, a, b, f } = await start({ [alice.id]: "dispatch", [bob.id]: "dispatch" });
		h.open("D1");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 1 && b.holder.dialogRequests().length === 1, 3000, "both controllers");
		h.close("D1", "local");
		await f.poll();
		await until(() => a.holder.dialogRequests().length === 0 && b.holder.dialogRequests().length === 0, 3000, "both closed");
	});

	test("only attended members at dispatch are controllers; an attended computer forwards nothing", async () => {
		const { d, a } = await start();
		assert.deepEqual(d.holder.dialogControllers(), [{ team: TEAM_HEX, device: alice.id }]);
		assert.deepEqual(a.holder.dialogControllers(), []);
	});
});

// unit-status and notice (Unattended devices): the unattended device reports its units to its dispatch controllers every minute and on a change, and tells them what went wrong, once.
describe("unit-status and notices", () => {
	async function start(trust: Record<string, "reply" | "forward" | "dispatch"> = { [alice.id]: "dispatch", [bob.id]: "reply" }) {
		world();
		const clock = fakeClock(), d = rig("dave", trust), a = rig("alice"), b = rig("bob");
		let units: UnitFacts[] = [{ unit: "moldplan", state: "live", monitors: [] }], report = "Deployed v1.2";
		const posted: { device: string; units: number }[] = [], asked: string[] = [];
		const reporter = (who: Rig) => new UnitReporter({
			controllers: () => who.holder.dialogControllers(), units: async (team) => (asked.push(team), units), report: () => report, now: clock.now, log: (e) => who.store.log(e),
			status: async (t, dev, u) => (posted.push({ device: dev, units: u.length }), who.holder.sendUnitStatus(t, dev, u)), notice: (t, dev, n) => who.holder.sendDialog(t, dev, "notice", n),
		});
		await Promise.all([d.holder.start(), a.holder.start(), b.holder.start()]);
		return { clock, d, a, b, reporter: reporter(d), attended: reporter(a), posted, asked, set: (u: UnitFacts[], r = report) => ((units = u), (report = r)) };
	}

	test("the status goes to the controller at dispatch, again on a change and after a minute, never twice for nothing", async () => {
		const { clock, a, b, reporter, posted, set } = await start();
		await reporter.tick();
		await until(() => a.holder.summary().units.length === 1, 3000, "the status on alice");
		assert.deepEqual(a.holder.summary().units[0], { team: TEAM_HEX, device: dave.id, units: [{ unit: "moldplan", state: "live", monitors: [], report: "Deployed v1.2" }] });
		assert.equal(b.holder.summary().units.length, 0, "bob is at reply: no status");
		await reporter.tick();
		clock.advance(STATUS_EVERY_MS - 1);
		await reporter.tick();
		assert.equal(posted.length, 1, "nothing changed and the minute has not passed");
		set([{ unit: "moldplan", state: "working", monitors: ["tail -f log"] }]);
		await reporter.tick();
		assert.equal(posted.length, 2, "a change goes at once");
		await until(() => a.holder.summary().units[0]?.units[0]?.state === "working", 3000, "the change on alice");
		clock.advance(STATUS_EVERY_MS);
		await reporter.tick();
		assert.equal(posted.length, 3, "a minute later it goes again");
		set([{ unit: "moldplan", state: "working", monitors: [] }], "x".repeat(6000));
		await reporter.tick();
		await until(() => (a.holder.summary().units[0]?.units[0]?.report.length ?? 0) > 0 && a.holder.summary().units[0]!.units[0]!.monitors.length === 0, 3000, "the long report");
		assert.equal(Buffer.byteLength(a.holder.summary().units[0]!.units[0]!.report), 4096, "the report is cut to 4 KB");
	});

	test("the units are read once per team in a pass, however many controllers it has", async () => {
		const { reporter, posted, asked } = await start({ [alice.id]: "dispatch", [bob.id]: "dispatch" });
		await reporter.tick();
		assert.deepEqual([posted.length, asked], [2, [TEAM_HEX]]);
	});

	test("a device that stopped reporting shows its last units marked stale after 3 minutes, and none after 30", async () => {
		const { a, reporter } = await start();
		await reporter.tick();
		await until(() => a.holder.summary().units.length === 1, 3000, "the status on alice");
		assert.equal(a.holder.summary().units[0]!.stale, undefined, "fresh");
		skew = 4 * 60_000;
		assert.equal(a.holder.summary().units[0]!.stale, true);
		assert.equal(a.holder.summary().units[0]!.units[0]!.unit, "moldplan", "its last units are still there");
		skew = 31 * 60_000;
		assert.equal(a.holder.summary().units.length, 0);
	});

	test("the key of a refusal notice holds a hash of its text, so the log never carries the text", async () => {
		const { d, reporter } = await start();
		const text = "A run could not start: /home/someone/secret-project/.pi/settings.json is a link to /etc/passwd";
		const n = runNotice({ kind: "refused", workspace: "w", label: "moldplan", ally: false, text });
		assert.equal(n.notice.text, text, "the controller reads the text");
		assert.ok(!n.key.includes("secret-project") && !n.key.includes("passwd"), n.key);
		assert.notEqual(n.key, runNotice({ kind: "refused", workspace: "w", label: "moldplan", ally: false, text: `${text}!` }).key);
		assert.equal(n.key, runNotice({ kind: "refused", workspace: "w", label: "moldplan", ally: false, text }).key, "the same refusal tells once");
		await reporter.notify(n.key, n.notice);
		const logged = events(d).filter((e) => e.event === "notice");
		assert.equal(logged.length, 1);
		assert.ok(!JSON.stringify(logged).includes("secret-project"));
		assert.deepEqual([logged[0]!.kind, logged[0]!.unit], ["run-refused", "moldplan"]);
	});

	test("a notice goes once per trigger to the controllers at dispatch, and clears with the day", async () => {
		const { a, b, reporter } = await start();
		const n = runNotice({ kind: "ended", run: "r1", workspace: "w", label: "moldplan", ally: true, outcome: "crashed", detail: "pi exited without tower_done" });
		await reporter.notify(n.key, n.notice);
		await reporter.notify(n.key, n.notice);
		await until(() => a.holder.summary().alerts.some((x) => x.kind === "notice"), 3000, "the notice on alice");
		const alerts = a.holder.summary().alerts.filter((x) => x.kind === "notice");
		assert.equal(alerts.length, 1);
		assert.deepEqual([alerts[0]!.data.what, alerts[0]!.data.unit, alerts[0]!.data.text, alerts[0]!.data.label], ["run-crashed", "moldplan", "An ally run crashed: pi exited without tower_done", "ci-box"]);
		assert.equal(b.holder.summary().alerts.some((x) => x.kind === "notice"), false);
		const trust = runNotice({ kind: "ended", run: "r2", workspace: "w", label: "moldplan", ally: false, outcome: "crashed", detail: "No trust decision for /p within 10 minutes" });
		assert.equal(trust.notice.kind, "trust-unanswered");
		assert.equal(runNotice({ kind: "refused", workspace: "w", label: "moldplan", ally: false, text: "A run could not start: x" }).notice.kind, "run-refused");
	});

	test("an attended computer sends no status and no notice", async () => {
		const { a, attended, posted } = await start();
		await attended.tick();
		await attended.notify("k", { kind: "run-crashed", unit: "u", text: "t" });
		assert.equal(posted.length, 0);
		assert.equal(a.holder.summary().alerts.some((x) => x.kind === "notice"), false);
	});

	test("a dialog unanswered for 30 minutes and an oversize one are told once; an answered one is not", async () => {
		const { clock, d, a, reporter } = await start();
		const h = fakeHub(), f = new DialogForwarder({ hub: h.hub, read: async () => {}, controllers: () => d.holder.dialogControllers(), post: (t, dev, k, p) => d.holder.sendDialog(t, dev, k, p), log: (e) => d.store.log(e), now: clock.now, notice: (k, n) => reporter.notify(k, n) });
		d.sink = (x) => f.answer(x);
		const noticesOnAlice = () => a.holder.summary().alerts.filter((x) => x.kind === "notice");
		h.open("D1");
		h.open("D2");
		await f.tick();
		await until(() => a.holder.dialogRequests().length === 2, 3000, "both on alice");
		clock.advance(UNANSWERED_MS - 1);
		await f.tick();
		assert.equal(noticesOnAlice().length, 0);
		assert.deepEqual(await a.holder.answerDialog(dave.id, "D2", selectDigest(SELECT), JSON.stringify({ choice: 0 })), { ok: true });
		await until(() => h.sent.length === 1, 3000, "D2 answered");
		clock.advance(1);
		await f.tick();
		await f.tick();
		await until(() => noticesOnAlice().length === 1, 3000, "the unanswered notice");
		assert.equal(noticesOnAlice()[0]!.data.what, "dialog-unanswered");
		const big = { title: "x".repeat(70_000), choices: [{ label: "ok" }] };
		h.open("BIG", answerable("BIG", { digest: selectDigest(big), select: big }));
		await f.tick();
		await f.tick();
		await until(() => noticesOnAlice().length === 2, 3000, "the oversize notice");
		assert.equal(noticesOnAlice().filter((x) => x.data.what === "dialog-oversize").length, 1);
	});
});
