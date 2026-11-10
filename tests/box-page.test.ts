import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Base, RemoteBox, Unit } from "../src/net.ts";
import type { AllyCard } from "../gui/linkmodel.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { until } from "./fakes.ts";

// A remote (operate) base on the map (docs/specs/2026-11-07-link-operate.md §8), on the fake document: the device badge and team, the actions the box lets through, `unreachable` greyed with when it was last seen, `ended` as one line with its reason,
// the "Earlier runs" fold read from api/transcripts, and the box's ally card folded under it. Every word of a box is untrusted: it only ever becomes text, and no URL comes from it.

sessionGlobals();
// The fake document has neither a comment node nor `replaceWith`, which the ⋯ menus (gui/menu.ts) use.
Object.assign(document, { createComment: () => new El("#comment") });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const { baseEl, fillBase, loadBox } = await import("../gui/render.ts");
await loadBox(); // the remote base's parts are a chunk of their own: loaded here as the page loads it with the first remote base
const { useRuns } = await import("../gui/box.ts");
const { m } = await import("../gui/paraglide/messages.js");

const CAN = ["history", "input", "keys", "answer", "dequeue", "commands", "upload", "mirror", "dismiss", "close-unit", "close-tab"];
const box = (over: Partial<RemoteBox> = {}): RemoteBox => ({ device: "dev1", short: "a1b2c3", label: "agent-tower-01", team: "moldplan", scope: "team", can: CAN, state: "live", ...over });
const unit = (key: string, over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle", subs: [], ...over });
const remote = (over: Partial<Base> = {}, b: Partial<RemoteBox> = {}): Base => ({ id: "x0000000000000001", label: "Work", mark: "working", tower: null, tabs: [{ id: "x00000000000000t1", label: "api", units: [unit("x0000000000000a01", { subs: [unit("x0000000000000a02", { role: "subagent", ended: true, mark: "done" })] })] }], outposts: [], outside: [], box: box(b), ...over });
const local = (): Base => ({ id: "w1", label: "Harbor", mark: "idle", tower: null, tabs: [{ id: "w1:t1", label: "api", units: [unit("a01")] }], outposts: [], outside: [] });
const draw = (b: Base, under: AllyCard[] = []) => {
	const el = baseEl() as unknown as El;
	page.body.replaceChildren(el);
	fillBase(el as unknown as HTMLElement, b, { under });
	return el;
};
useRuns(async () => ({ rows: [] })); // the page does not reach for a network here
const one = (el: El, selector: string) => el.querySelector(selector)!;
const quit = (el: El, unitKey: string) => el.querySelectorAll(".unit").find((u) => u.dataset.key === unitKey)!.querySelector(".card > .quit-btn")!;
const rows = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ key: `x${String(i + 1).padStart(16, "0")}`, name: `run-${i + 1}`, role: "main", workspace: "Work", first: Date.now() - 3_600_000, last: Date.now() - 600_000 * (i + 1), size: 1024 })) });
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a remote base shows the box's badge (label and short id) and the team's name, a local base shows neither", () => {
	const el = draw(remote());
	assert.ok(el.classes.has("remote"));
	assert.equal(el.dataset.box, "live");
	assert.equal(one(el, ".box-line").hidden, false);
	assert.equal(one(el, ".box-dev").textContent, "agent-tower-01 · a1b2c3");
	assert.equal(one(el, ".box-team").textContent, m.box_team({ team: "moldplan" }));
	const plain = draw(local());
	assert.equal(plain.classes.has("remote"), false);
	assert.equal(plain.dataset.box, undefined);
	for (const part of [".box-line", ".box-runs", ".box-ally", ".box-ended"]) assert.ok(one(plain, part).hidden || one(plain, part).hasAttribute("hidden"), `${part} stays hidden on a local base (its markup says so; a browser reads the attribute as the property)`);
});

test("a remote base cannot be opened into, stashed or quit as a base (decision 9); a local one can", () => {
	const el = draw(remote());
	assert.equal(one(el, "header > .menu").hidden, true, "the base's Quit menu goes");
	assert.equal(one(el, ".spawn-btns").hidden, true, "+ Main, + Member and Stash go");
	assert.equal(one(el, ".tab-add").hidden, true, "a squad's + button goes");
	const plain = draw(local());
	assert.equal(one(plain, "header > .menu").hidden, false);
	assert.equal(one(plain, ".spawn-btns").hidden, false);
	assert.equal(one(plain, ".tab-add").hidden, false);
});

test("the ⋯ entries follow box.can: Quit unit, Dismiss and Quit squad each appear only when the box lists them", () => {
	const full = draw(remote());
	assert.equal(quit(full, "x0000000000000a01").hidden, false, "Quit a main");
	assert.equal(one(full, ".tab .menu").hidden, false, "Quit squad");
	const sub = full.querySelectorAll(".unit").find((u) => u.dataset.key === "x0000000000000a02")!.querySelector(".card > .quit-btn")!;
	assert.equal(sub.hidden, false);
	assert.equal(sub.dataset.close, "dismiss", "an ended subagent is dismissed, not quit");

	const noClose = draw(remote({}, { can: CAN.filter((c) => c !== "close-unit" && c !== "close-tab") }));
	assert.equal(quit(noClose, "x0000000000000a01").hidden, true, "no close-unit, no Quit on a main");
	assert.equal(one(noClose, ".tab .menu").hidden, true, "no close-tab, no Quit squad (and no empty ⋯)");
	assert.equal(one(noClose, ".tab .quit-btn").hidden, true, "the squad's Quit itself is hidden, not only its menu");
	assert.equal(one(full, ".tab .quit-btn").hidden, false);
	assert.equal(noClose.querySelectorAll(".unit").find((u) => u.dataset.key === "x0000000000000a02")!.querySelector(".card > .quit-btn")!.hidden, false, "Dismiss is still listed");

	const noDismiss = draw(remote({}, { can: CAN.filter((c) => c !== "dismiss") }));
	assert.equal(noDismiss.querySelectorAll(".unit").find((u) => u.dataset.key === "x0000000000000a02")!.querySelector(".card > .quit-btn")!.hidden, true, "no dismiss, no Dismiss");
	assert.equal(quit(noDismiss, "x0000000000000a01").hidden, false);

	const local1 = draw(local());
	assert.equal(quit(local1, "a01").hidden, false, "a local main keeps its Quit");
});

test("the tower's Quit is the box scope's: it needs `tower` in can", () => {
	const tower = { name: "tower", mark: "idle" as const, key: "x0000000000000f01", control: true, subs: [] };
	assert.equal(one(draw(remote({ tower }, { scope: "team" })), ".tower-quit").hidden, true);
	assert.equal(one(draw(remote({ tower }, { scope: "box", can: [...CAN, "tower"] })), ".tower-quit").hidden, false);
});

test("unreachable greys the base, says when it was last seen, and takes no action", () => {
	const seen = Date.now() - 125_000;
	const el = draw(remote({}, { state: "unreachable", seen }));
	assert.equal(el.dataset.box, "unreachable");
	assert.equal(one(el, ".box-seen").hidden, false);
	assert.equal(one(el, ".box-seen").textContent, `${m.box_unreachable()} · ${m.box_seen_pre()}2m${m.link_unit_ago()}`);
	assert.equal(one(el, ".box-seen .age").dataset.since, String(seen), "the page's clock keeps it current");
	assert.equal(quit(el, "x0000000000000a01").hidden, true, "a greyed base takes no Quit");
	assert.equal(one(el, ".tab .menu").hidden, true);
	const live = draw(remote());
	assert.equal(one(live, ".box-seen").hidden, true, "a live base does not say it");
});

test("ended is one line with its reason and nothing else of the base", () => {
	const ended = (why: string, label = "agent-tower-01") => draw({ id: "x00000000000000e1", label, mark: "unknown", tower: null, tabs: [], outposts: [], outside: [], box: box({ state: "ended", why, can: [], label }) });
	const revoked = ended("policy");
	assert.equal(revoked.dataset.box, "ended");
	assert.equal(one(revoked, ".box-ended").hidden, false);
	assert.equal(one(revoked, ".box-ended").textContent, m.box_ended_revoked());
	assert.equal(one(ended("roster"), ".box-ended").textContent, m.box_ended_revoked());
	assert.equal(one(ended("not-granted"), ".box-ended").textContent, m.box_ended_refused());
	assert.equal(one(ended("whatever"), ".box-ended").textContent, m.box_ended_other());
	for (const part of [".tabs", ".outposts", ".tower-subs", ".spawn-btns", ".tower-notices"]) assert.equal(one(revoked, part).hidden, true, `${part} is not drawn`);
	assert.equal(one(revoked, ".box-dev").textContent, "agent-tower-01 · a1b2c3", "the badge still says which machine");
	assert.equal(one(revoked, ".box-runs").hidden, true);
	// A live base after it brings the parts back.
	const el = draw(remote({ id: "x00000000000000e1" }, { state: "ended", why: "policy", can: [] }));
	fillBase(el as unknown as HTMLElement, remote({ id: "x00000000000000e1" }), { under: [] });
	assert.equal(one(el, ".box-ended").hidden, true);
	assert.equal(one(el, ".tabs").hidden, false);
});

test("the two ended words are the spec's, in zh-TW exactly, and every box string is in both languages", () => {
	const zh = JSON.parse(readFileSync(new URL("../gui/messages/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>, en = JSON.parse(readFileSync(new URL("../gui/messages/en.json", import.meta.url), "utf8")) as Record<string, string>;
	assert.equal(zh.box_ended_revoked, "操作權限已撤銷");
	assert.equal(zh.box_ended_refused, "這台機器不讓這部裝置操作");
	const keys = Object.keys(en).filter((k) => k.startsWith("box_"));
	assert.ok(keys.length >= 10, "the box strings exist");
	for (const k of keys) assert.ok(zh[k], `${k} in zh-TW`);
	assert.deepEqual(Object.keys(zh).filter((k) => k.startsWith("box_")).sort(), keys.sort(), "no string in one language only");
});

test("what a box says is text: a label with markup draws as that text, makes no element, and no URL or handler comes from it", () => {
	const evil = `<img src=x onerror=alert(1)>"><a href="javascript:alert(2)">`;
	const el = draw(remote({ label: evil, tabs: [{ id: "x00000000000000t1", label: evil, units: [unit("x0000000000000a01", { name: evil, note: evil })] }] }, { label: evil, team: evil, short: "<b>" }));
	assert.equal(one(el, ".box-dev").textContent, `${evil} · <b>`);
	assert.equal(one(el, ".box-team").textContent, m.box_team({ team: evil }));
	assert.equal(one(el, ".box-dev").children.length, 0);
	assert.equal(el.all((x) => x.tag === "img").length, 0);
	for (const a of el.all((x) => x.tag === "a")) assert.doesNotMatch(a.getAttribute("href") ?? "", /javascript|onerror|alert/, "no link carries the box's text");
	assert.equal(el.all((x) => [...x.attrs.keys()].some((k) => k.startsWith("on"))).length, 0, "no handler attribute");
});

test("Earlier runs: a fold under a live base, filled from api/transcripts; a row opens the read-only comms view of that run", async () => {
	const asked: string[] = [];
	useRuns(async (path) => (asked.push(path), rows(3)));
	const el = draw(remote());
	await until(() => !one(el, ".box-runs").hidden, "the fold");
	assert.deepEqual(asked, ["transcripts?base=x0000000000000001"], "the base is named by the controller's id, the box's never");
	assert.equal(one(el, ".box-runs summary").textContent, m.box_runs({ count: 3 }));
	const links = el.querySelectorAll(".box-runs li a");
	assert.equal(links.length, 3);
	assert.equal(links[0]!.getAttribute("data-route"), "w/x0000000000000001/s/x0000000000000001", "the existing session route of that run's key");
	assert.equal(links[0]!.querySelector(".name")!.textContent, "run-1");
	assert.ok(links[0]!.querySelector(".age")!.dataset.since, "when it ended, kept current");
	// Redrawing does not ask again for the same state.
	fillBase(el as unknown as HTMLElement, remote(), { under: [] });
	await settle();
	assert.equal(asked.length, 1);
});

test("Earlier runs: none (or an answer the page does not accept) draws no fold; a hostile row is dropped; the fold is gone while the base is not live", async () => {
	useRuns(async () => ({ rows: [] }));
	const none = draw(remote());
	await settle();
	assert.equal(one(none, ".box-runs").hidden, true);

	useRuns(async () => ({ rows: [{ key: "../../etc", name: "x", role: "main", workspace: "w", first: 1, last: 2, size: 3 }, { key: "x0000000000000009", name: "<script>", role: "main", workspace: "w", first: 1, last: 2, size: 3 }] }));
	const one1 = draw(remote({ id: "x0000000000000002" }));
	await until(() => !one(one1, ".box-runs").hidden, "the fold with the good row");
	assert.equal(one1.querySelectorAll(".box-runs li a").length, 1);
	assert.equal(one1.querySelector(".box-runs li a .name")!.textContent, "<script>");
	assert.equal(one1.all((x) => x.tag === "script").length, 0);

	useRuns(async () => { throw new Error("502"); });
	const failed = draw(remote({ id: "x0000000000000003" }));
	await settle();
	assert.equal(one(failed, ".box-runs").hidden, true, "a refused list is no fold, not a broken one");

	let calls = 0;
	useRuns(async () => (calls++, rows(2)));
	const grey = draw(remote({ id: "x0000000000000004" }, { state: "unreachable", seen: Date.now() }));
	await settle();
	assert.equal(calls, 0, "nothing is asked of a box that cannot be reached");
	assert.equal(one(grey, ".box-runs").hidden, true);
});

test("Earlier runs: a page of 50 offers More, which asks with the cursor the box gave and adds the rows", async () => {
	const asked: string[] = [];
	useRuns(async (path) => (asked.push(path), path.includes("before=") ? { rows: rows(2).rows.map((r, i) => ({ ...r, key: `x${String(100 + i).padStart(16, "0")}` })) } : { ...rows(50), before: "5000:x0000000000000032" }));
	const el = draw(remote({ id: "x0000000000000005" }));
	await until(() => el.querySelectorAll(".box-runs li a").length === 50, "the first page");
	const more = one(el, ".box-more");
	assert.equal(more.hidden, false);
	more.click();
	await until(() => el.querySelectorAll(".box-runs li a").length === 52, "the second page");
	assert.equal(asked[1], "transcripts?base=x0000000000000005&before=5000%3Ax0000000000000032");
	assert.equal(more.hidden, true, "no cursor, no More");
});

test("a box tower's finished runs (an ally run, an event run) are the tower's own fold, never rows among the agents' Earlier runs; the fold is closed, counts them, and a row says whose run it was", async () => {
	const mixed = { rows: [
		{ key: "x0000000000000a01", name: "Mei's Mac", role: "ally", workspace: "Work", first: Date.now() - 40_000, last: Date.now() - 20_000, size: 1024 },
		{ key: "x0000000000000a02", name: "export-main", role: "main", workspace: "Work", first: Date.now() - 3_600_000, last: Date.now() - 600_000, size: 1024 },
		{ key: "x0000000000000a03", name: "e3a1b2c4", role: "run", workspace: "Work", first: Date.now() - 90_000, last: Date.now() - 60_000, size: 1024 },
		{ key: "x0000000000000a04", name: "Work", role: "tower", workspace: "Work", first: Date.now() - 90_000, last: Date.now() - 60_000, size: 1024 },
	] };
	useRuns(async () => mixed);
	const el = draw(remote({ id: "x0000000000000011" }));
	await until(() => !one(el, ".box-truns").hidden, "the tower's fold");
	assert.deepEqual(el.querySelectorAll(".box-runs li a .name").map((n) => n.textContent), ["export-main"], "the agents' fold holds the agent only");
	assert.equal(one(el, ".box-runs summary").textContent, m.box_runs({ count: 1 }));
	assert.equal(one(el, ".box-truns summary").textContent, m.box_tower_runs({ count: 3 }));
	assert.equal(one(el, ".box-truns").hasAttribute("open"), false, "folded until the boss opens it");
	assert.deepEqual(el.querySelectorAll(".box-truns li a .name").map((n) => n.textContent), ["Mei's Mac", "e3a1b2c4", "Work"]);
	assert.deepEqual(el.querySelectorAll(".box-truns li a .role").map((n) => n.textContent), [m.role_ally(), m.role_run(), m.role_tower()], "each row names what kind of run it was");
	assert.equal(el.querySelectorAll(".box-truns li a")[0]!.getAttribute("data-route"), "w/x0000000000000011/s/x0000000000000a01", "a run still opens its read-only comms");
	// Only tower runs: no agents' fold, and the tower's fold stands alone, with Show more still reachable.
	useRuns(async () => ({ rows: mixed.rows.filter((r) => r.role !== "main"), before: "1:x0000000000000a04" }));
	const only = draw(remote({ id: "x0000000000000012" }));
	await until(() => !one(only, ".box-truns").hidden, "the tower's fold alone");
	assert.equal(one(only, ".box-runs").hidden, true, "no agent finished: no agents' fold");
	assert.equal(one(only, ".box-more").hidden, false);
});

test("a live base takes its box's ally card in a fold; the card is the same ally card", () => {
	const card = { id: "dev1/Work", team: "t", teamName: "moldplan", teams: [{ team: "t", teamName: "moldplan" }], device: "dev1", short: "a1b2c3", label: "agent-tower-01", online: true, unattended: true, workspace: "Work", tower: "idle", tabs: [] } as unknown as AllyCard;
	const el = draw(remote(), [card]);
	assert.equal(one(el, ".box-ally").hidden, false);
	assert.equal(one(el, ".box-ally summary").textContent, m.box_ally());
	assert.equal(el.querySelectorAll(".box-ally .base.ally").length, 1);
	assert.equal(one(el, ".box-ally h2").textContent, "Work");
	fillBase(el as unknown as HTMLElement, remote(), { under: [] });
	assert.equal(one(el, ".box-ally").hidden, true, "the card goes back to the map when no base holds it");
});

test("the session view, the zoomed base and the phone's list follow the same rule: Quit by box.can, no + Main on a remote base, the machine named in the title", async () => {
	const { aimSession } = await import("../gui/quit.ts"), { aimOpening } = await import("../gui/render.ts"), { baseTitle } = await import("../gui/boxmodel.ts");
	const main = unit("x0000000000000a01");
	const press = (b: Base) => { const button = new El("button"); aimSession(button as unknown as HTMLElement, { u: main, base: b }); return button; };
	assert.equal(press(remote()).hidden, false, "a live remote main with close-unit has Quit in its own view");
	assert.equal(press(remote({}, { can: CAN.filter((c) => c !== "close-unit") })).hidden, true);
	assert.equal(press(remote({}, { state: "unreachable", seen: 1 })).hidden, true);
	assert.equal(press(local()).hidden, false);
	const add = new El("button");
	aimOpening(add as unknown as HTMLElement, remote());
	assert.equal(add.hidden, true, "no + Main on a remote base, in the zoomed base, the comms header or the drawer either");
	aimOpening(add as unknown as HTMLElement, local());
	assert.equal(add.hidden, false);
	const { blocked } = await import("../gui/composer.ts"), facts = { name: "x", control: true, live: true, mark: "idle" as const, online: false };
	assert.equal(blocked({ ...facts, away: true }), m.box_blocked(), "a greyed box's composer says the machine cannot be reached, not that the stream is down");
	assert.equal(blocked(facts), m.blocked_offline());
	assert.equal(baseTitle(remote()), "Work · agent-tower-01");
	assert.equal(baseTitle(local()), "Harbor");
});
