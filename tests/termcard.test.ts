import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createKeys } from "../src/keys.ts";
import { El, page } from "./card-dom.ts";
import en from "../gui/messages/en.json" with { type: "json" };
import zh from "../gui/messages/zh-TW.json" with { type: "json" };

// The terminal card (gui/termcard.ts) as the page drives it, on a fake DOM: each state drawn as its words and buttons, a prompt's card (執行, the server's confirm), a pane's (one line, the mask, Send Enter), the
// ways it closes, and every body it posts checked by the server's own `check`. The rules it asks of cardmodel.ts are tested there; here they are seen working through the DOM.

const { termCard } = await import("../gui/termcard.ts");
const { m } = await import("../gui/paraglide/messages.js");

type Phase = "connecting" | "live" | "hidden" | "paused" | "refused";
interface Reply { ok: boolean; status: number; body: Record<string, unknown> }
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function rig(kind: "prompt" | "pane", { command = "sudo apt update", name = "billing-main", escape, run, enter }: { command?: string; name?: string; escape?: boolean; run?: string; /** Zen's card: Enter acts on the primary control (Z-D20). */ enter?: boolean } = {}) {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	page.fine = true;
	page.focus = undefined;
	const posts: { action: string; body: Record<string, unknown> }[] = [], replies: ((r: Reply) => void)[] = [], overs: string[] = [];
	const conn = { key: "k", rows: [] as string[], cols: 80, phase: "live" as Phase, why: "", stale: () => stale };
	let stale = false, hold: string | undefined, w!: { rows(rows: string[]): void; state(s: string, c: unknown): void; end(): void; taken(): void }, stops = 0, retries = 0;
	const card = termCard({
		step: { kind, key: kind === "pane" ? "grant:g1" : "S", name, command, run },
		watch: (x) => ((w = x), { conn: conn as never, stop: () => void stops++, retry: () => (retries++, rig.phase("connecting")) }),
		post: (action, body) => (posts.push({ action, body }), new Promise((resolve) => replies.push(resolve as never))),
		stream: () => "st",
		held: () => hold,
		over: (why) => void overs.push(why),
		...(escape === undefined ? {} : { escape }),
		...(enter === undefined ? {} : { enter }),
	});
	const el = card.el as unknown as El;
	const at = (c: string) => el.byClass(c)!;
	const rig = {
		card, el, posts, overs, conn, at,
		go: () => at("tcard-go"), input: () => at("tcard-input"), status: () => at("tcard-status"), mask: () => at("tcard-mask"),
		rows(rows: string[]) { conn.rows = rows; w.rows(rows); },
		phase(p: Phase, why = "") { Object.assign(conn, { phase: p, why }); w.state("off", conn); },
		stale(on: boolean) { stale = on; w.state("off", conn); },
		hold(text: string | undefined) { hold = text; card.update(); },
		end: () => w.end(),
		taken: () => w.taken(),
		stops: () => stops,
		retries: () => retries,
		click: (b: El) => b.onclick!({ isTrusted: true }),
		press: () => rig.click(rig.go()),
		reply: async (status: number, body: Record<string, unknown> = {}) => (replies.shift()!({ ok: status < 300, status, body }), await settle()),
		tick: (ms: number) => mock.timers.tick(ms),
		done: () => mock.timers.reset(),
		/** The status line's buttons, by class. */
		ask: () => ({ yes: at("tcard-status").byClass("pad-yes"), no: at("tcard-status").byClass("pad-no"), why: at("tcard-status").byClass("pad-ask-why") }),
	};
	return rig;
}
const PW = ["Hit:1 http://ports.ubuntu.com", "[sudo] password for boss:"];

test("a prompt card shows the command, the line that says where it waits, and one button 執行; a pane card shows the rows' tail, one line, the mask, and Send Enter", () => {
	const p = rig("prompt");
	try {
		assert.equal(p.el.byClass("tcard-cmd")!.textContent, "sudo apt update");
		assert.equal(p.el.byClass("tcard-wait")!.textContent, m.card_waits({ name: "billing-main" }));
		assert.equal(p.go().textContent, m.card_run());
		assert.ok(!p.go().disabled);
		assert.equal(p.el.byClass("tcard-tail"), undefined, "a prompt's card has no rows");
		assert.equal(p.el.byClass("tcard-input"), undefined, "and no input");
		assert.equal(p.el.byClass("tcard-mask"), undefined);
		assert.equal(p.el.getAttribute("role"), "dialog");
		assert.equal(p.el.getAttribute("aria-modal"), "false");
		assert.equal(p.el.byClass("tcard-head")!.byClass("x")!.getAttribute("aria-label"), m.close());
		assert.equal(p.el.byClass("tcard-head")!.all().find((e) => e.tag === "h2")!.textContent, m.terminal_title({ name: "billing-main" }));
		assert.equal(p.el.getAttribute("aria-labelledby"), p.el.byClass("tcard-head")!.all().find((e) => e.tag === "h2")!.getAttribute("id"));
	} finally { p.done(); }
	const q = rig("pane");
	try {
		q.rows(["a", "", "b", "c", "", "d", "e", "f", ""]);
		assert.equal(q.el.byClass("tcard-tail")!.textContent, "b\nc\nd\ne\nf".split("\n").slice(-4).join("\n"), "the last four non-blank rows, trailing blanks dropped");
		assert.equal(q.go().textContent, m.send_enter());
		assert.equal(q.mask().textContent, m.card_mask());
		assert.equal(q.mask().getAttribute("aria-pressed"), "false");
		assert.equal(q.input().type, "text");
		assert.equal(q.el.byClass("tcard-tail")!.getAttribute("aria-live"), "off");
		assert.equal(q.status().getAttribute("role"), "status");
		assert.equal(q.el.byClass("tcard-full")!.textContent, m.card_full());
	} finally { q.done(); }
});

test("the command is display only, and a card with no command omits its line", () => {
	const p = rig("prompt", { command: "" });
	try {
		assert.equal(p.el.byClass("tcard-cmd"), undefined);
	} finally { p.done(); }
});

test("each state draws its words and enables what it should", () => {
	const q = rig("pane");
	try {
		q.phase("connecting");
		assert.deepEqual([q.status().textContent, q.go().disabled, q.el.dataset.state], [m.connecting(), true, "connecting"]);
		q.phase("live");
		q.rows(["$ ls", "file"]);
		assert.deepEqual([q.status().textContent, q.go().disabled, q.el.dataset.state], ["", false, "live"]);
		q.stale(true);
		assert.deepEqual([q.status().textContent, q.go().disabled, q.el.classList.contains("stale")], [m.card_stale(), true, true]);
		q.stale(false);
		q.phase("paused");
		assert.deepEqual([q.status().textContent, q.go().disabled], [m.paused_hidden(), true]);
		q.phase("hidden");
		assert.deepEqual([q.status().textContent, q.go().disabled], [m.mirror_hidden(), true]);
		q.phase("refused", "Too many terminals.");
		assert.deepEqual([q.status().textContent, q.status().dataset.tone, q.go().disabled], ["Too many terminals.", "error", false], "a refusal says the server's reason and the button is there to retry");
		q.phase("live");
		q.hold(m.tower_term_standing());
		assert.deepEqual([q.status().textContent, q.go().disabled, q.el.dataset.state], [m.tower_term_standing(), true, "held"]);
		q.hold(undefined);
		assert.equal(q.el.dataset.state, "live");
	} finally { q.done(); }
});

test("a prompt card whose session's mirror ended stays and says why; a pane card whose pane ended is over", () => {
	const p = rig("prompt");
	try {
		p.phase("refused", m.mirror_ended({ why: "it left its pane" }));
		p.end();
		assert.deepEqual([p.overs, p.el.dataset.state, p.status().textContent, p.go().disabled], [[], "ended", m.mirror_ended({ why: "it left its pane" }), true]);
	} finally { p.done(); }
	const q = rig("pane");
	try {
		q.end();
		assert.deepEqual(q.overs, ["gone"]);
	} finally { q.done(); }
});

test("a prompt: 執行 posts one Enter with the stream, nothing while it is on its way, and a 200 ends the card", async () => {
	const p = rig("prompt");
	try {
		p.press();
		assert.deepEqual(p.posts, [{ action: "keys", body: { key: "enter", stream: "st" } }]);
		assert.deepEqual([p.go().disabled, p.go().textContent, p.status().textContent], [true, m.card_sending(), m.card_sending()]);
		p.press();
		assert.equal(p.posts.length, 1, "a second press while it is on its way sends nothing");
		await p.reply(200, { accepted: true });
		assert.deepEqual(p.overs, ["taken"]);
	} finally { p.done(); }
});

test("one tap: a prompt step that holds a grant sends Enter naming its answer once; a refusal leaves the usual confirm on the next press, with no run", async () => {
	const p = rig("prompt", { run: "a1b2c3d4e5f6a7b8" });
	try {
		p.press();
		assert.deepEqual(p.posts[0]!.body, { key: "enter", stream: "st", run: "a1b2c3d4e5f6a7b8" });
		await p.reply(409, { error: "run_changed", reason: "server English" });
		assert.equal(p.status().textContent, m.refuse_run_changed(), "in the page's words by the code");
		p.tick(200);
		p.press();
		assert.deepEqual(p.posts[1]!.body, { key: "enter", stream: "st" }, "the grant is spent: the next Enter asks the confirm");
		await p.reply(409, { error: "confirm", confirm: "command", reason: "x" });
		assert.deepEqual(p.overs, []);
	} finally { p.done(); }
});

test("one tap: a step with no grant, and a pane step, never send run", () => {
	for (const kind of ["prompt", "pane"] as const) {
		const p = rig(kind, { run: kind === "pane" ? "a1b2c3d4e5f6a7b8" : undefined });
		try {
			p.press();
			assert.equal("run" in p.posts[0]!.body, false, kind);
		} finally { p.done(); }
	}
});

test("a prompt: the server's confirm shows in the page's words by its token (an unknown one in the server's), the focus goes to Cancel, and Send it posts exactly the token the server named", async () => {
	const said = "Server English that must not show.";
	for (const [token, want] of [["command", m.card_confirm_command({ name: "billing-main" })], ["unread", m.card_confirm_unread({ name: "billing-main" })], ["reload", m.card_confirm_ending({ command: "reload" })], ["quit", m.card_confirm_ending({ command: "quit" })], ["something-new", said]] as const) {
		const p = rig("prompt");
		try {
			p.press();
			await p.reply(409, { error: "confirm", confirm: token, reason: said });
			const { yes, no, why } = p.ask();
			assert.equal(why!.textContent, want, token);
			assert.ok(token === "something-new" || !p.status().textContent.includes(said), "the server's English does not show for a token the card knows");
			assert.deepEqual([yes!.textContent, no!.textContent], [m.card_confirm_yes(), m.cancel()]);
			assert.equal(page.focus, no, "the focus goes to Cancel, never to the confirm");
			assert.deepEqual(p.overs, [], "a confirm does not end the step");
			yes!.onclick!({ isTrusted: false });
			assert.equal(p.posts.length, 1, "a synthetic confirm sends nothing");
			p.tick(200);
			p.click(yes!);
			assert.deepEqual(p.posts.at(-1)!.body, { key: "enter", stream: "st", confirmed: token });
			await p.reply(200, { accepted: true });
			assert.deepEqual(p.overs, ["taken"], "a confirmed Enter that the server took ends it");
		} finally { p.done(); }
	}
});

test("a prompt: Cancel clears the confirm and sends nothing; a refusal stays, in the page's words by its code, and can be retried", async () => {
	const p = rig("prompt");
	try {
		p.press();
		await p.reply(409, { error: "confirm", confirm: "command", reason: "r" });
		p.click(p.ask().no!);
		assert.deepEqual([p.posts.length, p.status().textContent, p.go().disabled, p.overs], [1, "", false, []]);
		p.tick(200);
		p.press();
		await p.reply(409, { error: "no_mirror", reason: "Keys are sent only while live." });
		assert.deepEqual([p.status().textContent, p.status().dataset.tone, p.go().disabled, p.overs], [m.refuse_no_mirror(), "error", false, []]);
		p.tick(200);
		p.press();
		assert.equal(p.posts.length, 3, "the button is there to try again");
		assert.equal(p.status().textContent, m.card_sending(), "a new try clears the last refusal");
	} finally { p.done(); }
});

test("a prompt's card is over by an Enter taken from its expansion's pad and by no refusal", async () => {
	const p = rig("prompt");
	try {
		p.press();
		await p.reply(404, { error: "not_found", reason: "gone" });
		assert.deepEqual(p.overs, [], "a refusal never ends a prompt's card");
		p.taken();
		assert.deepEqual(p.overs, ["taken"]);
	} finally { p.done(); }
});

test("a pane's rows do not say the shown command a second time", () => {
	const q = rig("pane");
	try {
		q.rows(["$ sudo apt update", "[sudo] password for boss:"]);
		assert.equal(q.el.byClass("tcard-tail")!.textContent, "[sudo] password for boss:", "the echo of the command shown above is not in the rows");
		assert.equal(q.el.byClass("tcard-cmd")!.textContent, "sudo apt update");
	} finally { q.done(); }
	const r = rig("pane", { command: "ls" });
	try {
		r.rows(["$ ls", "file"]);
		assert.equal(r.el.byClass("tcard-tail")!.textContent, "file");
	} finally { r.done(); }
});

test("a pane: Send Enter with an empty line posts Enter only", async () => {
	const q = rig("pane");
	try {
		q.rows(["$ sudo apt update"]);
		q.press();
		assert.deepEqual(q.posts.map((p) => p.body), [{ key: "enter", stream: "st" }]);
		await q.reply(200);
		assert.deepEqual(q.overs, [], "an Enter taken does not end a pane's card: more prompts may follow");
		assert.equal(q.status().textContent, m.card_sent());
	} finally { q.done(); }
});

test("a pane: 70 characters go as 64 and 6 then Enter, in order, 130 ms apart, and the field is empty at once", async () => {
	const q = rig("pane");
	try {
		const times: number[] = [];
		q.rows(["$ "]);
		q.input().value = "x".repeat(70);
		q.press();
		assert.equal(q.input().value, "");
		for (let i = 0; i < 3; i++) {
			times.push(Date.now());
			assert.equal(q.posts.length, i + 1);
			await q.reply(200);
			q.tick(130);
		}
		assert.deepEqual(q.posts.map((p) => (p.body.text === undefined ? p.body.key : [...String(p.body.text)].length)), [64, 6, "enter"]);
		assert.ok(times.every((t, i) => i === 0 || t - times[i - 1]! >= 130));
	} finally { q.done(); }
});

test("a pane: a refused text drops the Enter, a plain field gets its text back, and a masked field stays empty", async () => {
	const q = rig("pane");
	try {
		q.rows(["$ "]);
		q.input().value = "hello";
		q.press();
		await q.reply(409, { error: "no_mirror", reason: "No mirror." });
		q.tick(1000);
		assert.deepEqual(q.posts.map((p) => p.body), [{ text: "hello", stream: "st" }], "no Enter after the text that did not land");
		assert.equal(q.input().value, "hello", "the boss can retry");
		assert.equal(q.status().textContent, m.refuse_no_mirror());
	} finally { q.done(); }
	const s = rig("pane");
	try {
		s.rows(PW);
		s.input().value = "hunter2";
		s.press();
		assert.equal(s.input().value, "");
		await s.reply(409, { error: "no_mirror", reason: "No mirror." });
		assert.equal(s.input().value, "", "a masked field is never filled again");
	} finally { s.done(); }
});

test("a plain field's text comes back after a refusal only if the boss has typed nothing since", async () => {
	const q = rig("pane");
	try {
		q.rows(["$ "]);
		q.input().value = "first";
		q.press();
		q.input().value = "second";
		await q.reply(409, { error: "no_mirror", reason: "x" });
		assert.equal(q.input().value, "second");
	} finally { q.done(); }
});

test("a synthetic click on an idle card sends nothing", () => {
	const p = rig("prompt");
	try {
		p.go().onclick!({ isTrusted: false });
		assert.equal(p.posts.length, 0);
	} finally { p.done(); }
});

test("a password prompt masks the field by itself, says so, and moves the focus to the input on a desktop but not on a phone", () => {
	const q = rig("pane");
	try {
		q.rows(["$ sudo apt update"]);
		assert.equal(q.input().type, "text");
		q.rows(PW);
		assert.deepEqual([q.input().type, q.mask().getAttribute("aria-pressed"), q.status().textContent, q.el.dataset.state, page.focus], ["password", "true", m.card_secret(), "secret", q.input()]);
	} finally { q.done(); }
	const r = rig("pane");
	try {
		page.fine = false;
		r.rows(PW);
		assert.deepEqual([r.input().type, page.focus], ["password", undefined], "a phone's keyboard opens by the boss's tap");
	} finally { r.done(); }
});

test("the mask goes off by itself only when the prompt is gone and the field is empty, never while text is typed in it", () => {
	const q = rig("pane");
	try {
		q.rows(PW);
		q.input().value = "abc";
		q.rows(["Sorry, try again.", "$ "]);
		assert.equal(q.input().type, "password", "typed text is never unmasked");
		q.input().value = "";
		q.rows(["Sorry, try again.", "$ ", "done"]);
		assert.equal(q.input().type, "text");
	} finally { q.done(); }
});

test("a prompt the rule misses is masked by hand, stays masked, and a hand mask on a prompt that matches can be taken off", () => {
	const q = rig("pane");
	try {
		q.rows(["Enter secret>"]);
		assert.equal(q.input().type, "text", "the rule cannot know");
		q.click(q.mask());
		assert.deepEqual([q.input().type, q.mask().getAttribute("aria-pressed")], ["password", "true"]);
		q.rows(["Enter secret>", "more"]);
		assert.equal(q.input().type, "password", "a hand mask stays");
		q.click(q.mask());
		assert.equal(q.input().type, "text");
		q.rows(PW);
		assert.equal(q.input().type, "text", "a hand unmask is not undone by the prompt");
		q.mask().onclick!({ isTrusted: false });
		assert.equal(q.input().type, "text", "a synthetic click does not toggle it");
	} finally { q.done(); }
});

test("a hand mask is for the prompt it answered: after an accepted send it resets, and a later password prompt masks again by itself", async () => {
	const q = rig("pane");
	try {
		q.rows(["Enter secret>"]);
		q.click(q.mask());
		q.input().value = "s3cret";
		q.press();
		await q.reply(200);
		q.tick(130);
		await q.reply(200);
		q.rows(["ok", "$ "]);
		assert.equal(q.input().type, "text", "the next line is plain");
		q.rows(["ok", "$ sudo ls", "[sudo] password for boss:"]);
		assert.equal(q.input().type, "password");
	} finally { q.done(); }
});

test("Enter in the input sends once; a repeat, a composition, and a synthetic key send nothing; the primary button never takes the focus on open", () => {
	const q = rig("pane");
	try {
		q.rows(["$ "]);
		q.card.focus();
		assert.equal(page.focus, q.input(), "the input takes the focus on a desktop");
		const key = (e: Record<string, unknown>) => q.input().fire("keydown", { key: "Enter", ...e });
		key({ repeat: true });
		key({ isComposing: true });
		key({ isTrusted: false });
		assert.equal(q.posts.length, 0);
		assert.equal(key({}), true, "Enter is kept from the browser");
		assert.equal(q.posts.length, 1);
		assert.equal(q.go().fire("keydown", { key: "Enter", repeat: true }), true, "a held Enter on the button is not a press");
		q.go().onclick!({ isTrusted: false });
		assert.equal(q.posts.length, 1, "a synthetic click sends nothing");
	} finally { q.done(); }
});

test("the focus goes to the input, the card, or its header by kind and pointer, and to Cancel in a confirm", async () => {
	const p = rig("prompt");
	try {
		p.card.focus();
		assert.equal(page.focus, p.el);
		page.fine = false;
		p.card.focus();
		assert.equal(page.focus, p.el.all().find((e) => e.tag === "h2"));
		page.fine = true;
		p.press();
		await p.reply(409, { error: "confirm", confirm: "command", reason: "r" });
		p.card.focus();
		assert.equal(page.focus, p.ask().no);
	} finally { p.done(); }
});

test("a pane's card is over when its pane is gone: the ended frame, an attach refused as not found or pane_closed, or a write refused as gone; never when a write is refused otherwise or the network fails", async () => {
	for (const [status, error] of [[404, "not_found"], [409, "pane_closed"]] as const) {
		const q = rig("pane");
		try {
			q.press();
			await q.reply(status, { error, reason: "gone" });
			assert.deepEqual(q.overs, ["gone"], `${status} ${error}`);
		} finally { q.done(); }
	}
	for (const [status, error] of [[409, "no_mirror"], [429, "rate"], [403, "blocked"]] as const) {
		const q = rig("pane");
		try {
			q.press();
			await q.reply(status, { error, reason: "x" });
			assert.deepEqual(q.overs, [], `${status} ${error}`);
		} finally { q.done(); }
	}
});

test("× and Esc inside the card close it, Full terminal hands it over, and a Zen card does not take Esc", () => {
	const q = rig("pane");
	try {
		q.click(q.el.byClass("tcard-x")!);
		assert.deepEqual(q.overs, ["closed"]);
		assert.equal(q.el.fire("keydown", { key: "Escape" }), true);
		assert.deepEqual(q.overs, ["closed", "closed"]);
		q.el.fire("keydown", { key: "Escape", isComposing: true });
		q.el.fire("keydown", { key: "a" });
		assert.equal(q.overs.length, 2, "an input method's Esc and other keys do not close it");
		q.click(q.el.byClass("tcard-full")!);
		assert.deepEqual(q.overs.at(-1), "full");
	} finally { q.done(); }
	const z = rig("pane", { escape: false });
	try {
		assert.equal(z.el.fire("keydown", { key: "Escape" }), false);
		assert.deepEqual(z.overs, []);
	} finally { z.done(); }
});

test("the card's line is no form field a password manager meets: no form around it, autocomplete and correction off, a visible-on-focus label", () => {
	const q = rig("pane");
	try {
		assert.ok(!q.el.all().some((e) => e.tag === "form"), "no form, so no submit event");
		const input = q.input();
		assert.deepEqual(["autocomplete", "autocapitalize", "autocorrect", "spellcheck"].map((a) => input.getAttribute(a)), ["off", "off", "off", "false"]);
		const label = q.el.byClass("tcard-label")!;
		assert.equal(label.getAttribute("for"), input.getAttribute("id"));
		assert.equal(label.textContent, m.card_input());
		assert.equal(q.mask().getAttribute("aria-pressed"), "false");
	} finally { q.done(); }
});

test("the card holds no number of rows, columns, or items, whatever the pane is", () => {
	const q = rig("pane", { command: "ls", name: "ops" });
	try {
		q.conn.cols = 80;
		q.rows(Array.from({ length: 24 }, (_, i) => (i === 23 ? "[sudo] password for boss:" : "")));
		const chrome = q.el.all().filter((e) => !e.classes.has("tcard-tail") && !e.classes.has("tcard-cmd") && !e.classes.has("tcard-cmdbox"));
		const own = chrome.flatMap((e) => e.kids.filter((k): k is string => typeof k === "string")).join(" ");
		assert.doesNotMatch(own, /\d/, own);
		assert.doesNotMatch(own, /×.*\d|\d.*×/);
	} finally { q.done(); }
});

test("every body the card posts passes the server's own key check, with the stream and only a token the server named", async () => {
	const p = rig("prompt");
	const clock = { t: 1_000_000 };
	const k = createKeys({ fresh: () => true, secret: async () => false, answerable: async () => false, probe: async () => undefined, now: () => clock.t });
	try {
		p.press();
		await p.reply(409, { error: "confirm", confirm: "command", reason: "r" });
		p.tick(200);
		p.click(p.ask().yes!);
		await p.reply(200);
		const q = rig("pane");
		p.done = q.done;
		q.rows(PW);
		q.input().value = "x".repeat(70);
		q.press();
		for (let i = 0; i < 3; i++) (await q.reply(200), q.tick(130));
		const bodies = [...p.posts, ...q.posts].map((x) => x.body);
		const ps = p.posts.length;
		assert.equal(bodies.length, 5);
		for (const body of bodies) {
			clock.t += 200;
			const asked = k.check("S", body);
			assert.ok(!("status" in asked), JSON.stringify([body, asked]));
			assert.deepEqual(Object.keys(body).filter((key) => !["key", "text", "stream", "confirmed"].includes(key)), [], "no other shape");
			assert.ok("key" in body ? body.key === "enter" : "text" in body, "only Enter and typed text: no Escape, arrows, chords, or paste");
		}
		assert.deepEqual(bodies.filter((b) => "confirmed" in b).map((b) => b.confirmed), ["command"]);
		assert.ok(p.posts.every((x) => x.action === "keys") && q.posts.every((x) => x.action === "keys") && ps === 2);
	} finally { p.done(); }
});

test("the card's words exist in both languages and the Chinese ones are Chinese", () => {
	const keys = Object.keys(en).filter((k) => k.startsWith("card_"));
	assert.equal(keys.length, 13);
	assert.deepEqual(Object.keys(zh).filter((k) => k.startsWith("card_")), keys);
	for (const k of keys) assert.match((zh as Record<string, string>)[k]!, /[\u4e00-\u9fff]/, k);
	assert.equal(m.card_run({}, { locale: "zh-TW" }), "執行");
	assert.equal(m.card_sent({}, { locale: "zh-TW" }), "已送出。");
	assert.equal(m.card_confirm_yes({}, { locale: "zh-TW" }), "確認送出");
	assert.match(m.card_confirm_ending({ command: "reload" }, { locale: "zh-TW" }), /\/reload/);
});

test("stop leaves the connection and the card keeps nothing of what was typed", () => {
	const q = rig("pane");
	try {
		q.rows(PW);
		q.input().value = "hunter2";
		q.card.stop();
		assert.equal(q.stops(), 1);
		assert.ok(!q.el.all().some((e) => e.getAttribute("value") === "hunter2" || e.textContent.includes("hunter2")), "the typed text is in the field only");
	} finally { q.done(); }
});

test("a card whose attach was refused reattaches from its button instead of sending keys, says it is connecting, and backs off when refused again", async () => {
	for (const kind of ["prompt", "pane"] as const) {
		const q = rig(kind);
		try {
			q.phase("refused", "Too many terminals are open.");
			assert.equal(q.el.dataset.state, "refused");
			assert.ok(!q.go().disabled, "the button is enabled");
			q.press();
			assert.equal(q.retries(), 1, "one attach again");
			assert.deepEqual(q.posts, [], "and no key, which the server would refuse for lack of a mirror");
			assert.equal(q.el.dataset.state, "connecting");
			assert.equal(q.status().textContent, m.connecting());
			assert.ok(q.go().disabled);
			q.phase("refused", "again");
			q.press();
			assert.equal(q.retries(), 1, "refused again at once: it waits");
			assert.equal(q.el.dataset.state, "connecting", "and says so");
			q.tick(999);
			assert.equal(q.retries(), 1);
			q.tick(1);
			assert.equal(q.retries(), 2, "the second try after 1 s");
			q.phase("refused", "again");
			q.press();
			q.tick(1999);
			assert.equal(q.retries(), 2);
			q.tick(1);
			assert.equal(q.retries(), 3, "the third after 2 s more");
			q.rows(["$ "]);
			q.phase("live");
			q.press();
			assert.deepEqual(q.posts.length, 1, "attached: the button sends keys again");
		} finally { q.done(); }
	}
	const w = rig("prompt");
	try {
		w.phase("refused", "x");
		w.press();
		w.phase("refused", "x");
		w.press();
		w.card.stop();
		w.tick(10_000);
		assert.equal(w.retries(), 1, "a card that is gone does not reattach");
	} finally { w.done(); }
});

test("the Enter that commits an input method's composition (keyCode 229 with isComposing already false) sends nothing and is left to the browser", () => {
	const q = rig("pane");
	try {
		q.rows(["$ "]);
		assert.equal(q.input().fire("keydown", { key: "Enter", keyCode: 229, isComposing: false }), false, "not kept from the browser, which commits the candidate");
		assert.equal(q.posts.length, 0);
		assert.equal(q.input().fire("keydown", { key: "Enter", isComposing: true }), false);
		assert.equal(q.posts.length, 0);
		assert.equal(q.input().fire("keydown", { key: "Enter", keyCode: 13 }), true);
		assert.equal(q.posts.length, 1);
	} finally { q.done(); }
});

test("a card that was stopped is over for good: a late reply to its Enter or its text closes nothing", async () => {
	for (const reply of [[200, {}], [404, { error: "not_found" }], [409, { error: "pane_closed" }]] as const) {
		const q = rig("prompt");
		try {
			q.press();
			q.card.stop();
			await q.reply(reply[0], reply[1]);
			q.taken();
			q.end();
			assert.deepEqual(q.overs, [], `a late ${reply[0]} after stop`);
		} finally { q.done(); }
	}
	const p = rig("pane");
	try {
		p.rows(["$ "]);
		p.input().value = "yes";
		p.press();
		p.card.stop();
		await p.reply(404, { error: "not_found" });
		assert.deepEqual(p.overs, []);
	} finally { p.done(); }
});

test("a text that landed is not put back when its Enter is refused, so a retry does not type it twice", async () => {
	const q = rig("pane");
	try {
		q.rows(["$ "]);
		q.input().value = "yes";
		q.press();
		await q.reply(200);
		q.tick(130);
		await q.reply(409, { error: "rate", reason: "slow" });
		assert.equal(q.input().value, "", "the line already holds it");
	} finally { q.done(); }
});

test("the mask reset on an accepted send does not unmask characters typed while it was on its way", async () => {
	const q = rig("pane");
	try {
		q.rows(["Enter secret>"]);
		q.click(q.mask());
		q.input().value = "s3cret";
		q.press();
		q.input().value = "next";
		await q.reply(200);
		q.tick(130);
		await q.reply(200);
		assert.equal(q.input().type, "password", "typed characters stay hidden");
		assert.equal(q.input().value, "next");
		q.input().value = "";
		q.rows(["ok", "$ "]);
		assert.equal(q.input().type, "text", "and the empty field follows the prompt again");
	} finally { q.done(); }
});

test("the auto-mask moves the focus only from the page's body or from inside the card, never from another field", () => {
	const q = rig("pane");
	try {
		const other = new El("textarea");
		page.root.append(other);
		other.focus();
		q.rows(PW);
		assert.equal(q.input().type, "password", "the field is masked all the same");
		assert.equal(page.focus, other, "the boss's typing elsewhere is not taken");
	} finally { q.done(); }
	const r = rig("pane");
	try {
		page.root.append(r.el);
		r.mask().focus();
		r.rows(PW);
		assert.equal(page.focus, r.input(), "from inside the card it goes to the line");
	} finally { r.done(); }
});

test("Z-D20: Zen's card (enter): Run takes the focus once it can act, the confirm's Send takes it (never Cancel) and Enter on it confirms, a held Enter and one that began before it confirm nothing, and a typed key moves the focus to Cancel (ZNI-F001); Standard's card keeps its focus on Cancel", async () => {
	const std = rig("prompt");
	try {
		std.press();
		await std.reply(409, { error: "confirm", confirm: "reload", reason: "r" });
		assert.equal(page.focus, std.ask().no, "Standard: Cancel");
	} finally { std.done(); }
	const p = rig("prompt", { enter: true, escape: false });
	try {
		assert.equal(page.focus, p.go(), "Run is the primary control: Enter presses it");
		assert.equal(p.go().fire("keydown", { key: "Enter", repeat: true }), true, "a held Enter on it is not a press");
		p.press();
		await p.reply(409, { error: "confirm", confirm: "reload", reason: "r" });
		const { yes, no } = p.ask();
		assert.equal(page.focus, yes, "Zen: the confirm's Send has the focus");
		assert.notEqual(page.focus, no);
		assert.equal(yes!.fire("keydown", { key: "Enter", repeat: true, timeStamp: Infinity }), true, "a held Enter is ignored");
		assert.equal(yes!.fire("keydown", { key: "Enter", timeStamp: -1 }), true, "so is one that began before the confirm");
		assert.equal(p.posts.length, 1);
		p.tick(200);
		assert.equal(yes!.fire("keydown", { key: "Enter", timeStamp: Infinity }), false, "a fresh Enter is the button's");
		p.click(yes!);
		assert.deepEqual(p.posts.at(-1)!.body, { key: "enter", stream: "st", confirmed: "reload" });
		await p.reply(200, { accepted: true });
		assert.deepEqual(p.overs, ["taken"]);
	} finally { p.done(); }
	const t = rig("prompt", { enter: true, escape: false });
	try {
		t.press();
		await t.reply(409, { error: "confirm", confirm: "reload", reason: "r" });
		const { yes, no } = t.ask();
		assert.equal(yes!.fire("keydown", { key: "a", timeStamp: Infinity }), true, "a key typed while the confirm shows is kept from Send");
		assert.equal(page.focus, no, "the focus went to Cancel");
		t.tick(200);
		assert.equal(yes!.fire("keydown", { key: "Enter", timeStamp: Infinity }), true, "and the Enter that ends the typing is kept from it");
		assert.equal(t.posts.length, 1, "nothing was confirmed");
	} finally { t.done(); }
	const q = rig("pane", { enter: true, escape: false });
	try {
		q.rows(["$ "]);
		q.card.focus();
		assert.equal(page.focus, q.input(), "a pane's card: the line takes the focus, and Enter in it is Send Enter");
	} finally { q.done(); }
});
