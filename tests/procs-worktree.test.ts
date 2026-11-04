import assert from "node:assert/strict";
import { test } from "node:test";
import { checkoutOf, rootOfRemoved, under, type Disk } from "../src/procs/worktree.ts";
import { OWNER_KEY, ownerOf, parseOwnerRows, readOwners, setOwner } from "../src/procs/marker.ts";

// Which checkout a working folder is in (a linked worktree is a `.git` file that points into `<repo>/.git/worktrees/`), and the owner marker that a process carries in its environment.

const disk = (entries: Record<string, string | "dir">): Disk => ({
	kind: (path) => (path in entries ? (entries[path] === "dir" ? "dir" : "file") : undefined),
	read: (path) => (typeof entries[path] === "string" && entries[path] !== "dir" ? entries[path] : undefined),
});

const fs = disk({
	"/repo/.git": "dir",
	"/wt/feat-x/.git": "gitdir: /repo/.git/worktrees/feat-x\n",
	"/repo/sub/.git": "gitdir: /repo/.git/modules/sub\n",
	"/bare-wt/.git": "gitdir: /srv/bare.git/worktrees/w1",
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
