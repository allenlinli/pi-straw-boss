import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aclCommand, aclProblems, folderProblems, parseAclOutput } from "../src/server/acl.ts";
import { forgetSid, ownerGate, ownerSid, protectFolder, readDacl, runNative } from "../src/server/winprep.ts";

// Real icacls and PowerShell on a Windows runner (the windows workflow's win-acl job; runneradmin is elevated with UAC off, the condition of the U12 refusal). No server is started.
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
	const { file, args, options } = aclCommand(dir);
	const result = parseAclOutput(execFileSync(file, args, options));
	assert.deepEqual(aclProblems(result), []);
});

test("ownerGate closes an open folder of the user's", { skip: !win }, async () => {
	forgetSid();
	const dir = seeded("gate");
	await ownerGate(dir);
	assert.deepEqual(folderProblems(readDacl(dir, runNative), ownerSid()), []);
});
