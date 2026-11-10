import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aclCommand, aclMarkerPath, aclProblems, folderProblems, parseAclOutput } from "../src/server/acl.ts";
import { launchCommand, parseLaunchOutput } from "../src/server/breakaway.ts";
import { cimCommand, parseCim } from "../src/server/lineage.ts";
import { startCommand } from "../src/startof.ts";
import { forgetSid, ownerGate, ownerSid, protectFolder, readDacl, runNative } from "../src/server/winprep.ts";

// Real icacls and PowerShell on a Windows runner (the windows workflow's win-acl job; runneradmin is elevated with UAC off, the condition of the U12 refusal). No server is started (the launch test starts a node child that ends after 3 s).
const win = process.platform === "win32";
const base = () => mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TEMP ?? ".", "sb-acl-"));
const icacls = (...args: string[]) => execFileSync("icacls.exe", args, { encoding: "utf8" });
const seeded = (name: string, ...extra: string[]) => {
	const dir = join(base(), name);
	mkdirSync(dir);
	icacls(dir, "/grant", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-11:(OI)(CI)M", ...extra);
	return dir;
};

test("protectFolder takes explicit BA and AU grants off a new and an existing folder", { skip: !win }, () => {
	forgetSid();
	const fresh = join(base(), "fresh");
	protectFolder(fresh);
	const sid = ownerSid();
	assert.deepEqual(folderProblems(readDacl(fresh, runNative), sid), []);
	const existing = seeded("existing");
	console.log(`before: ${readDacl(existing, runNative)}`);
	protectFolder(existing);
	assert.deepEqual(folderProblems(readDacl(existing, runNative), sid), []);
});

test("a deny ACE is still refused, and named", { skip: !win }, () => {
	forgetSid();
	const dir = seeded("deny", "/deny", "*S-1-5-32-545:(OI)(CI)W");
	assert.throws(() => protectFolder(dir), /ACE of type D/);
});

test("the server's PowerShell script leaves the seeded folder with the owner and SYSTEM only", { skip: !win }, () => {
	forgetSid();
	const dir = seeded("script");
	// The runner's shell is PowerShell 7: aclCommand itself must drop its PSModulePath, so this runs what production runs.
	const { file, args, options } = aclCommand(dir, process.env);
	const result = parseAclOutput(execFileSync(file, args, options));
	assert.deepEqual(aclProblems(result), []);
});

test("ownerGate closes an open folder of the user's", { skip: !win }, async () => {
	forgetSid();
	const dir = seeded("gate");
	await ownerGate(dir);
	assert.deepEqual(folderProblems(readDacl(dir, runNative), ownerSid()), []);
});

// Todo #132: the scripts of the start path call no module cmdlet; what replaced them runs here on a real Windows PowerShell 5.1 (the runner's shell is PowerShell 7, and the package starts 5.1 by its absolute path).
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** This process's start, as the clock says it: the WMI text is the same instant to within a few seconds. */
const ownStart = () => Date.now() - process.uptime() * 1000;
const near = (iso: string) => assert.ok(Math.abs(Date.parse(iso) - ownStart()) < 15_000, `${iso} is not near this process's start ${new Date(ownStart()).toISOString()}`);

test("#132: startCommand tells this process's start time through [wmisearcher] in the ISO text, and fails for a pid that is not there", { skip: !win }, () => {
	const own = startCommand(process.pid);
	const text = execFileSync(own.file, own.args, own.options).trim();
	assert.match(text, ISO);
	near(text);
	const gone = startCommand(2_147_483_000);
	assert.throws(() => execFileSync(gone.file, gone.args, { ...gone.options, stdio: "pipe" }));
});

test("#132: cimCommand lists every process with the same six columns, this process among them with its start time", { skip: !win }, () => {
	const { file, args, options } = cimCommand("sbrun-live");
	const procs = parseCim(execFileSync(file, args, options));
	assert.ok(procs.length > 20, `${procs.length} processes`);
	const me = procs.find((p) => p.pid === process.pid);
	assert.ok(me, "this process is in the table");
	assert.match(me.started ?? "", ISO);
	near(me.started!);
	assert.equal(me.ppid, process.ppid);
	assert.match(me.name, /^node(\.exe)?$/i);
	assert.equal(me.carries, false);
});

test("#132: the server's script answers this pid's start time, and refuses a junction below the folder before it changes anything", { skip: !win }, () => {
	forgetSid();
	const dir = seeded("started");
	const { file, args, options } = aclCommand(dir, process.env, 20_000, process.pid);
	const result = parseAclOutput(execFileSync(file, args, options));
	assert.match(result.started ?? "", ISO);
	near(result.started!);
	const target = join(base(), "target");
	mkdirSync(target);
	symlinkSync(target, join(dir, "junction"), "junction");
	const again = aclCommand(dir, process.env, 20_000, process.pid);
	assert.throws(() => execFileSync(again.file, again.args, { ...again.options, stdio: "pipe", encoding: "utf8" }), /sb-reparse-point/);
});

test("#132: the launch script makes the process through WMI, leaves the ACL check in the marker as JSON, and tells the starter's start time", { skip: !win }, () => {
	forgetSid();
	const dir = seeded("launch");
	const token = "0123456789abcdef0123456789abcdef";
	const spec = { command: process.execPath, args: ["-e", "setTimeout(() => {}, 3000)"], env: { ...process.env }, cwd: dir, options: { detached: true as const, stdio: "ignore" as const, windowsHide: true as const }, starterPid: process.pid, acl: { dir, token } };
	const { file, args, options } = launchCommand(spec, process.env);
	const answer = parseLaunchOutput(execFileSync(file, args, options));
	assert.ok(answer.pid > 0);
	assert.match(answer.starterStarted ?? "", ISO);
	near(answer.starterStarted!);
	assert.match(answer.started ?? "", ISO);
	const marker = JSON.parse(readFileSync(aclMarkerPath(dir, token), "utf8")) as { pid: number; error?: string; sid?: string; started?: string; dir?: string };
	assert.equal(marker.error, undefined);
	assert.equal(marker.pid, answer.pid);
	assert.match(marker.sid ?? "", /^S-1-/);
	assert.equal(marker.started, answer.started);
	assert.match(marker.dir ?? "", /^O:/);
});
