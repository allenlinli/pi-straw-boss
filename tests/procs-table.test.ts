import assert from "node:assert/strict";
import { test } from "node:test";
import { baseName, cpuSeconds, descendants, exeName, isOrphan, named, parsePs, programOf, PS_ARGS, readTable, refOf, sameProc, type Proc } from "../src/procs/table.ts";
import { classifyCwd, parseLsofCwd, readCwds } from "../src/procs/cwd.ts";

// The process table and the cwd reader: parsing ps and lsof output, identity by (pid, start time), and the orphan test.

const PS = [
	"    1     0     1     0 Ss   Mon Nov  3 08:00:00 2026    0:41.20 /sbin/launchd",
	"  500     1   500   501 S    Tue Nov  4 03:50:02 2026    0:00.05 /bin/sleep",
	"  501   500   500   501 Z    Tue Nov  4 03:50:03 2026    0:00.00 (sh)",
	"  777   600   777   501 R+   Tue Nov  4 03:51:00 2026 1-02:03:04 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"  800     1   800   502 S    Tue Nov  4 03:52:00 2026    0:01.00 /usr/sbin/other-user",
	"garbage line",
	"",
].join("\n");

test("parsePs reads pid, parent, group, state, start time, cpu time, and a program name with spaces; a zombie is marked; junk lines are dropped", () => {
	const table = parsePs(PS);
	assert.deepEqual(table.map((p) => p.pid), [1, 500, 501, 777, 800]);
	assert.deepEqual(table[1], { pid: 500, ppid: 1, pgid: 500, uid: 501, started: "Tue Nov  4 03:50:02 2026", cpu: 0.05, comm: "/bin/sleep", zombie: false });
	assert.equal(table[2]!.zombie, true);
	assert.equal(table[3]!.comm, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
	assert.equal(table[3]!.cpu, 86400 + 2 * 3600 + 3 * 60 + 4, "1-02:03:04 is a day, two hours, three minutes, four seconds");
});

test("cpuSeconds reads the Mac and Linux forms of the cpu time and refuses nonsense", () => {
	assert.equal(cpuSeconds("0:00.05"), 0.05);
	assert.equal(cpuSeconds("12:34.50"), 12 * 60 + 34.5);
	assert.equal(cpuSeconds("01:02:03"), 3723);
	assert.equal(cpuSeconds("2-00:00:01"), 2 * 86400 + 1);
	assert.equal(cpuSeconds("abc"), undefined);
});

test("baseName is the program without its folder, so output names a program and nothing else", () => {
	assert.equal(baseName("/bin/sleep"), "sleep");
	assert.equal(baseName("node"), "node");
	assert.equal(baseName("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "Google Chrome");
});

test("identity is (pid, start time): the same pid with another start time is another process", () => {
	const [, sleep] = parsePs(PS);
	assert.ok(sameProc(refOf(sleep!), { pid: 500, started: "Tue Nov  4 03:50:02 2026" }));
	assert.ok(!sameProc(refOf(sleep!), { pid: 500, started: "Tue Nov  4 09:00:00 2026" }));
	assert.ok(!sameProc(refOf(sleep!), { pid: 501, started: "Tue Nov  4 03:50:02 2026" }));
});

test("readTable asks ps in the C locale and keeps the account's own processes; it refuses a platform without ps", async () => {
	const calls: string[][] = [];
	const table = await readTable(async (file, args) => (calls.push([file, ...args]), PS), { uid: 501, platform: "darwin" });
	assert.deepEqual(table!.map((p) => p.pid), [500, 501, 777], "pid 1 is root's, pid 800 another account's");
	assert.deepEqual(calls, [["ps", ...PS_ARGS]]);
	assert.equal(await readTable(async () => PS, { uid: 501, platform: "win32" }), undefined);
	await assert.rejects(readTable(async () => { throw new Error("ps failed"); }, { uid: 501, platform: "linux" }), /ps failed/);
});

const P = (pid: number, ppid: number, over: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, uid: 501, started: `t${pid}`, cpu: 0, comm: "node", zombie: false, ...over });

test("isOrphan: a parent that is pid 1 or a subreaper; a live parent, or a parent of another account that the table lacks, is not", () => {
	assert.ok(isOrphan(P(10, 1), [123]));
	assert.ok(isOrphan(P(11, 123), [123]), "systemd --user adopts on Linux");
	assert.ok(!isOrphan(P(12, 10), [123]));
	assert.ok(!isOrphan(P(13, 9999), []), "a parent the table does not list (another account's) is not a dead parent");
});

test("descendants follow parent links down, once, without the roots and without looping on a bad table", () => {
	const table = [P(1, 0), P(2, 1), P(3, 2), P(4, 2), P(5, 4), P(6, 99), P(7, 7)];
	assert.deepEqual(descendants(table, [2]).map((p) => p.pid).sort(), [3, 4, 5]);
	assert.deepEqual(descendants(table, [7]).map((p) => p.pid), [], "a process that is its own parent has no descendants");
	assert.deepEqual(descendants(table, [3, 2]).map((p) => p.pid).sort(), [4, 5], "a root is never listed as a descendant, also when it is below another root");
});

test("parseLsofCwd reads the -Fpfni records of lsof into a path and an inode per pid, whatever order and extra pids come", () => {
	const text = "p500\nfcwd\ni828153092\nn/tmp/work tree\np501\nfcwd\ni12\nn/private/x\n";
	const map = parseLsofCwd(text);
	assert.deepEqual([...map], [[500, { path: "/tmp/work tree", inode: "828153092" }], [501, { path: "/private/x", inode: "12" }]]);
	assert.deepEqual([...parseLsofCwd("")], []);
	assert.deepEqual([...parseLsofCwd("p1\nfcwd\n")], [], "a record without a name says nothing");
});

test("readCwds on a Mac asks lsof for the candidates only, in chunks, and tolerates the missing pids; on Linux it reads the link and sees ' (deleted)'", async () => {
	const asked: string[] = [];
	const run = async (file: string, args: string[]) => (asked.push(`${file} ${args.join(" ")}`), "p5\nfcwd\ni1\nn/w\n");
	const pids = Array.from({ length: 450 }, (_, i) => i + 5);
	const map = await readCwds(pids, { run, platform: "darwin", readlink: () => { throw new Error("not used"); } });
	assert.equal(asked.length, 3, "chunks of 200");
	assert.ok(asked.every((line) => line.startsWith("lsof -a -d cwd -Fpfni -p ")));
	assert.deepEqual(map.get(5), { path: "/w", inode: "1" });
	const links = new Map([[7, "/work/tree"], [8, "/work/gone (deleted)"]]);
	const linux = await readCwds([7, 8, 9], { run: async () => "", platform: "linux", readlink: (pid) => { const v = links.get(pid); if (!v) throw Object.assign(new Error("x"), { code: "ENOENT" }); return v; } });
	assert.deepEqual([...linux], [[7, { path: "/work/tree" }], [8, { path: "/work/gone", deleted: true }]]);
});

test("classifyCwd: a deleted link, an absent path, and a path that now has another inode are removed; the same inode is present", () => {
	assert.equal(classifyCwd({ path: "/w", deleted: true }, "5"), "removed");
	assert.equal(classifyCwd({ path: "/w", inode: "5" }, null), "removed", "the path is not there");
	assert.equal(classifyCwd({ path: "/w", inode: "5" }, "6"), "removed", "recreated at the same path");
	assert.equal(classifyCwd({ path: "/w", inode: "5" }, "5"), "present");
	assert.equal(classifyCwd({ path: "/w" }, "6"), "present", "no inode to compare (Linux): the path is there");
});

test("RV-F003: lsof exits 1 with nothing printed when none of a chunk's pids exists: an empty answer for that chunk, the other chunks still answer; any other failure is thrown", async () => {
	const pids = Array.from({ length: 250 }, (_, i) => i + 5);
	const calls: string[] = [];
	const run = async (_file: string, args: string[]) => {
		calls.push(args.at(-1)!);
		if (calls.length === 1) throw Object.assign(new Error("Command failed"), { code: 1 });
		return "p205\nfcwd\ni1\nn/w\n";
	};
	const map = await readCwds(pids, { run, platform: "darwin", readlink: () => { throw new Error("not used"); } });
	assert.equal(calls.length, 2);
	assert.deepEqual([...map], [[205, { path: "/w", inode: "1" }]]);
	await assert.rejects(readCwds([5], { run: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); }, platform: "darwin" }), /timed out/);
});

test("readTable keeps every account's rows with `all` (the kill sequence's membership view) and the account's own by default", async () => {
	const ask = async () => ["  1 0 1 0 Ss Mon Nov  3 08:00:00 2026 0:41.20 /sbin/launchd", "  7 1 7 501 S Mon Nov  3 08:00:00 2026 0:00.00 node"].join("\n");
	assert.deepEqual((await readTable(ask, { uid: 501, platform: "darwin" }))!.map((p) => p.pid), [7]);
	assert.deepEqual((await readTable(ask, { uid: 501, platform: "darwin", all: true }))!.map((p) => p.pid), [1, 7]);
});

test("on Linux ps names a node process after its main thread: `named` gives a row its executable, which programOf shows; comm stays what ps said; readTable reads no link", async () => {
	const ask = async () => [
		"  1 0 1 0 Ss Mon Nov  3 08:00:00 2026 0:41.20 systemd",
		"  7 1 7 501 S Mon Nov  3 08:00:00 2026 0:01.00 MainThread",
		"  8 1 8 501 S Mon Nov  3 08:00:00 2026 0:01.00 MainThread",
		"  9 1 9 501 Z Mon Nov  3 08:00:00 2026 0:00.00 MainThread",
		" 10 1 10 501 S Mon Nov  3 08:00:00 2026 0:00.00 kworker",
		" 11 1 11 502 S Mon Nov  3 08:00:00 2026 0:00.00 MainThread",
		" 12 1 12 501 S Mon Nov  3 08:00:00 2026 0:00.00 sh",
	].join("\n");
	const links = new Map([[7, "/usr/local/bin/node"], [8, "/usr/bin/node (deleted)"], [9, "/usr/local/bin/node"], [11, "/usr/local/bin/node"], [12, "/usr/bin/bad\nname"]]);
	const asked: number[] = [];
	const readlink = (pid: number) => { asked.push(pid); const v = links.get(pid); if (!v) throw Object.assign(new Error("x"), { code: "ENOENT" }); return v; };
	const table = (await readTable(ask, { uid: 501, platform: "linux", all: true }))!;
	assert.ok(table.every((p) => p.exe === undefined), "the table read names nothing: the tick pays no readlink");
	const by = new Map(table.map((p) => [p.pid, p]));
	const show = (pid: number) => named(by.get(pid)!, { uid: 501, platform: "linux", readlink });
	const seven = show(7);
	assert.deepEqual([seven.comm, seven.exe, programOf(seven)], ["MainThread", "node", "node"]);
	assert.equal(show(8).exe, "node", "a replaced file still names the program");
	assert.deepEqual([9, 10, 11, 12].map((pid) => programOf(show(pid))), ["MainThread", "kworker", "MainThread", "sh"], "a zombie, an unreadable link, another account's row, and a name with a control character keep comm");
	assert.deepEqual(asked.sort((a, b) => a - b), [7, 8, 10, 12], "only the account's own live rows are looked up, and only when asked");
	assert.equal(named(by.get(7)!, { uid: 501, platform: "darwin", readlink: () => { throw new Error("not used"); } }).exe, undefined, "off Linux the link is never read");
});

test("exeName and programOf: a link's file name without ' (deleted)', refused with a control character; the path's last part of comm where there is no exe", () => {
	assert.equal(exeName("/usr/local/bin/node"), "node");
	assert.equal(exeName("/opt/my app/bin/node (deleted)"), "node");
	assert.equal(exeName("/usr/bin/a\u001b[2Jb"), undefined);
	assert.equal(exeName(""), undefined);
	assert.equal(programOf({ comm: "/bin/sleep" }), "sleep");
	assert.equal(programOf({ comm: "MainThread", exe: "node" }), "node");
});
