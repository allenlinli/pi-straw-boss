import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { folderOf, parseLink, parseOpen } from "../src/bossopen.ts";
import { createBossPaths, type Post } from "../src/bosspaths.ts";
import type { ControlDeps } from "../src/control.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Kit } from "../src/state.ts";

// /boss open base|member|main and /boss link [status] | link decide: each posts the route the page posts to (open/*, open/progress, trust/answer, link/state, link/decide), answers the trust
// question in pi, and asks before approving a join request. The last tests run the real control handler in-process.

/** A wait the test owns: it polls a condition a bounded number of times and fails with what it waited for, so a broken change fails the test and does not hang the file. */
async function until(condition: () => boolean, what: string) {
	for (let tries = 0; !condition(); tries++) {
		if (tries >= 2000) assert.fail(`never happened: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sb-open-link-")));
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");

type Reply = { status: number; body: Record<string, unknown> };
const SETS = [["alpha", "bravo", "charlie", "delta"], ["echo", "foxtrot", "golf", "hotel"], ["india", "juliet", "kilo", "lima"]];
const REQUESTS = [
	{ id: "aabbccdd11223344", team: "t1", teamName: "Shop floor", label: "Lab Mac", short: "LM01", unattended: false, sets: SETS, expires: 9e12 },
	{ id: "aabb99887766", team: "t1", teamName: "Shop floor", label: "Kiosk", short: "KI02", unattended: true, sets: [], expires: 9e12 },
	{ id: "ffee00112233", team: "t2", teamName: "Other", label: "Phone", short: "PH03", unattended: false, sets: SETS, expires: 9e12 },
];
const VIEW = {
	deviceId: "d-self", short: "SELF", label: "Boss Mac", relay: "https://r", invites: [], join: undefined, prefill: undefined, allies: [], alerts: [], confirms: [], joinRequests: REQUESTS,
	teams: [{ team: "t1", name: "Shop floor", status: "running", self: { role: "admin", attended: true }, members: [{ id: "d-self", short: "SELF", label: "Boss Mac", role: "admin", attended: true, self: true, online: true }, { id: "d2", short: "D2", label: "Lab", role: "member", attended: false, self: false, online: false }] }],
};

function world({ ui = true, selects = [] as (string | undefined)[], confirm = true, lang = "en", at = true, pollMs = 5 }: { ui?: boolean; selects?: (string | undefined)[] | ((title: string, options: string[], signal?: AbortSignal) => string | undefined | Promise<string | undefined>); confirm?: boolean; lang?: string; at?: boolean; pollMs?: number } = {}) {
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [], selected: { title: string; options: string[]; signal?: AbortSignal }[] = [], asked: string[][] = [];
	const replies = new Map<string, Reply[] | Reply | ((json: Record<string, unknown>) => Reply | Promise<Reply>)>();
	const post: Post = async (_r, path, json) => {
		posted.push({ path, json });
		const r = replies.get(path);
		if (typeof r === "function") return r(json);
		if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0]!;
		return r ?? { status: 200, body: {} };
	};
	const queue = Array.isArray(selects) ? [...selects] : [];
	const kit = {
		cfg: { env: { LANG: lang }, run: async () => JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "Shop base" }] } }) },
		s: { at: at ? { workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1" } : undefined, ui: ui ? { confirm: async (title: string, body: string) => (asked.push([title, body]), confirm), select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => (selected.push({ title, options, ...(opts?.signal ? { signal: opts.signal } : {}) }), typeof selects === "function" ? selects(title, options, opts?.signal) : queue.shift()), notify: () => {} } : undefined },
		guiDir: scratch, me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, here: (fn) => fn(), post, pollMs });
	return { paths, told, posted, selected, asked, reply: (path: string, r: Reply[] | Reply | ((json: Record<string, unknown>) => Reply | Promise<Reply>)) => replies.set(path, r), at: (path: string) => posted.filter((p) => p.path === path) };
}

test("parseOpen reads the kind, the folder (quoted or not), and the rest of the line; parseLink reads status and decide; anything else is undefined", () => {
	assert.deepEqual(parseOpen("base ~/proj My base"), { kind: "base", dir: "~/proj", text: "My base" });
	assert.deepEqual(parseOpen('main "my dir/x y" do the thing\nand more'), { kind: "main", dir: "my dir/x y", text: "do the thing\nand more" });
	assert.deepEqual(parseOpen("member"), { kind: "member", text: "" });
	assert.deepEqual(parseOpen("member ../x"), { kind: "member", dir: "../x", text: "" });
	assert.deepEqual([parseOpen(undefined), parseOpen(""), parseOpen("tower x")], [undefined, undefined, undefined]);
	assert.deepEqual([parseLink(undefined), parseLink("status"), parseLink(" decide ab12 approve "), parseLink("decide ab12 refuse")], [{ action: "status" }, { action: "status" }, { action: "decide", id: "ab12", verdict: "approve" }, { action: "decide", id: "ab12", verdict: "refuse" }]);
	assert.deepEqual([parseLink("decide ab12"), parseLink("decide ab12 maybe"), parseLink("decide"), parseLink("x")], [undefined, undefined, undefined, undefined]);
});

test("folderOf expands ~ and resolves a relative folder against the session's own", () => {
	assert.equal(folderOf("~", "/w"), homedir());
	assert.equal(folderOf("~/a/b", "/w"), join(homedir(), "a", "b"));
	assert.equal(folderOf("../x", "/w/y"), "/w/x");
	assert.equal(folderOf("sub", "/w"), "/w/sub");
	assert.equal(folderOf("/abs/p/", "/w"), "/abs/p");
});

test("open base posts open/base with the folder resolved from the session's, the label, and a deploy id, then says what opened", async () => {
	mkdirSync(join(scratch, "proj", "api"), { recursive: true });
	const w = world();
	w.reply("open/base", { status: 200, body: { workspace: "wZ", session: "sess-9" } });
	await w.paths.open("base api Billing API", join(scratch, "proj"));
	const [open] = w.at("open/base");
	assert.deepEqual({ ...open!.json, deploy: typeof open!.json.deploy }, { dir: join(scratch, "proj", "api"), label: "Billing API", prompt: "", deploy: "string" });
	assert.match(String(open!.json.deploy), /^pi-[\w-]{8,64}$/);
	assert.match(w.told.at(-1)!.text, /^Opened base .*api \(session sess-9\)$/);
	assert.equal(w.told.at(-1)!.level, undefined);
});

test("open main posts open/main in this session's base with the prompt; open member with no folder splits beside this session's tab, with a folder opens a tab of its own", async () => {
	mkdirSync(join(scratch, "m1"), { recursive: true });
	const w = world();
	await w.paths.open("main m1 fix the build, then tell me", scratch);
	await w.paths.open("member", scratch);
	await w.paths.open("member m1", scratch);
	const bodies = w.posted.filter((p) => p.path.startsWith("open/") && p.path !== "open/progress").map((p) => [p.path, { ...p.json, deploy: undefined }]);
	assert.deepEqual(bodies, [
		["open/main", { workspace: "wA", dir: join(scratch, "m1"), prompt: "fix the build, then tell me", deploy: undefined }],
		["open/member", { workspace: "wA", tab: "wA:t1", deploy: undefined }],
		["open/member", { workspace: "wA", dir: join(scratch, "m1"), deploy: undefined }],
	]);
});

test("a bad line posts nothing: a missing or unreadable folder, a member with a message, no base, no kind", async () => {
	const w = world(), blind = world({ at: false });
	await w.paths.open("base", scratch);
	await w.paths.open("main", scratch);
	await w.paths.open("base nowhere-at-all", scratch);
	await w.paths.open(`base ${join(scratch, "bundle", "index.html")}`, scratch);
	await w.paths.open("member bundle hello", scratch);
	await w.paths.open("tower", scratch);
	await w.paths.open(undefined, scratch);
	await blind.paths.open("main bundle", scratch);
	await blind.paths.open("member", scratch);
	assert.deepEqual([w.posted, blind.posted], [[], []]);
	assert.deepEqual(w.told.map((t) => t.level), Array(7).fill("error"));
	assert.match(w.told[0]!.text, /needs a folder/);
	assert.match(w.told[2]!.text, /is not a folder/);
	assert.match(w.told[4]!.text, /takes only a folder/);
	assert.match(blind.told[0]!.text, /not in a base yet/);
});

test("open words in zh-TW use the page's terms", async () => {
	const w = world({ lang: "zh-TW" });
	w.reply("open/base", { status: 200, body: { session: "s1" } });
	await w.paths.open("base bundle", scratch);
	assert.match(w.told[0]!.text, /^正在開啟基地 /);
	assert.match(w.told.at(-1)!.text, /^已開啟基地 .*（工作階段 s1）$/);
	w.reply("open/base", { status: 409, body: { reason: "資料夾不安全", step: "create" } });
	await w.paths.open("base bundle", scratch);
	assert.equal(w.told.at(-1)!.text, "在「建立基地」失敗：資料夾不安全");
});

test("a refused open names the failed step and the server's reason; a silent server says it may still open", async () => {
	const w = world();
	w.reply("open/main", { status: 409, body: { error: "open_failed", reason: "the tower is gone", step: "join" } });
	await w.paths.open("main bundle", scratch);
	assert.deepEqual(w.told.at(-1), { text: 'Failed at "Join the Straw Net": the tower is gone', level: "error" });
	w.reply("open/main", { status: 400, body: { error: "not_allowed", reason: "Only folders in your home folder can be picked." } });
	await w.paths.open("main bundle", scratch);
	assert.match(w.told.at(-1)!.text, /^Failed at "Open a tab": Only folders in your home/);
	w.reply("open/main", { status: 0, body: {} });
	await w.paths.open("main bundle", scratch);
	assert.deepEqual([w.told.at(-1)!.level, w.told.at(-1)!.text.startsWith("The server did not answer in time")], ["warning", true]);
});

test("a trust question the opening waits on is asked in pi once, and the choice goes to trust/answer with the question's id and digest", async () => {
	const w = world({ selects: ["Trust it this once"] });
	const ask = { id: "q1", digest: "dg1", folder: "/home/x/proj", found: [{ kind: "extensions", path: ".pi/extensions", items: ["a", "b", "c", "d", "e", "f", "g"], more: 2 }, { kind: "settings", path: ".pi/settings.json", items: [], more: 0, unreadable: true }] };
	let release!: (r: Reply) => void;
	w.reply("open/member", () => new Promise<Reply>((done) => (release = done)));
	w.reply("open/progress", { status: 200, body: { steps: [], finished: false, trust: ask } });
	w.reply("trust/answer", { status: 200, body: { outcome: "accepted" } });
	const running = w.paths.open("member bundle", scratch);
	try {
		await until(() => w.at("trust/answer").length > 0, "the trust answer");
		const polled = w.at("open/progress").length;
		await until(() => w.at("open/progress").length >= polled + 4, "four more progress polls, each still showing the question"); // it keeps showing in the progress: it is not asked again
	} finally {
		release({ status: 200, body: { session: "s2" } }); // a failed wait must not leave the opening polling for ever
		await running;
	}
	assert.equal(w.selected.length, 1);
	assert.deepEqual(w.selected[0]!.options, ["Trust this folder", "Trust it this once", "Do not trust"]);
	assert.match(w.selected[0]!.title, /Trust this folder\?\n\/home\/x\/proj\n.*\n.*\n {2}extensions \.pi\/extensions: a, b, c, d, e \(4 more\)\n {2}settings \.pi\/settings\.json \(unreadable\)$/);
	const [answer] = w.at("trust/answer");
	assert.deepEqual({ ...answer!.json, answerId: typeof answer!.json.answerId }, { id: "q1", digest: "dg1", choice: "once", answerId: "string" });
	assert.match(String(answer!.json.answerId), /^[0-9a-f]{32}$/);
	assert.ok(w.told.some((t) => t.text === "Answered"));
	assert.match(w.told.at(-1)!.text, /^Opened member /);
});

test("a dismissed trust question sends nothing; an answer that went stale or was not confirmed is worded, not retried", async () => {
	const ask = { id: "q1", digest: "dg1", folder: "/p", found: [] };
	for (const [selects, reply, expect] of [
		[[undefined], { status: 200, body: {} }, undefined],
		[["Trust this folder"], { status: 200, body: { outcome: "stale", by: "terminal" } }, /Already answered in the terminal/],
		[["Do not trust"], { status: 200, body: { outcome: "unknown" } }, /not confirmed/],
		[["Trust this folder"], { status: 409, body: { reason: "The question changed" } }, /The question changed/],
	] as const) {
		const w = world({ selects: [...selects] });
		let release!: (r: Reply) => void;
		w.reply("open/main", () => new Promise<Reply>((done) => (release = done)));
		w.reply("open/progress", { status: 200, body: { steps: [], finished: false, trust: ask } });
		w.reply("trust/answer", reply);
		const running = w.paths.open("main bundle", scratch);
		try {
			await until(() => w.selected.length > 0, "the trust question");
			const polled = w.at("open/progress").length;
			await until(() => w.at("open/progress").length >= polled + 3, "three more progress polls");
		} finally {
			release({ status: 200, body: {} });
			await running;
		}
		assert.equal(w.at("trust/answer").length, expect ? 1 : 0);
		if (expect) assert.match(w.told.find((t) => expect.test(t.text))?.text ?? "none", expect);
	}
});

test("a trust question with no pi screen is left to the GUI or the terminal", async () => {
	const w = world({ ui: false });
	let release!: (r: Reply) => void;
	w.reply("open/main", () => new Promise<Reply>((done) => (release = done)));
	w.reply("open/progress", { status: 200, body: { steps: [], finished: false, trust: { id: "q1", digest: "d", folder: "/p", found: [] } } });
	const running = w.paths.open("main bundle", scratch);
	try {
		await until(() => w.told.some((t) => /trust question/.test(t.text)), "the no-screen note");
		const polled = w.at("open/progress").length;
		await until(() => w.at("open/progress").length >= polled + 3, "three more progress polls");
	} finally {
		release({ status: 200, body: {} });
		await running;
	}
	assert.deepEqual(w.at("trust/answer"), []);
	assert.equal(w.told.filter((t) => /trust question/.test(t.text)).length, 1, "said once");
});

test("the trust select closes when the open ends: its signal aborts, and no trust/answer is posted", async () => {
	const w = world({ selects: (_t, _o, signal) => new Promise<string | undefined>((done) => signal?.addEventListener("abort", () => done(undefined), { once: true })) });
	let release!: (r: Reply) => void;
	w.reply("open/main", () => new Promise<Reply>((done) => (release = done)));
	w.reply("open/progress", { status: 200, body: { steps: [], finished: false, trust: { id: "q1", digest: "d", folder: "/p", found: [] } } });
	const running = w.paths.open("main bundle", scratch);
	try {
		await until(() => w.selected.length > 0, "the trust question");
		assert.equal(w.selected[0]!.signal?.aborted, false, "open while the opening waits");
	} finally {
		release({ status: 200, body: {} });
		await running;
	}
	assert.equal(w.selected[0]!.signal?.aborted, true, "the opening ended: the question goes with it");
	for (let turn = 0; turn < 10; turn++) await new Promise((done) => setImmediate(done)); // the aborted select settles
	assert.deepEqual(w.at("trust/answer"), []);
	assert.equal(w.selected.length, 1);
});

test("a failure names the create step as the page does (base, tab, split pane), and a member with no folder is named by its base", async () => {
	const w = world();
	for (const [line, path, step] of [["base bundle", "open/base", "Create the base"], ["main bundle", "open/main", "Open a tab"], ["member bundle", "open/member", "Open a tab"], ["member", "open/member", "Split a pane"]] as const) {
		w.reply(path, { status: 409, body: { reason: "no", step: "create" } });
		await w.paths.open(line, scratch);
		assert.equal(w.told.at(-1)!.text, `Failed at "${step}": no`, line);
	}
	w.reply("open/member", { status: 200, body: { session: "s3" } });
	await w.paths.open("member", scratch);
	assert.deepEqual([w.told.at(-2)!.text, w.told.at(-1)!.text], ["Opening member Shop base…", "Opened member Shop base (session s3)"]);
});

test("link status lists the device, its teams and members, and the join requests waiting with a short id; it posts link/state only", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: VIEW } });
	await w.paths.link(undefined);
	assert.deepEqual(w.posted.map((p) => p.path), ["link/state"]);
	const text = w.told.at(-1)!.text;
	assert.match(text, /^This device: Boss Mac \(SELF\)\nTeam Shop floor: you are admin; running\n {2}Boss Mac \(SELF\) · admin · attended · this computer\n {2}Lab \(D2\) · member · unattended · offline\nJoin requests waiting/);
	assert.match(text, /\n {2}aabbccdd {2}Lab Mac \(LM01\) asks to join Shop floor\n/);
	assert.match(text, /\n {2}aabb9988 {2}Kiosk \(KI02\) asks to join Shop floor · unattended\n/);
	w.reply("link/state", { status: 200, body: { view: { ...VIEW, teams: [], joinRequests: [] } } });
	await w.paths.link("status");
	assert.equal(w.told.at(-1)!.text, "This device: Boss Mac (SELF)\nNo team yet\nNo join request is waiting");
	w.reply("link/state", { status: 200, body: {} });
	await w.paths.link("status");
	assert.equal(w.told.at(-1)!.level, "warning");
});

test("link decide approve of an attended request shows the team, the device, and the word sets in pi, and posts the chosen set's index as pick", async () => {
	const w = world({ selects: ["echo foxtrot golf hotel"] });
	w.reply("link/state", { status: 200, body: { view: VIEW } });
	w.reply("link/decide", { status: 200, body: { joined: true } });
	await w.paths.link("decide aabbcc approve");
	assert.equal(w.selected.length, 1);
	assert.match(w.selected[0]!.title, /Lab Mac \(LM01\) asks to join the team Shop floor\. Look at Lab Mac's screen/);
	assert.deepEqual(w.selected[0]!.options, ["alpha bravo charlie delta", "echo foxtrot golf hotel", "india juliet kilo lima", "None of these: refuse"]);
	assert.deepEqual(w.at("link/decide"), [{ path: "link/decide", json: { id: "aabbccdd11223344", pick: 1 } }]);
	assert.equal(w.told.at(-1)!.text, "Lab Mac joined Shop floor");
});

test("link decide approve of an unattended request asks to confirm, naming the team and the device; a no sends nothing", async () => {
	const w = world({ confirm: false });
	w.reply("link/state", { status: 200, body: { view: VIEW } });
	await w.paths.link("decide aabb99 approve");
	assert.equal(w.asked.length, 1);
	assert.match(w.asked[0]![1]!, /Kiosk \(KI02\) is an unattended device .* team Shop floor/);
	assert.deepEqual(w.at("link/decide"), []);
	assert.equal(w.told.at(-1)!.text, "Nothing was decided");
	const yes = world();
	yes.reply("link/state", { status: 200, body: { view: VIEW } });
	yes.reply("link/decide", { status: 200, body: { joined: true } });
	await yes.paths.link("decide aabb99887766 approve");
	assert.deepEqual(yes.at("link/decide"), [{ path: "link/decide", json: { id: "aabb99887766", approve: true } }]);
	assert.equal(yes.told.at(-1)!.text, "Kiosk joined Shop floor");
});

test("a wrong choice and a dismissed choice: none-of-these refuses, a dismissal decides nothing; the server's refusal is shown", async () => {
	const none = world({ selects: ["None of these: refuse"] });
	none.reply("link/state", { status: 200, body: { view: VIEW } });
	none.reply("link/decide", { status: 200, body: { joined: false } });
	await none.paths.link("decide ffee approve");
	assert.deepEqual(none.at("link/decide"), [{ path: "link/decide", json: { id: "ffee00112233", approve: false } }]);
	assert.equal(none.told.at(-1)!.text, "Refused Phone: nobody joined");
	const gone = world({ selects: [undefined] });
	gone.reply("link/state", { status: 200, body: { view: VIEW } });
	await gone.paths.link("decide ffee approve");
	assert.deepEqual([gone.at("link/decide"), gone.told.at(-1)!.text], [[], "Nothing was decided"]);
	const wrong = world({ selects: ["alpha bravo charlie delta"] });
	wrong.reply("link/state", { status: 200, body: { view: VIEW } });
	wrong.reply("link/decide", { status: 409, body: { reason: "Those were not the words on the new computer's screen" } });
	await wrong.paths.link("decide ffee approve");
	assert.deepEqual(wrong.told.at(-1), { text: "Those were not the words on the new computer's screen", level: "error" });
});

test("link decide refuse posts approve:false without asking; an ambiguous or unknown id does nothing", async () => {
	const w = world();
	w.reply("link/state", { status: 200, body: { view: VIEW } });
	w.reply("link/decide", { status: 200, body: { joined: false } });
	await w.paths.link("decide ffee0011 refuse");
	assert.deepEqual([w.asked, w.selected, w.at("link/decide")], [[], [], [{ path: "link/decide", json: { id: "ffee00112233", approve: false } }]]);
	assert.equal(w.told.at(-1)!.text, "Refused Phone: nobody joined");
	const before = w.at("link/decide").length;
	await w.paths.link("decide aabb approve"); // two requests start with aabb
	assert.match(w.told.at(-1)!.text, /More than one join request starts with "aabb"/);
	await w.paths.link("decide zzzz refuse");
	assert.match(w.told.at(-1)!.text, /No join request is waiting under "zzzz"/);
	await w.paths.link("decide ff refuse"); // under four characters picks nothing
	assert.match(w.told.at(-1)!.text, /No join request/);
	await w.paths.link("decide ffee0011 maybe");
	assert.match(w.told.at(-1)!.text, /link decide <id> approve\|refuse/);
	assert.equal(w.at("link/decide").length, before);
	assert.deepEqual(w.told.slice(-4).map((t) => t.level), ["error", "error", "error", "error"]);
});

test("link decide approve with no pi screen sends nothing", async () => {
	const w = world({ ui: false });
	w.reply("link/state", { status: 200, body: { view: VIEW } });
	await w.paths.link("decide ffee approve");
	assert.deepEqual(w.at("link/decide"), []);
	assert.match(w.told.at(-1)!.text, /needs the pi screen/);
});

// ---- The real control handler, in-process ---------------------------------------------------------------------------------------------

async function live() {
	const opened: { parts: string[]; json: Record<string, unknown> }[] = [], decided: Record<string, unknown>[] = [];
	const spawn: ControlDeps["spawn"] = async (parts, json) => (opened.push({ parts, json }), parts[1] === "progress" ? { status: 200, body: { steps: [], finished: false } } : { status: 200, body: { workspace: "wA", session: "sess-live" } });
	const link: ControlDeps["link"] = {
		enable: async () => {},
		call: async (name, args) => {
			if (name === "state") return { ok: true, view: VIEW };
			if (name === "decide") return (decided.push(args), { ok: true, joined: args.pick === 1 });
			return { ok: false, error: "no" };
		},
	};
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup: () => undefined, workspace: () => [] }, link, spawn, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	const told: { text: string; level?: string }[] = [], selects = ["echo foxtrot golf hotel"];
	const kit = {
		cfg: { env: { LANG: "en" }, run: async () => "{}" },
		s: { at: { workspaceId: "wA", tabId: "wA:t1", paneId: "wA:p1" }, ui: { confirm: async () => true, select: async () => selects.shift(), notify: () => {} } },
		guiDir: scratch, me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: gui.port, token: gui.token, csrf: gui.csrf, pid: 1 } as never }), sessions: async () => [] }, closeSelf: () => undefined, here: (fn) => fn(), pollMs: 20 });
	return { gui, paths, told, opened, decided };
}

test("live: open base, member, and main reach the spawn route with the body the page sends, and the answer is worded", async () => {
	mkdirSync(join(scratch, "live-dir"), { recursive: true });
	const w = await live();
	await w.paths.open("base live-dir Live", scratch);
	await w.paths.open("main live-dir say hi", scratch);
	await w.paths.open("member", scratch);
	const opens = w.opened.filter((o) => o.parts[1] !== "progress");
	assert.deepEqual(opens.map((o) => o.parts), [["open", "base"], ["open", "main"], ["open", "member"]]);
	assert.deepEqual(opens.map((o) => ({ ...o.json, deploy: undefined })), [
		{ dir: join(scratch, "live-dir"), label: "Live", prompt: "", deploy: undefined },
		{ workspace: "wA", dir: join(scratch, "live-dir"), prompt: "say hi", deploy: undefined },
		{ workspace: "wA", tab: "wA:t1", deploy: undefined },
	]);
	assert.ok(opens.every((o) => /^pi-[\w-]{8,64}$/.test(String(o.json.deploy))));
	assert.deepEqual(w.told.filter((t) => t.text.startsWith("Opened")).map((t) => t.text.replace(/ \S*live-dir/, " DIR")), ["Opened base DIR (session sess-live)", "Opened main DIR (session sess-live)", `Opened member wA (session sess-live)`]);
});

test("live: link status and decide go through link/state and link/decide of the real handler", async () => {
	const w = await live();
	await w.paths.link(undefined);
	assert.match(w.told.at(-1)!.text, /Join requests waiting/);
	await w.paths.link("decide aabbccdd approve");
	assert.deepEqual(w.decided, [{ id: "aabbccdd11223344", pick: 1 }]);
	assert.equal(w.told.at(-1)!.text, "Lab Mac joined Shop floor");
	await w.paths.link("decide ffee refuse");
	assert.deepEqual(w.decided.at(-1), { id: "ffee00112233", approve: false });
	assert.equal(w.told.at(-1)!.text, "Refused Phone: nobody joined");
});
