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
		{ id: "wA", label: "Alpha", mark: "idle", head: true, tower: { name: "tower · A", mark: "idle", key: "tower-A", control: true, subs: [] }, outposts: [], outside: [],
			tabs: [{ id: "wA:t1", label: "work", units: [unit("m1", "api-main", "main", { subs: [unit("kid-old", "builder", "subagent", { ended: true }), unit("kid-live", "runner", "subagent")] }), unit("b1", "api-member", "member")] }, { id: "wA:t2", label: "other", units: [unit("m2", "dup", "main")] }] },
		{ id: "wB", label: "Beta", mark: "idle", head: false, tower: null, outposts: [], outside: [], tabs: [{ id: "wB:t1", label: "work", units: [unit("m3", "dup", "main")] }] },
	],
} as unknown as Net;

function world({ ui = true, answer = true, lang = "en" }: { ui?: boolean; answer?: boolean; lang?: string } = {}) {
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
	const paths = createBossPaths(kit, { host: { ensure: async () => ({ record: { port: 1, token: "t", pid: 1 } as never }), sessions: async () => [] }, server: { logs: async (n?: number) => (logs.push(n ?? 0), ["line a", "line b"]) }, closeSelf: (keep) => (self.push(keep), undefined), post, read: async () => NET });
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
	let handler: ((args: string, ctx: { ui: object; hasUI: boolean }) => Promise<void>) | undefined;
	const told: string[] = [];
	const spy = (name: string) => async (...a: unknown[]) => void called.push(`${name} ${JSON.stringify(a)}`);
	const paths = { needWorkspace: spy("needWorkspace"), close: spy("close"), stashOther: spy("stashOther"), dismiss: spy("dismiss"), devices: spy("devices"), unpair: spy("unpair"), logs: spy("logs") };
	const kit = { pi: { registerCommand: (_n: string, c: { handler: typeof handler }) => (handler = c.handler) }, cfg: { env: {} }, s: {}, guiDir: "/nowhere", tell: (t: string) => void told.push(t) } as unknown as Kit;
	const never = new Proxy({}, { get: (_t, k) => async () => void called.push(`other ${String(k)}`) });
	registerBoss(kit, { runMode: { active: () => active }, host: never as never, membership: never as never, reach: never as never, closeSelf: () => { called.push("closeSelf"); return undefined; }, stashing: never as never, paths: paths as never });
	return { run: (line: string) => handler!(line, { ui: {}, hasUI: true }), called, told };
}

test("each typed line reaches its path", async () => {
	const b = boss(false);
	for (const line of ["close api-member", "close all Beta", "close unit:dup", "stash mine --workspace Beta", "dismiss", "dismiss builder", "gui devices", "gui unpair all", "gui unpair abc", "server logs", "server logs 20"]) await b.run(line);
	assert.deepEqual(b.called, [
		'close ["api-member"]', 'close ["Beta",true]', 'close ["unit:dup"]', 'stashOther ["mine","Beta"]', 'dismiss [null]', 'dismiss ["builder"]', "devices []", 'unpair ["all"]', 'unpair ["abc"]', "logs [null]", 'logs ["20"]',
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
	for (const line of ["close api-member", "close all Beta", "stash --workspace Beta", "dismiss", "gui devices", "gui unpair all", "server logs"]) await b.run(line);
	assert.deepEqual(b.called, []);
	assert.equal(b.told.length, 7);
	assert.ok(b.told.every((t) => /takes no \/boss command/.test(t)));
});
