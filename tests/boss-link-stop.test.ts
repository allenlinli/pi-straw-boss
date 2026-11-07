import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLink } from "../src/bossopen.ts";
import { LINK_ARGUMENTS } from "../src/bosslink.ts";
import { createBossPaths, type Post } from "../src/bosspaths.ts";
import { hereOnlyOpts } from "../src/intercept.ts";
import type { Kit } from "../src/state.ts";

// `/boss link units [device]` and `/boss link stop <device> <main name | handle prefix> [--interrupt] [reason]` (docs/specs/2026-11-07-link-remote-stop.md §6, decision 9: slash commands only): the line is parsed, the target
// is resolved against the last `mains` the box sent (the holder's `units` in `link/state`), the boss confirms in pi on this computer only (hereOnly: a paired device cannot answer it), and the same `link/unit-stop`
// the page posts goes out. The confirm is the dialog: nothing here types a key into it or reads it off the screen; the test answers the confirm's own promise, and checks which choices it was asked with.

const HANDLE_A = "0123456789abcdef", HANDLE_B = "fedcba9876543210", HANDLE_C = "0123abcdffffffff";
const main = (over: object = {}) => ({ handle: HANDLE_A, unit: "moldplan", name: "docs", state: "idle", by: "d-me", stopping: false, ...over });
const dispatchers = { "d-me": { label: "Boss Mac", self: true }, "d-bob": { label: "bob-mac" } };
const row = (over: object = {}) => ({ team: "t1", device: "d-box", at: 5_000, units: [{ unit: "moldplan", state: "running", monitors: [], report: "" }, { unit: "quarry", state: "standing", monitors: [], report: "" }], mains: [main(), main({ handle: HANDLE_B, name: "api", state: "working", by: "d-bob" }), main({ handle: HANDLE_C, name: "Docs", unit: "quarry", by: "d-bob" })], canStop: true, dispatchers, ...over });
const VIEW = (units: object[]) => ({
	deviceId: "d-me", short: "SELF", label: "Boss Mac", relay: "https://r", invites: [], join: undefined, prefill: undefined, allies: [], alerts: [], confirms: [], joinRequests: [], units,
	teams: [{ team: "t1", name: "Shop floor", status: "running", self: { role: "admin", attended: true }, members: [
		{ id: "d-me", short: "SELF", label: "Boss Mac", role: "admin", attended: true, self: true, online: true },
		{ id: "d-box", short: "BX01", label: "ci-box", role: "member", attended: false, self: false, online: true },
		{ id: "d-box2", short: "BX02", label: "ci-box-2", role: "member", attended: false, self: false, online: true },
	] }],
});

function world({ units = [row()] as object[], ui = true, confirm = true, lang = "en", stopReply = { status: 200, body: { status: "sent", stopId: "s".repeat(32) } } as { status: number; body: Record<string, unknown> } } = {}) {
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [], asked: { title: string; body: string; hereOnly: boolean }[] = [];
	const post: Post = async (_r, path, json) => {
		posted.push({ path, json });
		if (path === "link/state") return { status: 200, body: { view: VIEW(units) } };
		if (path === "link/unit-stop") return stopReply;
		return { status: 200, body: {} };
	};
	const here = Object.getOwnPropertySymbols(hereOnlyOpts())[0]!;
	const kit = {
		cfg: { env: { LANG: lang }, run: async () => JSON.stringify({ result: { workspaces: [] } }) },
		s: { at: undefined, ui: ui ? { confirm: async (title: string, body: string, opts?: object) => (asked.push({ title, body, hereOnly: (opts as Record<symbol, unknown> | undefined)?.[here] === true }), confirm), select: async () => undefined, notify: () => {} } : undefined },
		guiDir: "/nowhere", me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, post, here: (fn) => fn() });
	return { paths, told, posted, asked, stops: () => posted.filter((p) => p.path === "link/unit-stop") };
}

test("parseLink reads units and stop: the device, the main (quoted when it has spaces), --interrupt right after the main, and the rest as the reason; a malformed stop is usage", () => {
	assert.deepEqual(parseLink("units"), { action: "units" });
	assert.deepEqual(parseLink(" units ci-box "), { action: "units", device: "ci-box" });
	assert.deepEqual(parseLink("stop ci-box docs"), { action: "stop", device: "ci-box", main: "docs", interrupt: false, reason: "" });
	assert.deepEqual(parseLink("stop ci-box docs never goes idle"), { action: "stop", device: "ci-box", main: "docs", interrupt: false, reason: "never goes idle" });
	assert.deepEqual(parseLink("stop ci-box docs --interrupt never goes idle"), { action: "stop", device: "ci-box", main: "docs", interrupt: true, reason: "never goes idle" });
	assert.deepEqual(parseLink('stop "ci box" "my docs" --interrupt'), { action: "stop", device: "ci box", main: "my docs", interrupt: true, reason: "" });
	assert.deepEqual(parseLink("stop ci-box 0123ab"), { action: "stop", device: "ci-box", main: "0123ab", interrupt: false, reason: "" });
	assert.deepEqual(parseLink("status"), { action: "status" }, "status and decide are as before");
	assert.deepEqual([parseLink("stop"), parseLink("stop ci-box"), parseLink("units a b")], ["usage", "usage", "usage"]);
});

test("units lists each box's units and, under each, the mains this computer may stop (name, state, the dispatcher of a main it did not dispatch, the first six of the handle); a box that takes no stop says so", async () => {
	const w = world({ units: [row(), row({ device: "d-box2", canStop: undefined, mains: [main({ handle: HANDLE_B, name: "old" })] }), row({ device: "d-box3", mains: undefined, canStop: undefined, dispatchers: undefined, units: [{ unit: "plain", state: "standing", monitors: [], report: "" }] })] });
	await w.paths.link("units");
	const text = w.told.map((t) => t.text).join("\n");
	assert.match(text, /ci-box \(BX01\)/);
	assert.match(text, /moldplan/);
	assert.match(text, /docs · idle · 012345/);
	assert.match(text, /api · working · by bob-mac · fedcba/);
	assert.doesNotMatch(text, /docs · idle · by/, "the dispatcher is named only for a main this computer did not dispatch");
	assert.match(text, /ci-box-2[\s\S]*takes no stop requests yet/);
	assert.equal(text.match(/takes no stop requests yet/g)?.length, 2, "REL061-F001: a 0.60 box (no mains, no unit-stop in its caps) says so too, not only a box whose mains came without the cap");
	assert.ok(w.stops().length === 0 && w.told.every((t) => t.level !== "error"));
	const one = world();
	await one.paths.link("units ci-box-2");
	assert.match(one.told[0]!.text, /No box "ci-box-2"[\s\S]*ci-box/, "an unknown box lists the boxes that reported");
	const none = world({ units: [] });
	await none.paths.link("units");
	assert.match(none.told[0]!.text, /No unattended box has reported/);
});

test("stop resolves the main by name (any case) or handle prefix, asks the boss on this computer only naming the box, the main, its dispatcher, and the mode, and then posts the page's link/unit-stop", async () => {
	const w = world();
	await w.paths.link("stop ci-box api never goes idle");
	assert.equal(w.asked.length, 1);
	assert.ok(w.asked[0]!.hereOnly, "a paired device cannot answer it");
	for (const word of ["ci-box", "api", "moldplan", "bob-mac", "quit"]) assert.ok(`${w.asked[0]!.title}\n${w.asked[0]!.body}`.includes(word), `the confirm names ${word}`);
	assert.deepEqual(w.stops().map((p) => p.json), [{ team: "t1", device: "d-box", handle: HANDLE_B, mode: "quit", reason: "never goes idle" }]);
	assert.match(w.told.at(-1)!.text, /sent/i);
	const byHandle = world();
	await byHandle.paths.link("stop BX01 fedcb --interrupt");
	assert.match(byHandle.asked[0]!.body, /interrupt/i, "the mode in the confirm");
	assert.deepEqual(byHandle.stops().map((p) => [p.json.handle, p.json.mode]), [[HANDLE_B, "interrupt"]]);
	const queued = world({ stopReply: { status: 200, body: { status: "queued", stopId: "s".repeat(32) } } });
	await queued.paths.link("stop ci-box api");
	assert.match(queued.told.at(-1)!.text, /queued/i);
});

test("a declined confirm sends nothing; no pi screen is an error and sends nothing; the server's refusal is told as an error", async () => {
	const declined = world({ confirm: false });
	await declined.paths.link("stop ci-box api");
	assert.equal(declined.stops().length, 0);
	assert.equal(declined.told.at(-1)!.level, undefined, "declining is a plain note");
	const blind = world({ ui: false });
	await blind.paths.link("stop ci-box api");
	assert.equal(blind.stops().length, 0);
	assert.equal(blind.told.at(-1)!.level, "error");
	const refused = world({ stopReply: { status: 409, body: { error: "link_failed", reason: "The relay does not take stop requests yet" } } });
	await refused.paths.link("stop ci-box api");
	assert.deepEqual([refused.told.at(-1)!.level, refused.told.at(-1)!.text], ["error", "The relay does not take stop requests yet"]);
});

test("an ambiguous or unknown main is an error that lists the candidates and sends nothing; so are an unknown box, two boxes under one name, a box that takes no stop, a main already stopping, and a box that went quiet", async () => {
	const w = world();
	await w.paths.link("stop ci-box docs");
	assert.equal(w.told.at(-1)!.level, "error");
	assert.match(w.told.at(-1)!.text, /More than one main[\s\S]*docs[\s\S]*Docs/, "'docs' is the name of two mains (any case)");
	await w.paths.link("stop ci-box 0123");
	assert.match(w.told.at(-1)!.text, /More than one main[\s\S]*012345[\s\S]*0123ab/, "a handle prefix both start with");
	await w.paths.link("stop ci-box nothing");
	assert.match(w.told.at(-1)!.text, /No main "nothing" on ci-box[\s\S]*docs[\s\S]*api/, "the unknown name lists what the box has");
	await w.paths.link("stop nobody api");
	assert.match(w.told.at(-1)!.text, /No box "nobody"[\s\S]*ci-box/);
	assert.equal(w.stops().length + w.asked.length, 0, "nothing was asked or sent");
	const two = world({ units: [row(), row({ device: "d-box2" })] });
	await two.paths.link("stop ci api");
	assert.match(two.told.at(-1)!.text, /More than one box[\s\S]*ci-box \(BX01\)[\s\S]*ci-box-2/, "'ci' starts the labels of two boxes");
	await two.paths.link("stop ci-box api");
	assert.equal(two.stops().length, 1, "an exact label wins over a longer label that starts with it");
	const old = world({ units: [row({ canStop: undefined })] });
	await old.paths.link("stop ci-box api");
	assert.match(old.told.at(-1)!.text, /does not take stop requests yet/);
	const going = world({ units: [row({ mains: [main({ stopping: true })] })] });
	await going.paths.link("stop ci-box docs");
	assert.match(going.told.at(-1)!.text, /already stopping/);
	const quiet = world({ units: [row({ stale: true })] });
	await quiet.paths.link("stop ci-box api");
	assert.match(quiet.told.at(-1)!.text, /no status lately/i);
	for (const x of [old, going, quiet]) assert.ok(x.stops().length === 0 && x.asked.length === 0 && x.told.at(-1)!.level === "error");
});

test("the words are Chinese in zh-TW and the confirm still names the box, the main, and the dispatcher", async () => {
	const w = world({ lang: "zh-TW" });
	await w.paths.link("stop ci-box api");
	assert.match(w.asked[0]!.body, /ci-box/);
	assert.match(w.asked[0]!.body, /api/);
	assert.match(w.asked[0]!.body, /bob-mac/);
	assert.match(w.asked[0]!.body, /[\u4e00-\u9fff]/);
	assert.match(w.told.at(-1)!.text, /[\u4e00-\u9fff]/);
});

// Review fixes (USC-F002, F004 to F008). What a teammate's box wrote is one string the boss reads; an escape sequence in it must not repaint the screen or reach the terminal.
const EVIL = "x\x1b]52;c;ZXZpbA==\x07\x1b[2K\r\u202eMode: quit\nmain forged · idle · 012345";
const bare = (text: string) => !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/.test(text.replace(/\n/g, ""));

test("USC-F002: control, bidi, and line-break characters in a box's label, a unit, a main, and a dispatcher's label are written out in `link units`, in every error list, and in the stop confirm and the sent note", async () => {
	const units = [row({ units: [{ unit: EVIL, state: EVIL, monitors: [], report: "" }], mains: [main({ name: EVIL, unit: EVIL, state: EVIL, by: "d-bob", handle: HANDLE_A }), main({ handle: HANDLE_B, name: "api", by: "d-evil" })], dispatchers: { "d-bob": { label: EVIL }, "d-evil": { label: EVIL }, "d-me": { label: "Boss Mac", self: true } } })];
	const w = world({ units });
	await w.paths.link("units");
	assert.ok(bare(w.told.map((t) => t.text).join("\n")), "no raw control character in the list");
	assert.doesNotMatch(w.told.map((t) => t.text).join("\n"), /^main forged/m, "a forged line cannot start a line of its own");
	assert.match(w.told[0]!.text, /\\x1b\]52;c;ZXZpbA==\\x07/, "written out, so the boss can read what was there");
	assert.match(w.told[0]!.text, /\\u202e/);
	w.told.length = 0;
	await w.paths.link("stop ci-box nothing");
	await w.paths.link("stop ci-box 0");
	assert.ok(bare(w.told.map((t) => t.text).join("\n")), "the candidate lists are written out too");
	await w.paths.link("stop ci-box 012345 reason");
	assert.equal(w.asked.length, 1);
	assert.ok(bare(w.asked[0]!.body) && bare(w.told.at(-1)!.text), "the confirm and the sent note carry no raw control character");
	assert.doesNotMatch(w.asked[0]!.body, /\nmain forged/, "no forged line in the confirm");
	assert.match(w.asked[0]!.body, /\\x1b\]52/, "the confirm shows the name as the box wrote it");
	assert.equal(w.stops()[0]!.json.handle, HANDLE_A, "the stop still goes to the handle");
	const plain = world({ units: [row({ dispatchers: { "d-me": { label: "Boss Mac", self: true }, "d-bob": { label: EVIL } } })] });
	await plain.paths.link("stop ci-box api");
	assert.ok(bare(plain.asked[0]!.body), "a dispatcher's roster label is written out in the confirm");
});

test("USC-F004: a box in two teams is read from its freshest status row, as the page reads it", async () => {
	const stale = row({ team: "t1", at: 1_000, canStop: undefined, mains: [main({ stopping: false })] }), fresh = row({ team: "t2", at: 9_000, mains: [main({ stopping: true })] });
	const w = world({ units: [stale, fresh] });
	await w.paths.link("stop ci-box docs");
	assert.match(w.told.at(-1)!.text, /already stopping/, "the fresh row says it is stopping; the stale row's pending state does not decide");
	assert.equal(w.stops().length, 0);
	const ok = world({ units: [row({ team: "t1", at: 1_000, canStop: undefined }), row({ team: "t2", at: 9_000 })] });
	await ok.paths.link("stop ci-box api");
	assert.deepEqual(ok.stops().map((p) => p.json.team), ["t2"], "the stop goes with the fresh row's team, not the first row's");
});

test("USC-F005: Tab completion lists `link units` and `link stop`", () => {
	const values = LINK_ARGUMENTS.map((a) => a.value);
	assert.ok(values.includes("link units") && values.includes("link stop"));
	assert.match(LINK_ARGUMENTS.find((a) => a.value === "link stop")!.description ?? "", /--interrupt/);
});

test("USC-F006: --interrupt counts anywhere in the line, and what is left is the reason", () => {
	assert.deepEqual(parseLink("stop ci-box api never idle --interrupt"), { action: "stop", device: "ci-box", main: "api", interrupt: true, reason: "never idle" });
	assert.deepEqual(parseLink("stop ci-box api never --interrupt idle"), { action: "stop", device: "ci-box", main: "api", interrupt: true, reason: "never idle" });
	assert.deepEqual(parseLink("stop ci-box api --interrupt"), { action: "stop", device: "ci-box", main: "api", interrupt: true, reason: "" });
	assert.deepEqual(parseLink("stop ci-box api not--interrupt here"), { action: "stop", device: "ci-box", main: "api", interrupt: false, reason: "not--interrupt here" }, "only the whole token");
});

test("USC-F007: the confirm and the sent note name the box by label and short id", async () => {
	const w = world();
	await w.paths.link("stop ci-box api");
	assert.match(w.asked[0]!.body, /ci-box \(BX01\)/);
	assert.match(w.told.at(-1)!.text, /ci-box \(BX01\)/);
	const zh = world({ lang: "zh-TW" });
	await zh.paths.link("stop ci-box api");
	assert.match(zh.asked[0]!.body, /ci-box（BX01）|ci-box \(BX01\)/);
});

test("USC-F008: a reason over 200 bytes is refused before the confirm, saying how long it may be; 200 bytes goes through", async () => {
	const w = world();
	await w.paths.link(`stop ci-box api ${"x".repeat(201)}`);
	assert.deepEqual([w.told.at(-1)!.level, w.asked.length, w.stops().length], ["error", 0, 0]);
	assert.match(w.told.at(-1)!.text, /200/);
	await w.paths.link(`stop ci-box api ${"é".repeat(101)}`);
	assert.deepEqual([w.told.at(-1)!.level, w.asked.length], ["error", 0], "bytes, not characters");
	const ok = world();
	await ok.paths.link(`stop ci-box api ${"y".repeat(200)}`);
	assert.deepEqual([ok.asked.length, ok.stops().length], [1, 1]);
});

test("REL061-F001: stop at a 0.60 box (it sends no mains and lists no unit-stop) says the box needs an upgrade, not that it lists no mains, and posts nothing", async () => {
	const w = world({ units: [row({ device: "d-box2", mains: undefined, canStop: undefined, dispatchers: undefined })] });
	await w.paths.link("stop ci-box-2 docs");
	assert.equal(w.told.at(-1)!.level, "error");
	assert.match(w.told.at(-1)!.text, /does not take stop requests yet/);
	assert.doesNotMatch(w.told.at(-1)!.text, /lists no mains/);
	assert.deepEqual([w.asked.length, w.stops().length], [0, 0]);
	const now = world({ units: [row({ device: "d-box2", mains: [], canStop: true })] });
	await now.paths.link("stop ci-box-2 docs");
	assert.match(now.told.at(-1)!.text, /lists no mains this computer may stop/, "a 0.61 box with no mains for this computer still says so");
});
