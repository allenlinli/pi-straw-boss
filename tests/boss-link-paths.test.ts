import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LINK_ARGUMENTS, parseLinkMore } from "../src/bosslink.ts";
import { registerBoss } from "../src/boss.ts";
import { createBossPaths, type Post } from "../src/bosspaths.ts";
import { createControl, localOnlyText, type ControlDeps } from "../src/control.ts";
import { startGui, type Gui } from "../src/gui.ts";
import { encodeInvite } from "../src/link/join.ts";
import type { Kit } from "../src/state.ts";
import { hereWorld } from "./here.ts";

// The boss's typed twins of the link operations the page alone could do (todo #34, gaps G1, G2, G7, G3): `/boss link confirms | confirm <id> allow|deny | asks | answer <id> … | invite cancel|show <hash> | join cancel | leave <team>
// | create <relay> <dir> | join <invite|@file>`. Each posts the route the page posts to, asks in pi hereOnly what changes who may command this computer, and is the boss's typed input only.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sb-link-paths-")));
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});
mkdirSync(join(scratch, "proj"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const HERE_ONLY = Symbol.for("pi-straw-boss.here-only");

type Reply = { status: number; body: Record<string, unknown> };
const LONG = `{"command":"rm -rf build && echo ${"x".repeat(900)}","cwd":"/srv/app"}`;
const CONFIRMS = [
	{ dialogId: "c1aa22bb33cc44dd", team: "t1", from: "d-mate", fromLabel: "Mei's Mac", fromShort: "MEI01", digest: "dg-c1", tool: "bash", args: LONG, tower: "sb-tower-x", at: Date.now() - 125_000 },
	{ dialogId: "c2bb33cc44dd55ee", team: "t1", from: "d-mate", fromLabel: "Mei's Mac", fromShort: "MEI01", digest: "dg-c2", tool: "write", args: "line one\n\x1b[2K\rall fine\u202eevil", tower: "sb-tower-x", at: Date.now() - 10_000 },
];
const SELECT = JSON.stringify({ select: { title: "Deploy to staging?", choices: [{ label: "Yes" }, { label: "No" }, { label: "Later" }] }, cancel: true });
const ONE_Q = JSON.stringify({ questions: [{ question: "Which branch?", multiple: false, options: [{ title: "main" }, { title: "dev" }, { title: "next" }] }] });
const TWO_Q = JSON.stringify({ questions: [{ question: "Which branch?", multiple: false, options: [{ title: "main" }, { title: "dev" }] }, { question: "Which checks?", multiple: true, options: [{ title: "unit" }, { title: "e2e" }, { title: "lint" }] }] });
const BAD_Q = JSON.stringify({ select: { title: "x", choices: "no" } });
const dialog = (id: string, json: string, extra: Record<string, string | number> = {}) => ({ id: `dialog/d-kiosk/${id}`, kind: "dialog", level: "warning", team: "t1", teamName: "Shop floor", data: { device: "d-kiosk", dialogId: id, digest: `dg-${id}`, owner: "main - build", dialog: json, label: "Kiosk", short: "KI02", answered: 0, ...extra } });
const ALERTS = [
	dialog("a1b2c3d4e5f6", SELECT), dialog("b2c3d4e5f6a1", ONE_Q), dialog("c3d4e5f6a1b2", TWO_Q), dialog("d4e5f6a1b2c3", BAD_Q),
	dialog("e5f6a1b2c3d4", SELECT, { closed: "local" }), dialog("f6a1b2c3d4e5", SELECT, { answered: 1 }),
	{ id: "join/x", kind: "join-request", level: "warning", team: "t1", teamName: "Shop floor", data: {} },
];
const INVITES = [
	{ hash: "ab12cd34ef56ab12cd34ef56", team: "t1", teamName: "Shop floor", forDevice: "", created: 1, expires: Date.now() + 8 * 60_000 },
	{ hash: "ab99cd34ef56ab12cd34ef56", team: "t1", teamName: "Shop floor", forDevice: "kiosk2abcdefghijklmnopqrst", created: 1, expires: Date.now() + 40 * 60_000 },
];
const TEAMS = [
	{ team: "t1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Shop floor", status: "running", self: { role: "admin", attended: true }, members: [], onlyAdmin: false },
	{ team: "t2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Forked", status: "stopped", stoppedWhy: "roster fork", self: { role: "member", attended: true }, members: [], onlyAdmin: false },
];
// The page's state as the holder returns it; a plain record, since what a test overrides is of any shape.
const view = (over: Record<string, unknown> = {}): Record<string, any> => ({ deviceId: "d-self", short: "SELF", label: "Boss Mac", relay: "https://r.example", invites: [], join: undefined, prefill: undefined, allies: [], alerts: [], confirms: [], units: [], joinRequests: [], teams: TEAMS, ...over });
const FULL = view({ confirms: CONFIRMS.map((c) => ({ ...c, team: TEAMS[0]!.team })), alerts: ALERTS.map((a) => ({ ...a, team: TEAMS[0]!.team })), invites: INVITES.map((i) => ({ ...i, team: TEAMS[0]!.team })) });

const TOKEN = "fake-qzx-relay", INVITE = encodeInvite({ relay: "https://relay.example", team: Buffer.alloc(16, 7), secret: Buffer.alloc(32, 9), inviterId: "a".repeat(26), inviterKeyHash: Buffer.alloc(32, 5), forDevice: "" });

interface WorldOptions { ui?: boolean; confirm?: boolean | boolean[]; selects?: (string | undefined)[]; inputs?: (string | undefined)[]; lang?: string; custom?: boolean; /** The confirm throws (a pi that fails under the dialog). */ boom?: boolean; /** What the server answers a request to mark the pane local-only. */ markError?: string }
function world({ ui = true, confirm = true, selects = [], inputs = [], lang = "en", custom = true, boom = false, markError }: WorldOptions = {}) {
	// The pane's mark at the server (src/heremark.ts), made of the real marks: `during` is what a paired device's key pad would meet when each pi screen opened.
	const hw = hereWorld("wA:p1", markError ? { reply: () => ({ ok: false, error: markError }) } : {}), during: { kind: string; marked: boolean }[] = [];
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [], asked: { title: string; body: string; opts?: Record<symbol, unknown> }[] = [], selected: { title: string; options: string[]; opts?: Record<symbol, unknown> }[] = [], typed: { title: string }[] = [], frames: string[][] = [], piCalls: string[] = [];
	const replies = new Map<string, Reply[] | Reply | ((json: Record<string, unknown>) => Reply | Promise<Reply>)>(), keys: string[][] = [], selectQueue = [...selects], inputQueue = [...inputs], confirmQueue = Array.isArray(confirm) ? [...confirm] : undefined;
	const post: Post = async (_r, path, json) => {
		posted.push({ path, json });
		const r = replies.get(path);
		if (typeof r === "function") return r(json);
		if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0]!;
		return r ?? { status: 200, body: {} };
	};
	const screen = {
		confirm: async (title: string, body: string, opts?: Record<symbol, unknown>) => {
			asked.push({ title, body, ...(opts ? { opts } : {}) });
			during.push({ kind: "confirm", marked: hw.marked() });
			if (boom) throw new Error("the dialog broke");
			return confirmQueue ? confirmQueue.shift() === true : confirm === true;
		},
		select: async (title: string, options: string[], opts?: Record<symbol, unknown>) => (selected.push({ title, options, ...(opts ? { opts } : {}) }), during.push({ kind: "select", marked: hw.marked() }), selectQueue.shift()),
		input: async (title: string) => (typed.push({ title }), inputQueue.shift()),
		notify: () => {},
		...(custom ? {
			// A pi screen the test types on: every script is the keys of one ui.custom call; a frame is what the component drew after each key.
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (v: unknown) => void) => Promise<{ render(w: number): string[]; handleInput(d: string): void }> | { render(w: number): string[]; handleInput(d: string): void }) => {
				const script = keys.shift();
				assert.ok(script, "an unexpected ui.custom call");
				during.push({ kind: "custom", marked: hw.marked() });
				let result: unknown, finished = false;
				const comp = await factory({ requestRender() {} }, {}, {}, (v) => ((finished = true), (result = v)));
				frames.push(comp.render(80));
				for (const data of script) {
					if (finished) break;
					comp.handleInput(data);
					frames.push(comp.render(80));
				}
				assert.ok(finished, "the screen was left open");
				return result;
			},
		} : {}),
	};
	const kit = {
		// Anything the module writes to the session through pi would be a leak: every call is recorded.
		pi: new Proxy({}, { get: (_t, k) => (...a: unknown[]) => void piCalls.push(`${String(k)} ${JSON.stringify(a)}`) }),
		cfg: { env: { LANG: lang }, run: async () => "{}" },
		s: { at: { workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1" }, ui: ui ? screen : undefined },
		guiDir: scratch, me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, post, here: hw.here });
	return { paths, hw, during, told, posted, asked, selected, typed, frames, piCalls, run: (line: string, cwd = scratch) => paths.link(line, cwd), reply: (path: string, r: Reply[] | Reply | ((json: Record<string, unknown>) => Reply | Promise<Reply>)) => replies.set(path, r), keys: (...scripts: string[][]) => void keys.push(...scripts), at: (path: string) => posted.filter((p) => p.path === path), last: () => told.at(-1)! };
}
const typing = (text: string) => [...text.split(""), "\r"];

test("parseLinkMore reads each new subcommand and says usage for a malformed one; status, decide, and anything else are not its", () => {
	assert.deepEqual([parseLinkMore("confirms"), parseLinkMore("confirm c1aa allow"), parseLinkMore(" confirm  c1aa  deny ")], [{ action: "confirms" }, { action: "confirm", id: "c1aa", verdict: "allow" }, { action: "confirm", id: "c1aa", verdict: "deny" }]);
	assert.deepEqual([parseLinkMore("asks"), parseLinkMore("answer a1b2 2"), parseLinkMore("answer a1b2 Use the dev branch, please"), parseLinkMore("answer a1b2 --cancel"), parseLinkMore("answer a1b2")], [{ action: "asks" }, { action: "answer", id: "a1b2", cancel: false, text: "2" }, { action: "answer", id: "a1b2", cancel: false, text: "Use the dev branch, please" }, { action: "answer", id: "a1b2", cancel: true, text: "" }, { action: "answer", id: "a1b2", cancel: false, text: "" }]);
	assert.deepEqual([parseLinkMore("invite cancel ab12"), parseLinkMore("invite show ab12"), parseLinkMore("join cancel")], [{ action: "invite-cancel", hash: "ab12" }, { action: "invite-show", hash: "ab12" }, { action: "join-cancel" }]);
	assert.deepEqual([parseLinkMore("leave Forked --force"), parseLinkMore('leave "Shop floor"'), parseLinkMore("leave --force Forked")], [{ action: "leave", team: "Forked", force: true }, { action: "leave", team: "Shop floor", force: false }, { action: "leave", team: "Forked", force: true }]);
	assert.deepEqual(parseLinkMore("create https://r.example ~/proj --share presence --label 'Boss Mac'"), { action: "create", relay: "https://r.example", project: "~/proj", share: "presence", label: "Boss Mac" });
	assert.deepEqual(parseLinkMore("create https://r.example ~/proj"), { action: "create", relay: "https://r.example", project: "~/proj" });
	assert.deepEqual(parseLinkMore("join @/tmp/inv.txt --project ../p --share status --label Lab"), { action: "join", source: "@/tmp/inv.txt", project: "../p", share: "status", label: "Lab" });
	assert.deepEqual(parseLinkMore("join strawlink1:abc"), { action: "join", source: "strawlink1:abc" });
	for (const bad of ["confirms x", "confirm", "confirm c1aa", "confirm c1aa maybe", "answer", "invite", "invite show", "invite team", "join", "join cancel x", "leave", "leave a b", "create", "create https://r.example", "create a b c", "create a b --share loud", "join x --force", "leave a --label x", "join x --project"]) assert.equal(parseLinkMore(bad), "usage", bad);
	for (const other of [undefined, "", "status", "decide ab12 approve", "frobnicate"]) assert.equal(parseLinkMore(other), undefined, String(other));
	assert.ok(LINK_ARGUMENTS.every((a) => a.value.startsWith("link ")));
});

test("link status adds the open invites, the join in progress, and how many confirms and questions wait, only when there are some", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: view() } });
	await w.run("status");
	assert.doesNotMatch(w.last().text, /invite|Joining|confirm|question/i);
	w.reply("link/state", { status: 200, body: { view: { ...FULL, join: { id: "j", state: "waiting", label: "Lab", words: ["alpha", "bravo", "charlie", "delta"], expires: Date.now() + 5 * 60_000, pinned: false, needsProject: false } } } });
	await w.run("status");
	const text = w.last().text;
	assert.match(text, /Open invites .*\/boss link invite show\|cancel <hash>/);
	assert.match(text, /\n {2}ab12cd34 {2}Shop floor · expires in \d+ min\n/);
	assert.match(text, /\n {2}ab99cd34 {2}Shop floor · for kiosk2 · expires in \d+ min\n/);
	assert.match(text, /Joining: waiting .*alpha bravo charlie delta/);
	assert.match(text, /2 confirms wait: \/boss link confirms/);
	assert.match(text, /4 forwarded questions wait: \/boss link asks/, "closed and answered ones and other alerts are not counted");
});

test("confirms lists each request with who asked, the tool, its age, and the arguments in full; control and bidi characters are shown as escapes", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("confirms");
	assert.deepEqual(w.posted.map((p) => p.path), ["link/state"]);
	const text = w.last().text;
	assert.match(text, /\/boss link confirm <id> allow\|deny/);
	assert.match(text, /\n {2}c1aa22bb {2}Mei's Mac \(MEI01\) · team Shop floor · tool bash · 2 min ago\n/);
	assert.ok(text.includes(LONG), "all 900 characters of the arguments");
	assert.ok(text.includes("line one"), "a second line");
	assert.ok(!/[\x00-\x08\x0b-\x1f\x7f\u202e]/.test(text.replace(/\n/g, "")), "no raw control or bidi character reaches the screen");
	assert.match(text, /\\x1b\[2K\\x0dall fine\\u202eevil/);
	w.reply("link/state", { status: 200, body: { view: view() } });
	await w.run("confirms");
	assert.match(w.last().text, /No confirm is waiting/);
	w.reply("link/state", { status: 200, body: {} });
	await w.run("confirms");
	assert.equal(w.last().level, "warning");
});

test("confirm allow asks hereOnly with the whole call, then posts the request's id and the digest the boss saw", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	w.reply("link/confirm-answer", { status: 200, body: {} });
	await w.run("confirm c1aa22 allow");
	assert.equal(w.asked.length, 1);
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true, "only this computer answers it");
	assert.match(w.asked[0]!.body, /Mei's Mac \(MEI01\)/);
	assert.match(w.asked[0]!.body, /Shop floor/);
	assert.match(w.asked[0]!.body, /bash/);
	assert.ok(w.asked[0]!.body.includes(LONG), "the arguments in full");
	assert.deepEqual(w.at("link/confirm-answer"), [{ path: "link/confirm-answer", json: { dialogId: "c1aa22bb33cc44dd", digest: "dg-c1", allow: true } }]);
	assert.match(w.last().text, /Allowed .*bash/);
	assert.equal(w.last().level, undefined);
});

test("confirm allow sends the digest of the request it showed, even when the request is replaced while the boss reads it", async () => {
	const w = world();
	let calls = 0;
	w.reply("link/state", () => ({ status: 200, body: { view: { ...FULL, confirms: FULL.confirms.map((c: object) => ({ ...c, digest: ++calls === 1 ? "dg-first" : "dg-second" })) } } }));
	w.reply("link/confirm-answer", { status: 409, body: { error: "link_failed", reason: "That request changed; look at it again" } });
	await w.run("confirm c1aa allow");
	assert.equal(w.at("link/confirm-answer")[0]!.json.digest, "dg-first");
	assert.deepEqual(w.last(), { text: "That request changed; look at it again", level: "error" }, "the holder's refusal is shown");
});

test("confirm deny posts without asking; a declined allow, a missing screen, an unknown or ambiguous id, and a bad word post nothing", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("confirm c2bb deny");
	assert.deepEqual([w.asked.length, w.at("link/confirm-answer")], [0, [{ path: "link/confirm-answer", json: { dialogId: "c2bb33cc44dd55ee", digest: "dg-c2", allow: false } }]]);
	assert.match(w.last().text, /Denied/);
	const no = world({ confirm: false });
	no.reply("link/state", { status: 200, body: { view: FULL } });
	await no.run("confirm c1aa allow");
	assert.deepEqual([no.asked.length, no.at("link/confirm-answer"), no.last().text], [1, [], "Nothing was decided"]);
	const blind = world({ ui: false });
	blind.reply("link/state", { status: 200, body: { view: FULL } });
	await blind.run("confirm c1aa allow");
	assert.deepEqual(blind.at("link/confirm-answer"), []);
	assert.match(blind.last().text, /needs the pi screen/);
	const w2 = world();
	w2.reply("link/state", { status: 200, body: { view: FULL } });
	for (const line of ["confirm zzzz allow", "confirm c allow", "confirm c1 allow", "confirm c1aa maybe"]) await w2.run(line);
	assert.deepEqual([w2.at("link/confirm-answer"), w2.told.map((t) => t.level)], [[], ["error", "error", "error", "error"]]);
	assert.match(w2.told[0]!.text, /No confirm is waiting under "zzzz"/);
	const two = world();
	two.reply("link/state", { status: 200, body: { view: { ...FULL, confirms: FULL.confirms.map((c: object, i: number) => ({ ...c, dialogId: `same-${i}-0000` })) } } });
	await two.run("confirm same allow");
	assert.match(two.last().text, /More than one confirm starts with "same"/);
	assert.deepEqual(two.at("link/confirm-answer"), []);
});

test("a refused confirm answer is shown as the server said it, and a server that does not answer says so", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	w.reply("link/confirm-answer", { status: 409, body: { error: "link_failed", reason: "That request is gone or has timed out" } });
	await w.run("confirm c1aa deny");
	assert.deepEqual(w.last(), { text: "That request is gone or has timed out", level: "error" });
	w.reply("link/confirm-answer", { status: 0, body: {} });
	await w.run("confirm c1aa deny");
	assert.equal(w.last().level, "error");
});

test("asks lists the open forwarded questions with numbered choices; closed, answered, and unreadable ones are left out or said so", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("asks");
	const text = w.last().text;
	assert.match(text, /\/boss link answer <id> <choice number \| text>/);
	assert.match(text, /\n {2}a1b2c3d4 {2}Kiosk \(KI02\) · team Shop floor · main - build\n {4}Deploy to staging\?\n {6}1\. Yes\n {6}2\. No\n {6}3\. Later\n/);
	assert.match(text, /answer a1b2c3d4 --cancel/);
	assert.match(text, /\n {2}b2c3d4e5 .*\n {4}Which branch\?\n {6}1\. main\n {6}2\. dev\n {6}3\. next\n/);
	assert.match(text, /c3d4e5f6 .*\n {4}1\) Which branch\?[\s\S]*2\) Which checks\? \(several\)/);
	assert.match(text, /\n {2}d4e5f6a1[^\n]*\n {4}\(this question cannot be shown here/);
	assert.doesNotMatch(text, /e5f6a1b2|f6a1b2c3/, "a closed and an answered one are not listed");
	w.reply("link/state", { status: 200, body: { view: view() } });
	await w.run("asks");
	assert.match(w.last().text, /No forwarded question is waiting/);
});

test("answer to a select: a choice number is confirmed hereOnly with the question and the choice, then posted with the device, dialog, and digest", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	w.reply("link/dialog-answer", { status: 200, body: {} });
	await w.run("answer a1b2 2");
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true);
	assert.match(w.asked[0]!.body, /Kiosk \(KI02\)/);
	assert.match(w.asked[0]!.body, /Deploy to staging\?/);
	assert.match(w.asked[0]!.body, /2\. No/);
	assert.deepEqual(w.at("link/dialog-answer"), [{ path: "link/dialog-answer", json: { device: "d-kiosk", dialogId: "a1b2c3d4e5f6", digest: "dg-a1b2c3d4e5f6", answer: { choice: 1 } } }]);
	assert.match(w.last().text, /Answer sent to Kiosk/);
});

test("answer to a select with no number asks in pi; text, a number out of range, or a number for another question post nothing", async () => {
	const w = world({ selects: ["3. Later"] });
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("answer a1b2");
	assert.deepEqual(w.selected[0]!.options, ["1. Yes", "2. No", "3. Later"]);
	assert.equal(w.selected[0]!.opts?.[HERE_ONLY], true);
	assert.deepEqual(w.at("link/dialog-answer").map((p) => p.json.answer), [{ choice: 2 }]);
	const bad = world();
	bad.reply("link/state", { status: 200, body: { view: FULL } });
	for (const line of ["answer a1b2 yes please", "answer a1b2 0", "answer a1b2 4", "answer a1b2 2,3", "answer d4e5 1", "answer e5f6 1", "answer zzzz 1"]) await bad.run(line);
	assert.deepEqual([bad.at("link/dialog-answer"), bad.asked, bad.told.map((t) => t.level)], [[], [], Array(7).fill("error")]);
	assert.match(bad.told[0]!.text, /takes a choice number from 1 to 3/);
	assert.match(bad.told[5]!.text, /No forwarded question is waiting under "e5f6"/);
});

test("answer to questions: numbers pick options, other text is the boss's own words, and several questions are asked one by one in pi", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("answer b2c3 2");
	await w.run("answer b2c3 Use the release branch");
	assert.deepEqual(w.at("link/dialog-answer").map((p) => p.json.answer), [{ answers: [{ choices: [1] }] }, { answers: [{ text: "Use the release branch" }] }]);
	assert.match(w.asked[1]!.body, /Use the release branch/);
	await w.run("answer b2c3 1,2");
	assert.equal(w.at("link/dialog-answer").length, 2, "a single-choice question takes one number");
	assert.equal(w.last().level, "error");
	await w.run("answer c3d4 1");
	assert.equal(w.at("link/dialog-answer").length, 2, "two questions are not answered by one line");
	assert.match(w.last().text, /2 questions/);
	const each = world({ selects: ["2. dev"], inputs: ["1, 3"] });
	each.reply("link/state", { status: 200, body: { view: FULL } });
	await each.run("answer c3d4");
	assert.deepEqual(each.selected[0]!.options, ["1. main", "2. dev", "Write my own answer"]);
	assert.match(each.typed[0]!.title, /Which checks\?/);
	assert.deepEqual(each.at("link/dialog-answer").map((p) => p.json.answer), [{ answers: [{ choices: [1] }, { choices: [0, 2] }] }]);
	const own = world({ selects: ["Write my own answer"], inputs: ["the hotfix branch", undefined] });
	own.reply("link/state", { status: 200, body: { view: FULL } });
	await own.run("answer b2c3");
	assert.deepEqual(own.at("link/dialog-answer").map((p) => p.json.answer), [{ answers: [{ text: "the hotfix branch" }] }]);
});

test("answer --cancel is for a question that takes a cancel; every answer is confirmed hereOnly, a no or a dismissed prompt sends nothing, and the device's refusal is shown", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	w.reply("link/dialog-answer", { status: 409, body: { error: "link_failed", reason: "This device already answered that question" } });
	await w.run("answer a1b2 --cancel");
	assert.deepEqual(w.at("link/dialog-answer").map((p) => p.json.answer), [{ cancel: true }]);
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true);
	assert.deepEqual(w.last(), { text: "This device already answered that question", level: "error" });
	await w.run("answer b2c3 --cancel");
	assert.equal(w.at("link/dialog-answer").length, 1, "this question takes no cancel");
	const no = world({ confirm: false });
	no.reply("link/state", { status: 200, body: { view: FULL } });
	await no.run("answer a1b2 1");
	assert.deepEqual([no.at("link/dialog-answer"), no.last().text], [[], "Nothing was sent"]);
	const dismissed = world({ selects: [undefined] });
	dismissed.reply("link/state", { status: 200, body: { view: FULL } });
	await dismissed.run("answer a1b2");
	assert.deepEqual([dismissed.at("link/dialog-answer"), dismissed.asked, dismissed.last().text], [[], [], "Nothing was sent"]);
	const blind = world({ ui: false });
	blind.reply("link/state", { status: 200, body: { view: FULL } });
	await blind.run("answer a1b2 1");
	assert.deepEqual(blind.at("link/dialog-answer"), []);
	assert.match(blind.last().text, /needs the pi screen/);
});

test("invite cancel asks hereOnly, then posts the invite's full hash; a no, an unknown or an ambiguous start does nothing", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("invite cancel ab12cd");
	assert.deepEqual(w.at("link/invite-cancel"), [{ path: "link/invite-cancel", json: { hash: "ab12cd34ef56ab12cd34ef56" } }]);
	assert.deepEqual(w.asked.map((a) => a.opts?.[HERE_ONLY]), [true], "it asks, on this computer only: a paired device cannot cancel an invite either");
	assert.match(w.last().text, /Cancelled the invite for Shop floor/);
	await w.run("invite cancel ab");
	await w.run("invite cancel ab12cd34ef56ab12cd34ef56zz");
	await w.run("invite cancel zzzz");
	assert.equal(w.at("link/invite-cancel").length, 1);
	assert.deepEqual(w.told.slice(-3).map((t) => t.level), ["error", "error", "error"]);
	await w.run("invite cancel ab");
	w.reply("link/invite-cancel", { status: 409, body: { reason: "boom" } });
	await w.run("invite cancel ab99");
	assert.deepEqual(w.last(), { text: "boom", level: "error" });
});

test("invite show prints the invite text only on a pi screen the boss closes: not in a notice, not in a session entry, not in the confirm", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: FULL } });
	w.reply("link/invite-text", { status: 200, body: { text: INVITE, expires: Date.now() + 9 * 60_000, rows: ["010"] } });
	w.keys(["\r"]);
	await w.run("invite show ab12");
	assert.deepEqual(w.at("link/invite-text"), [{ path: "link/invite-text", json: { hash: "ab12cd34ef56ab12cd34ef56" } }]);
	const shown = w.frames[0]!.join("");
	assert.ok(shown.includes(INVITE.slice(0, 60)) && shown.includes(INVITE.slice(-30)), "the screen shows the text, wrapped");
	assert.ok(w.frames[0]!.every((line) => [...line].length <= 80));
	const elsewhere = JSON.stringify([w.told, w.asked, w.selected, w.typed, w.piCalls]);
	assert.ok(!elsewhere.includes(INVITE.slice(12, 50)), "nowhere else");
	assert.match(w.told.map((t) => t.text).join("\n"), /^$/, "nothing is told: the screen is all");
	const no = world({ ui: false });
	no.reply("link/state", { status: 200, body: { view: FULL } });
	await no.run("invite show ab12");
	assert.deepEqual(no.at("link/invite-text"), [], "no screen, no credential asked for");
	const lapsed = world();
	lapsed.reply("link/state", { status: 200, body: { view: FULL } });
	lapsed.reply("link/invite-text", { status: 409, body: { reason: "That invite has lapsed" } });
	await lapsed.run("invite show ab12");
	assert.deepEqual(lapsed.last(), { text: "That invite has lapsed", level: "error" });
	assert.deepEqual(lapsed.frames, []);
	const flat = world({ custom: false });
	flat.reply("link/state", { status: 200, body: { view: FULL } });
	await flat.run("invite show ab12");
	assert.deepEqual(flat.at("link/invite-text"), [], "a screen that cannot show it privately never asks for it");
	assert.equal(flat.last().level, "error");
});

test("join cancel posts link/join-cancel; leave asks hereOnly with the team's name and posts the team's full id and the force flag", async () => {
	const w = world();
	await w.run("join cancel");
	assert.deepEqual(w.at("link/join-cancel"), [{ path: "link/join-cancel", json: {} }]);
	assert.match(w.last().text, /Cancelled the join/);
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("leave forked --force");
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true);
	assert.match(w.asked[0]!.body, /Forked/);
	assert.match(w.asked[0]!.body, /forgets the team/);
	assert.deepEqual(w.at("link/leave"), [{ path: "link/leave", json: { team: "t2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", force: true } }]);
	await w.run("leave t1aaaa");
	assert.deepEqual(w.at("link/leave")[1], { path: "link/leave", json: { team: "t1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", force: false } });
	w.reply("link/leave", { status: 409, body: { reason: "This device is the team's only attended admin. If it leaves, nobody can remove a device or rotate the key; make a second admin first, or leave anyway" } });
	await w.run('leave "Shop floor"');
	assert.match(w.last().text, /only attended admin/);
	assert.equal(w.last().level, "error");
	const before = w.at("link/leave").length;
	await w.run("leave nowhere");
	const no = world({ confirm: false });
	no.reply("link/state", { status: 200, body: { view: FULL } });
	await no.run("leave Forked --force");
	assert.deepEqual([w.at("link/leave").length, no.at("link/leave"), no.last().text], [before, [], "Nothing was left"]);
	const blind = world({ ui: false });
	blind.reply("link/state", { status: 200, body: { view: FULL } });
	await blind.run("leave Forked --force");
	assert.deepEqual(blind.at("link/leave"), []);
});

test("create asks hereOnly naming the relay, folder and share, then takes the relay's token on a masked screen and posts it only in link/create", async () => {
	const w = world();
	w.reply("link/create", { status: 200, body: { team: "t9", name: "proj" } });
	w.keys(typing(TOKEN));
	await w.run(`create https://relay.example ${join(scratch, "proj")} --share presence --label Boss`);
	assert.equal(w.asked.length, 1);
	assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true);
	assert.match(w.asked[0]!.body, /https:\/\/relay\.example/);
	assert.ok(w.asked[0]!.body.includes(join(scratch, "proj")));
	assert.match(w.asked[0]!.body, /presence/);
	assert.deepEqual(w.at("link/create"), [{ path: "link/create", json: { relay: "https://relay.example", token: TOKEN, project: join(scratch, "proj"), share: "presence", label: "Boss" } }]);
	assert.match(w.last().text, /Created the team proj/);
	// The token is in the request and nowhere else: not on any screen frame, notice, dialog, select, or session entry.
	const elsewhere = JSON.stringify([w.told, w.asked, w.selected, w.typed, w.frames, w.piCalls]);
	assert.ok(!elsewhere.includes(TOKEN) && !elsewhere.includes("qzx"), "the token is nowhere but in the request");
	assert.ok(w.frames.some((f) => f.join("").includes("•••")), "the screen showed bullets");
	assert.deepEqual(w.typed, [], "ui.input echoes what is typed, so it is never used");
});

test("create: a pasted token works, Escape or an empty token sends nothing, a refusal is shown without the token, and a bad line or a declined confirm never asks for it", async () => {
	const pasted = world();
	pasted.reply("link/create", { status: 200, body: { name: "p" } });
	pasted.keys([`\x1b[200~${TOKEN}\n\x1b[201~`, "\r"]);
	await pasted.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual(pasted.at("link/create").map((p) => [p.json.token, p.json.share, "label" in p.json]), [[TOKEN, "status", false]]);
	const esc = world();
	esc.keys([...TOKEN.split("").slice(0, 4), "\x1b"]);
	await esc.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual([esc.at("link/create"), esc.last().text], [[], "Nothing was sent"]);
	const empty = world();
	empty.keys(["\r"]);
	await empty.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual(empty.at("link/create"), []);
	const refused = world();
	refused.reply("link/create", { status: 409, body: { error: "link_failed", reason: `The relay refused the token ${TOKEN}` } });
	refused.keys(typing(TOKEN));
	await refused.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.equal(refused.last().level, "error");
	assert.ok(!JSON.stringify(refused.told).includes(TOKEN), "a server reason that echoes the token is scrubbed");
	assert.match(refused.last().text, /The relay refused the token/);
	const no = world({ confirm: false });
	await no.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual([no.frames, no.at("link/create"), no.last().text], [[], [], "Nothing was created"]);
	const flat = world({ custom: false });
	await flat.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual([flat.asked, flat.typed, flat.at("link/create")], [[], [], []], "no private screen: no confirm, no input, nothing");
	assert.match(flat.last().text, /private screen|without showing/);
	const bad = world();
	await bad.run("create https://relay.example /no/such/folder-here");
	await bad.run("create https://relay.example");
	assert.deepEqual([bad.frames, bad.asked, bad.at("link/create")], [[], [], []]);
	assert.deepEqual(bad.told.map((t) => t.level), ["error", "error"]);
	const blind = world({ ui: false });
	await blind.run(`create https://relay.example ${join(scratch, "proj")}`);
	assert.deepEqual(blind.at("link/create"), []);
});

test("join reads an invite from the line or from @file, asks hereOnly naming the team, relay and folder, posts join-start then join-project, and shows the four words", async () => {
	writeFileSync(join(scratch, "inv.txt"), `${INVITE}\n`);
	for (const source of [INVITE, "@inv.txt"]) {
		const w = world();
		w.reply("link/join-start", { status: 200, body: { words: ["alpha", "bravo", "charlie", "delta"], expires: Date.now() + 9 * 60_000, pinned: false } });
		await w.run(`join ${source} --project proj --share presence --label Lab`);
		assert.equal(w.asked.length, 1);
		assert.equal(w.asked[0]!.opts?.[HERE_ONLY], true);
		assert.match(w.asked[0]!.body, /team 070707/, "the team id the invite names");
		assert.match(w.asked[0]!.body, /https:\/\/relay\.example/);
		assert.ok(w.asked[0]!.body.includes(join(scratch, "proj")));
		assert.deepEqual(w.posted.map((p) => p.path), ["link/join-start", "link/join-project"]);
		assert.deepEqual(w.posted[0]!.json, { text: INVITE, label: "Lab" });
		assert.deepEqual(w.posted[1]!.json, { project: join(scratch, "proj"), share: "presence" });
		assert.match(w.last().text, /alpha bravo charlie delta/);
		assert.match(w.last().text, /\/boss link join cancel/);
		assert.equal(w.last().level, undefined);
	}
});

test("join with no --project uses this session's folder, and says so in the confirm; a refusal of join-start is shown and never posts the folder", async () => {
	const w = world();
	w.reply("link/join-start", { status: 200, body: { words: ["a", "b", "c", "d"], expires: Date.now() + 60_000, pinned: true } });
	await w.run(`join ${INVITE}`, join(scratch, "proj"));
	assert.ok(w.asked[0]!.body.includes(join(scratch, "proj")));
	assert.match(w.asked[0]!.body, /this session's folder/);
	assert.deepEqual(w.posted[1]!.json, { project: join(scratch, "proj"), share: "status" });
	const bad = world();
	bad.reply("link/join-start", { status: 409, body: { reason: "This computer is in that team already" } });
	await bad.run(`join ${INVITE} --project proj`);
	assert.deepEqual(bad.posted.map((p) => p.path), ["link/join-start"]);
	assert.deepEqual(bad.last(), { text: "This computer is in that team already", level: "error" });
	const half = world();
	half.reply("link/join-start", { status: 200, body: { words: ["a", "b", "c", "d"], expires: Date.now() + 60_000, pinned: false } });
	half.reply("link/join-project", { status: 409, body: { reason: "That folder is not safe" } });
	await half.run(`join ${INVITE} --project proj`);
	assert.match(half.told.map((t) => t.text).join("\n"), /That folder is not safe[\s\S]*\/boss link join cancel/);
	assert.equal(half.last().level, "error");
});

test("join: a line that is no invite, a missing file or folder, a no, and a missing screen post nothing; the invite text is not echoed in an error", async () => {
	for (const [line, ui, confirm] of [["join strawlink1:garbage --project proj", true, true], ["join hello", true, true], ["join @missing.txt --project proj", true, true], [`join ${INVITE} --project nowhere-at-all`, true, true], [`join ${INVITE} --project proj`, true, false], [`join ${INVITE} --project proj`, false, true]] as const) {
		const w = world({ ui, confirm });
		await w.run(line);
		assert.deepEqual(w.posted, [], line);
		assert.equal(w.told.length, 1, line);
		assert.ok(!w.told[0]!.text.includes(INVITE.slice(15, 60)), `${line}: the invite is not echoed`);
	}
	const w = world();
	w.reply("link/join-start", { status: 409, body: { reason: `Cannot use ${INVITE}` } });
	await w.run(`join ${INVITE} --project proj`);
	assert.ok(!w.last().text.includes(INVITE.slice(15, 60)), "a reason that echoes the invite is scrubbed");
});

test("zh-TW words the answers in Traditional Chinese", async () => {
	const w = world({ lang: "zh-TW" });
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("confirms");
	assert.match(w.last().text, /等待你回答的確認/);
	await w.run("confirm c2bb deny");
	assert.match(w.last().text, /已拒絕/);
	await w.run("asks");
	assert.match(w.last().text, /轉送來的問題/);
	assert.match(w.last().text, /Which branch\?/);
});

// ---- The /boss command: which line reaches the link path, and a run reaches none --------------------------------------------------------------

function boss(active: boolean) {
	const called: string[] = [], told: string[] = [];
	let handler: ((args: string, ctx: { ui: object; hasUI: boolean; cwd: string }) => Promise<void>) | undefined;
	const link = async (...a: unknown[]) => void called.push(`link ${JSON.stringify(a)}`);
	const kit = { pi: { registerCommand: (_n: string, c: { handler: typeof handler }) => (handler = c.handler) }, cfg: { env: {} }, s: {}, guiDir: "/nowhere", tell: (t: string) => void told.push(t) } as unknown as Kit;
	const never = new Proxy({}, { get: (_t, k) => async () => void called.push(`other ${String(k)}`) });
	registerBoss(kit, { runMode: { active: () => active }, host: never as never, membership: never as never, reach: never as never, closeSelf: () => undefined, stashing: never as never, paths: { link } as never });
	return { run: (line: string) => handler!(line, { ui: {}, hasUI: true, cwd: "/work" }), called, told };
}
const LINES = ["link on", "link operate", "link operate off", "link operate on", "link confirms", "link confirm c1aa allow", "link asks", "link answer a1b2 2", "link invite cancel ab12", "link invite show ab12", "link join cancel", "link leave Forked --force", "link create https://r.example ~/p --share status", "link join @/tmp/i.txt --project ~/p"];

test("each new line reaches the link path with the session's folder", async () => {
	const b = boss(false);
	for (const line of LINES) await b.run(line);
	assert.deepEqual(b.called, LINES.map((l) => `link ${JSON.stringify([l.slice(5), "/work"])}`));
});

test("a tower run or an ally run reaches none of them: they are the boss's typed input", async () => {
	const b = boss(true);
	for (const line of LINES) await b.run(line);
	assert.deepEqual(b.called, []);
	assert.equal(b.told.length, LINES.length);
	assert.ok(b.told.every((t) => /takes no \/boss command/.test(t)));
});

test("a paired device's composer cannot run them (a slip guard like link decide), nor hide one in /boss open's first message; status and plain text pass", () => {
	for (const text of LINES.map((l) => `/boss ${l}`).concat(["/boss  link  confirm c allow", "/boss open main ~/x /boss link join @f", "  /boss link answer a b"])) assert.equal(localOnlyText(text), true, text);
	for (const text of ["/boss link", "/boss link status", "/boss open member", "/boss status", "link confirms"]) assert.equal(localOnlyText(text), false, text);
});

// ---- The real control handler, in-process ---------------------------------------------------------------------------------------------

test("live: every command reaches its link route with the arguments the holder takes, as the page sends them", async () => {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const link: ControlDeps["link"] = {
		enable: async () => {},
		call: async (name, args) => {
			calls.push({ name, args });
			if (name === "state") return { ok: true, view: FULL };
			if (name === "invite-text") return { ok: true, text: INVITE, expires: Date.now() + 60_000, hash: String(args.hash) };
			if (name === "create") return { ok: true, team: "t9", name: "proj" };
			if (name === "join-start") return { ok: true, words: ["a", "b", "c", "d"], expires: Date.now() + 60_000, pinned: false };
			return { ok: true };
		},
	};
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: () => undefined, workspace: () => [] }, link, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	const w = world();
	const paths = createBossPaths({ ...({} as Kit), pi: {}, cfg: { env: { LANG: "en" }, run: async () => "{}" }, s: { at: undefined, ui: { confirm: async () => true, select: async () => undefined, input: async () => undefined, notify: () => {}, custom: async (factory: (...a: never[]) => unknown) => { let result: unknown; const comp = (await factory({ requestRender() {} } as never, {} as never, {} as never, ((v: unknown) => (result = v)) as never)) as { handleInput(d: string): void }; for (const k of typing(TOKEN)) comp.handleInput(k); return result; } } }, guiDir: scratch, me: () => "m1", tell: (t: string) => void w.told.push({ text: t }) } as unknown as Kit, { host: { ensure: async () => ({ record: { port: gui.port, token: gui.token, csrf: gui.csrf, pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, here: (fn) => fn() });
	for (const line of ["confirm c1aa22 allow", "answer a1b2 2", "invite cancel ab12", "join cancel", "leave Forked --force"]) await paths.link(line, scratch);
	assert.deepEqual(calls.filter((c) => c.name !== "state"), [
		{ name: "confirm-answer", args: { dialogId: "c1aa22bb33cc44dd", digest: "dg-c1", allow: true } },
		{ name: "dialog-answer", args: { device: "d-kiosk", dialogId: "a1b2c3d4e5f6", digest: "dg-a1b2c3d4e5f6", answer: { choice: 1 } } },
		{ name: "invite-cancel", args: { hash: "ab12cd34ef56ab12cd34ef56" } },
		{ name: "join-cancel", args: {} },
		{ name: "leave", args: { team: "t2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", force: true } },
	]);
	await paths.link(`create https://relay.example ${join(scratch, "proj")}`, scratch);
	await paths.link(`join ${INVITE} --project proj`, scratch);
	const [create, start, project] = calls.filter((c) => ["create", "join-start", "join-project"].includes(c.name));
	assert.deepEqual([create, start?.name, project], [{ name: "create", args: { relay: "https://relay.example", token: TOKEN, project: join(scratch, "proj"), share: "status" } }, "join-start", { name: "join-project", args: { project: join(scratch, "proj"), share: "status" } }]);
});

// ---- The review's findings (PLP-F001 to PLP-F006) --------------------------------------------------------------------------------------------

/** The screens a world opened: each was open with the pane marked, so a paired device's key pad was Escape only. */
const everyScreenMarked = (w: ReturnType<typeof world>, kinds: string[]) => {
	assert.deepEqual(w.during.map((d) => d.kind), kinds);
	assert.ok(w.during.every((d) => d.marked), `a screen opened with the pane unmarked: ${JSON.stringify(w.during)}`);
	assert.equal(w.hw.faces.any(), false, "the mark is dropped when the command ends");
	assert.equal(w.hw.marked(), false);
};

test("PLP-F001: every hereOnly screen of a link command opens with the pane marked, so a paired device's key pad sends Escape only to it, and the mark is gone when the command ends", async () => {
	const confirm = world();
	confirm.reply("link/state", { status: 200, body: { view: FULL } });
	await confirm.run("confirm c1aa allow");
	everyScreenMarked(confirm, ["confirm"]);
	const answer = world({ selects: ["2. No"] });
	answer.reply("link/state", { status: 200, body: { view: FULL } });
	await answer.run("answer a1b2");
	everyScreenMarked(answer, ["select", "confirm"]);
	const create = world();
	create.keys(typing(TOKEN));
	await create.run(`create https://relay.example ${join(scratch, "proj")}`);
	everyScreenMarked(create, ["confirm", "custom"]);
	const joined = world();
	joined.reply("link/join-start", { status: 200, body: { words: ["a", "b", "c", "d"], expires: Date.now() + 60_000, pinned: false } });
	await joined.run(`join ${INVITE} --project proj`);
	everyScreenMarked(joined, ["confirm"]);
	const leave = world();
	leave.reply("link/state", { status: 200, body: { view: FULL } });
	await leave.run("leave Forked --force");
	everyScreenMarked(leave, ["confirm"]);
	const cancel = world();
	cancel.reply("link/state", { status: 200, body: { view: FULL } });
	await cancel.run("invite cancel ab12cd");
	everyScreenMarked(cancel, ["confirm"]);
	const show = world();
	show.reply("link/state", { status: 200, body: { view: FULL } });
	show.reply("link/invite-text", { status: 200, body: { text: INVITE, expires: Date.now() + 9 * 60_000 } });
	show.keys(["\r"]);
	await show.run("invite show ab12");
	everyScreenMarked(show, ["custom"]);
	assert.ok(show.hw.asked.some((a) => a.open === true && a.pane === "wA:p1"), "the mark is on this session's pane");
});

test("PLP-F001: the mark is dropped on every way out: a no, Escape, a refused request, and a dialog that throws", async () => {
	const no = world({ confirm: false });
	no.reply("link/state", { status: 200, body: { view: FULL } });
	await no.run("leave Forked --force");
	everyScreenMarked(no, ["confirm"]);
	const esc = world({ selects: [undefined] });
	esc.reply("link/state", { status: 200, body: { view: FULL } });
	await esc.run("answer a1b2");
	everyScreenMarked(esc, ["select"]);
	const token = world();
	token.keys([...TOKEN.split("").slice(0, 3), "\x1b"]);
	await token.run(`create https://relay.example ${join(scratch, "proj")}`);
	everyScreenMarked(token, ["confirm", "custom"]);
	const refused = world();
	refused.reply("link/state", { status: 200, body: { view: FULL } });
	refused.reply("link/leave", { status: 409, body: { reason: "boom" } });
	await refused.run("leave Forked --force");
	everyScreenMarked(refused, ["confirm"]);
	const throws = world({ boom: true });
	throws.reply("link/state", { status: 200, body: { view: FULL } });
	await assert.rejects(throws.run("leave Forked --force"), /the dialog broke/);
	everyScreenMarked(throws, ["confirm"]);
	assert.equal(throws.hw.timers(), 0, "no renewal is left running");
	const noInvite = world({ confirm: false });
	noInvite.reply("link/state", { status: 200, body: { view: FULL } });
	await noInvite.run("invite cancel ab12cd");
	assert.deepEqual([noInvite.at("link/invite-cancel"), noInvite.last().text], [[], "Nothing was decided"]);
	everyScreenMarked(noInvite, ["confirm"]);
});

test("PLP-F001: a pane that cannot be marked refuses the screen: nothing is asked and nothing is posted", async () => {
	const w = world({ markError: "Wi-Fi access is served by the default Herdr's sb server" });
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await assert.rejects(w.run("confirm c1aa allow"), /local-only/);
	assert.deepEqual([w.asked, w.at("link/confirm-answer")], [[], []]);
	const deny = world({ markError: "stopped" });
	deny.reply("link/state", { status: 200, body: { view: FULL } });
	await deny.run("confirm c1aa deny");
	assert.equal(deny.at("link/confirm-answer").length, 1, "a deny has no screen, so no mark");
});

test("PLP-F001: a GUI that is not running takes no paired device's keys, so the screen opens as before", async () => {
	const w = world({ markError: "stopped" });
	w.reply("link/state", { status: 200, body: { view: FULL } });
	await w.run("confirm c1aa allow");
	assert.equal(w.asked.length, 1);
	assert.equal(w.at("link/confirm-answer").length, 1);
});

const ESC_ID = "\x1b[8mabcdefghij";
const WITH_ESC = view({ confirms: [{ ...CONFIRMS[0]!, dialogId: ESC_ID, team: TEAMS[0]!.team }, { ...CONFIRMS[1]!, team: TEAMS[0]!.team }], alerts: [{ ...dialog(ESC_ID, SELECT), team: TEAMS[0]!.team }, { ...dialog("b2c3d4e5f6a1", ONE_Q), team: TEAMS[0]!.team }] });
const RAW = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;

test("PLP-F002: a teammate's dialog id is shown with its escape sequence written out in confirms and asks, and typed back as shown it still finds the request", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: WITH_ESC } });
	await w.run("confirms");
	assert.ok(!RAW.test(w.last().text.replace(/\n/g, "")), "no raw escape in the confirms listing");
	assert.match(w.last().text, /\\x1b\[8ma/, "the id as the boss reads it");
	await w.run("asks");
	assert.ok(!RAW.test(w.last().text.replace(/\n/g, "")), "no raw escape in the asks listing");
	assert.match(w.last().text, /\\x1b\[8ma[^\n]*\n[\s\S]*answer \\x1b\[8ma/, "the head and the cancel hint show it the same way");
	w.reply("link/confirm-answer", { status: 200, body: {} });
	await w.run("confirm \\x1b[8ma deny");
	assert.deepEqual(w.at("link/confirm-answer").map((p) => p.json.dialogId), [ESC_ID], "the request's own id goes to the holder");
	w.reply("link/dialog-answer", { status: 200, body: {} });
	await w.run("answer \\x1b[8ma --cancel");
	assert.deepEqual(w.at("link/dialog-answer").map((p) => p.json.dialogId), [ESC_ID]);
});

test("PLP-F002: every field a teammate sends is escaped in the listings: label, short id, tool, team, owner, and the question", async () => {
	const evil = "\x1b[2J\x1b[8m";
	const v = view({ teams: [{ ...TEAMS[0]!, name: `Shop${evil}floor` }, TEAMS[1]], confirms: [{ ...CONFIRMS[0]!, team: TEAMS[0]!.team, fromLabel: `Mei${evil}`, fromShort: `M${evil}`, tool: `bash${evil}` }], alerts: [{ ...dialog("a1b2c3d4e5f6", JSON.stringify({ select: { title: `Deploy${evil}?`, choices: [{ label: `Yes${evil}` }] } })), team: TEAMS[0]!.team, teamName: `Shop${evil}`, data: { ...dialog("a1b2c3d4e5f6", SELECT).data, label: `Kiosk${evil}`, short: `K${evil}`, owner: `main${evil}` } }] });
	const w = world();
	w.reply("link/state", { status: 200, body: { view: v } });
	await w.run("confirms");
	await w.run("asks");
	for (const t of w.told) assert.ok(!RAW.test(t.text.replace(/\n/g, "")), t.text);
});

test("PLP-F003: a one-line field with line breaks is shown on one line, so a teammate cannot lay out the allow confirm; arguments keep their lines, indented", async () => {
	const tool = "read\n\nThis is a read-only call; the arguments below are an example only.\n";
	const v = view({ confirms: [{ ...CONFIRMS[0]!, team: TEAMS[0]!.team, tool, fromLabel: "Mei\nAPPROVED BY BOSS", args: "first\nsecond" }] });
	const w = world();
	w.reply("link/state", { status: 200, body: { view: v } });
	await w.run("confirm c1aa allow");
	const body = w.asked[0]!.body, head = body.slice(0, body.indexOf("Its arguments, in full:"));
	assert.ok(!head.slice(0, -2).includes("\n"), `the question above the arguments is one paragraph: ${JSON.stringify(head)}`);
	assert.ok(head.includes("read\\n\\nThis is a read-only call"), "the breaks are written out");
	assert.ok(head.includes("Mei\\nAPPROVED BY BOSS"));
	assert.match(body, /Its arguments, in full:\n\n {2}first\n {2}second$/, "the arguments keep their lines, set in from the question");
	await w.run("confirms");
	const lines = w.last().text.split("\n");
	assert.equal(lines.filter((l) => /^ {2}c1aa22bb /.test(l)).length, 1);
	assert.ok(lines.find((l) => l.startsWith("  c1aa22bb"))!.includes("read\\n\\nThis is"), "the listing line is one line too");
});

test("PLP-F004: U+061C, U+180E, and U+FFF9 to U+FFFB are written out like the other bidi and invisible characters", async () => {
	const v = view({ confirms: [{ ...CONFIRMS[0]!, team: TEAMS[0]!.team, args: "a\u061cb\u180ec\ufff9d\ufffae\ufffbf" }] });
	const w = world();
	w.reply("link/state", { status: 200, body: { view: v } });
	await w.run("confirms");
	assert.ok(!RAW.test(w.last().text.replace(/\n/g, "")));
	assert.match(w.last().text, /a\\u061cb\\u180ec\\ufff9d\\ufffae\\ufffbf/);
});

test("PLP-F005: an id that is exactly one request's and also the start of another's is ambiguous: nothing is done and the candidates are listed in full", async () => {
	const shadow = view({ confirms: [{ ...CONFIRMS[0]!, team: TEAMS[0]!.team }, { ...CONFIRMS[0]!, team: TEAMS[0]!.team, dialogId: "c1aa22bb", digest: "dg-shadow", fromLabel: "Shadow" }] });
	const w = world();
	w.reply("link/state", { status: 200, body: { view: shadow } });
	await w.run("confirm c1aa22bb deny");
	assert.deepEqual(w.at("link/confirm-answer"), []);
	assert.equal(w.last().level, "error");
	assert.match(w.last().text, /More than one confirm/);
	assert.ok(w.last().text.includes("c1aa22bb33cc44dd") && w.last().text.includes("Shadow"), "the candidates, by their full ids and who sent them");
	await w.run("confirm c1aa22bb33cc44dd deny");
	assert.deepEqual(w.at("link/confirm-answer").map((p) => p.json.digest), ["dg-c1"], "the full id of one names it");
	await w.run("confirms");
	assert.ok(w.last().text.split("\n").some((l) => l.startsWith("  c1aa22bb33cc44dd ")), "a listing shows the full id where eight characters name two requests");
	const asks = view({ alerts: [{ ...dialog("a1b2c3d4e5f6", SELECT), team: TEAMS[0]!.team }, { ...dialog("a1b2c3d4", SELECT), team: TEAMS[0]!.team }] });
	const q = world();
	q.reply("link/state", { status: 200, body: { view: asks } });
	await q.run("answer a1b2c3d4 1");
	assert.deepEqual([q.asked, q.at("link/dialog-answer")], [[], []]);
	assert.match(q.last().text, /More than one forwarded question/);
	assert.ok(q.last().text.includes("a1b2c3d4e5f6"));
	await q.run("answer a1b2c3d4e5f6 1");
	assert.equal(q.at("link/dialog-answer").length, 1);
	const hashes = view({ invites: [{ ...INVITES[0]!, team: TEAMS[0]!.team }, { ...INVITES[0]!, team: TEAMS[0]!.team, hash: "ab12cd34" }] });
	const i = world();
	i.reply("link/state", { status: 200, body: { view: hashes } });
	await i.run("invite cancel ab12cd34");
	assert.deepEqual(i.at("link/invite-cancel"), []);
	assert.match(i.last().text, /More than one open invite/);
	const teams = view({ teams: [TEAMS[0]!, { ...TEAMS[1]!, name: "t1aaaa" }] });
	const t = world();
	t.reply("link/state", { status: 200, body: { view: teams } });
	await t.run("leave t1aaaa");
	assert.deepEqual(t.at("link/leave"), [], "a team named like another's id is ambiguous too");
});

test("PLP-F006: a /boss link answer with line breaks in its text reaches the link path and never promotes the session", async () => {
	const b = boss(false);
	await b.run("link answer a1b2 first line\nsecond line");
	await b.run("link answer a1b2 \n  starts with a break");
	assert.deepEqual(b.called, [`link ${JSON.stringify(["answer a1b2 first line\nsecond line", "/work"])}`, `link ${JSON.stringify(["answer a1b2 \n  starts with a break", "/work"])}`]);
});

// ---- /boss link operate (todo #121 wiring, docs/specs/2026-11-07-link-operate.md §8): the sessions this computer holds on unattended boxes, and ending them ------------------------------------------------

test("parseLinkMore reads `operate`, `operate off` and `operate on`, and says usage for anything after them", () => {
	assert.deepEqual([parseLinkMore("operate"), parseLinkMore(" operate "), parseLinkMore("operate off"), parseLinkMore("operate   off"), parseLinkMore("operate on"), parseLinkMore("operate  on ")], [{ action: "operate" }, { action: "operate" }, { action: "operate-off" }, { action: "operate-off" }, { action: "operate-on" }, { action: "operate-on" }]);
	for (const bad of ["operate on now", "operate off now", "operate box", "operate --force", "operate onn"]) assert.equal(parseLinkMore(bad), "usage", bad);
	assert.ok(LINK_ARGUMENTS.some((a) => a.value === "link operate") && LINK_ARGUMENTS.some((a) => a.value === "link operate off") && LINK_ARGUMENTS.some((a) => a.value === "link operate on"));
});

test("/boss link operate lists each session with the box's label as the boss reads it, in both languages; with none it says so", async () => {
	const sessions = [
		{ team: "t1", teamName: "Shop floor", device: "d1", label: "agent-tower-01\u202eevil", short: "AGT01", scope: "box", state: "live", since: Date.now() - 125_000, pages: 2 },
		{ team: "t1", teamName: "Shop floor", device: "d2", label: "cell-2", short: "CEL02", scope: "team", state: "unreachable", pages: 1 },
	];
	for (const lang of ["en", "zh-TW"]) {
		const w = world({ lang });
		w.reply("link/operate", { status: 200, body: { sessions } });
		await w.run("operate");
		assert.deepEqual(w.at("link/operate").map((p) => p.json), [{}]);
		const said = w.last().text;
		assert.ok(said.includes("AGT01") && said.includes("CEL02") && said.includes("Shop floor"), said);
		assert.ok(!said.includes("\u202e"), "a label a teammate wrote shows with its controls escaped");
		assert.match(said, lang === "en" ? /2 pages connected/ : /2 個頁面連著/);
		assert.match(said, /operate off/);
		const none = world({ lang });
		none.reply("link/operate", { status: 200, body: { sessions: [] } });
		await none.run("operate");
		assert.match(none.last().text, lang === "en" ? /No operate session is open/ : /沒有開著的操作連線/);
	}
	const refused = world();
	refused.reply("link/operate", { status: 409, body: { error: "link_failed" } });
	await refused.run("operate");
	assert.equal(refused.told.at(-1)!.level, "error");
});

test("/boss link operate off posts the route that ends them, tells so in both languages, and says usage for a malformed line", async () => {
	for (const lang of ["en", "zh-TW"]) {
		const w = world({ lang });
		await w.run("operate off");
		assert.deepEqual(w.at("link/operate-off").map((p) => p.json), [{}]);
		assert.match(w.last().text, lang === "en" ? /Every operate session from this computer was ended/ : /操作連線都已結束/);
		assert.match(w.last().text, lang === "en" ? /stays off.*until \/boss link operate on/ : /保持關閉.*\/boss link operate on/, "it says how long, and what turns it on");
		await w.run("operate onn");
		assert.equal(w.at("link/operate-off").length, 1);
		assert.equal(w.told.at(-1)!.level, "error");
		assert.match(w.last().text, /\/boss link operate \[off\|on\]/);
	}
});

test("/boss link operate off says so when the switch could not be written down, and operate on posts its own route, tells so, and says when it could not be removed", async () => {
	for (const lang of ["en", "zh-TW"]) {
		const unsaved = world({ lang });
		unsaved.reply("link/operate-off", { status: 200, body: { saved: false } });
		await unsaved.run("operate off");
		assert.equal(unsaved.told.at(-1)!.level, "warning");
		assert.match(unsaved.last().text, lang === "en" ? /could not be written down/ : /沒能寫進狀態資料夾/);
		const on = world({ lang });
		await on.run("operate on");
		assert.deepEqual(on.at("link/operate-on").map((p) => p.json), [{}]);
		assert.equal(on.at("link/operate-off").length, 0);
		assert.match(on.last().text, lang === "en" ? /Operate is on/ : /操作功能已開啟/);
		const stuck = world({ lang });
		stuck.reply("link/operate-on", { status: 200, body: { saved: false } });
		await stuck.run("operate on");
		assert.equal(stuck.told.at(-1)!.level, "error");
		assert.match(stuck.last().text, lang === "en" ? /Operate stays off/ : /仍然關閉/);
		const refused = world({ lang });
		refused.reply("link/operate-on", { status: 409, body: { error: "link_failed" } });
		await refused.run("operate on");
		assert.equal(refused.told.at(-1)!.level, "error");
	}
});

test("/boss link operate says since when operate is off, with no list of sessions", async () => {
	const at = new Date(2026, 10, 7, 14, 3).getTime();
	for (const lang of ["en", "zh-TW"]) {
		const w = world({ lang });
		w.reply("link/operate", { status: 200, body: { sessions: [], off: at } });
		await w.run("operate");
		assert.match(w.last().text, lang === "en" ? /Operate is off since 2026-11-07 14:03 \(turn it on with \/boss link operate on\)/ : /操作功能已關閉，自 2026-11-07 14:03 起.*\/boss link operate on/);
	}
});

test("live: link/operate and link/operate-off are routes of this computer's own page only; a paired device's request is refused", async () => {
	const calls: string[] = [];
	const link: ControlDeps["link"] = { enable: async () => {}, call: async (name) => (calls.push(name), { ok: true, sessions: [] }) };
	const control = createControl({ link, lookup: () => undefined, csrf: "c", canonical: () => undefined });
	assert.equal((await control.run(["link", "operate"], {}, { remote: false, secure: false })).status, 200);
	assert.equal((await control.run(["link", "operate-off"], {}, { remote: false, secure: false })).status, 200);
	assert.equal((await control.run(["link", "operate-on"], {}, { remote: false, secure: false })).status, 200);
	for (const name of ["operate", "operate-off", "operate-on"]) assert.equal((await control.run(["link", name], {}, { remote: true, secure: false })).status, 403, name);
	assert.deepEqual(calls, ["operate", "operate-off", "operate-on"]);
});

test("/boss link on posts the page's link/enable and says it is setting up; a refusal is told as an error; extra words are usage; the help names it", async () => {
	assert.deepEqual([parseLinkMore("on"), parseLinkMore(" on "), parseLinkMore("on now")], [{ action: "on" }, { action: "on" }, "usage"]);
	assert.ok(LINK_ARGUMENTS.some((a) => a.value === "link on"));
	for (const [status, level] of [[200, undefined], [502, "error"]] as const) {
		const w = world(); w.reply("link/enable", { status, body: status === 200 ? {} : { error: "link_failed", reason: "boom" } });
		await w.run("on");
		assert.deepEqual(w.at("link/enable").map((p) => p.json), [{}]);
		assert.equal(w.last().level, level);
		assert.match(w.last().text, status === 200 ? /Setting up Straw Link/ : /boom/);
	}
});
