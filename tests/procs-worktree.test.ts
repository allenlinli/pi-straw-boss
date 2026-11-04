import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOf, physical, rootOfRemoved, under, type Disk } from "../src/procs/worktree.ts";
import { OWNER_KEY, ownerOf, parseOwnerRows, readOwners, setOwner } from "../src/procs/marker.ts";

// Which checkout a working folder is in (a linked worktree is a `.git` file that points into `<repo>/.git/worktrees/`), and the owner marker that a process carries in its environment.

const statSyncOk = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const disk = (entries: Record<string, string | "dir">): Disk => ({
	kind: (path) => (path in entries ? (entries[path] === "dir" ? "dir" : "file") : undefined),
	read: (path) => (typeof entries[path] === "string" && entries[path] !== "dir" ? entries[path] : undefined),
});

const fs = disk({
	"/repo/.git": "dir",
	"/wt/feat-x/.git": "gitdir: /repo/.git/worktrees/feat-x\n",
	"/repo/.git/worktrees/feat-x": "dir",
	"/repo/.git/worktrees/feat-x/gitdir": "/wt/feat-x/.git\n",
	"/wt/fake/.git": "gitdir: /nowhere/.git/worktrees/zz\n",
	"/wt/stranger/.git": "gitdir: /repo/.git/worktrees/other\n",
	"/repo/.git/worktrees/other": "dir",
	"/repo/.git/worktrees/other/gitdir": "/somewhere/else/.git\n",
	"/repo/sub/.git": "gitdir: /repo/.git/modules/sub\n",
	"/bare-wt/.git": "gitdir: /srv/bare.git/worktrees/w1",
	"/srv/bare.git/worktrees/w1": "dir",
	"/srv/bare.git/worktrees/w1/gitdir": "/bare-wt/.git",
	"/odd/.git": "not a pointer",
});

test("checkoutOf: the nearest .git going up decides: a gitdir file into worktrees/ is a linked worktree, a .git folder is a main checkout", () => {
	assert.deepEqual(checkoutOf("/wt/feat-x/src/deep", fs), { kind: "linked", root: "/wt/feat-x", gitdir: "/repo/.git/worktrees/feat-x" });
	assert.deepEqual(checkoutOf("/wt/feat-x", fs), { kind: "linked", root: "/wt/feat-x", gitdir: "/repo/.git/worktrees/feat-x" });
	assert.deepEqual(checkoutOf("/repo/src", fs), { kind: "main", root: "/repo" });
	assert.deepEqual(checkoutOf("/bare-wt/a", fs), { kind: "linked", root: "/bare-wt", gitdir: "/srv/bare.git/worktrees/w1" }, "a worktree of a bare repository");
});

test("checkoutOf: a submodule is not a linked worktree, a .git file that points nowhere known is not one, and a folder outside any repository has none", () => {
	assert.deepEqual(checkoutOf("/repo/sub/x", fs), { kind: "submodule", root: "/repo/sub" });
	assert.deepEqual(checkoutOf("/odd/x", fs), { kind: "none" });
	assert.deepEqual(checkoutOf("/tmp/nothing", fs), { kind: "none" });
});

test("RR-F006: a .git file counts as a linked worktree only when git's own check holds: the admin folder is there and its gitdir file points back at this .git", () => {
	assert.deepEqual(checkoutOf("/wt/fake/x", fs), { kind: "none" }, "text that matches /worktrees/<x> and points nowhere");
	assert.deepEqual(checkoutOf("/wt/stranger", fs), { kind: "none" }, "an admin folder that belongs to another worktree");
	assert.equal(checkoutOf("/wt/feat-x", fs).kind, "linked");
	const relative = disk({ "/r/wt/.git": "gitdir: ../.git/worktrees/wt\n", "/r/.git/worktrees/wt": "dir", "/r/.git/worktrees/wt/gitdir": "../../../wt/.git\n" });
	assert.equal(checkoutOf("/r/wt", relative).kind, "linked", "relative pointers (worktree.useRelativePaths) resolve from their own folders");
});

test("under: a path is under a root when it is the root or below it, never a sibling that shares a prefix", () => {
	assert.ok(under("/wt/feat-x", "/wt/feat-x"));
	assert.ok(under("/wt/feat-x/a/b", "/wt/feat-x"));
	assert.ok(under("/wt/feat-x/a/", "/wt/feat-x/"));
	assert.ok(!under("/wt/feat-xy", "/wt/feat-x"));
	assert.ok(!under("/wt", "/wt/feat-x"));
});

test("rootOfRemoved: a vanished cwd belongs to the longest known root above it", () => {
	assert.equal(rootOfRemoved("/wt/feat-x/pkg/a", ["/wt", "/wt/feat-x", "/other"]), "/wt/feat-x");
	assert.equal(rootOfRemoved("/nowhere/x", ["/wt"]), undefined);
});

test("ownerOf finds the owner id among the words of one ps row and returns the id only; a word that merely contains the key does not count", () => {
	assert.equal(ownerOf(`node server.js PATH=/usr/bin ${OWNER_KEY}=abc-123_X HOME=/h`), "abc-123_X");
	assert.equal(ownerOf(`${OWNER_KEY}=abc`), "abc");
	assert.equal(ownerOf(`X_${OWNER_KEY}=abc node`), undefined);
	assert.equal(ownerOf("node a b c"), undefined);
	assert.equal(ownerOf(`${OWNER_KEY}=`), undefined);
	assert.equal(ownerOf(`${OWNER_KEY}=${"a".repeat(80)}`), undefined, "an id has a bound");
});

test("parseOwnerRows keeps pid → owner for the requested pids only, skips rows without the marker, and holds nothing else of the row", () => {
	const text = [
		`  500 node a.js FOO=1 ${OWNER_KEY}=own-a BAR=2`,
		`  501 /bin/sh -c x`,
		`  502 python3 ${OWNER_KEY}=own-b`,
		`  999 node ${OWNER_KEY}=own-c`,
		`continuation line ${OWNER_KEY}=own-d`,
	].join("\n");
	const map = parseOwnerRows(text, new Set([500, 501, 502]));
	assert.deepEqual([...map], [[500, "own-a"], [502, "own-b"]]);
	assert.ok(!JSON.stringify([...map]).includes("FOO"), "no environment is kept");
});

test("readOwners on a Mac asks ps -E for the candidates in chunks; on Linux it reads environ and drops what it cannot read", async () => {
	const asked: string[][] = [];
	const run = async (file: string, args: string[]) => (asked.push([file, ...args]), `  5 node ${OWNER_KEY}=own-a\n`);
	const pids = Array.from({ length: 450 }, (_, i) => i + 5);
	const mac = await readOwners(pids, { run, platform: "darwin", environ: () => { throw new Error("not used"); } });
	assert.equal(asked.length, 5, "chunks of 100");
	assert.ok(asked.every(([file, ...args]) => file === "ps" && args.includes("-E")));
	assert.equal(mac.get(5), "own-a");
	const linux = await readOwners([7, 8], { run: async () => "", platform: "linux", environ: (pid) => { if (pid === 8) throw Object.assign(new Error("denied"), { code: "EACCES" }); return Buffer.from(`PATH=/bin\0${OWNER_KEY}=own-z\0HOME=/h\0`); } });
	assert.deepEqual([...linux], [[7, "own-z"]]);
});

test("setOwner puts the marker in the environment it is given, and nowhere else", () => {
	const env: NodeJS.ProcessEnv = { A: "1" };
	setOwner("own-q", env);
	assert.deepEqual(env, { A: "1", [OWNER_KEY]: "own-q" });
	assert.throws(() => setOwner("bad id", env), /owner id/);
});

test("RV-F004: the root is physical: a logical /tmp path finds the /private/tmp root lsof reports; a path that is gone resolves from its nearest folder that is there", () => {
	const real = (path: string) => (path.startsWith("/tmp/") ? `/private${path}` : path);
	const private_ = disk({ "/private/tmp/wt/.git": "gitdir: /repo/.git/worktrees/wt\n", "/repo/.git/worktrees/wt": "dir", "/repo/.git/worktrees/wt/gitdir": "/tmp/wt/.git\n" });
	assert.deepEqual(checkoutOf("/tmp/wt/sub", private_, real), { kind: "linked", root: "/private/tmp/wt", gitdir: "/repo/.git/worktrees/wt" });
	assert.ok(under("/private/tmp/wt/sub", (checkoutOf("/tmp/wt/sub", private_, real) as { root: string }).root), "so it compares with what lsof says");
	const dir = mkdtempSync(join(tmpdir(), "wtp-"));
	try {
		mkdirSync(join(dir, "real", "a"), { recursive: true });
		symlinkSync(join(dir, "real"), join(dir, "link"));
		assert.equal(physical(join(dir, "link", "a")), join(realpathSync(dir), "real", "a"));
		assert.equal(physical(join(dir, "link", "gone", "deeper")), join(realpathSync(dir), "real", "gone", "deeper"), "a removed folder resolves from the part that exists");
		assert.equal(physical("/no-such-top-folder/x"), "/no-such-top-folder/x");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("RR-F007: readOwners treats ps exiting 1 with nothing printed (every pid of a chunk gone) as an empty chunk, not a failure of the others", async () => {
	const seen: string[] = [];
	const pids = Array.from({ length: 150 }, (_, i) => i + 10);
	const run = async (_file: string, args: string[]) => {
		const chunk = args[args.length - 1]!;
		seen.push(chunk.split(",")[0]!);
		if (chunk.startsWith("10,")) throw Object.assign(new Error("ps failed"), { code: 1 });
		return `  ${110} /usr/bin/node x ${OWNER_KEY}=own-a\n`;
	};
	const out = await readOwners(pids, { run, platform: "darwin" });
	assert.deepEqual([...out], [[110, "own-a"]], "the first chunk was empty; the second still answered");
	assert.equal(seen.length, 2);
	await assert.rejects(readOwners([1], { run: async () => { throw Object.assign(new Error("denied"), { code: 2 }); }, platform: "darwin" }), /denied/, "another failure is still a failure");
});

test("RR-F005: physical gives the case the disk has (APFS ignores case), so a caller's wrong case still compares with what lsof says", (t) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "wtc-")));
	try {
		mkdirSync(join(dir, "WtA", "Sub"), { recursive: true });
		if (!statSyncOk(join(dir, "wta"))) return t.skip("this file system is case-sensitive");
		assert.equal(physical(join(dir, "wta", "sub")), join(dir, "WtA", "Sub"));
		assert.equal(physical(join(dir, "WTA", "gone")), join(dir, "WtA", "gone"), "a removed tail keeps the caller's text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("RV-F005: the last marker word of a row wins, so an argument that looks like the marker never beats the environment entry", () => {
	assert.equal(ownerOf(`/bin/sh -c echo ${OWNER_KEY}=victim PATH=/bin ${OWNER_KEY}=real`), "real");
	assert.equal(ownerOf(`/bin/sh -c echo ${OWNER_KEY}=victim PATH=/bin`), "victim", "argv alone is all ps shows for an Apple binary; the snapshot and cwd rules are the cover there");
	const map = parseOwnerRows(`  42 /bin/sh -c echo ${OWNER_KEY}=victim PATH=/bin ${OWNER_KEY}=real`, new Set([42]));
	assert.equal(map.get(42), "real");
	assert.equal(ownerOf(`${OWNER_KEY}=real ${OWNER_KEY}=${"x".repeat(80)}`), undefined, "the last one decides, and it is not an id");
});
