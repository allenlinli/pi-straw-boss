import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { followLabel } from "../gui/viewlabel.ts";
import { autoView, mountZenBack, choiceOf, KEY, mountPick, mountView, resolve, THEME, type ViewEnv } from "../gui/view.ts";

// The page's view (gui/view.ts): Auto, Standard, or Geek from the device's storage and the OS's contrast preference, set on <html> before the first render.

test("the stored choice and prefers-contrast resolve to a view: an explicit choice wins, anything else is Auto", () => {
	const table: [string | null, boolean, "standard" | "geek" | "zen"][] = [
		[null, false, "standard"], [null, true, "geek"],
		["auto", false, "standard"], ["auto", true, "geek"],
		["standard", false, "standard"], ["standard", true, "standard"],
		["geek", false, "geek"], ["geek", true, "geek"],
		["", false, "standard"], ["", true, "geek"],
		["zen", false, "zen"], ["zen", true, "zen"], ["ZEN", false, "standard"],
		["GEEK", false, "standard"], ["dark", true, "geek"], ["1", false, "standard"], ["{}", true, "geek"], ["undefined", false, "standard"],
	];
	for (const [stored, contrast, expected] of table) assert.equal(resolve(choiceOf(stored), contrast), expected, `${JSON.stringify(stored)} with prefers-contrast ${contrast ? "more" : "no-preference"}`);
	assert.equal(choiceOf("dark"), "auto", "an invalid stored value reads as Auto");
});

/** The page's parts as plain objects: storage, the contrast query, the root, and the theme-color meta. */
function world(stored: string | null, more: boolean, opts: { refuse?: boolean; server?: string } = {}) {
	let listener: (() => void) | undefined;
	const written: string[] = [];
	const media = { matches: more, addEventListener: (_: "change", fn: () => void) => (listener = fn) };
	const env: ViewEnv = {
		root: { dataset: {} },
		meta: { content: "#1a1b26" },
		...(opts.server !== undefined ? { server: { content: opts.server } } : {}),
		media,
		storage: {
			getItem: () => {
				if (opts.refuse) throw new Error("denied");
				return stored;
			},
			setItem: (key: string, value: string) => {
				if (opts.refuse) throw new Error("denied");
				written.push(`${key}=${value}`);
				stored = value;
			},
		},
	};
	return { env, written, flip: (next: boolean) => ((media.matches = next), listener?.()) };
}

test("the view is on <html> and the theme color follows it, as soon as it is mounted", () => {
	const w = world("geek", false);
	const view = mountView(w.env);
	assert.equal(w.env.root.dataset.view, "geek");
	assert.equal(w.env.meta?.content, THEME.geek);
	assert.deepEqual([view.choice(), view.view()], ["geek", "geek"]);
	const plain = world(null, false);
	mountView(plain.env);
	assert.equal(plain.env.root.dataset.view, "standard");
	assert.equal(plain.env.meta?.content, "#1a1b26", "the page's own color stays for Standard");
});

test("Auto follows prefers-contrast live; an explicit choice does not", () => {
	const auto = world(null, false);
	mountView(auto.env);
	auto.flip(true);
	assert.equal(auto.env.root.dataset.view, "geek");
	assert.equal(auto.env.meta?.content, THEME.geek);
	auto.flip(false);
	assert.equal(auto.env.root.dataset.view, "standard");
	assert.equal(auto.env.meta?.content, "#1a1b26", "back to the color the page came with");
	const fixed = world("standard", false);
	mountView(fixed.env);
	fixed.flip(true);
	assert.equal(fixed.env.root.dataset.view, "standard");
});

test("choosing stores the choice under sb.view and switches at once; a refused storage still switches for this page", () => {
	const w = world(null, false);
	const seen: string[] = [];
	const view = mountView(w.env);
	view.onChange((v: string) => seen.push(v));
	view.set("geek");
	assert.deepEqual(w.written, [`${KEY}=geek`]);
	assert.equal(w.env.root.dataset.view, "geek");
	view.set("auto");
	assert.equal(w.env.root.dataset.view, "standard");
	assert.deepEqual(seen, ["geek", "standard"]);
	const refused = world(null, true, { refuse: true });
	const v = mountView(refused.env);
	assert.equal(refused.env.root.dataset.view, "geek", "storage refused: Auto reads the OS");
	v.set("standard");
	assert.equal(refused.env.root.dataset.view, "standard");
	assert.deepEqual([v.choice(), v.view()], ["standard", "standard"]);
});

test("an invalid stored value is Auto and is left as it is until the person chooses", () => {
	const w = world("sparkly", true);
	const view = mountView(w.env);
	assert.deepEqual([view.choice(), view.view()], ["auto", "geek"]);
	assert.deepEqual(w.written, []);
});

test("the settings' control is four words (Auto, Standard, Geek, Zen) in a group, one of them pressed, each a pair-btn so a phone gives it 44 px", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	const group = /<div class="view-pick" id="view-pick"[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? "";
	const buttons = [...group.matchAll(/<button class="pair-btn" type="button" data-choice="(\w+)" aria-pressed="(\w+)" data-m="(\w+)">/g)].map((x) => x.slice(1));
	assert.deepEqual(buttons, [["auto", "true", "view_auto"], ["standard", "false", "view_standard"], ["geek", "false", "view_geek"], ["zen", "false", "view_zen"]]);
	assert.match(html, /role="group" aria-labelledby="view-label"/);
});

test("the control presses a button for the stored choice, switches on a click, and follows another tab's write", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	const heard: Record<string, ((e: { key: string }) => void)[]> = {};
	g.addEventListener = (type: string, fn: (e: { key: string }) => void) => void (heard[type] ??= []).push(fn);
	try {
		const w = world("geek", false);
		const view = mountView(w.env);
		const make = (choice: string) => {
			const attrs: Record<string, string> = {}, click: (() => void)[] = [];
			return { dataset: { choice }, attrs, click, setAttribute: (k: string, v: string) => (attrs[k] = v), addEventListener: (_: string, fn: () => void) => click.push(fn) };
		};
		const buttons = ["auto", "standard", "geek"].map(make);
		mountPick({ querySelectorAll: () => buttons } as unknown as HTMLElement, view);
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "false", "true"]);
		buttons[1]!.click[0]!();
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "true", "false"]);
		assert.equal(w.env.root.dataset.view, "standard");
		assert.deepEqual(w.written, [`${KEY}=standard`]);
		w.env.storage.setItem(KEY, "geek"); // another tab of this device chose Geek
		heard.storage![0]!({ key: KEY });
		assert.equal(w.env.root.dataset.view, "geek");
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "false", "true"]);
		heard.storage![0]!({ key: "sb.sound" });
		assert.equal(w.env.root.dataset.view, "geek", "another key is none of ours");
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("the server's default slots in under Auto: an explicit device choice wins over it, and with the server on auto prefers-contrast decides", () => {
	const table: [string | null, string, boolean, "standard" | "geek"][] = [
		// device choice, server default, prefers-contrast more, view
		[null, "geek", false, "geek"], [null, "geek", true, "geek"], [null, "standard", false, "standard"], [null, "standard", true, "standard"],
		[null, "auto", false, "standard"], [null, "auto", true, "geek"],
		["auto", "geek", false, "geek"], ["auto", "standard", true, "standard"],
		["standard", "geek", false, "standard"], ["standard", "geek", true, "standard"],
		["geek", "standard", false, "geek"], ["geek", "standard", true, "geek"], ["geek", "auto", false, "geek"],
		["sparkly", "geek", false, "geek"], // an invalid stored value is Auto, so it follows the server
		[null, "sparkly", true, "geek"], [null, "GEEK", false, "standard"], [null, "", true, "geek"], // an invalid server value is Auto too
	];
	for (const [stored, server, contrast, expected] of table) assert.equal(resolve(choiceOf(stored), contrast, choiceOf(server)), expected, `device ${JSON.stringify(stored)}, server ${JSON.stringify(server)}, contrast ${contrast}`);
	assert.equal(autoView(true), "geek");
	assert.equal(autoView(true, "standard"), "standard");
});

test("the page starts in the server's default from the meta the server wrote, before the first render, and a device that chose keeps its choice", () => {
	const follower = world(null, false, { server: "geek" });
	const view = mountView(follower.env);
	assert.equal(follower.env.root.dataset.view, "geek", "the first thing the page does paints the default: no frame in the other view");
	assert.equal(follower.env.meta?.content, THEME.geek);
	assert.deepEqual([view.choice(), view.server(), view.view()], ["auto", "geek", "geek"]);
	const chose = world("standard", true, { server: "geek" });
	mountView(chose.env);
	assert.equal(chose.env.root.dataset.view, "standard");
	const none = world(null, true);
	assert.equal(mountView(none.env).server(), "auto", "a page without the meta (an older server, the demo) follows the screen");
	assert.equal(none.env.root.dataset.view, "geek");
});

test("a new server default switches a following page live and tells it, and leaves a page with its own choice alone; a repeat is not a change", () => {
	const w = world(null, false, { server: "auto" });
	const view = mountView(w.env);
	const seen: string[] = [], servers: string[] = [];
	view.onChange((v: string) => seen.push(v));
	view.onServer((s: string) => servers.push(s));
	view.setServer("geek");
	assert.equal(w.env.root.dataset.view, "geek");
	assert.equal(w.env.meta?.content, THEME.geek);
	view.setServer("geek");
	view.setServer("standard");
	view.setServer("sparkly"); // not a view: reads as auto, like a bad stored value
	assert.deepEqual(seen, ["geek", "standard"], "the screen's contrast preference (off here) decides again at the last one");
	assert.deepEqual(servers, ["geek", "standard", "auto"]);
	assert.deepEqual(w.written, [], "the server's default is never written to the device's storage");
	const own = world("standard", false, { server: "auto" });
	const mine = mountView(own.env);
	mine.setServer("geek");
	assert.equal(own.env.root.dataset.view, "standard", "a device's own choice wins");
	assert.equal(mine.server(), "geek", "and still knows the server's default for its Follow label");
});

test("the Auto button reads as the server's default when there is one (Follow server (geek)) and as Auto when there is not, and follows a change", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	g.addEventListener = () => {};
	try {
		const w = world(null, false, { server: "geek" });
		const view = mountView(w.env);
		const make = (choice: string) => ({ dataset: { choice }, textContent: "", setAttribute() {}, addEventListener() {} });
		const buttons = ["auto", "standard", "geek"].map(make);
		const flags: Record<string, boolean> = {};
		const group = { dataset: {}, querySelectorAll: () => buttons, toggleAttribute: (name: string, on: boolean) => (flags[name] = on) };
		mountPick(group as unknown as HTMLElement, view, (server) => (server === "auto" ? "Auto" : `Follow server (${server})`));
		assert.equal(buttons[0]!.textContent, "Follow server (geek)");
		assert.equal(flags["data-following"], true, "the long label gets a row of its own");
		assert.equal(buttons[1]!.textContent, "", "the other two keep their own words");
		view.setServer("standard");
		assert.equal(buttons[0]!.textContent, "Follow server (standard)");
		view.setServer("auto");
		assert.equal(buttons[0]!.textContent, "Auto");
		assert.equal(flags["data-following"], false);
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("main.ts feeds the server's default from the page's meta, each hello, and the view event, and index.html carries no sb-view of its own (the server writes it)", () => {
	const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8");
	assert.match(main, /source\.listen\("view"/);
	assert.match(main, /\.setServer\(/);
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	assert.ok(!html.includes('name="sb-view"'));
});

test("zen is a view: a device's choice, a server default that wins over prefers-contrast, never picked by Auto alone; the theme color is the ink ground, and Standard's comes back", () => {
	assert.equal(THEME.zen, "#14110e");
	for (const contrast of [false, true]) {
		assert.equal(resolve("auto", contrast, "zen"), "zen", `a server default of zen wins (contrast ${contrast})`);
		assert.equal(resolve("zen", contrast, "standard"), "zen");
		assert.equal(resolve("geek", contrast, "zen"), "geek", "a device's own choice wins over the server");
		assert.notEqual(resolve("auto", contrast), "zen", "Auto with no default never resolves to Zen");
	}
	const w = world(null, true, { server: "zen" });
	const view = mountView(w.env);
	assert.deepEqual([view.choice(), view.view(), w.env.root.dataset.view, w.env.meta?.content], ["auto", "zen", "zen", THEME.zen]);
	view.set("standard");
	assert.equal(w.env.meta?.content, "#1a1b26", "the page's own color is back in Standard");
	view.set("zen");
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content, w.written.at(-1)], ["zen", THEME.zen, `${KEY}=zen`]);
	const older = world("zen", false);
	older.env.server = { content: "zen" };
	assert.equal(mountView(older.env).server(), "zen");
});

test("the Auto button reads Follow server (Zen) when the server's default is zen, and the Zen button is a choice of its own", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	g.addEventListener = () => {};
	try {
		const w = world(null, false, { server: "zen" });
		const view = mountView(w.env);
		const make = (choice: string) => {
			const attrs: Record<string, string> = {};
			return { dataset: { choice }, attrs, textContent: "", setAttribute: (k: string, v: string) => (attrs[k] = v), addEventListener: () => {} };
		};
		const buttons = ["auto", "standard", "geek", "zen"].map(make);
		const names: Record<string, string> = { zen: "Zen", geek: "Geek", standard: "Standard" };
		mountPick({ querySelectorAll: () => buttons, toggleAttribute: () => {}, dataset: {} } as unknown as HTMLElement, view, (server) => (server === "auto" ? "Auto" : `Follow server (${names[server]})`));
		assert.equal(buttons[0]!.textContent, "Follow server (Zen)");
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["true", "false", "false", "false"]);
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("the page's Auto label names the server's default, Zen included", () => {
	assert.equal(followLabel("auto"), "Auto");
	assert.equal(followLabel("zen"), "Follow server (Zen)");
	assert.equal(followLabel("geek"), "Follow server (Geek)");
	assert.equal(followLabel("standard"), "Follow server (Standard)");
});

test("the Zen back button is hidden unless the view is Zen and data-zen-away is set; its click clears the mark", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	g.addEventListener = () => {};
	try {
		for (const [stored, away, hidden] of [["zen", false, true], ["zen", true, false], ["standard", true, true], ["geek", false, true]] as const) {
			const w = world(stored, false);
			const view = mountView(w.env);
			let click: () => void = () => {};
			const button = { hidden: false, addEventListener: (_: string, fn: () => void) => (click = fn) } as unknown as HTMLElement;
			const root = { dataset: (away ? { zenAway: "" } : {}) as DOMStringMap };
			mountZenBack(button, view, root);
			assert.equal(button.hidden, hidden, `${stored} away=${away}`);
			if (!hidden) {
				click();
				assert.equal(root.dataset.zenAway, undefined, "the click leaves away");
				assert.equal(button.hidden, true);
			}
		}
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("a page that left Zen (data-zen-away on the root) shows Standard with the page's own theme color, keeps the device's choice, stores nothing, and shows Zen again when the mark goes", () => {
	const w = world("zen", false);
	const view = mountView(w.env);
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content], ["zen", THEME.zen]);
	w.env.root.dataset.zenAway = "";
	view.reread();
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content, view.choice(), view.view(), w.written], ["standard", "#1a1b26", "zen", "zen", []], "Standard on show; the resolved view is still Zen for the page's own rules");
	w.flip(true); // an OS change re-applies the view: it must not bring Zen back over the away page
	assert.equal(w.env.root.dataset.view, "standard");
	delete w.env.root.dataset.zenAway;
	view.reread();
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content], ["zen", THEME.zen]);
	const geek = world("geek", false);
	geek.env.root.dataset.zenAway = "";
	mountView(geek.env);
	assert.equal(geek.env.root.dataset.view, "geek", "the mark changes nothing for another view");
});

test("a listener that draws the view again meets no second change: the new view is noted before the listeners run", () => {
	const w = world("standard", false);
	const view = mountView(w.env);
	let calls = 0;
	view.onChange(() => (calls++, view.refresh()));
	view.set("zen");
	assert.equal(calls, 1);
	assert.equal(w.env.root.dataset.view, "zen");
});
