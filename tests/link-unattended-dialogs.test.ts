import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Offer, Sent } from "../src/dialogs.ts";
import { DialogForwarder } from "../src/link/dialogs-out.ts";
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
	let change = () => {};
	const hub = {
		onChange: (cb: () => void) => ((change = cb), () => {}),
		answerable: () => [...offers.values()],
		outcome: (id: string) => (closed.has(id) ? { open: false as const, by: closed.get(id)! } : offers.has(id) ? { open: true as const } : { open: false as const, by: "gone" }),
		send: async (key: string, _t: unknown, answer: Answer): Promise<Sent> => (sent.push({ key, answer }), { status: 200, body: { outcome: "accepted" } }),
	};
	return {
		hub, sent, change: () => change(),
		open: (id: string, a: Answerable = answerable(id), owner = "rpiv") => void offers.set(id, { key: "S", owner, target: { from: "S", bridgeId: "B", answer: a } }),
		close: (id: string, by = "remote") => void (closed.set(id, by), offers.delete(id)),
	};
}
function forwarder(dave: Rig, h: ReturnType<typeof fakeHub>) {
	const f = new DialogForwarder({ hub: h.hub, read: async () => {}, controllers: () => dave.holder.dialogControllers(), post: (t, d, k, p) => dave.holder.sendDialog(t, d, k, p), log: (e) => dave.store.log(e) });
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
