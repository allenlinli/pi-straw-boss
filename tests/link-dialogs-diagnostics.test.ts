import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Offer, Sent } from "../src/dialogs.ts";
import { DialogForwarder, MAX_OPEN, PASS_STUCK_MS, UNANSWERED_MS } from "../src/link/dialogs-out.ts";
import type { DialogClose, DialogOpen, Notice } from "../src/link/kinds.ts";
import type { Answerable } from "../src/owners.ts";
import { selectDigest } from "../src/owners.ts";

// What the box's own log says of a forwarded question (docs/how-it-works.md, Unattended devices): a forward that works leaves no mark in the controller's absence, so every step of it is a line with ids and counts, and a pass that
// stops answering is said, then let go. The lines carry no word of a question.

const T = "t".repeat(16);
const SELECT = { title: "Pick one - the secret title", choices: [{ label: "Vanilla" }, { label: "Mint" }] };
const boss = { team: T, device: "boss" };

function fakeHub() {
	const offers = new Map<string, Offer>(), closed = new Map<string, string>();
	const hub = {
		onChange: () => () => {},
		answerable: () => [...offers.values()],
		outcome: (id: string) => (closed.has(id) ? { open: false as const, by: closed.get(id)! } : offers.has(id) ? { open: true as const } : { open: false as const, by: "gone" }),
		send: async (): Promise<Sent> => ({ status: 200, body: { outcome: "accepted" } }),
	};
	const answerable = (id: string): Answerable => ({ dialog: id, digest: selectDigest(SELECT), select: SELECT });
	return { hub, open: (id: string, key = "U") => void offers.set(id, { key, owner: "rpiv", target: { from: key, bridgeId: "B", answer: answerable(id) } }), close: (id: string, by = "local") => void (closed.set(id, by), offers.delete(id)) };
}
interface Post { to: string; kind: string; id: string; owner?: string }
function rig(over: Partial<ConstructorParameters<typeof DialogForwarder>[0]> = {}, start: { list: { team: string; device: string }[]; known: boolean } = { list: [boss], known: true }) {
	const h = fakeHub(), posts: Post[] = [], logs: Record<string, unknown>[] = [], notices: { key: string; notice: Notice }[] = [], state = { ...start };
	let now = 1_000_000;
	const f = new DialogForwarder({
		hub: h.hub, read: async () => {}, controllers: () => state.list, controllersKnown: () => state.known, now: () => now,
		post: async (_team, device, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose) => void posts.push({ to: device, kind, id: payload.dialogId, ...("owner" in payload ? { owner: payload.owner } : {}) }),
		log: (e) => void logs.push(e), notice: (key, notice) => void notices.push({ key, notice }), ...over,
	});
	return { h, f, posts, logs, notices, state, advance: (ms: number) => void (now += ms) };
}
const lines = (logs: Record<string, unknown>[], event: string) => logs.filter((e) => e.event === event);

describe("the forwarder says what it sees", () => {
	test("who it sees is a line at the first pass and again only when the count or the known flag changes", async () => {
		const r = rig({}, { list: [], known: true });
		await r.f.poll();
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-controllers").map((e) => [e.count, e.known]), [[0, true]], "a box with nobody at dispatch says so once");
		r.state.list = [boss];
		await r.f.poll();
		r.state.list = [boss];
		await r.f.poll();
		r.state.known = false;
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-controllers").map((e) => [e.count, e.known]), [[0, true], [1, true], [1, false]]);
	});

	test("a question is a line when the forwarder first sees it, a line per controller it is posted to, and a line when it ends; none holds the question", async () => {
		const r = rig({}, { list: [boss, { team: T, device: "dev" }], known: true });
		r.h.open("D1", "unit-7");
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-seen").map((e) => [e.dialog, e.unit, e.owner]), [["D1", "unit-7", "rpiv"]]);
		assert.deepEqual(lines(r.logs, "dialog-sent").map((e) => [e.kind, e.dialog, e.team, e.to]).sort(), [["dialog-open", "D1", T, "boss"], ["dialog-open", "D1", T, "dev"]]);
		await r.f.poll();
		assert.equal(lines(r.logs, "dialog-seen").length, 1, "seen once");
		assert.equal(lines(r.logs, "dialog-sent").length, 2, "and not posted again until the refresh");
		r.h.close("D1", "remote");
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-ended").map((e) => [e.dialog, e.by, e.sent]), [["D1", "remote", 2]]);
		assert.deepEqual(lines(r.logs, "dialog-sent").map((e) => e.kind).sort(), ["dialog-close", "dialog-close", "dialog-open", "dialog-open"]);
		assert.ok(!JSON.stringify(r.logs).includes("secret title"), "no word of the question");
	});

	test("a post that fails is its own line and not a sent one", async () => {
		const r = rig({ post: async () => { throw new Error("The link holder is not running"); } });
		r.h.open("D1");
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-post-failed").map((e) => [e.kind, e.dialog]), [["dialog-open", "D1"]]);
		assert.equal(lines(r.logs, "dialog-sent").length, 0);
	});

	test("the room for open questions used up is a line, once, until it frees", async () => {
		const r = rig();
		for (let i = 0; i < MAX_OPEN + 2; i++) r.h.open(`D${i}`);
		await r.f.poll();
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-full").map((e) => e.open), [MAX_OPEN]);
		assert.equal(lines(r.logs, "dialog-seen").length, MAX_OPEN);
		r.h.close("D0");
		await r.f.poll();
		await r.f.poll();
		assert.equal(lines(r.logs, "dialog-seen").length, MAX_OPEN + 1, "a freed place is taken by the next");
		assert.equal(lines(r.logs, "dialog-full").length, 2, "and the room used up again is said again");
	});
});

describe("a pass that does not settle", () => {
	/** A `read` whose first call waits for `release`, then every call answers at once. */
	function stuckRead() {
		let release!: () => void, calls = 0;
		const first = new Promise<void>((resolve) => (release = resolve));
		return { read: () => (calls++ === 0 ? first : Promise.resolve()), release: () => release(), calls: () => calls };
	}

	test("a second look inside the limit waits on the pass in flight; one past it logs where the pass waits, lets it go, and forwards with a pass of its own", async () => {
		const s = stuckRead(), r = rig({ read: s.read });
		r.h.open("D1");
		const stuck = r.f.poll();
		r.advance(PASS_STUCK_MS - 1);
		void r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-pass-stuck"), [], "inside the limit it is the same pass");
		assert.equal(r.posts.length, 0);
		r.advance(1);
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-pass-stuck").map((e) => [e.step, e.ms]), [["read", PASS_STUCK_MS]]);
		assert.deepEqual(r.posts.map((p) => [p.kind, p.id, p.to]), [["dialog-open", "D1", "boss"]], "the new pass forwarded it");
		s.release();
		await stuck;
		assert.equal(r.posts.length, 1, "the pass let go stops where it stands: nothing is posted twice");
	});

	test("the pass let go does not clear the new pass: a look while the new one is in flight still waits on it", async () => {
		const s = stuckRead();
		let gate!: () => void;
		// The first read never returns, the second waits at the gate, and the rest answer at once (the look that overlaps the fresh pass makes it run once more).
		const r = rig({ read: () => (s.calls() === 1 && !gate ? (s.read(), new Promise<void>((resolve) => (gate = resolve))) : s.read()) });
		r.h.open("D1");
		const stuck = r.f.poll();
		r.advance(PASS_STUCK_MS);
		const fresh = r.f.poll(); // lets the stuck pass go and starts a pass that waits at the gate
		s.release();
		await stuck; // the let-go pass ends: its end must not clear `polling` of the fresh one
		void r.f.poll();
		assert.equal(r.posts.length, 0, "the fresh pass is still the one in flight");
		assert.equal(lines(r.logs, "dialog-pass-stuck").length, 1);
		gate();
		await fresh;
		assert.equal(r.posts.length, 1);
	});

	test("a step other than the read is named too, and a post that never returned is made again by the pass that replaces it", async () => {
		let posts = 0;
		const r = rig({ post: (...args) => (posts++ === 0 ? new Promise<void>(() => {}) : Promise.resolve(void r.posts.push({ to: args[1], kind: args[2], id: args[3].dialogId }))) });
		r.h.open("D1");
		void r.f.poll();
		await new Promise((resolve) => setImmediate(resolve)); // the pass reaches its post
		r.advance(PASS_STUCK_MS);
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-pass-stuck").map((e) => e.step), ["post"]);
		assert.deepEqual(r.posts.map((p) => [p.kind, p.id, p.to]), [["dialog-open", "D1", "boss"]], "the controller was marked as sent and is sent again at once, not in ten minutes");
	});
});

describe("a pass let go does not lose what it had not finished", () => {
	const dev = { team: T, device: "dev" };
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	/** A post that records itself, except the `n`th call of `kind`, which never returns. */
	function hangAt(kind: string, n: number) {
		let seen = 0;
		const calls: Post[] = [];
		return { calls, post: (_team: string, device: string, k: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose) => (k === kind && seen++ === n ? new Promise<void>(() => {}) : Promise.resolve(void calls.push({ to: device, kind: k, id: payload.dialogId }))) };
	}

	test("a close the released pass had not posted is posted by the pass that replaces it, to every controller", async () => {
		const h = hangAt("dialog-close", 0), r = rig({ post: h.post }, { list: [boss, dev], known: true });
		r.h.open("D1");
		await r.f.poll();
		r.h.close("D1", "remote");
		void r.f.poll();
		await tick(); // the pass reaches the first close
		r.advance(PASS_STUCK_MS);
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-pass-stuck").map((e) => e.step), ["post"]);
		assert.deepEqual(h.calls.filter((p) => p.kind === "dialog-close").map((p) => p.to).sort(), ["boss", "dev"], "each controller got the close, though the dialog had left the open list");
		await r.f.poll();
		assert.equal(h.calls.filter((p) => p.kind === "dialog-close").length, 2, "and a close that was posted is not posted again");
	});

	test("a withdrawn close the released pass had not posted is posted by the pass that replaces it", async () => {
		const h = hangAt("dialog-close", 0), r = rig({ post: h.post }, { list: [boss, dev], known: true });
		r.h.open("D1");
		await r.f.poll();
		r.state.list = [boss];
		void r.f.poll();
		await tick();
		r.advance(PASS_STUCK_MS);
		await r.f.poll();
		assert.deepEqual(h.calls.filter((p) => p.kind === "dialog-close").map((p) => p.to), ["dev"]);
	});

	test("a close that failed is tried again at the next pass, and given up after a few failures", async () => {
		let fail = 1;
		const closes: string[] = [];
		const r = rig({ post: async (_t, device, kind) => { if (kind === "dialog-close") { if (fail > 0) { fail--; throw new Error("holder down"); } closes.push(device); } } });
		r.h.open("D1");
		await r.f.poll();
		r.h.close("D1");
		await r.f.poll();
		assert.deepEqual(closes, []);
		await r.f.poll();
		assert.deepEqual(closes, ["boss"], "the second pass posted it");
		await r.f.poll();
		assert.deepEqual(closes, ["boss"], "once");

		const always = rig({ post: async (_t, _d, kind) => { if (kind === "dialog-close") throw new Error("holder down"); } });
		always.h.open("D2");
		await always.f.poll();
		always.h.close("D2");
		for (let i = 0; i < 12; i++) await always.f.poll();
		assert.equal(lines(always.logs, "dialog-post-failed").length, 5, "five tries, then it is given up");
		assert.deepEqual(lines(always.logs, "dialog-close-dropped").map((e) => [e.dialog, e.reason]), [["D2", "failed"]]);
	});

	test("a pending close is given up when the card would have expired anyway", async () => {
		const h = hangAt("dialog-close", 0), r = rig({ post: h.post });
		r.h.open("D1");
		await r.f.poll();
		r.h.close("D1");
		void r.f.poll();
		await tick();
		r.advance(25 * 60_000 + 1);
		await r.f.poll();
		assert.deepEqual(h.calls.filter((p) => p.kind === "dialog-close"), [], "past OPEN_STALE_MS the card is gone at the controller, so no close is sent");
		assert.deepEqual(lines(r.logs, "dialog-close-dropped").map((e) => e.reason), ["stale"]);
	});

	test("a post that fails after its pass was let go does not erase the replacing pass's mark: the question is not sent twice", async () => {
		let first = true, reject!: (error: Error) => void;
		const opens: string[] = [];
		const r = rig({ post: (_t, device, kind) => (first ? ((first = false), new Promise<void>((_ok, no) => (reject = no))) : Promise.resolve(void (kind === "dialog-open" && opens.push(device)))) });
		r.h.open("D1");
		const stale = r.f.poll();
		await tick();
		r.advance(PASS_STUCK_MS);
		await r.f.poll();
		assert.deepEqual(opens, ["boss"], "the replacing pass posted it");
		reject(new Error("late failure"));
		await stale;
		r.advance(1000);
		await r.f.poll();
		assert.deepEqual(opens, ["boss"], "inside the refresh time it is not posted again");
	});

	test("at most one pass let go is outstanding: a second stuck pass is said once and not let go while the first still hangs", async () => {
		let reads = 0;
		const r = rig({ read: () => (++reads <= 2 ? new Promise<void>(() => {}) : Promise.resolve()) });
		r.h.open("D1");
		void r.f.poll();
		r.advance(PASS_STUCK_MS);
		void r.f.poll(); // lets the first go, starts the second, which hangs too
		assert.equal(reads, 2);
		for (let i = 0; i < 5; i++) {
			r.advance(PASS_STUCK_MS);
			void r.f.poll();
		}
		assert.equal(reads, 2, "no third pass while the first is still outstanding");
		assert.equal(lines(r.logs, "dialog-pass-stuck").length, 1);
		assert.deepEqual(lines(r.logs, "dialog-pass-hung").map((e) => e.step), ["read"], "said once");
	});
});

describe("the unit that asked", () => {
	test("a controller is told the unit's name as the question's owner, and the log says the same name, with the package that owns the dialog apart", async () => {
		const r = rig({ unit: (key) => (key === "unit-7" ? "main - docs" : undefined) });
		r.h.open("D1", "unit-7");
		r.h.open("D2", "unit-8");
		await r.f.poll();
		assert.deepEqual(r.posts.map((p) => [p.id, p.owner]).sort(), [["D1", "main - docs"], ["D2", "rpiv"]], "a unit with no name is told by its package, as before");
		assert.deepEqual(lines(r.logs, "dialog-seen").map((e) => [e.dialog, e.owner, e.package]), [["D1", "main - docs", "rpiv"], ["D2", "rpiv", "rpiv"]]);
	});

	test("the notice of a question unanswered for 30 minutes names the unit", async () => {
		const r = rig({ unit: () => "subagent - scout" });
		r.h.open("D1");
		await r.f.poll();
		r.advance(UNANSWERED_MS + 1);
		await r.f.poll();
		assert.deepEqual(r.notices.map((n) => n.notice.text), ["A question of subagent - scout has waited 30 minutes for an answer."]);
	});
});
