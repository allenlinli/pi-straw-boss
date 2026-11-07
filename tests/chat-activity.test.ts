import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Unit } from "../src/net.ts";
import { declarations, rulesOf } from "./css-rules.ts";
import { El } from "./fake-dom.ts";

// What a unit is doing (todo #127): the status row under the last message is gone from the comms log; the composer carries the state instead, as a ring that moves round the box while the unit
// works (a still one while it waits for the boss or failed, and for anyone who asked for less motion) and as words for assistive tech. The page has no browser here: the model, the mounted composer
// in the fake DOM, and the style sheet's text are checked; the real animation is checked by the screenshots of the change.

Object.assign(globalThis, { matchMedia: () => ({ matches: false }), CSS: { supports: () => true }, window: {} });
const { mountChat } = await import("../gui/chat.ts");
const { mountComposer } = await import("../gui/composer.ts");
const { composerUnit } = await import("../gui/sessionfacts.ts");
const { m } = await import("../gui/paraglide/messages.js");

const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
const src = (name: string) => readFileSync(new URL(`../gui/${name}`, import.meta.url), "utf8");
const unit = (extra: Partial<Unit> = {}): Unit => ({ id: "u", key: "u", name: "Ada", role: "main", mark: "idle", control: true, subs: [], ...extra });
const facts = (mk: Parameters<typeof composerUnit>[1]["mk"], extra: Partial<Unit> = {}, state = "live") => composerUnit(unit(extra), { name: "Ada", mk, state, online: true });

test("the comms log has no status row: the chat draws no live line and takes no live state", () => {
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "a1", name: "main", role: "main", mark: "working" as const }), link: () => undefined });
	chat.apply({ key: "a1", reset: true, items: [{ id: "u1", kind: "user", text: "hi" }] });
	assert.equal(root.find((el) => el.classes.has("chat-live")).length, 0, "no row under the last message");
	assert.equal("setLive" in chat, false, "nothing draws one later");
	assert.doesNotMatch(css, /\.chat-live\b/, "and the style sheet keeps no rule for it");
	for (const file of ["session.ts", "zen.ts", "sessionfacts.ts"]) assert.doesNotMatch(src(file), /setLive|liveOf/, `${file} no longer feeds the log a live state`);
});

test("the log keeps the space the empty row left under its last message: the end sentinel carries it, so the chat's scroll geometry is as it was", () => {
	const end = rulesOf(css).find((r) => r.parts.includes(".chat-end"));
	assert.ok(end);
	assert.ok(declarations(end!.body).some(([p, v]) => p === "margin-top" && v === "13px"), "14 px of the old row, less the pixel the sentinel sat in");
});

test("the composer's facts say what the unit does: its words, the ring's state, and which working state it is", () => {
	const act = (mk: Parameters<typeof facts>[0], note?: string, state = "live") => facts(mk, note ? { note } : {}, state).activity;
	assert.deepEqual(act("working", "thinking"), { text: m.note_thinking(), mark: "working", kind: "thinking" });
	assert.deepEqual(act("working"), { text: m.mark_working(), mark: "working", kind: "thinking" }, "no note yet: it works");
	assert.deepEqual(act("working", "tool:edit"), { text: m.using({ tool: "edit" }), mark: "working", kind: "tool" });
	assert.deepEqual(act("working", "watching a monitor"), { text: m.note_monitoring(), mark: "working", kind: "monitoring" });
	assert.deepEqual(act("commanding"), { text: m.mark_commanding(), mark: "commanding", kind: "thinking" });
	assert.deepEqual(act("waiting"), { text: m.mark_waiting(), mark: "waiting", kind: "thinking" }, "the boss is asked: a still ring of its own colour");
	assert.deepEqual(act("error"), { text: m.mark_error(), mark: "error", kind: "thinking" });
	assert.equal(act("idle"), undefined, "an idle unit has no ring");
	assert.equal(act("done"), undefined);
	assert.equal(act("working", "tool:edit", "recent"), undefined, "a session that left the net is not at work");
	assert.equal(composerUnit(unit({ ended: true, control: false }), { name: "Ada", mk: "working", state: "live", online: true }).activity, undefined, "a finished subagent keeps no ring");
});

function mounted() {
	const root = new El("div"), composer = mountComposer(root as never, "k-activity", (() => Promise.resolve({ ok: true })) as never);
	return { root, composer, form: root.find((el) => el.tag === "form")[0]!, status: root.find((el) => el.classes.has("cmp-activity"))[0] };
}

test("a working composer carries the state on its form and says it to assistive tech; an idle one carries nothing and says nothing", () => {
	const { composer, form, status } = mounted();
	assert.ok(status, "a region for the words");
	assert.equal(status!.attrs.get("role"), "status");
	assert.equal(status!.attrs.get("aria-live"), "polite");
	composer.update(facts("working", { note: "tool:edit" }));
	assert.deepEqual([form.dataset.activity, form.dataset.kind, status!.textContent], ["working", "tool", m.using({ tool: "edit" })]);
	composer.update(facts("working", { note: "thinking" }));
	assert.deepEqual([form.dataset.activity, form.dataset.kind, status!.textContent], ["working", "thinking", m.note_thinking()]);
	composer.update(facts("commanding"));
	assert.deepEqual([form.dataset.activity, status!.textContent], ["commanding", m.mark_commanding()]);
	composer.update(facts("waiting"));
	assert.deepEqual([form.dataset.activity, status!.textContent], ["waiting", m.mark_waiting()], "waiting for the boss stays its own state");
	composer.update(facts("idle"));
	assert.deepEqual([form.dataset.activity, form.dataset.kind, status!.textContent], [undefined, undefined, ""]);
});

test("the words change only when the state does, so a screen reader is not told the same thing again on every redraw", () => {
	const { composer, status } = mounted();
	composer.update(facts("working", { note: "thinking" }));
	const node = status!.kids[0];
	composer.update(facts("working", { note: "thinking" }));
	assert.equal(status!.kids[0], node, "the same words are left alone");
});

test("the composer under a log that ended has no ring", () => {
	const { composer, form } = mounted();
	composer.update(facts("working", { note: "thinking" }));
	composer.update(composerUnit(unit({ ended: true, control: false }), { name: "Ada", mk: "working", state: "live", online: true }));
	assert.equal(form.dataset.activity, undefined);
});

// The style sheet. The ring is the box's own pseudo element, out of the layout, so a state change moves nothing; the motion is declared once and the stills are the base.
const ring = rulesOf(css).filter((r) => r.parts.some((p) => p.includes("[data-activity]") || p.includes("[data-activity=")));

test("the ring is drawn by a pseudo element that takes no room and no taps, with no vendor-prefixed property", () => {
	const base = ring.find((r) => r.parts.some((p) => /\.cmp-row::before$/.test(p)));
	assert.ok(base, "a ring on the composer's row");
	const decl = declarations(base!.body);
	assert.ok(decl.some(([p, v]) => p === "position" && v === "absolute"));
	assert.ok(decl.some(([p, v]) => p === "pointer-events" && v === "none"));
	assert.ok(decl.some(([p]) => p === "mask"), "the ring is a gradient seen through a frame mask");
	assert.ok(!decl.some(([p]) => p === "height" || p === "min-height" || p === "margin" || p === "width"), "it sets no size of its own: inset only");
	for (const r of ring) assert.doesNotMatch(r.body, /-webkit-/, `${r.selector} uses only standard properties`);
	assert.doesNotMatch(css.split("\n").filter((l) => l.includes("data-activity") || l.includes("cmp-ring")).join("\n"), /-webkit-/);
});

test("each state has its own colour from the page's tokens, and a waiting or failed unit has a ring that never moves", () => {
	const text = ring.map((r) => `${r.selector} {${r.body}}`).join("\n");
	// the thought is the base kind: no rule of its own
	for (const state of ["working", "commanding", "waiting", "error"]) assert.match(text, new RegExp(`\\[data-activity="${state}"\\]`), state);
	for (const kind of ["tool", "monitoring"]) assert.match(text, new RegExp(`\\[data-kind="${kind}"\\]`), kind);
	assert.match(text, /var\(--accent\)/);
	assert.match(text, /var\(--violet\)/);
	assert.match(text, /var\(--amber\)/);
	assert.match(text, /var\(--err\)/);
	assert.doesNotMatch(text.replace(/mask:[^;]*;/g, ""), /#[0-9a-f]{3,8}\b|rgba?\(/i, "no colour of its own: the tokens only (the mask's opaque stop is no colour shown)");
	const still = ring.filter((r) => r.parts.some((p) => /data-activity="(waiting|error)"/.test(p)));
	assert.ok(still.length > 0 && still.every((r) => !/animation/.test(r.body)), "a waiting or failed ring does not move");
});

test("the motion exists only where the page allows it: not under reduced motion, in a calm page, or in Geek, which keep the still ring", () => {
	assert.match(css, /@keyframes ring-run \{[^}]*background-position/, "the sweep");
	const moving = ring.filter((r) => /animation/.test(r.body));
	assert.ok(moving.length > 0);
	assert.ok(moving.every((r) => r.parts.every((p) => /:not\(\[data-calm\]\)/.test(p) && /:not\(\[data-view="zen"\]\)/.test(p))), "the sweep is drawn only outside calm and Zen (Zen has its own line)");
	const geek = readFileSync(new URL("../gui/themes/geek/geek.css", import.meta.url), "utf8");
	assert.ok(geek.includes('html[data-view="geek"] .composer:is([data-activity="working"], [data-activity="commanding"]) .cmp-row::before { background: color-mix(in srgb, var(--ring) 55%, transparent) !important; }'), "and Geek's own sheet puts the flat ring back over it");
	const block = css.match(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*?cmp-row::before[\s\S]*?\n\}/);
	assert.ok(block, "the sweep sits in a no-preference block, so reduced motion gets the still ring and the global stop is a second guard");
	assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \*:not\(\.zen-hl\), \*::before, \*::after \{ animation: none !important/, "and the page's own stop remains");
});

test("the ring takes no layout: no rule of a state sets a size, a margin, or a display, and only the pseudo element has padding (the frame its mask cuts)", () => {
	for (const r of ring) for (const [p] of declarations(r.body)) {
		assert.ok(!/^(width|height|min-|max-|margin|flex|display|top$|left$|right$|bottom$)/.test(p), `${r.selector} sets ${p}`);
		if (p === "padding") assert.ok(r.parts.every((part) => part.endsWith("::before")), `${r.selector} pads a real box`);
	}
});

test("Zen draws a lit line under the box that only breathes in opacity, on its own tokens, and has no border box or sweep", () => {
	const lines = rulesOf(zen).filter((r) => r.parts.some((p) => p.includes("data-activity")));
	assert.ok(lines.length > 0, "Zen restyles the ring");
	const text = lines.map((r) => r.body).join("\n");
	assert.doesNotMatch(text, /background-position|transform|box-shadow/, "only opacity moves in Zen");
	assert.doesNotMatch(text, /-webkit-/);
	assert.match(zen, /@keyframes zen-ring \{[^}]*opacity[^}]*\}/);
	assert.doesNotMatch(zen.match(/@keyframes zen-ring \{[^}]*\}/)?.[0] ?? "", /transform|background|box-shadow/);
});
