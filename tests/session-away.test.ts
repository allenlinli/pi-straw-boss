import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pending } from "../src/ask.ts";
import type { Item } from "../src/items.ts";
import { selectDigest } from "../src/owners.ts";
import { m } from "../gui/paraglide/messages.js";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import "./pbs-loader.ts";

// The session view's log of a unit on a remote base (docs/specs/2026-11-07-link-operate.md): its blocks cannot be submitted while the box is unreachable or ended, they are off with the reason, and they follow every snapshot of the net
// (todo #121 task 7 fix round 4, R-F001). A unit of a local base is unchanged.

sessionGlobals();
Object.assign(globalThis, { setTimeout: () => 0 }); // the session view runs no timer here
Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { mountSession } = await import("../gui/session.ts");
const { whenDrawn } = await import("../gui/mdbody.ts");
const { forgetLocks } = await import("../gui/blocklock.ts");
const { forgetAnswered, answeredHooks } = await import("../gui/answered.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((done) => setImmediate(done)); await whenDrawn(); };
const BLOCK = "Pick one.\n\n```suggest\n- Go ahead\n```";
type Box = { state: "live" | "unreachable" | "ended"; can: string[] };
const REMOTE = (state: Box["state"]) => ({ device: "dev1", short: "a1b2c3", label: "agent-tower-01", team: "moldplan", scope: "team", can: ["input", "answer", "keys"], state });

const SELECT = { title: "Run the export tonight?", choices: [{ label: "Yes" }, { label: "No" }] };
const PENDING: Pending = { callId: "c1", tool: "dialog", answer: { dialog: "m1", digest: selectDigest(SELECT), select: SELECT } };

async function mounted(box: Box["state"] | undefined, pending?: Pending) {
	forgetLocks();
	forgetAnswered();
	answeredHooks.get = async () => ({ done: [], pending: [] }) as never;
	const u = { key: "k", name: "billing", role: "session", mark: (pending ? "waiting" : "idle") as "idle", subs: [], control: true, ...(pending ? { pending } : {}) };
	const sent: string[] = [];
	const base = { id: "w1", label: "w1", tabs: [], outside: [u], ...(box ? { box: REMOTE(box) } : {}) };
	const scene = { route: { view: "session", ws: "w1", key: "k" }, net: { bases: [base] }, cards: {}, info: { name: "billing", role: "session", state: "live" } } as never as { net: { bases: (typeof base)[] } };
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async (action: string) => (sent.push(action), { ok: true, status: 200, body: {} }) };
	const view = new El("div");
	page.body.replaceChildren(view);
	const session = mountSession(scene as never, { view: view as never, data: () => data as never, openTile() {}, embedTerminal: async () => () => {}, online: () => true, fullScreen() {}, opened() {} });
	session.open("k");
	await settle();
	const draw = () => session.draw({ u: u as never, hit: { u, base } as never, mk: u.mark, state: "live", name: "billing" } as never);
	draw();
	session.chat!.apply({ key: "k", reset: true, items: [{ id: "a1", kind: "assistant", text: BLOCK } as Item] });
	await settle();
	const chips = () => view.find((el) => el.tagName === "pbs-suggest")[0] as El & { answered?: unknown };
	const notes = () => view.find((el) => el.className === "pbs-note").map((el) => el.textContent);
	const askNote = () => view.find((el) => String(el.className).split(" ").includes("ask-note")).map((el) => el.textContent).join("");
	const choices = () => view.find((el) => el.tagName === "button" && SELECT.choices.some((c) => String(el.textContent).includes(c.label))) as (El & { disabled?: boolean })[];
	return { sent, chips, notes, askNote, choices, draw, flip: (next: Box["state"]) => (base.box = REMOTE(next) as never) };
}

test("R-F001: the session view's blocks follow the box: off with box_answer_blocked when it is unreachable or ended, on again when it is live, and a local base's are always on", async () => {
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const w = await mounted(state);
		assert.equal(w.chips().hasAttribute("inert"), off, String(state));
		assert.deepEqual(w.notes(), [off ? m.box_answer_blocked() : ""], String(state));
	}
	const w = await mounted("live");
	w.flip("unreachable");
	w.draw();
	assert.equal(w.chips().hasAttribute("inert"), true, "the next snapshot turns it off");
	assert.deepEqual(w.notes(), [m.box_answer_blocked()]);
	w.flip("live");
	w.draw();
	assert.equal(w.chips().hasAttribute("inert"), false, "and back on");
	assert.deepEqual(w.notes(), [""]);
});

test("the session view's dialog panel of a unit on an away box is off and says why, as Zen's and the dock's do; a local or live one says nothing", async () => {
	for (const [state, off] of [["unreachable", true], ["ended", true], ["live", false], [undefined, false]] as const) {
		const w = await mounted(state, PENDING);
		assert.ok(w.choices().length > 0, `${state}: the dialog's choices are drawn`);
		assert.equal(w.choices().every((b) => b.disabled === true), off, `${state}: its choices`);
		assert.equal(w.askNote().includes(m.box_answer_blocked()), off, `${state}: the reason beside them`);
	}
});
