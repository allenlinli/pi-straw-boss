import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Offer, Sent } from "../src/dialogs.ts";
import { DialogForwarder } from "../src/link/dialogs-out.ts";
import type { DialogClose, DialogOpen, Notice } from "../src/link/kinds.ts";
import { EVERYONE, reaches } from "../src/link/scope.ts";
import { runNotice, UnitReporter } from "../src/link/unitstatus.ts";
import type { Answer, Answerable } from "../src/owners.ts";
import { selectDigest } from "../src/owners.ts";

// G3 (docs/specs/2026-11-05-link-shared-box.md, Who is told): on a box shared by several devs a unit's question and a run's notice go to the controller that dispatched it and to the team's admins, and an answer
// from anyone else is refused by the box. Devices: dev1 and dev2 are two controllers at dispatch, boss is an admin of the team, and T is the team.

const T = "t".repeat(16);
const SELECT = { title: "Pick one", choices: [{ label: "Vanilla" }, { label: "Mint" }] };
const controllers = [{ team: T, device: "dev1" }, { team: T, device: "dev2" }, { team: T, device: "boss" }];
const admin = (team: string, device: string) => team === T && device === "boss";

test("reaches: everyone, the dispatcher, the admins; a scope with no device is the admins' alone; the team must agree", () => {
	const dev1 = { team: T, device: "dev1" }, dev2 = { team: T, device: "dev2" }, boss = { team: T, device: "boss" }, other = { team: "u".repeat(16), device: "dev1" };
	assert.deepEqual([dev1, dev2, boss].map((c) => reaches(EVERYONE, c, admin)), [true, true, true]);
	assert.deepEqual([dev1, dev2, boss].map((c) => reaches({ device: "dev1" }, c, admin)), [true, false, true]);
	assert.deepEqual([dev1, dev2, boss].map((c) => reaches({}, c, admin)), [false, false, true], "nobody dispatched it: the admins only");
	assert.equal(reaches({ device: "dev1", team: T }, other, admin), false, "the same device in another team is not the dispatcher");
	assert.equal(reaches({ device: "dev1", team: T }, dev1, admin), true);
});

test("reaches: an admin of another team is not a recipient of a question that names its team (g346-F001)", () => {
	const U = "u".repeat(16), admins = (team: string, device: string) => (team === T && device === "boss") || (team === U && device === "boss2");
	const boss2 = { team: U, device: "boss2" }, boss = { team: T, device: "boss" };
	assert.equal(reaches({ device: "dev1", team: T }, boss2, admins), false, "the admin of team U gets nothing of team T's dispatcher");
	assert.equal(reaches({ device: "dev1", team: T }, boss, admins), true);
	assert.equal(reaches({ team: T }, boss2, admins), false, "a unit of team T that no device dispatched: team T's admins");
	assert.equal(reaches({}, boss2, admins), true, "a scope that names no team (the box's own unit) is every admin's");
});

function fakeHub() {
	const offers = new Map<string, Offer>(), sent: { key: string; answer: Answer }[] = [];
	const hub = {
		onChange: () => () => {},
		answerable: () => [...offers.values()],
		outcome: (id: string) => (offers.has(id) ? { open: true as const } : { open: false as const, by: "gone" }),
		send: async (key: string, _t: unknown, answer: Answer): Promise<Sent> => (sent.push({ key, answer }), { status: 200, body: { outcome: "accepted" } }),
	};
	const answerable = (id: string): Answerable => ({ dialog: id, digest: selectDigest(SELECT), select: SELECT });
	return { hub, sent, open: (id: string, key: string) => void offers.set(id, { key, owner: "rpiv", target: { from: key, bridgeId: "B", answer: answerable(id) } }), close: (id: string) => void offers.delete(id) };
}
interface Post { to: string; kind: string; id: string }
function rig(over: Partial<ConstructorParameters<typeof DialogForwarder>[0]> = {}, who: Record<string, { device: string; team?: string } | undefined> = {}) {
	const h = fakeHub(), posts: Post[] = [], logs: Record<string, unknown>[] = [], notices: { key: string; notice: Notice; scope: unknown }[] = [];
	let now = 1_000_000;
	const f = new DialogForwarder({
		hub: h.hub, read: async () => {}, controllers: () => controllers, now: () => now,
		post: async (_team, device, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose) => void posts.push({ to: device, kind, id: payload.dialogId }),
		log: (e) => void logs.push(e), notice: (key, notice, scope) => void notices.push({ key, notice, scope }),
		dispatcher: async (key) => who[key], admin, ...over,
	});
	return { h, f, posts, logs, notices, advance: (ms: number) => void (now += ms) };
}
const to = (posts: Post[], id: string, kind = "dialog-open") => posts.filter((p) => p.id === id && p.kind === kind).map((p) => p.to).sort();
const reply = (id: string, answerId: string) => ({ team: T, dialogId: id, digest: selectDigest(SELECT), answer: JSON.stringify({ choice: 1 }), answerId });

describe("dialog forwarding on a shared box", () => {
	test("a question goes to the controller whose unit asked and to the admin, not to the other controller; an unattributed unit's goes to the admin alone", async () => {
		const r = rig({}, { U1: { device: "dev1" }, U2: { device: "dev2", team: T }, U3: undefined });
		r.h.open("D1", "U1");
		r.h.open("D2", "U2");
		r.h.open("D3", "U3");
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1"), ["boss", "dev1"]);
		assert.deepEqual(to(r.posts, "D2"), ["boss", "dev2"]);
		assert.deepEqual(to(r.posts, "D3"), ["boss"]);
	});

	test("an answer from a controller the question was not for is refused by the box and does not use the question up; the dispatcher's and the admin's are carried", async () => {
		const r = rig({}, { U1: { device: "dev1" } });
		r.h.open("D1", "U1");
		await r.f.poll();
		await r.f.answer({ ...reply("D1", "a".repeat(32)), from: "dev2" });
		assert.equal(r.h.sent.length, 0, "nothing reaches the session");
		assert.deepEqual(r.logs.filter((e) => e.event === "drop").map((e) => [e.reason, e.from]), [["dialog-answer-not-recipient", "dev2"]]);
		await r.f.answer({ ...reply("D1", "a".repeat(32)), from: "dev1" });
		assert.equal(r.h.sent.length, 1, "the refused answer id was not spent, and the dispatcher's answer is carried");
		const admin1 = rig({}, { U1: { device: "dev1" } });
		admin1.h.open("D1", "U1");
		await admin1.f.poll();
		await admin1.f.answer({ ...reply("D1", "b".repeat(32)), from: "boss" });
		assert.equal(admin1.h.sent.length, 1, "an admin may answer any question");
	});

	test("an answer for an unattributed unit's question is the admin's alone", async () => {
		const r = rig({}, {});
		r.h.open("D1", "U9");
		await r.f.poll();
		await r.f.answer({ ...reply("D1", "a".repeat(32)), from: "dev1" });
		assert.equal(r.h.sent.length, 0);
		await r.f.answer({ ...reply("D1", "c".repeat(32)), from: "boss" });
		assert.equal(r.h.sent.length, 1);
	});

	test("a unit found to be someone's after the first pass moves the question: the others are told it is withdrawn, the dispatcher gets it", async () => {
		const who: Record<string, { device: string } | undefined> = {};
		const r = rig({}, who);
		r.h.open("D1", "U1");
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1"), ["boss"], "unattributed at first");
		who.U1 = { device: "dev2" };
		r.advance(1);
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1"), ["boss", "dev2"]);
		assert.deepEqual(to(r.posts, "D1", "dialog-close"), [], "the admin stays a recipient: nobody is withdrawn");
	});

	test("a controller that stops being the dispatcher's team or an admin is withdrawn the question it had", async () => {
		const who = { U1: { device: "dev1" } };
		let admins = true;
		const r = rig({ admin: (team, device) => admins && admin(team, device) }, who);
		r.h.open("D1", "U1");
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1"), ["boss", "dev1"]);
		admins = false;
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1", "dialog-close"), ["boss"], "the demoted admin is told the question is withdrawn");
		await r.f.answer({ ...reply("D1", "d".repeat(32)), from: "boss" });
		assert.equal(r.h.sent.length, 0, "and may not answer it");
	});

	test("the notices a question makes are scoped like the question: oversize and unanswered go to its dispatcher and the admins", async () => {
		const r = rig({}, { U1: { device: "dev1", team: T } });
		r.h.open("D1", "U1");
		await r.f.poll();
		r.advance(31 * 60_000);
		await r.f.poll();
		assert.deepEqual(r.notices.map((n) => [n.notice.kind, n.scope]), [["dialog-unanswered", { device: "dev1", team: T }]]);
	});

	test("a question nobody can be told of is logged once and stays open; its unanswered notice is retried until somebody is told (g346-F005d)", async () => {
		let admins = false;
		const told: string[] = [];
		const r = rig({ admin: (team, device) => admins && admin(team, device), notice: (key) => { if (!admins) return false; told.push(key); } }, {});
		r.h.open("D1", "U9");
		await r.f.poll();
		await r.f.poll();
		assert.deepEqual(r.posts, [], "nobody is told: never widened to the dispatch controllers");
		assert.equal(r.logs.filter((e) => e.event === "dialog-unrouted").length, 1, "the box's own log says it waits");
		r.advance(31 * 60_000);
		await r.f.poll();
		assert.deepEqual(told, []);
		admins = true;
		await r.f.poll();
		assert.deepEqual(told, ["unanswered/D1"], "the notice goes once an admin is there");
		assert.deepEqual(to(r.posts, "D1"), ["boss"]);
	});

	test("with no dispatcher lookup (an attended computer, an older wiring) every controller gets every question, as before", async () => {
		const r = rig({ dispatcher: undefined, admin: undefined }, {});
		r.h.open("D1", "U1");
		await r.f.poll();
		assert.deepEqual(to(r.posts, "D1"), ["boss", "dev1", "dev2"]);
		await r.f.answer({ ...reply("D1", "e".repeat(32)), from: "dev2" });
		assert.equal(r.h.sent.length, 1);
	});
});

describe("notices on a shared box", () => {
	function reporter() {
		const sent: { to: string; kind: string }[] = [];
		const rep = new UnitReporter({
			controllers: () => controllers, units: async () => [], report: () => "", status: async () => {}, now: () => 1, log: () => {}, admin,
			notice: async (_team, device, n) => void sent.push({ to: device, kind: n.kind }),
		});
		return { rep, sent, got: () => sent.map((s) => s.to).sort() };
	}
	const notice: Notice = { kind: "run-crashed", unit: "Alpha", text: "An ally run crashed" };

	test("a notice for one device's run goes to that controller and the admins, once", async () => {
		const { rep, got } = reporter();
		await rep.notify("run/1", notice, { device: "dev1" });
		await rep.notify("run/1", notice, { device: "dev1" });
		assert.deepEqual(got(), ["boss", "dev1"]);
	});
	test("a notice for a run nobody dispatched goes to the admins; EVERYONE reaches every controller", async () => {
		const a = reporter();
		await a.rep.notify("run/2", notice, {});
		assert.deepEqual(a.got(), ["boss"]);
		const b = reporter();
		await b.rep.notify("run/3", notice, EVERYONE);
		assert.deepEqual(b.got(), ["boss", "dev1", "dev2"]);
	});
	test("notify says whether it told anybody (g346-F005c)", async () => {
		const none = new UnitReporter({ controllers: () => [{ team: T, device: "dev2" }], units: async () => [], report: () => "", status: async () => {}, notice: async () => {}, now: () => 1, log: () => {}, admin });
		assert.equal(await none.notify("run/5", notice, {}), false);
		const some = reporter();
		assert.equal(await some.rep.notify("run/5", notice, {}), true);
		assert.equal(await some.rep.notify("run/5", notice, {}), false, "already told");
	});
	test("a notice with nobody to reach is not remembered as told", async () => {
		const only = new UnitReporter({ controllers: () => [{ team: T, device: "dev2" }], units: async () => [], report: () => "", status: async () => {}, notice: async () => {}, now: () => 1, log: () => {}, admin });
		await only.notify("run/4", notice, { device: "dev1" });
		const sent: string[] = [];
		const again = new UnitReporter({ controllers: () => controllers, units: async () => [], report: () => "", status: async () => {}, notice: async (_t, d) => void sent.push(d), now: () => 1, log: () => {}, admin });
		await again.notify("run/4", notice, { device: "dev1" });
		assert.deepEqual(sent.sort(), ["boss", "dev1"]);
	});
	test("runNotice names the device and team of an ally run's signal, and nothing for a run nobody dispatched", () => {
		const ally = runNotice({ kind: "ended", run: "r1", workspace: "w", label: "Alpha", ally: true, outcome: "crashed", device: "dev1", team: T });
		assert.deepEqual(ally.scope, { device: "dev1", team: T });
		assert.deepEqual(runNotice({ kind: "ended", run: "r2", workspace: "w", label: "Alpha", ally: false, outcome: "crashed" }).scope, {});
		assert.deepEqual(runNotice({ kind: "refused", workspace: "w", label: "Alpha", ally: true, text: "no", device: "dev2", team: T }).scope, { device: "dev2", team: T });
		assert.deepEqual(runNotice({ kind: "refused", workspace: "w", label: "Alpha", ally: false, text: "no" }).scope, {});
	});
});
