import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mountSettings, type Panel, type Part, type Tab } from "../gui/settings.ts";

// The settings page's sections (gui/settings.ts): Phone & devices, Teams, and Server are `<details>` that fill with their panel when they open and drop it when they close or the page is left.
// Who may have which is decided by main.ts (a paired device has neither Phone nor Server, a desk window no Phone) and told to mountSettings; the page's own markup is read from index.html here.

class Box {
	hidden = false;
	open = false;
	body = { kids: 0 as number, replaceChildren(...k: unknown[]) { this.kids = k.length; } };
	listeners: (() => void)[] = [];
	scrolled = 0;
	id: string;
	constructor(id: string) { this.id = id; }
	querySelector(selector: string) { return selector === ".set-body" ? this.body : null; }
	addEventListener(type: string, fn: () => void) { if (type === "toggle") this.listeners.push(fn); }
	scrollIntoView() { this.scrolled++; }
	/** A person's press on the summary: the open state flips and the browser says so. */
	press() { this.open = !this.open; for (const fn of this.listeners) fn(); }
}
function page(allowed = { phone: true, server: true }) {
	const boxes = new Map(["phone", "teams", "server"].map((n) => [n, new Box(`set-${n}`)]));
	const root = { querySelector: (selector: string) => boxes.get(selector.replace("#set-", "")) ?? null } as unknown as HTMLElement;
	const made: string[] = [], closed: string[] = [], selected: string[] = [], gate = new Map<string, () => void>();
	const panel = (name: string, tab: Tab): Panel => ({ id: name, title: name, body: () => ({}) as HTMLElement, closed: () => void closed.push(name), ...(name === "phone" ? { select: (t: Tab) => void selected.push(t) } : {}), ...(made.push(`${name}:${tab}`) && {}) });
	const make = Object.fromEntries((["phone", "teams", "server"] as Part[]).map((n) => [n, (tab: () => Tab) => new Promise<Panel>((done) => gate.set(n, () => done(panel(n, tab()))))])) as Parameters<typeof mountSettings>[2];
	const settings = mountSettings(root, allowed, make);
	/** Lets a panel's chunk arrive. */
	const arrive = async (name: string) => { gate.get(name)?.(); gate.delete(name); await new Promise<void>((r) => setImmediate(r)); };
	return { boxes, settings, made, closed, selected, arrive, gate };
}

test("a section this page may not have stays hidden, and a route to it opens nothing and fetches nothing", async () => {
	for (const [allowed, hidden] of [[{ phone: false, server: false }, ["phone", "server"]], [{ phone: false, server: true }, ["phone"]], [{ phone: true, server: true }, []]] as const) {
		const p = page(allowed);
		assert.deepEqual([...p.boxes].filter(([, b]) => b.hidden).map(([n]) => n), hidden);
		assert.equal(p.boxes.get("teams")!.hidden, false, "Teams is every page's: a paired device reads it");
		for (const section of ["phone", "wifi", "server"] as const) {
			p.settings.show(section);
			await p.arrive(section === "wifi" ? "phone" : section);
		}
		for (const name of hidden) assert.equal(p.boxes.get(name)!.open, false, `${name} stays shut`);
		assert.ok(p.made.every((m) => !(hidden as readonly string[]).includes(m.split(":")[0]!)), `built ${p.made.join(", ")}`);
	}
});

test("a section builds when it opens (by a route or by hand), only once, and is dropped when it closes or the page is left", async () => {
	const p = page();
	p.settings.show("teams");
	p.settings.show("teams"); // the route twice while the chunk loads
	p.boxes.get("teams")!.press(); // the browser's toggle for the open the route made (the box is already open: the press shuts it)
	assert.equal(p.boxes.get("teams")!.open, false);
	await p.arrive("teams");
	assert.deepEqual([p.made.length, p.boxes.get("teams")!.body.kids, p.closed], [1, 0, []], "closed again while it loaded: what arrived is not drawn");
	p.boxes.get("teams")!.press(); // open by hand
	await p.arrive("teams");
	assert.deepEqual([p.made, p.boxes.get("teams")!.body.kids], [["teams:tailscale", "teams:tailscale"], 1]);
	p.boxes.get("teams")!.press();
	assert.deepEqual([p.closed, p.boxes.get("teams")!.body.kids], [["teams"], 0], "closing runs the panel's end (its poll stops) and empties the section");
	p.settings.show("server");
	await p.arrive("server");
	p.boxes.get("teams")!.press();
	await p.arrive("teams");
	p.settings.hide();
	assert.deepEqual([...p.boxes.values()].map((b) => b.open), [false, false, false]);
	assert.deepEqual(p.closed.sort(), ["server", "teams", "teams"], "leaving the page ends every open panel");
	assert.deepEqual([...p.boxes.values()].map((b) => b.body.kids), [0, 0, 0]);
});

test("Wi-Fi is Phone on its Same Wi-Fi tab: it opens Phone there, and moves a Phone that is already built", async () => {
	const p = page();
	p.settings.show("wifi");
	await p.arrive("phone");
	assert.deepEqual([p.made, p.boxes.get("phone")!.open, p.boxes.get("phone")!.scrolled], [["phone:lan"], true, 1]);
	p.settings.show("phone");
	p.settings.show("wifi");
	assert.deepEqual(p.selected, ["tailscale", "lan"], "an open Phone follows the route's tab without being built again");
	assert.deepEqual(p.made, ["phone:lan"]);
	const hand = page();
	hand.boxes.get("phone")!.press();
	await hand.arrive("phone");
	assert.deepEqual(hand.made, ["phone:tailscale"], "opened by hand it starts on Tailscale");
});

test("a route with no section opens none and leaves what is open as it is", async () => {
	const p = page();
	p.settings.show();
	assert.deepEqual([...p.boxes.values()].map((b) => b.open), [false, false, false]);
});

test("the page's markup: This device is always there with its words, the three disclosures are closed and fill later, the gear is a link to the route, and the old popover and tiles are gone", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	for (const id of ["set-device", "set-phone", "set-teams", "set-server", "settings-view", "view-pick", "remind", "effects", "effects-vol", "effects-try", "background", "background-vol", "lang"]) assert.ok(html.includes(`id="${id}"`), id);
	for (const name of ["phone", "teams", "server"]) assert.match(html, new RegExp(`<details class="set-group" id="set-${name}"(?: hidden)?><summary><h3 data-m="set_${name}">`), name);
	assert.match(html, /<a class="pair-btn prefs-btn" id="prefs" href="settings" data-route="settings"/);
	assert.doesNotMatch(html, /prefs-pop|sound-pop|id="sound"|id="sound-vol"|id="pair"|id="server"|id="teams"|popovertarget="prefs-pop"/);
	for (const id of ["remind", "effects", "background"]) assert.match(html, new RegExp(`<button class="pair-btn tog" id="${id}" type="button" aria-pressed="\\w+" aria-labelledby="${id}-label"`), `${id} is a labelled switch`);
	assert.doesNotMatch(html.slice(html.indexOf('id="set-phone"')), /<details class="set-group"[^>]* open/, "no section starts open");
});
