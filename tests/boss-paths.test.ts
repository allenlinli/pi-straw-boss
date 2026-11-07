import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerBoss } from "../src/boss.ts";
import { createBossPaths, parseStash, type Post } from "../src/bosspaths.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Kit } from "../src/state.ts";

// /boss close <name>, close all <workspace>, stash --workspace, dismiss, gui devices / unpair, server logs: each posts the route the page posts to, asks the boss first when it
// quits someone else, and is refused in a tower run or an ally run.

const unit = (key: string, name: string, role: Unit["role"], extra: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark: "idle", subs: [], ...extra });
const NET = {
	bases: [
		{ id: "wA", label: "Alpha", mark: "idle", tower: { name: "tower · A", mark: "idle", key: "tower-A", control: true, subs: [] }, outposts: [], outside: [],
			tabs: [{ id: "wA:t1", label: "work", units: [unit("m1", "api-main", "main", { subs: [unit("kid-old", "builder", "subagent", { ended: true }), unit("kid-live", "runner", "subagent")] }), unit("b1", "api-member", "member")] }, { id: "wA:t2", label: "other", units: [unit("m2", "dup", "main")] }] },
		{ id: "wB", label: "Beta", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "wB:t1", label: "work", units: [unit("m3", "dup", "main")] }] },
	],
} as unknown as Net;

function world({ ui = true, answer = true, lang = "en", version = "0.60.5" }: { ui?: boolean; answer?: boolean; lang?: string; version?: string | null } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "sb-paths-"));
	const told: { text: string; level?: string }[] = [], posted: { path: string; json: Record<string, unknown> }[] = [], asked: string[][] = [], self: boolean[] = [];
	let reply: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
	const replies = new Map<string, typeof reply>();
	const post: Post = async (_r, path, json) => (posted.push({ path, json }), replies.get(path) ?? reply);
	const kit = {
		cfg: { env: { LANG: lang }, run: async () => JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wB", label: "Beta" }] } }) },
		s: { ui: ui ? { confirm: async (title: string, body: string) => (asked.push([title, body]), answer) } : undefined },
		guiDir: dir, me: () => "m1", tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	const logs: number[] = [];
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1, version: version ?? undefined } as never }), sessions: async () => [] }, server: { logs: async (n?: number) => (logs.push(n ?? 0), ["line a", "line b"]) }, closeSelf: (keep) => (self.push(keep), undefined), here: (fn) => fn(), post, read: async () => NET });
	return { paths, told, posted, asked, self, logs, dir, reply: (r: typeof reply, path?: string) => (path ? replies.set(path, r) : (reply = r)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("close <name> confirms in pi, names what quits, and posts close/unit with the unit's key", async () => {
	const w = world();
	await w.paths.close("api-member");
	assert.equal(w.asked.length, 1);
	assert.match(w.asked[0]![1]!, /api-member \(in Alpha\) quits/);
	assert.deepEqual(w.posted, [{ path: "close/unit", json: { key: "b1" } }]);
	assert.deepEqual(w.told.map((t) => t.text), ["Closing api-member…"], "a 200 only says the quit was accepted");
	w.done();
});

test("a key prefix of under six characters picks nothing; six characters pick the key", async () => {
	const w = world();
	await w.paths.close("tower");
	assert.deepEqual(w.posted, []);
	assert.match(w.told.at(-1)!.text, /Nothing on the net is named "tower"/);
	await w.paths.close("tower-");
	assert.deepEqual(w.posted, [{ path: "close/unit", json: { key: "tower-A" } }]);
	w.done();
});

test("close <squad> posts close/tab with its workspace and tab, and the confirm names its members", async () => {
	const w = world();
	await w.paths.close("squad:work");
	assert.equal(w.posted.length, 0, "work names a squad in two bases");
	assert.match(w.told.at(-1)!.text, /more than one/);
	await w.paths.close("other");
	assert.match(w.asked.at(-1)![1]!, /squad other \(in Alpha\) quits: dup/);
	assert.deepEqual(w.posted, [{ path: "close/tab", json: { workspace: "wA", tab: "wA:t2" } }]);
	w.done();
});

test("close <base> and close all <workspace> post close/all for that workspace, after a confirm that names the base's units", async () => {
	const w = world();
	await w.paths.close("Beta");
	await w.paths.close("alpha", true);
	assert.deepEqual(w.posted, [{ path: "close/all", json: { workspace: "wB" } }, { path: "close/all", json: { workspace: "wA" } }]);
	assert.match(w.asked[1]![1]!, /whole base Alpha quits: tower · A, api-main, api-member, dup/);
	w.done();
});

test("a refused confirm closes nothing; with no pi screen nothing is asked and nothing closes", async () => {
	const no = world({ answer: false });
	await no.paths.close("api-member");
	assert.deepEqual([no.posted, no.told.at(-1)!.text], [[], "Nothing was closed"]);
	const blind = world({ ui: false });
	await blind.paths.close("api-member");
	await blind.paths.unpair("all");
	assert.deepEqual(blind.posted, []);
	assert.deepEqual(blind.told.map((x) => x.level), ["error", "error"]);
	no.done();
	blind.done();
});

test("an ambiguous or unknown name lists the candidates and does nothing", async () => {
	const w = world();
	await w.paths.close("dup");
	assert.deepEqual([w.posted, w.asked], [[], []]);
	assert.match(w.told.at(-1)!.text, /unit:dup \(in Alpha\) \[m2\][\s\S]*unit:dup \(in Beta\) \[m3\]/);
	await w.paths.close("unit:dup");
	await w.paths.close("nobody");
	assert.deepEqual(w.posted, []);
	assert.match(w.told.at(-1)!.text, /Nothing on the net is named "nobody"/);
	await w.paths.close("m3");
	assert.deepEqual(w.posted, [{ path: "close/unit", json: { key: "m3" } }], "a key picks one of two units with one name");
	w.done();
});

test("closing yourself by name is the bare /boss close: no confirm and no post", async () => {
	const w = world();
	await w.paths.close("api-main");
	assert.deepEqual([w.self, w.asked, w.posted], [[false], [], []]);
	w.done();
});

test("the server's refusal comes back as it words it, as an error", async () => {
	const w = world();
	w.reply({ status: 409, body: { error: "refused", reason: "Nothing was closed: x cannot be closed from here." } });
	await w.paths.close("api-member");
	assert.deepEqual(w.told.at(-1), { text: "Nothing was closed: x cannot be closed from here.", level: "error" });
	w.done();
});

test("stash --workspace parses, confirms, and posts close/stash for that workspace with the label as the name", async () => {
	assert.deepEqual([parseStash(undefined), parseStash("mine"), parseStash("--workspace Beta"), parseStash("mine --workspace Beta two"), parseStash("--workspace=Beta"), parseStash("--workspace"), parseStash("mine --workspace"), parseStash("--workspace=")], [{}, { name: "mine" }, { workspace: "Beta" }, { name: "mine", workspace: "Beta two" }, { workspace: "Beta" }, { flag: true }, { name: "mine", flag: true }, { flag: true }]);
	const w = world();
	w.reply({ status: 200, body: { sessions: 3 } });
	await w.paths.stashOther(undefined, "beta");
	assert.match(w.asked[0]![1]!, /Beta is put away/);
	assert.deepEqual(w.posted, [{ path: "close/stash", json: { workspace: "wB", name: "Beta" } }]);
	assert.match(w.told.at(-1)!.text, /Stashed Beta as "Beta" \(3 sessions\)/);
	await w.paths.stashOther("x", "nowhere");
	assert.equal(w.posted.length, 1);
	assert.match(w.told.at(-1)!.text, /No workspace is labeled/);
	w.done();
});

test("stash --workspace refuses a name already stashed, before asking anything", async () => {
	const w = world();
	const { stashFile } = await import("../src/stash.ts");
	mkdirSync(join(stashFile(w.dir, "taken"), ".."), { recursive: true });
	writeFileSync(stashFile(w.dir, "taken"), "{}");
	await w.paths.stashOther("taken", "Beta");
	assert.deepEqual([w.asked, w.posted, w.told.at(-1)!.level], [[], [], "error"]);
	w.done();
});

test("dismiss and dismiss all post dismiss; a name posts the finished subagent's key and an unfinished one is refused", async () => {
	const w = world();
	w.reply({ status: 200, body: { dismissed: 2 } });
	await w.paths.dismiss(undefined);
	await w.paths.dismiss("all");
	assert.deepEqual(w.posted, [{ path: "dismiss", json: { all: true } }, { path: "dismiss", json: { all: true } }]);
	assert.equal(w.told.at(-1)!.text, "Dismissed 2 finished subagents");
	w.posted.length = 0;
	await w.paths.dismiss("builder");
	assert.deepEqual(w.posted, [{ path: "dismiss", json: { key: "kid-old" } }]);
	await w.paths.dismiss("runner");
	assert.equal(w.posted.length, 1, "a subagent still running is not dismissed");
	assert.match(w.told.at(-1)!.text, /No finished subagent is named "runner"/);
	w.done();
});

test("gui devices lists id, label, network, paired and last seen from remote/devices", async () => {
	const w = world();
	w.reply({ status: 200, body: { on: true, devices: [{ id: "abc123", label: "iPhone · Safari", paired: Date.UTC(2026, 9, 30, 8, 5), seen: 0, net: "tailnet" }, { id: "def456", label: "", paired: 0, seen: Date.UTC(2026, 10, 1, 1, 2), net: "lan", host: "mac.local" }] } }, "remote/devices");
	await w.paths.devices();
	assert.deepEqual(w.posted, [{ path: "remote/devices", json: {} }]);
	assert.equal(w.told.at(-1)!.text, ["Paired devices (Tailscale access is on):", "  abc123  iPhone · Safari  Tailscale  paired 2026-10-30 08:05 UTC  last seen never", "  def456  ?  Wi-Fi  paired never  last seen 2026-11-01 01:02 UTC"].join("\n"));
	w.done();
});

test("gui unpair <id> takes a unique start of an id and posts remote/unpair; all confirms first and posts remote/unpair-all; neither touches the address", async () => {
	const w = world();
	w.reply({ status: 200, body: { on: true, devices: [{ id: "abc123" }, { id: "abd999" }] } }, "remote/devices");
	await w.paths.unpair("ab");
	assert.match(w.told.at(-1)!.text, /More than one/);
	await w.paths.unpair("zzz");
	assert.match(w.told.at(-1)!.text, /No paired device/);
	await w.paths.unpair("abc");
	assert.deepEqual(w.posted.filter((p) => p.path === "remote/unpair"), [{ path: "remote/unpair", json: { id: "abc123" } }]);
	w.posted.length = 0;
	w.reply({ status: 200, body: { unpaired: 2 } }, "remote/unpair-all");
	await w.paths.unpair("all");
	assert.match(w.asked.at(-1)![1]!, /The address does not change/);
	assert.deepEqual(w.posted, [{ path: "remote/unpair-all", json: {} }]);
	assert.equal(w.told.at(-1)!.text, "Unpaired 2 devices");
	assert.ok(w.posted.every((p) => !/rotate/.test(p.path)));
	const no = world({ answer: false });
	await no.paths.unpair("all");
	assert.deepEqual(no.posted, []);
	w.done();
	no.done();
});

test("server logs [n] reads the log as boss_server logs does and caps n at 200", async () => {
	const w = world();
	await w.paths.logs(undefined);
	await w.paths.logs("50");
	assert.deepEqual(w.logs, [200, 50]);
	assert.equal(w.told.at(-1)!.text, "line a\nline b");
	for (const bad of ["0", "201", "x", "-1"]) await w.paths.logs(bad);
	assert.deepEqual(w.logs, [200, 50]);
	assert.equal(w.told.at(-1)!.level, "error");
	w.done();
});

test("zh-TW locale words the confirm and the answers in Traditional Chinese", async () => {
	const w = world({ lang: "zh-TW.UTF-8" });
	await w.paths.close("api-member");
	assert.match(w.asked[0]![1]!, /會結束/);
	assert.equal(w.told.at(-1)!.text, "正在關閉 api-member…");
	w.done();
});

// The /boss command itself: which line reaches which path, and a run reaches none.
function boss(active: boolean) {
	const called: string[] = [];
	let handler: ((args: string, ctx: { ui: object; hasUI: boolean; cwd: string }) => Promise<void>) | undefined;
	const told: string[] = [];
	const spy = (name: string) => async (...a: unknown[]) => void called.push(`${name} ${JSON.stringify(a)}`);
	const paths = { needWorkspace: spy("needWorkspace"), close: spy("close"), stashOther: spy("stashOther"), dismiss: spy("dismiss"), open: spy("open"), link: spy("link"), devices: spy("devices"), send: spy("send"), stop: spy("stop"), unpair: spy("unpair"), logs: spy("logs") };
	const kit = { pi: { registerCommand: (_n: string, c: { handler: typeof handler }) => (handler = c.handler) }, cfg: { env: {} }, s: {}, guiDir: "/nowhere", tell: (t: string) => void told.push(t) } as unknown as Kit;
	const never = new Proxy({}, { get: (_t, k) => async () => void called.push(`other ${String(k)}`) });
	registerBoss(kit, { runMode: { active: () => active }, host: never as never, membership: never as never, reach: never as never, closeSelf: () => { called.push("closeSelf"); return undefined; }, stashing: never as never, paths: paths as never });
	return { run: (line: string) => handler!(line, { ui: {}, hasUI: true, cwd: "/work" }), called, told };
}

test("each typed line reaches its path", async () => {
	const b = boss(false);
	for (const line of ["close api-member", "close all Beta", "close unit:dup", "stash mine --workspace Beta", "dismiss", "dismiss builder", "gui devices", "gui unpair all", "gui unpair abc", "server logs", "server logs 20", "send api-member hello there", "send api-member --after then this\nand that", "stop api-member", "send", "send api-member", "stop", 'send "tower · A" hi', "send api-member --after", "send api-member --after  ", 'send "tower · A" --after then', 'stop "tower · A"', "stop api member", "open base ~/x My base", "open member", "open main ../y do it\nthen this", "link", "link status", "link decide ab12 approve"]) await b.run(line);
	assert.deepEqual(b.called, [
		'close ["api-member"]', 'close ["Beta",true]', 'close ["unit:dup"]', 'stashOther ["mine","Beta"]', 'dismiss [null]', 'dismiss ["builder"]', "devices []", 'unpair ["all"]', 'unpair ["abc"]', "logs [null]", 'logs ["20"]',
		'send ["api-member",false,"hello there"]', 'send ["api-member",true,"then this\\nand that"]', 'stop ["api-member"]', 'send ["",false,""]', 'send ["",false,""]', 'stop [""]', 'send ["tower · A",false,"hi"]', 'send ["",false,""]', 'send ["",false,""]', 'send ["tower · A",true,"then"]', 'stop ["tower · A"]', 'stop [""]',
		'open ["base ~/x My base","/work"]', 'open ["member","/work"]', 'open ["main ../y do it\\nthen this","/work"]', 'link [null,"/work"]', 'link ["status","/work"]', 'link ["decide ab12 approve","/work"]',
	]);
});

test("stash --workspace with no value refuses and never stashes this base", async () => {
	for (const line of ["stash --workspace", "stash --workspace ", "stash mine --workspace", "stash --workspace="]) {
		const b = boss(false);
		await b.run(line);
		assert.deepEqual(b.called, ["needWorkspace []"], line);
	}
});

test("bare close and close all keep their meanings", async () => {
	const b = boss(false);
	await b.run("close");
	assert.deepEqual(b.called, ["closeSelf"]);
	const c = boss(false);
	await c.run("close all");
	assert.deepEqual(c.called, ["other closeAll"]);
});

test("a tower run or an ally run reaches none of them", async () => {
	const b = boss(true);
	for (const line of ["close api-member", "close all Beta", "stash --workspace Beta", "dismiss", "gui devices", "gui unpair all", "server logs", "send api-member hi", "stop api-member", "open base x", "open member", "open main x", "link", "link decide a approve"]) await b.run(line);
	assert.deepEqual(b.called, []);
	assert.equal(b.told.length, 14);
	assert.ok(b.told.every((t) => /takes no \/boss command/.test(t)));
});

// G6: /boss send and /boss stop post the routes the composer posts to, and the server keeps its guards.
test("send <name> posts sessions/<key>/input as send, --after as followUp, to a main, a member, the tower, or a subagent, and says where it went", async () => {
	const w = world();
	await w.paths.send("api-member", false, "run the build");
	await w.paths.send("runner", true, "then the tests");
	await w.paths.send("tower-A", false, "hello tower");
	assert.deepEqual(w.posted, [
		{ path: "sessions/b1/input", json: { text: "run the build", as: "send", guarded: true } },
		{ path: "sessions/kid-live/input", json: { text: "then the tests", as: "followUp", guarded: true } },
		{ path: "sessions/tower-A/input", json: { text: "hello tower", as: "send", guarded: true } },
	]);
	assert.deepEqual(w.told.map((t) => t.text), ["Sent to api-member", "Sent to runner as a follow-up", "Sent to tower · A"]);
	w.done();
});

test("send refuses what names nothing, two things, or this very session, and posts nothing; empty words say how", async () => {
	const w = world();
	await w.paths.send("nobody", false, "x");
	assert.match(w.told.at(-1)!.text, /Nothing on the net is named "nobody"/);
	await w.paths.send("dup", false, "x");
	await w.paths.send("api-main", false, "x");
	assert.match(w.told.at(-1)!.text, /^That is this session/, "m1 is this session");
	await w.paths.send("api-member", false, "   ");
	assert.match(w.told.at(-1)!.text, /^Nothing was sent: name the session/);
	assert.deepEqual(w.posted, []);
	assert.ok(w.told.every((t) => t.level === "error"));
	w.done();
});

test("the server's refusal of a send is shown as it wrote it (a blocked dialog, a link request, the size)", async () => {
	const w = world();
	w.reply({ status: 409, body: { error: "blocked", reason: "It is waiting on a dialog; answer it in the terminal." } });
	await w.paths.send("api-member", false, "x");
	assert.deepEqual(w.told.at(-1), { text: "It is waiting on a dialog; answer it in the terminal.", level: "error" });
	w.reply({ status: 413, body: {} });
	await w.paths.send("api-member", false, "x");
	assert.equal(w.told.at(-1)!.text, "the server answered 413");
	w.done();
});

test("a command that ends the session is confirmed in pi and sent again with confirmed; declined, nothing more is sent; with no screen it is not sent", async () => {
	const w = world();
	w.reply({ status: 409, body: { error: "confirm", reason: "This command ends or replaces the session; confirm to send it." } });
	await w.paths.send("api-member", false, "/quit");
	assert.equal(w.asked.length, 1);
	assert.match(w.asked[0]![1]!, /^api-member \(in Alpha\) \[b1\] would end or replace its session with this: \/quit/, "the confirm names the session as the boss typed it, its base, and its key");
	assert.deepEqual(w.posted.map((p) => p.json), [{ text: "/quit", as: "send", guarded: true }, { text: "/quit", as: "send", guarded: true, confirmed: true }]);
	const no = world({ answer: false });
	no.reply({ status: 409, body: { error: "confirm", reason: "x" } });
	await no.paths.send("api-member", false, "/new");
	assert.equal(no.posted.length, 1, "no second post");
	assert.equal(no.told.at(-1)!.text, "Nothing was sent", "a declined send does not say anything was closed");
	const blind = world({ ui: false });
	blind.reply({ status: 409, body: { error: "confirm", reason: "x" } });
	await blind.paths.send("api-member", false, "/new");
	assert.equal(blind.posted.length, 1);
	for (const x of [w, no, blind]) x.done();
});

test("stop <name> asks first, as the page's Stop does, then posts Esc to the session's keys route; it refuses what names nothing or itself, and with no screen or a declined confirm it sends nothing", async () => {
	const w = world();
	await w.paths.stop("runner");
	assert.deepEqual(w.asked, [["Stop it?", "runner (in Alpha) [kid-live] stops its current task; the messages queued for it go back to its terminal editor."]]);
	assert.deepEqual(w.posted, [{ path: "sessions/kid-live/keys", json: { keys: ["esc"] } }]);
	assert.equal(w.told.at(-1)!.text, "Sent Esc to runner");
	await w.paths.stop("api-main");
	await w.paths.stop("zzz");
	await w.paths.stop("");
	assert.equal(w.posted.length, 1);
	assert.match(w.told.at(-1)!.text, /^Nothing was stopped: name the session: \/boss stop <name\|key>/, "stop has its own usage line, not send's");
	w.reply({ status: 409, body: { reason: "Another input to this session is still on its way." } });
	await w.paths.stop("runner");
	assert.equal(w.told.at(-1)!.text, "Another input to this session is still on its way.");
	const no = world({ answer: false });
	await no.paths.stop("runner");
	assert.deepEqual([no.posted, no.told.at(-1)!.text], [[], "Nothing was stopped"]);
	const blind = world({ ui: false });
	await blind.paths.stop("runner");
	assert.deepEqual([blind.posted, blind.told.at(-1)!.level], [[], "error"]);
	assert.match(blind.told.at(-1)!.text, /needs the pi screen to confirm/);
	for (const x of [w, no, blind]) x.done();
});

test("PTP-F010: a name with spaces is named in quotes, for send and stop; a name that is a key or one word needs none", async () => {
	const w = world();
	await w.paths.send("tower · A", false, "hi");
	await w.paths.stop("tower · A");
	assert.deepEqual(w.posted.map((p) => p.path), ["sessions/tower-A/input", "sessions/tower-A/keys"]);
	assert.ok(w.told.every((t) => t.level !== "error"), JSON.stringify(w.told));
	w.done();
});

test("PTP-F010: the usage lines say how to quote a name with spaces", async () => {
	const w = world();
	await w.paths.send("", false, "");
	await w.paths.stop("");
	assert.match(w.told[0]!.text, /\/boss send <name\|key> \[--after\] <text>.*quote a name that has spaces/);
	assert.match(w.told[1]!.text, /\/boss stop <name\|key>.*quote a name that has spaces/);
	w.done();
});

test("in Traditional Chinese the send words follow", async () => {
	const w = world({ lang: "zh-TW.UTF-8" });
	await w.paths.send("api-member", true, "x");
	assert.equal(w.told.at(-1)!.text, "已送給 api-member（排在目前工作之後）");
	await w.paths.stop("runner");
	assert.equal(w.told.at(-1)!.text, "已對 runner 送出 Esc");
	assert.equal(w.asked.at(-1)![0], "要停止嗎？");
	w.done();
});

// G4, G5, G9 through the /boss command: which line reaches the tower or the head.
function towerBoss({ hasUI = true, answer = true, runs = true }: { hasUI?: boolean; answer?: boolean; runs?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "sb-tower-boss-"));
	writeFileSync(join(dir, "config.json"), JSON.stringify({ towerRuns: { enabled: runs } }));
	const asked: Record<string, unknown>[] = [], told: { text: string; level?: string }[] = [], confirms: string[][] = [], opened: unknown[] = [];
	let handler: ((args: string, ctx: { ui: object; hasUI: boolean; cwd: string }) => Promise<void>) | undefined;
	const server = { ask: async (request: Record<string, unknown>, o: { start: string }) => (asked.push({ ...request, start: o.start }), request.cmd === "status" ? { ok: true, towers: [], head: null } : { ok: true, queued: "e1", answered: request.answers ?? undefined }) };
	const kit = {
		pi: { registerCommand: (_n: string, c: { handler: typeof handler }) => (handler = c.handler) },
		cfg: { env: { LANG: "en" }, run: async () => JSON.stringify({ result: { workspaces: [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wB", label: "Beta" }, { workspace_id: "wH", label: "Crown", tokens: { sb_head: "h" } }] } }) },
		s: { at: { workspaceId: "wA" } }, guiDir: dir, tell: (text: string, level?: string) => void told.push({ text, level }),
	} as unknown as Kit;
	registerBoss(kit, {
		host: {} as never, membership: { joinNet: async () => {} } as never, reach: { openTower: async (...a: unknown[]) => (opened.push(a), { opened: false, target: { workspace_id: "wA" } }) } as never,
		closeSelf: () => undefined, stashing: { names: () => [] } as never, paths: {} as never, server: server as never,
	});
	const ui = { confirm: async (title: string, body: string) => (confirms.push([title, body]), answer) };
	return { run: (line: string) => handler!(line, { ui, hasUI, cwd: "/work" }), asked, told, confirms, opened, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("/boss tower -w <workspace> <command> acts on that workspace after a confirm that names it; without -w it is this session's workspace, with no confirm", async () => {
	const b = towerBoss();
	await b.run("tower -w Beta retry");
	await b.run("tower -w wB drop e-1");
	await b.run("tower retry");
	assert.deepEqual(b.asked.map((r) => [r.cmd, r.workspace, r.id]), [["tower-retry", "wB", undefined], ["tower-drop", "wB", "e-1"], ["tower-retry", "wA", undefined]]);
	assert.deepEqual(b.confirms.map((c) => c[1]), ["Wake it again for the tower of Beta (wB).", "Drop a parked event for the tower of Beta (wB)."]);
	await b.run("tower -w nope retry");
	assert.match(b.told.at(-1)!.text, /No workspace matches "nope"/);
	await b.run("tower -w");
	assert.match(b.told.at(-1)!.text, /^Usage: \/boss tower \[-w/);
	assert.equal(b.asked.length, 3);
	b.done();
});

test("/boss tower -w <workspace> <message> is a tower-event for that workspace (no opening, no focus); --answers rides along; the tower runs must be on", async () => {
	const b = towerBoss();
	await b.run("tower -w Beta --answers w3 Yes, deploy");
	assert.deepEqual(b.asked.at(-1), { cmd: "tower-event", workspace: "wB", text: "Yes, deploy", present: true, answers: "W3", start: "never" });
	assert.match(b.told.at(-1)!.text, /Handed to the tower of Beta.* W3 is marked answered\./);
	assert.deepEqual(b.opened, [], "the tower of another workspace is not opened or focused");
	const off = towerBoss({ runs: false });
	await off.run("tower -w Beta hello");
	assert.deepEqual([off.asked, off.told.at(-1)!.level], [[], "warning"]);
	const long = towerBoss();
	await long.run(`tower -w Beta ${"x".repeat(16_385)}`);
	assert.deepEqual([long.asked, long.told.at(-1)!.level], [[], "error"]);
	for (const x of [b, off, long]) x.done();
});

test("/boss tower --answers W3 <message> opens this workspace's tower as a plain prompt does and the event carries answers; a command word after it is the message", async () => {
	const b = towerBoss();
	await b.run("tower --answers W3 Use the staging token");
	await b.run("tower --answers W4 retry");
	assert.deepEqual(b.asked.map((r) => [r.cmd, r.workspace, r.text, r.answers, r.start]), [["tower-event", "wA", "Use the staging token", "W3", "boss"], ["tower-event", "wA", "retry", "W4", "boss"]]);
	assert.match(b.told[0]!.text, /W3 is marked answered/);
	await b.run("tower plain words");
	assert.equal("answers" in b.asked.at(-1)!, false);
	b.done();
});

test("/boss tower -w head goes to the head: commands as /boss head's, a message as head-event with --answers, and a lone head command word is refused as a message", async () => {
	const b = towerBoss();
	await b.run("tower -w head retry");
	await b.run("tower -w head --answers W2 Go ahead");
	await b.run("tower -w head Go ahead");
	await b.run("tower -w head close");
	await b.run("head retry");
	await b.run("head --answers W5 Yes");
	assert.deepEqual(b.asked.map((r) => [r.cmd, r.text, r.answers, r.start]), [
		["head-retry", undefined, undefined, "never"], ["head-event", "Go ahead", "W2", "boss"], ["head-event", "Go ahead", undefined, "boss"], ["head-retry", undefined, undefined, "never"], ["head-event", "Yes", "W5", "boss"],
	]);
	assert.match(b.told.find((t) => t.level === "error")!.text, /with more words/);
	assert.ok(!b.asked.some((r) => r.cmd === "head-close"), "close was not sent");
	b.done();
});

test("PTP-F007: -w with the head's own Herdr workspace, by id or label, is the head tower as the page maps it: head commands, head-event, a lone command word refused as a message, and a confirm that says the head", async () => {
	const b = towerBoss();
	await b.run("tower -w wH retry");
	await b.run("tower -w Crown --answers W2 Go ahead");
	await b.run("tower -w wH Go ahead");
	await b.run("tower -w Crown close");
	await b.run("tower -w head leave");
	assert.deepEqual(b.asked.map((r) => [r.cmd, r.workspace, r.text, r.answers, r.start]), [
		["head-retry", undefined, undefined, undefined, "never"], ["head-event", undefined, "Go ahead", "W2", "boss"], ["head-event", undefined, "Go ahead", undefined, "boss"], ["head-leave", undefined, undefined, undefined, "never"],
	]);
	assert.deepEqual(b.confirms.map((c) => c[1]), ["Wake it again for the head tower.", "Leave the boss conversation for the head tower."]);
	assert.match(b.told.find((t) => t.level === "error")!.text, /with more words/);
	assert.ok(!b.asked.some((r) => r.cmd === "tower-event" || r.cmd === "head-close"), "no workspace tower was written to as the head's id");
	b.done();
});

test("these writes need a pi with a screen; a read does not", async () => {
	const b = towerBoss({ hasUI: false });
	for (const line of ["tower -w Beta retry", "tower -w Beta hello", "tower -w head retry", "tower -w head hello", "head deliver e-1"]) await b.run(line);
	assert.deepEqual(b.asked, []);
	assert.ok(b.told.every((t) => t.level === "error"), JSON.stringify(b.told));
	b.done();
});

// PTPR-F002: a server older than the first one that reads `guarded` would type the text as a plain local write, which is the PTP-F001 bypass.
test("PTPR-F002: /boss send refuses, and posts nothing, when the sb server's recorded version predates the guarded flag; it names the version needed", async () => {
	for (const version of ["0.60.4", "0.59.9", "0.1.0"]) {
		const w = world({ version });
		await w.paths.send("api-member", false, "run the build");
		assert.deepEqual(w.posted, [], version);
		assert.equal(w.told.at(-1)!.level, "error");
		assert.match(w.told.at(-1)!.text, /0\.60\.5/);
		assert.match(w.told.at(-1)!.text, /restart/i);
		w.done();
	}
	for (const version of ["0.60.5", "0.61.0", "1.0.0"]) {
		const w = world({ version });
		await w.paths.send("api-member", false, "run the build");
		assert.equal(w.posted.length, 1, version);
		w.done();
	}
	const none = world({ version: null });
	await none.paths.send("api-member", false, "x");
	assert.deepEqual(none.posted, [], "a record with no version predates it");
	none.done();
});
