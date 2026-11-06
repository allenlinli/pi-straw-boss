import assert from "node:assert/strict";
import { test } from "node:test";
import { PAD } from "../src/keys.ts";

// The key pad (gui/keypad.ts) as the page drives it: one key per trusted press of its own button, the server's confirm inline, and the
// buttons the mirror's state allows.

/** The few DOM calls the pad makes: elements with attributes, data, children, handlers, disabled, and focus. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	dataset: Record<string, string> = {};
	disabled = false;
	focused = false;
	onclick: ((e: { isTrusted: boolean }) => void) | null = null;
	handlers: Record<string, ((e: Record<string, unknown>) => void)[]> = {};
	addEventListener(type: string, on: (e: Record<string, unknown>) => void) {
		(this.handlers[type] ??= []).push(on);
	}
	/** A key on this button as a browser takes it: the page's handlers first; an Enter they leave alone is the button's click. Returns whether the key was prevented. */
	press(init: { key: string; repeat?: boolean; timeStamp?: number }, type = "keydown") {
		let prevented = false;
		for (const on of this.handlers[type] ?? []) on({ ...init, preventDefault: () => (prevented = true) });
		if (!prevented && type === "keydown" && (init.key === "Enter" || init.key === " ")) this.onclick?.({ isTrusted: true });
		return prevented;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, value);
		if (name.startsWith("data-")) this.dataset[name.slice(5)] = value;
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = [...kids];
	}
	focus() {
		this.focused = true;
	}
	get text(): string {
		return this.kids.map((k) => (typeof k === "string" ? k : k.text)).join("");
	}
	all(): El[] {
		return this.kids.flatMap((k) => (k instanceof El ? [k, ...k.all()] : []));
	}
}
Object.assign(globalThis, { document: { createElement: () => new El() }, getSelection: () => ({ isCollapsed: true }) }); // off a Mac (CI's Linux) a Ctrl+C asks the page whether text is selected
const mod = await import("../gui/keypad.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function pad(state: "live" | "hidden" | "off" = "live", enter = false) {
	const heard: string[] = [], posts: Record<string, unknown>[] = [], replies: ((r: { ok: boolean; status: number; body: Record<string, unknown> }) => void)[] = [];
	const s = { state };
	const p = mod.keypad({ name: "billing", enterConfirms: () => enter, state: () => s.state, stream: () => "st", taken: () => void heard.push("taken"), post: (action, body) => (assert.equal(action, "keys"), posts.push(body), new Promise((resolve) => replies.push(resolve))) });
	const el = p.el as unknown as El;
	const key = (k: string) => el.all().find((b) => b.dataset.key === k)!;
	const reply = async (status: number, body: Record<string, unknown> = {}) => (replies.shift()!({ ok: status < 300, status, body }), await tick());
	return { p, el, s, posts, heard, key, reply, press: (k: string, isTrusted = true) => key(k).onclick!({ isTrusted }), keys: () => el.all().filter((b) => b.dataset.key).map((b) => b.dataset.key) };
}

test("the module exposes the pad and nothing that sends a sequence; the pad has exactly the server's keys", () => {
	assert.deepEqual(Object.keys(mod), ["keypad"]);
	const { keys, el } = pad();
	assert.deepEqual(keys().sort(), [...PAD].sort());
	assert.equal(el.attrs.get("aria-label"), "Keys for billing");
});

test("one key per trusted press of its button; a synthetic click sends nothing, and presses while a key is on its way wait their turn", async () => {
	const { press, posts, reply, key } = pad();
	press("up", false);
	assert.equal(posts.length, 0, "not the user's own press");
	press("up");
	assert.deepEqual(posts, [{ key: "up", stream: "st" }]);
	assert.ok(!key("down").disabled, "the buttons stay as they are while the key is on its way, so they do not flicker as you type");
	press("down");
	press("3");
	assert.equal(posts.length, 1, "one write at a time");
	await reply(200, { accepted: true });
	await new Promise((r) => setTimeout(r, 160));
	assert.deepEqual(posts.at(-1), { key: "down", stream: "st" }, "then the next, after the gap");
	await reply(200, { accepted: true });
	await new Promise((r) => setTimeout(r, 160));
	assert.deepEqual(posts.map((p) => p.key), ["up", "down", "3"]);
});

const gap = () => new Promise((r) => setTimeout(r, 160));

test("the confirm says its reason in the page's words by the token the server named, and keeps the server's words for a token it does not know", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	const { press, reply, el, key } = pad();
	const note = () => el.all().find((x) => x.attrs.get("class") === "pad-note")!;
	const said = "Server English that must not show.";
	for (const [token, want] of [["unread", m.confirm_unread()], ["command", m.confirm_command()], ["reload", m.confirm_ending({ command: "/reload" })], ["quit", m.confirm_ending({ command: "/quit" })], ["double-esc", m.confirm_double_esc()], ["ctrl-d", m.confirm_ctrl_d()], ["double-ctrl-c", m.confirm_double_ctrl_c()]] as const) {
		press("enter");
		await reply(409, { error: "confirm", confirm: token, reason: said });
		const why = note().all().find((x) => x.attrs.get("class") === "pad-ask-why")!;
		assert.equal(why.text, want, token);
		assert.ok(!note().text.includes(said), token);
		note().all().find((x) => x.attrs.get("class") === "pad-no")!.onclick!({ isTrusted: true });
		await gap();
	}
	press("enter");
	await reply(409, { error: "confirm", confirm: "something-new", reason: said });
	assert.equal(note().all().find((x) => x.attrs.get("class") === "pad-ask-why")!.text, said, "an unknown token shows what the server said");
	assert.ok(key("enter"));
	assert.match(m.confirm_ending({ command: "/reload" }, { locale: "zh-TW" }), /\/reload.*結束或取代/);
	for (const name of ["confirm_unread", "confirm_command", "confirm_double_esc", "confirm_ctrl_d", "confirm_double_ctrl_c"] as const) assert.match(m[name]({}, { locale: "zh-TW" }), /[\u4e00-\u9fff]/, name);
});

test("the confirm's two buttons are one family: the yes button carries its label (Send Enter, Send Escape, Send Ctrl+D), the other is Cancel, both classed pad-yes and pad-no and no link", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	const { press, reply, el } = pad();
	const note = () => el.all().find((x) => x.attrs.get("class") === "pad-note")!;
	press("enter");
	await reply(409, { error: "confirm", confirm: "reload", reason: "x" });
	const buttons = note().all().filter((x) => x.attrs.get("type") === "button");
	assert.deepEqual(buttons.map((b) => [b.attrs.get("class"), b.text]), [["pad-yes", m.send_enter()], ["pad-no", m.cancel()]]);
	assert.ok(!note().all().some((x) => x.attrs.get("class") === "cmp-link"), "Cancel is no link");
	assert.equal(m.send_enter({}, { locale: "zh-TW" }), "送出 Enter");
});

test("a confirm pressed while its key is on its way sends nothing more", async () => {
	const { press, posts, reply, el } = pad();
	press("enter");
	await reply(409, { error: "confirm", confirm: "reload", reason: "x" });
	const yes = el.all().find((x) => x.attrs.get("class") === "pad-yes")!;
	yes.onclick!({ isTrusted: true });
	assert.equal(posts.length, 2);
	yes.onclick!({ isTrusted: true });
	assert.equal(posts.length, 2, "the confirm is busy until its write is answered");
	await reply(200, { accepted: true });
});

test("the server's confirm shows inline with its reason, and sends the same key with the token it named, once; Cancel sends nothing", async () => {
	const { press, posts, reply, el } = pad();
	press("enter");
	await reply(409, { error: "confirm", confirm: "reload", reason: "Enter would run /reload, which ends or replaces this session." });
	const note = el.all().find((x) => x.attrs.get("class") === "pad-note")!;
	assert.match(note.text, /\/reload/);
	const yes = note.all().find((x) => x.attrs.get("class") === "pad-yes")!;
	assert.ok(!yes.focused && note.all().find((x) => x.text === "Cancel")!.focused, "the focus goes to Cancel, so a second or held Enter does not confirm");
	yes.onclick!({ isTrusted: false });
	assert.equal(posts.length, 1, "a synthetic confirm sends nothing");
	yes.onclick!({ isTrusted: true });
	assert.deepEqual(posts.at(-1), { key: "enter", stream: "st", confirmed: "reload" });
	await reply(200, { accepted: true });
	assert.equal(note.text, "");
	press("esc");
	await gap(); // a press goes out after the gap since the last write, as typed keys do
	await reply(409, { error: "confirm", confirm: "double-esc", reason: "A second Escape on an idle session runs pi's double-Escape action." });
	note.all().find((x) => x.text === "Cancel")!.onclick!({ isTrusted: true });
	assert.equal(note.text, "");
	assert.equal(posts.length, 3);
	press("tab");
	await gap(); // a press goes out after the gap since the last write, as typed keys do
	await reply(409, { error: "no_mirror", reason: "Keys are sent only while this page shows the session's terminal live; open it again." });
	assert.match(note.text, /terminal live/, "a refusal says why");
});

test("a mirror hidden for a secret leaves only Escape; a stale, ended, or paused one leaves nothing", () => {
	const { p, s, key, keys } = pad("hidden");
	assert.deepEqual(keys().filter((k) => !key(k!).disabled), ["esc"]);
	s.state = "off";
	p.update();
	assert.deepEqual(keys().filter((k) => !key(k!).disabled), []);
	s.state = "live";
	p.update();
	assert.equal(keys().filter((k) => !key(k!).disabled).length, PAD.length);
});

test("taken fires once for an Enter the server took, directly or after the confirm, and never while it is on its way, refused, or for another key", async () => {
	const { press, reply, heard } = pad();
	press("enter");
	assert.deepEqual(heard, [], "going is not taken");
	await reply(200, { accepted: true });
	assert.deepEqual(heard, ["taken"]);
	heard.length = 0;
	await gap();
	press("enter");
	await reply(409, { error: "confirm", confirm: "command", reason: "x" });
	assert.deepEqual(heard, [], "a confirm is not taken");
	heard.length = 0;
	await gap();
	press("enter");
	await reply(409, { error: "no_mirror", reason: "x" });
	assert.deepEqual(heard, [], "a refusal is not taken");
	heard.length = 0;
	await gap();
	press("up");
	await reply(200, { accepted: true });
	assert.deepEqual(heard, [], "another key is not an Enter");
});

test("an Enter confirmed through the pad's inline button is taken when the server answers 200 to it", async () => {
	const { press, reply, heard, el } = pad();
	press("enter");
	await reply(409, { error: "confirm", confirm: "command", reason: "x" });
	el.all().find((x) => x.attrs.get("class") === "pad-yes")!.onclick!({ isTrusted: true });
	assert.deepEqual(heard, [], "the confirmed Enter is on its way");
	await reply(200, { accepted: true });
	assert.deepEqual(heard, ["taken"]);
});

test("Z-D20: in Zen the confirm's Send takes the focus and Enter on it confirms; a repeating Enter and one that began before the bar confirm nothing; Standard keeps the focus on Cancel", async () => {
	const standard = pad();
	standard.press("enter");
	await standard.reply(409, { error: "confirm", confirm: "reload", reason: "x" });
	assert.ok(standard.el.all().find((x) => x.attrs.get("class") === "pad-no")!.focused && !standard.el.all().find((x) => x.attrs.get("class") === "pad-yes")!.focused, "Standard: Cancel has the focus");
	const { press, posts, reply, el } = pad("live", true);
	press("enter");
	await reply(409, { error: "confirm", confirm: "reload", reason: "Enter would run /reload." });
	const yes = el.all().find((x) => x.attrs.get("class") === "pad-yes")!, no = el.all().find((x) => x.attrs.get("class") === "pad-no")!;
	assert.ok(yes.focused && !no.focused, "Zen: the one that sends has the focus");
	assert.equal(yes.press({ key: "Enter", repeat: true, timeStamp: Infinity }), true, "a held Enter is ignored");
	assert.equal(yes.press({ key: "Enter", timeStamp: -1 }), true, "so is an Enter whose keydown began before the confirm showed");
	assert.equal(yes.press({ key: " " }, "keyup"), true, "a space's release does not click it (Firefox)");
	assert.equal(posts.length, 1, "nothing was confirmed");
	assert.equal(yes.press({ key: "Enter", timeStamp: Infinity }), false, "a fresh Enter is the button's");
	assert.deepEqual(posts.at(-1), { key: "enter", stream: "st", confirmed: "reload" });
	await reply(200, { accepted: true });
});

test("ZNI-F001: in Zen a key typed while the confirm shows is not sent past it: the focus goes to Cancel, and the Enter that ends the typing confirms nothing (double Ctrl+C, then abc and Enter)", async () => {
	const { posts, reply, el, p } = pad("live", true);
	p.type({ key: "c", ctrlKey: true, code: "KeyC", altKey: false, shiftKey: false, metaKey: false, isComposing: false, repeat: false } as KeyboardEvent);
	await reply(409, { error: "confirm", confirm: "double-ctrl-c", reason: "A second Ctrl+C exits pi." });
	const yes = el.all().find((x) => x.attrs.get("class") === "pad-yes")!, no = el.all().find((x) => x.attrs.get("class") === "pad-no")!;
	assert.ok(yes.focused && !no.focused);
	no.focused = false;
	for (const k of ["a", " ", "c"]) assert.equal(yes.press({ key: k, timeStamp: Infinity }), true, `${k} is typing: kept from the button`);
	assert.ok(no.focused, "the focus went to Cancel");
	assert.equal(yes.press({ key: "Enter", timeStamp: Infinity }), true, "an Enter the bar still sees is kept from Send");
	assert.equal(posts.length, 1, "nothing was confirmed");
	for (const k of ["Tab", "Shift", "Escape", "Control"]) assert.equal(el.all().find((x) => x.attrs.get("class") === "pad-yes")!.press({ key: k, timeStamp: Infinity }), false, `${k} is not typing`);
});

test("ZNR-F007: in Zen the confirm's Send waits 400 ms: the second tap of a double Enter, 100 ms after the bar showed, confirms nothing; an Enter at 500 ms does; Standard has no Enter to confirm with", async () => {
	let clock = 5_000;
	const real = Object.getOwnPropertyDescriptor(performance, "now");
	Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true }); // the fake clock the bar's birth and the key's time stamp are read on
	try {
		for (const dwell of [100, 399]) {
			const { posts, reply, el, press } = pad("live", true);
			press("enter");
			await reply(409, { error: "confirm", confirm: "unread", reason: "pi has not shown you its screen." });
			const yes = el.all().find((x) => x.attrs.get("class") === "pad-yes")!;
			assert.equal(yes.press({ key: "Enter", timeStamp: clock + dwell }), true, `an Enter ${dwell} ms after the bar showed is kept from Send`);
			assert.equal(posts.length, 1, "nothing was confirmed");
			assert.equal(yes.press({ key: "Enter", timeStamp: clock + 500 }), false, "one at 500 ms is the button's");
			assert.deepEqual(posts.at(-1), { key: "enter", stream: "st", confirmed: "unread" });
			await reply(200, { accepted: true });
			clock += 1_000;
		}
		const std = pad("live", false);
		std.press("enter");
		await std.reply(409, { error: "confirm", confirm: "unread", reason: "x" });
		assert.equal(std.el.all().find((x) => x.attrs.get("class") === "pad-yes")!.handlers.keydown, undefined, "Standard's bar listens for no key: its Send is a click");
	} finally {
		if (real) Object.defineProperty(performance, "now", real);
		else delete (performance as { now?: unknown }).now;
	}
});
