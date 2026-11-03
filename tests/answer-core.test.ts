import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { selectDigest } from "../src/owners.ts";
import { El, page } from "./fake-dom.ts";

// The one place the page decides how an answer is posted, whether a card may answer, and what a reply means (gui/answer.ts), and its one wiring of the question panel (mountAnswer).
// The panel's inside (outcomes, Check again, the keys) is ask.ts's own tests; what is asserted here is what the wiring hands it: where an answer goes, who may cancel, and what a paired device may pick.

const fetched: { url: string; body: Record<string, unknown>; csrf?: string }[] = [];
Object.assign(globalThis, {
	location: { hostname: "127.0.0.1" },
	document: Object.assign(page, { querySelector: () => null }), // post.ts reads the page's secret from a meta tag; this page has none
	fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => (fetched.push({ url, body: JSON.parse(init.body), csrf: init.headers["x-sb-csrf"] }), { ok: true, status: 200, json: async () => ({ outcome: "accepted" }) }),
});
const { onStep } = await import("../gui/terminalthen.ts");
const { answerPost, canAnswer, mountAnswer, outcomeOf, trustPost } = await import("../gui/answer.ts");

const SELECT = { title: "MCP: scratch wants to run echo", choices: [{ label: "Allow once" }, { label: "Run on this computer", hereOnly: true as const }, { label: "Deny" }], copy: "echo hi" };
const pending = (extra: Partial<Pending> = {}): Pending => ({ callId: "c1", tool: "dialog", answer: { dialog: "m1", digest: selectDigest(SELECT), select: SELECT, cancel: true }, ...extra });
const settle = () => new Promise((done) => setImmediate(done));
let root: El;
beforeEach(() => {
	fetched.length = 0;
	page.body.replaceChildren((root = new El("div")));
	page.focused = undefined;
});
const choices = () => root.all((el) => el.getAttribute("role") === "radio");
const button = (text: string) => root.all((el) => el.tagName === "button" && el.textContent === text)[0];

test("an answer goes to the fixture's route when the demo has one, else to the pane's grant for a grant: key, else to the session, the key escaped", async () => {
	const seen: string[] = [];
	await answerPost("a b/1", (key: string) => (action: string, body: Record<string, unknown>) => (seen.push(`${key} ${action} ${body.n}`), Promise.resolve({ ok: true, status: 200, body: {} })))("answer", { n: 1 });
	assert.deepEqual(seen, ["a b/1 answer 1"], "the fixture's route is used, and nothing is fetched");
	assert.equal(fetched.length, 0);
	await answerPost("a b/1", () => undefined)("answer", { n: 2 }); // a fixture with no route for this key
	await answerPost("grant:g/1")("keys", { n: 3 });
	await answerPost("grant:g/1", () => undefined)("answer", { n: 4 });
	assert.deepEqual(fetched.map((f) => [f.url, f.body.n]), [["api/sessions/a%20b%2F1/answer", 2], ["api/panes/g%2F1/keys", 3], ["api/panes/g%2F1/answer", 4]]);
});

test("a trust answer goes to the fixture when the demo has one, else to trust/answer with the page's secret", async () => {
	const body = { id: "t", digest: "d", choice: "trust" as const, answerId: "a" };
	const seen: unknown[] = [];
	await trustPost((b) => (seen.push(b), Promise.resolve({ ok: true, status: 200, body: {} })))(body);
	assert.deepEqual([seen, fetched.length], [[body], 0]);
	await trustPost()(body);
	assert.deepEqual(fetched.map((f) => [f.url, f.body]), [["api/trust/answer", body]]);
});

test("a card may answer only while its unit waits and every other fact its view reads is true", () => {
	assert.equal(canAnswer("waiting", true), true);
	assert.equal(canAnswer("waiting", true, true), true);
	assert.equal(canAnswer("waiting", true, false), false, "a unit without control");
	assert.equal(canAnswer("waiting", false), false, "a stream that is not live");
	for (const mark of ["working", "idle", "done", "error", "unknown"]) assert.equal(canAnswer(mark, true, true), false, mark);
});

test("a reply is read once: accepted, unknown (the owner did not say, or a 504), or refused", () => {
	const r = (status: number, body: Record<string, unknown>) => ({ ok: status < 400, status, body });
	assert.equal(outcomeOf(r(200, { outcome: "accepted" })), "accepted");
	assert.equal(outcomeOf(r(200, { outcome: "unknown" })), "unknown");
	assert.equal(outcomeOf(r(504, {})), "unknown");
	for (const body of [{ outcome: "rejected", reason: "digest" }, { outcome: "stale" }, { outcome: "busy" }, {}]) assert.equal(outcomeOf(r(200, body)), "refused", JSON.stringify(body));
	assert.equal(outcomeOf(r(403, { reason: "local_only" })), "refused");
});

test("mountAnswer posts a panel's answer by the post it is given (the unit's route, or its own), and Show terminal and the accepted callback reach the view", async () => {
	let shown = 0;
	const opened: boolean[] = [];
	const panel = mountAnswer(root as unknown as HTMLElement, { key: "m", post: answerPost("m"), remote: false, show: () => shown++, accepted: (o) => opened.push(o) });
	panel.update(pending({ answer: { ...pending().answer!, select: { ...SELECT, choices: SELECT.choices.slice(0, 1) } } }), true);
	choices()[0]!.click();
	button("Send answer")!.click();
	await settle();
	assert.deepEqual(fetched.map((f) => [f.url, f.body.dialog, f.body.choice, typeof f.body.answerId, f.csrf]), [["api/sessions/m/answer", "m1", 0, "string", ""]]);
	assert.deepEqual(opened, [], "the view hears of an accepted answer after its outcome has shown");
	const own: string[] = [];
	page.body.replaceChildren((root = new El("div")));
	const other = mountAnswer(root as unknown as HTMLElement, { key: "m", remote: false, show: () => shown++, post: (action, body) => (own.push(`${action} ${body.dialog}`), Promise.resolve({ ok: true, status: 200, body: { outcome: "accepted" } })) });
	other.update(pending({ answer: undefined, why: "Waits on a prompt" }), true); // a read-only panel offers the terminal
	button("Show terminal")!.click();
	assert.equal(shown, 1, "Show terminal is the view's");
	other.update(pending(), true);
	choices()[2]!.click();
	button("Send answer")!.click();
	await settle();
	assert.deepEqual([own, fetched.length], [["answer m1"], 1], "an answer goes by the post it was given, not the default route");
});

test("mountAnswer keeps the answering rules: a paired device sees a hereOnly choice disabled and no Cancel when every choice is hereOnly, a secret_drop is read-only, and a card that cannot answer disables its controls", () => {
	const mount = (remote: boolean, p: Pending, can = true) => {
		page.body.replaceChildren((root = new El("div")));
		mountAnswer(root as unknown as HTMLElement, { key: "m", post: answerPost("m"), remote, show: () => {} }).update(p, can);
	};
	mount(true, pending());
	assert.deepEqual(choices().map((c) => c.disabled), [false, true, false], "a paired device may not pick what only this computer may");
	assert.ok(button("Cancel"), "and may cancel while it can pick some choice");
	mount(false, pending());
	assert.deepEqual(choices().map((c) => c.disabled), [false, false, false]);
	const only = pending({ answer: { ...pending().answer!, select: { title: "t", choices: [{ label: "here", hereOnly: true as const }] } } });
	mount(true, only);
	assert.equal(button("Cancel"), undefined, "no Cancel on a paired device when every choice is hereOnly");
	mount(false, only);
	assert.ok(button("Cancel"));
	mount(false, pending({ tool: "secret_drop" }));
	assert.equal(choices().length, 0, "a secret_drop is read-only on every page");
	assert.equal(button("Send answer"), undefined);
	assert.equal(button("Cancel"), undefined);
	mount(false, pending(), false);
	assert.deepEqual(choices().map((c) => c.disabled), [true, true, true], "no card answers while the page cannot");
});

test("an accepted answer that leaves a step in a terminal opens its card for the unit's key (the key mountAnswer was given)", async () => {
	const steps: { key: string; asker: string }[] = [];
	onStep((step) => steps.push(step));
	const panel = mountAnswer(root as unknown as HTMLElement, { key: "unit-7", show: () => {}, post: () => Promise.resolve({ ok: true, status: 200, body: { outcome: "accepted", then: { terminal: true } } }) });
	panel.update(pending(), true);
	choices()[0]!.click();
	button("Send answer")!.click();
	await settle();
	onStep(undefined);
	assert.deepEqual(steps.map((s) => [s.key, s.asker]), [["unit-7", "unit-7"]]);
});

// Which facts each view hands canAnswer, and the routes it passes, are asserted by behaviour where the view is mounted: layer-answer.test.ts (the dock), session-answer.test.ts, and zen-layer.test.ts.
