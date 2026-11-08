import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Base, Unit } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";

// Task 7 of the train workers: a train's unit card (the locomotive, the word 火車, a note that is the step and its wait), the base's chip, and an integrator's card that opens its yard, on the fake document.

sessionGlobals();
overwriteGetLocale(() => "zh-TW");
Object.assign(document, { createComment: () => new El("#comment") });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const { baseEl, fillBase, ICON, roleName, useYards } = await import("../gui/render.ts");
void page;

const unit = (key: string, role: Unit["role"], over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role, mark: "working", note: "thinking", subs: [], ...over });
const base = (units: Unit[]): Base => ({ id: "w1", label: "Harbor", mark: "working", tower: null, tabs: [{ id: "w1:t1", label: "trains", units }], outposts: [], outside: [] });
const draw = (b: Base, yard?: { projects: string[]; chip: string }) => {
	const el = baseEl() as unknown as El;
	fillBase(el as unknown as HTMLElement, b, yard ? { yard } : {});
	return el;
};
const card = (el: El, name: string) => el.find((x) => x.classes.has("unit") && x.find((y) => y.classes.has("name"))[0]?.textContent === name)[0]!;

test("a train's card draws the locomotive and says 火車; its note line is the step and its wait, in place of the mark's word", () => {
	assert.equal(ICON.train, "train");
	assert.equal(roleName("train"), "火車");
	assert.ok(readFileSync(new URL("../gui/index.html", import.meta.url), "utf8").includes('<symbol id="i-train" viewBox="0 0 512 512" fill="currentColor"'), "the locomotive is in the sprite");
	useYards(new Map([["tr", "全檢查 · unit：等負載 ≤30（現在 42）"]]), new Map());
	const el = draw(base([unit("tr", "train"), unit("m", "main")]));
	const train = card(el, "tr");
	assert.equal(train.find((x) => x.classes.has("role"))[0]!.textContent, "火車");
	assert.equal(train.find((x) => x.tag === "use")[0]!.dataset.icon, "train");
	assert.equal(train.find((x) => x.classes.has("note"))[0]!.textContent, "全檢查 · unit：等負載 ≤30（現在 42）");
	assert.notEqual(card(el, "m").find((x) => x.classes.has("note"))[0]!.textContent, "全檢查 · unit：等負載 ≤30（現在 42）", "another unit keeps its own note");
	useYards(new Map(), new Map());
	assert.equal(card(draw(base([unit("tr", "train")])), "tr").find((x) => x.classes.has("note"))[0]!.textContent, "思考中", "no yard line: the mark's word as any unit");
});

test("an integrator's card has a Yard button that carries its project; a unit that is not one has none", () => {
	useYards(new Map(), new Map([["m", "acme"]]));
	const el = draw(base([unit("m", "main"), unit("x", "main")]));
	const open = (name: string) => card(el, name).find((x) => x.classes.has("yard-open"))[0]!;
	assert.equal(open("m").hidden, false);
	assert.equal(open("m").dataset.yard, "acme");
	assert.equal(open("m").textContent, "調車場");
	assert.equal(open("x").hidden, true);
	useYards(new Map(), new Map());
});

test("a base's header chip carries the projects whose yard it holds and says the counts; with none it stays hidden", () => {
	const chip = (el: El) => el.find((x) => x.classes.has("yard-chip-btn"))[0]!;
	const withYard = draw(base([]), { projects: ["acme", "beta"], chip: "火車 3（等待 2）" });
	assert.equal(chip(withYard).hidden, false);
	assert.equal(chip(withYard).textContent, "火車 3（等待 2）");
	assert.equal(chip(withYard).dataset.yard, "acme beta");
	assert.equal(chip(draw(base([]))).hidden, true);
});

test("the yard sheet opens modal on the projects it is given, follows the net only when what it shows changed, and closes before a link to a comms is followed", async () => {
	Object.assign(El.prototype, {
		open: false,
		showModal(this: El & { open: boolean }) { this.open = true; },
		close(this: El & { open: boolean }) { this.open = false; this.dispatchEvent({ type: "close" }); },
	});
	const { mountYard } = await import("../gui/yard.ts");
	const yards = (round: number) => ({ projects: [{ project: "acme", forming: [], waiting: [], trains: [{ code: "2026-11-06-m", app: "web", state: "live" as const, key: "tr", round, cars: [], steps: [] }] }] });
	const net = (round: number) => ({ bases: [base([unit("tr", "train")])], yards: yards(round), load: { now: 42, cores: 14 } });
	const sheet = mountYard();
	const dialog = page.body.find((x) => x.tag === "dialog")[0] as El & { open: boolean };
	assert.equal(sheet.isOpen(), false);
	sheet.net(net(1) as never);
	assert.equal(dialog.open, false, "a snapshot alone opens nothing");
	sheet.open(["acme"]);
	assert.equal(sheet.isOpen(), true);
	assert.ok(dialog.textContent.includes("調車場 · acme") && dialog.textContent.includes("第 1 次組裝") && dialog.textContent.includes("負載 42／14 核"));
	const body = dialog.find((x) => x.classes.has("yard-body"))[0]!, first = body.children[0];
	sheet.net(net(1) as never);
	assert.equal(body.children[0], first, "the same reading draws nothing again");
	sheet.net(net(2) as never);
	assert.ok(dialog.textContent.includes("第 2 次組裝") && body.children[0] !== first, "a changed one does");
	sheet.open(["gone"]);
	assert.ok(dialog.textContent.includes("還沒有火車"), "a project the net no longer has is an empty yard");
	sheet.open(["acme"]);
	const link = dialog.find((x) => x.tag === "a" && x.classes.has("yard-code"))[0]!;
	assert.match(link.getAttribute("href")!, /^w\/w1\/s\/tr$/);
	dialog.handlers.click![0]!({ target: link });
	assert.equal(dialog.open, false, "a click on a train's link closes the sheet; the router follows the link");
	sheet.net(net(3) as never);
	assert.ok(!dialog.textContent.includes("第 3 次組裝"), "a closed sheet draws nothing");
});
