import assert from "node:assert/strict";
import { test } from "node:test";
import { DECLINED, registerDeclined, SLIPPED, WINDOW_MS } from "../src/declined.ts";

// Esc before a decline (docs/specs/2026-11-09-auto-mode.md, §9).

type Handler = (event: Record<string, unknown>) => unknown;
function world() {
	const handlers = new Map<string, Handler[]>(), bus = new Map<string, ((d: unknown) => void)[]>();
	let clock = 1_000_000;
	const pi = {
		events: { on: (c: string, h: (d: unknown) => void) => void bus.set(c, [...(bus.get(c) ?? []), h]), emit: (c: string, d: unknown) => (bus.get(c) ?? []).forEach((h) => h(d)) },
		on: (type: string, h: Handler) => void handlers.set(type, [...(handlers.get(type) ?? []), h]),
	};
	const declined = registerDeclined(pi as never, { now: () => clock });
	let n = 0;
	const result = (toolName: string, extra: Record<string, unknown> = {}) => {
		const event = { type: "tool_result", toolName, toolCallId: `call-${++n}`, input: {}, content: [{ type: "text", text: "result" }], isError: false, ...extra };
		const out = (handlers.get("tool_result") ?? []).map((h) => h(event)).find((x) => x !== undefined) as { content: { text: string }[] } | undefined;
		return { id: event.toolCallId as string, out, text: out?.content.map((c) => c.text) };
	};
	const ask = (details: Record<string, unknown>) => result("ask_user_question", { details });
	return { declined, pi, handlers, clock: (ms: number) => void (clock += ms), result, ask, hand: (by: string) => {
		const id = `dialog-${++n}`, call = `hand-${n}`;
		pi.events.emit("robot-hand:pending", { version: 1, id, toolCallId: call });
		pi.events.emit("robot-hand:closed", { version: 1, id, by });
		return result("robot_hand", { toolCallId: call });
	} };
}

test("a terminal Esc on ask_user_question gets the slipped-Esc note on the result", () => {
	const w = world();
	const r = w.ask({ answers: [], cancelled: true });
	assert.deepEqual(r.text, ["result", SLIPPED]);
	assert.match(SLIPPED, /second time/);
});

test("a validation error gets none, and an answer gets none", () => {
	const w = world();
	assert.equal(w.ask({ answers: [], cancelled: true, error: "bad questions" }).out, undefined);
	assert.equal(w.ask({ answers: [{ questionIndex: 0 }] }).out, undefined);
	assert.equal(w.result("ask_user_question", { details: { cancelled: true }, isError: true }).out, undefined);
});

test("robot_hand: Esc (by cancel) gets the note; \"No, thanks\" (by local) is an explicit answer and gets none", () => {
	const w = world();
	assert.deepEqual(w.hand("cancel").text, ["result", SLIPPED]);
	assert.equal(w.hand("local").out, undefined);
	assert.equal(w.hand("abort").out, undefined);
});

test("secret_drop: its cancel gets the note, its reply field and an applied secret do not", () => {
	const w = world();
	assert.deepEqual(w.result("secret_drop", { details: { status: "cancelled" } }).text, ["result", SLIPPED]);
	assert.equal(w.result("secret_drop", { details: { status: "reply", message: "already stored" } }).out, undefined);
	assert.equal(w.result("secret_drop", { details: { status: "applied" } }).out, undefined);
});

test("a second cancel within ten minutes with no answer between is a decline", () => {
	const w = world();
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", SLIPPED]);
	w.clock(WINDOW_MS - 1);
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", DECLINED]);
	assert.match(DECLINED, /do not ask a third time/);
});

test("the cancel of another tool counts: a hand Esc, then an ask_user_question Esc, is a decline", () => {
	const w = world();
	assert.deepEqual(w.hand("cancel").text, ["result", SLIPPED]);
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", DECLINED]);
});

test("a second cancel after an answer in between, or after ten minutes, gets the note again", () => {
	const w = world();
	w.ask({ cancelled: true });
	w.ask({ answers: [{ questionIndex: 0 }] });
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", SLIPPED]);
	w.clock(WINDOW_MS + 1);
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", SLIPPED]);
});

test("a cancel sb made is never the boss's: no note, no decline, and it does not start the rule", () => {
	const w = world();
	w.declined.sbCancelled("hand-sb");
	w.pi.events.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "hand-sb" });
	w.pi.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "cancel" });
	assert.equal(w.result("robot_hand", { toolCallId: "hand-sb" }).out, undefined);
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", SLIPPED], "the next boss cancel is a first one");
});

test("a new session forgets the first cancel", async () => {
	const w = world();
	w.ask({ cancelled: true });
	for (const h of w.handlers.get("session_start") ?? []) h({});
	assert.deepEqual(w.ask({ cancelled: true }).text, ["result", SLIPPED]);
});

test("other tools are left alone", () => {
	const w = world();
	assert.equal(w.result("bash", { details: { cancelled: true } }).out, undefined);
});
