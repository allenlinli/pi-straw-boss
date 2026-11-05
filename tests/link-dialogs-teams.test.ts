import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Offer, Sent } from "../src/dialogs.ts";
import { DialogForwarder, DialogViews, REFRESH_MS } from "../src/link/dialogs-out.ts";
import type { DialogClose, DialogOpen } from "../src/link/kinds.ts";
import type { Answerable } from "../src/owners.ts";
import { selectDigest } from "../src/owners.ts";

// A controller that belongs to two teams of one box (the 2026-11-05 trial: the Mac and the box share teams 91347f and f43751): the box tells it a question once, and the controller keeps one card for it
// (docs/specs/2026-11-05-link-shared-box.md, Who is told). Without it the Mac got two `dialog-open`s for one question, and the box's `dialog-seen` line named the package instead of the unit.

const A = "a".repeat(16), B = "b".repeat(16);
const SELECT = { title: "Pick one", choices: [{ label: "Vanilla" }, { label: "Mint" }] };

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
interface Post { team: string; to: string; kind: string; id: string; owner?: string; by?: string }
function rig(list: { team: string; device: string }[], over: Partial<ConstructorParameters<typeof DialogForwarder>[0]> = {}) {
	const h = fakeHub(), posts: Post[] = [], logs: Record<string, unknown>[] = [], state = { list };
	let now = 1_000_000;
	const f = new DialogForwarder({
		hub: h.hub, read: async () => {}, controllers: () => state.list, now: () => now,
		post: async (team, device, kind: "dialog-open" | "dialog-close", payload: DialogOpen | DialogClose) => void posts.push({ team, to: device, kind, id: payload.dialogId, ...("owner" in payload ? { owner: payload.owner } : {}), ...("by" in payload ? { by: payload.by } : {}) }),
		log: (e) => void logs.push(e), ...over,
	});
	return { h, f, posts, logs, state, advance: (ms: number) => void (now += ms) };
}
const opens = (posts: Post[]) => posts.filter((p) => p.kind === "dialog-open");
const lines = (logs: Record<string, unknown>[], event: string) => logs.filter((e) => e.event === event);

describe("a controller in two teams of the box is told once", () => {
	test("a question is posted to the device once, not once per team; the refresh and the close follow on the same team", async () => {
		const r = rig([{ team: A, device: "mac" }, { team: B, device: "mac" }]);
		r.h.open("D1");
		await r.f.poll();
		assert.deepEqual(opens(r.posts).map((p) => [p.team, p.to]), [[A, "mac"]], "one open, on the first team");
		r.advance(REFRESH_MS + 1);
		await r.f.poll();
		assert.deepEqual(opens(r.posts).map((p) => [p.team, p.to]), [[A, "mac"], [A, "mac"]], "the refresh is on the team it was told on");
		r.h.close("D1", "remote");
		await r.f.poll();
		assert.deepEqual(r.posts.filter((p) => p.kind === "dialog-close").map((p) => [p.team, p.to, p.by]), [[A, "mac", "remote"]], "and one close ends the card");
		assert.deepEqual(lines(r.logs, "dialog-ended").map((e) => e.sent), [1]);
	});

	test("two devices are still two posts, each on one team", async () => {
		const r = rig([{ team: A, device: "mac" }, { team: B, device: "mac" }, { team: B, device: "pc" }]);
		r.h.open("D1");
		await r.f.poll();
		assert.deepEqual(opens(r.posts).map((p) => [p.team, p.to]).sort(), [[A, "mac"], [B, "pc"]]);
	});

	test("a controller listed on the team it was told on stays there; one that lost that team is withdrawn there and told on the other", async () => {
		const r = rig([{ team: A, device: "mac" }, { team: B, device: "mac" }]);
		r.h.open("D1");
		await r.f.poll();
		r.state.list = [{ team: B, device: "mac" }, { team: A, device: "mac" }]; // the order changes: nothing moves
		await r.f.poll();
		assert.equal(opens(r.posts).length, 1, "no second open for the order of a list");
		r.state.list = [{ team: B, device: "mac" }];
		await r.f.poll();
		assert.deepEqual(r.posts.map((p) => [p.kind, p.team, p.by]), [["dialog-open", A, undefined], ["dialog-close", A, "withdrawn"], ["dialog-open", B, undefined]]);
	});

	test("a team where the controller is online is told before one where it is not", async () => {
		const r = rig([{ team: A, device: "mac" }, { team: B, device: "mac" }], { online: (team) => team === B });
		r.h.open("D1");
		await r.f.poll();
		assert.deepEqual(opens(r.posts).map((p) => [p.team, p.to]), [[B, "mac"]]);
	});
});

describe("the box's log names the unit that asks", () => {
	test("dialog-seen carries what the controllers are told asks, and the package apart; dialog-unrouted does the same", async () => {
		const r = rig([], { unit: () => "main - docs", dispatcher: async () => undefined });
		r.h.open("D1", "unit-7");
		await r.f.poll();
		r.state.list = [{ team: A, device: "mac" }];
		await r.f.poll();
		assert.deepEqual(lines(r.logs, "dialog-seen").map((e) => [e.dialog, e.unit, e.owner, e.package]), [["D1", "unit-7", "main - docs", "rpiv"]]);
		assert.deepEqual(lines(r.logs, "dialog-unrouted").map((e) => [e.dialog, e.owner]), [["D1", "main - docs"]]);
	});
});

describe("the controller keeps one card for one question", () => {
	const view = (team: string) => ({ team, device: "box", dialogId: "D1", digest: "d".repeat(64), owner: "main - docs", dialog: "{}", at: 1 });
	test("the same question from two teams is one view, new once, and one close ends it", () => {
		const v = new DialogViews();
		assert.deepEqual([v.put(view(A)), v.put(view(B))], [true, false], "the second is not news");
		assert.equal(v.list(() => true, 2).length, 1);
		v.close("box", "D1", "remote", 5);
		assert.deepEqual(v.list(() => true, 6).map((x) => x.closed?.by), ["remote"], "the one card is closed");
	});
});
