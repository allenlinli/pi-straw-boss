import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ACL_SCRIPT, folderProblems } from "../src/server/acl.ts";
import { removeArgs, strayGrants } from "../src/server/strays.ts";
import { OWNER_READ_RETRY_MS, forgetSid, ownerGate, protectArgs, protectFolder, setNote } from "../src/server/winprep.ts";
import { ServerWorld } from "./server-world.ts";

// An elevated token (a GitHub windows runner's runneradmin) makes folders that carry explicit ACEs of other accounts (BUILTIN\Administrators). `/inheritance:r` removes the inherited ACEs and
// `/grant:r` replaces only the grants it names, so an explicit BA ACE (and any other explicit one) stayed and the strict check refused the folder (exit 3, "grants … BA").
// The fake icacls here keeps a DACL that the calls change: protect, then `/remove:g`, as icacls does.

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const GOOD = `D:P(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;SY)`;
const ELEVATED = `D:P(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICIIO;0x1200a9;;;AU)`;
const OPEN = "D:PAI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)";
let world: ServerWorld;
beforeEach(() => {
	world = new ServerWorld();
	forgetSid();
});
afterEach(() => world.close());

interface Fake { start: string; afterProtect: string; afterRemove: string }
function icacls(over: Fake) {
	let dacl = over.start;
	const calls: string[][] = [];
	const run = (file: string, args: string[]) => {
		calls.push([file, ...args]);
		if (file === "whoami.exe") return `"PC\\runneradmin","${OWNER}"\r\n`;
		if (file.endsWith("powershell.exe")) return `${OWNER}\r\n`;
		if (args.includes("/inheritance:r")) dacl = over.afterProtect;
		else if (args.includes("/remove:g")) dacl = over.afterRemove;
		else if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${dacl}\r\n`, "utf16le")]));
		return "";
	};
	return { run, calls, steps: () => calls.map((c) => (c[0]!.endsWith("powershell.exe") ? "powershell" : c[0] === "whoami.exe" ? "whoami" : c.includes("/inheritance:r") ? "protect" : c.includes("/remove:g") ? "remove" : c.includes("/save") ? "save" : "other")) };
}
const STRAYS = ["S-1-5-32-544", "S-1-5-32-545", "S-1-5-11"];

test("strayGrants resolves OW, AC, RA and the other fixed well-known aliases", () => {
	assert.deepEqual(strayGrants(`D:P(A;;FA;;;${OWNER})(A;;FA;;;SY)(A;;FA;;;OW)(A;;FA;;;AC)(A;;FA;;;RA)`, OWNER), ["S-1-3-4", "S-1-15-2-1", "S-1-5-32-575"]);
});

test("strayGrants names every explicit allow ACE that is neither the owner nor SYSTEM, by SID (aliases resolved), and only those", () => {
	assert.deepEqual(strayGrants(ELEVATED, OWNER), STRAYS);
	assert.deepEqual(strayGrants(GOOD, OWNER), []);
	assert.deepEqual(strayGrants(`D:P(A;OICI;FA;;;S-1-5-32-544)(A;;FA;;;${OWNER})(A;;FA;;;S-1-5-32-544)(A;;FA;;;WD)`, OWNER), ["S-1-5-32-544", "S-1-1-0"], "listed once, whatever the spelling");
	assert.deepEqual(strayGrants(`D:P(A;;FA;;;${OWNER.toLowerCase()})(A;;FA;;;SY)`, OWNER), [], "the owner's SID in any case is the owner");
	assert.deepEqual(strayGrants("D:PAI(A;OICIID;FA;;;BA)", OWNER), [], "an inherited ACE cannot be removed here; the check refuses it");
	assert.deepEqual(strayGrants(`D:P(D;;FA;;;BU)(A;;FA;;;${OWNER})`, OWNER), [], "a deny ACE is not a grant; the check refuses it");
	assert.deepEqual(strayGrants("D:P(A;;FA;;;ZZ)(A;;FA;;;DA)", OWNER), [], "an alias that has no fixed SID stays for the check to refuse");
	assert.deepEqual(strayGrants("not an sddl", OWNER), [], "an SDDL that cannot be read is the check's to refuse");
	assert.deepEqual(strayGrants("D:NO_ACCESS_CONTROL", OWNER), []);
});

test("removeArgs takes the grants off by SID with /L, not by a localized name; the protect call is unchanged", () => {
	assert.deepEqual(removeArgs("C:\\s", STRAYS), ["C:\\s", "/remove:g", "*S-1-5-32-544", "*S-1-5-32-545", "*S-1-5-11", "/L"]);
	assert.deepEqual(protectArgs("C:\\s", OWNER), ["C:\\s", "/inheritance:r", "/grant:r", `*${OWNER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L"]);
});

test("the check itself is as strict as before: BA, Users and Authenticated Users are still refused by folderProblems", () => {
	const problems = folderProblems(ELEVATED, OWNER);
	for (const sid of ["BA", "BU", "AU"]) assert.ok(problems.some((p) => p.includes(`grants ${sid},`)), sid);
	assert.deepEqual(folderProblems(GOOD, OWNER), []);
});

test("a new folder made by an elevated token: protect, read, the stray grants removed by SID, read again; the folder is accepted", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: GOOD });
	protectFolder(dir, n.run);
	assert.deepEqual(n.steps(), ["whoami", "protect", "save", "remove", "save"]);
	const remove = n.calls.find((c) => c.includes("/remove:g"))!;
	assert.deepEqual(remove.slice(2), ["/remove:g", ...STRAYS.map((s) => `*${s}`), "/L"]);
	assert.ok(!remove.includes(`*${OWNER}`) && !remove.includes("*S-1-5-18"), "the owner and SYSTEM keep theirs");
});

test("an existing folder with a wrong DACL (an elevated run's) is closed the same way", () => {
	const dir = join(world.root, "existing");
	mkdirSync(dir);
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: GOOD });
	protectFolder(dir, n.run);
	assert.deepEqual(n.steps(), ["whoami", "save", "powershell", "protect", "save", "remove", "save"]);
});

test("a folder with nothing stray gets no remove call, and the calls are the ones there always were", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = icacls({ start: OPEN, afterProtect: GOOD, afterRemove: GOOD });
	protectFolder(dir, n.run);
	assert.deepEqual(n.steps(), ["whoami", "protect", "save"]);
});

test("a folder that cannot be shut stays refused: the grants are still there after the remove call", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: ELEVATED });
	assert.throws(() => protectFolder(dir, n.run), /the folder grants BA, who is neither the owner nor SYSTEM/);
	assert.deepEqual(n.steps(), ["whoami", "protect", "save", "remove", "save"], "one remove call, not a retry loop");
});

test("what is not a grant is not removed and is refused: a deny ACE, an alias without a fixed SID, a grant that stays after the remove call", () => {
	for (const [what, dacl, pattern] of [
		["a deny ACE", `D:P(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;SY)(D;OICI;FA;;;BU)`, /ACE of type D for BU/],
		["a domain-relative alias", `D:P(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;SY)(A;OICI;FA;;;DA)`, /grants DA, who is neither/],
		["an extra ACE of the owner", `D:P(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;${OWNER})`, /3 ACEs, not 2/],
	] as const) {
		forgetSid();
		const dir = join(world.root, `refused-${what.replace(/ /g, "-")}`, "straw-boss");
		const n = icacls({ start: OPEN, afterProtect: dacl, afterRemove: dacl });
		assert.throws(() => protectFolder(dir, n.run), pattern, what);
		assert.ok(!n.steps().includes("remove"), `${what}: nothing to remove by SID`);
	}
});

test("an open folder the gate shuts (the owner is the user) has its stray grants removed, is remembered, and costs no call at the next look", async () => {
	const dir = join(world.root, "open");
	mkdirSync(dir);
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: GOOD });
	assert.equal(await ownerGate(dir, n.run), true);
	assert.deepEqual(n.steps(), ["whoami", "powershell", "save", "protect", "save", "remove", "save"]);
	const before = n.calls.length;
	assert.equal(await ownerGate(dir, n.run), false);
	assert.equal(n.calls.length, before, "remembered as closed");
});

test("an open folder whose stray grants cannot be removed stays open: told once, read again later, never remembered", async () => {
	const dir = join(world.root, "stuck");
	mkdirSync(dir);
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: ELEVATED });
	await ownerGate(dir, n.run, undefined, () => 0);
	const calls = n.calls.length;
	await ownerGate(dir, n.run, undefined, () => 1000);
	assert.equal(n.calls.length, calls, "inside the retry window nothing is called");
	const notes: string[] = [];
	setNote((text) => notes.push(text));
	try {
		await ownerGate(dir, n.run, undefined, () => OWNER_READ_RETRY_MS + 1);
	} finally {
		setNote(undefined);
	}
	assert.ok(n.calls.length > calls, "after the retry window the folder is judged again: it was never remembered");
	assert.equal(notes.length, 0, "told once, at the first failure");
});

test("the server's PowerShell script takes the other explicit grants off the folder by SID, after the protect call and before the reset of what is below", () => {
	const lines = ACL_SCRIPT.split("\n");
	const protect = lines.findIndex((l) => l.includes("/inheritance:r")), strays = lines.findIndex((l) => l.includes("$strays = ")), remove = lines.findIndex((l) => l.includes("/remove:g")), reset = lines.findIndex((l) => l.includes("/reset /T"));
	assert.ok(protect >= 0 && protect < strays && strays <= remove && remove < reset, `${protect} ${strays} ${remove} ${reset}`);
	assert.match(lines[strays + 1]!, /GetAccessRules\(\$true, \$false, \[Security\.Principal\.SecurityIdentifier\]\)/, "explicit rules, as SIDs");
	assert.match(lines[strays + 1]!, /\$who -ne \$sid -and \$who -ne 'S-1-5-18'/, "all but the owner and SYSTEM");
	assert.match(lines[remove - 1]!, /'\*' \+ \$stray/, "by SID with the * prefix, so a localized group name cannot matter");
	assert.match(lines[remove]!, /\$LASTEXITCODE -ne 0/);
});

test("the folder swapped for a link during the remove call is refused (the link is looked at again after the remove)", () => {
	const dir = join(world.root, "swapped-link");
	mkdirSync(dir);
	const elsewhere = join(world.root, "elsewhere");
	mkdirSync(elsewhere);
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: GOOD });
	const run = (file: string, args: string[]) => {
		const out = n.run(file, args);
		if (args.includes("/remove:g")) {
			rmdirSync(dir);
			symlinkSync(elsewhere, dir, "dir");
		}
		return out;
	};
	assert.throws(() => protectFolder(dir, run), /link or junction/);
});

test("the folder replaced by another after the last read-back is refused", () => {
	const dir = join(world.root, "swapped-folder");
	mkdirSync(dir);
	const other = join(world.root, "other");
	mkdirSync(other);
	const n = icacls({ start: OPEN, afterProtect: ELEVATED, afterRemove: GOOD });
	let saves = 0;
	const run = (file: string, args: string[]) => {
		const out = n.run(file, args);
		if (args.includes("/save") && ++saves === 3) {
			renameSync(dir, join(world.root, "moved"));
			renameSync(other, dir);
		}
		return out;
	};
	assert.throws(() => protectFolder(dir, run), /replaced while it was protected/);
});

test("the server's PowerShell script lists only Allow rules, as the Node path does", () => {
	const line = ACL_SCRIPT.split("\n").find((l) => l.includes("GetAccessRules"))!;
	assert.match(line, /if \(\$rule\.AccessControlType -eq 'Allow'\)/);
});
