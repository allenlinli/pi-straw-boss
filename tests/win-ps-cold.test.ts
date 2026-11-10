import assert from "node:assert/strict";
import { test } from "node:test";
import { ACL_SCRIPT, START_FORMAT, START_OF_PS, TO_JSON_PS } from "../src/server/acl.ts";
import { LAUNCH_SCRIPT } from "../src/server/breakaway.ts";
import { cimCommand } from "../src/server/lineage.ts";
import { startCommand } from "../src/startof.ts";

// Todo #132: a fresh Windows PowerShell 5.1 builds its module analysis cache for the first cmdlet of a module it meets (Get-CimInstance, Add-Type, New-Object, Get-Process: 41 to 48 s on a cold
// windows-11-arm runner), and the server's hello waits 60 s for it. A script of the package that is on the start path calls none; Windows CI runs them (the `win-acl` job and the desk's wizard).
const SCRIPTS: [string, string][] = [
	["ACL_SCRIPT", ACL_SCRIPT],
	["LAUNCH_SCRIPT", LAUNCH_SCRIPT],
	["startCommand", startCommand(4242).args.at(-1)!],
	["cimCommand", cimCommand("abc").args.at(-1)!],
];
/** `Verb-Noun` words of a script: a cmdlet is named so (a parameter has no capital before its hyphen; the scripts' own words, `sb-reparse-point`, are lowercase). */
const cmdlets = (script: string) => [...new Set(script.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g) ?? [])].sort();
/** PowerShell's core cmdlets are in the session from its first instruction; no module is loaded for them. */
const CORE = ["ForEach-Object", "Out-Null", "Where-Object"];

test("#132: no script on the start path calls a cmdlet of a module before it needs one (the first costs 41 to 48 s cold)", () => {
	for (const [name, script] of SCRIPTS) {
		const found = cmdlets(script).filter((word) => !CORE.includes(word));
		// `Get-Item` is the walk's last resort when a reparse point's `LinkType` is not on the .NET object: a link or junction is refused, never read as an ordinary entry, and a walk with none below the folder never reaches it.
		const allowed = name === "ACL_SCRIPT" || name === "LAUNCH_SCRIPT" ? ["Get-Item"] : [];
		assert.deepEqual(found, allowed, `${name} calls ${found.join(", ")}`);
	}
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) {
		assert.equal(script.match(/Get-Item/g)?.length, 1);
		assert.match(script, /if \(\$info\.PSObject\.Properties\['LinkType'\]\) \{ \$kind = \$info\.LinkType \} else \{ \$kind = \(Get-Item -LiteralPath \$e -Force -ErrorAction Stop\)\.LinkType \}/);
	}
});

test("#132: the word of every module cmdlet the scripts used to call is gone (a fixed list, so a new word in cmdlets() cannot hide one)", () => {
	const banned = /\b(?:Get-CimInstance|Get-WmiObject|Get-Process|Add-Type|New-Object|Get-Acl|Test-Path|Join-Path|ConvertTo-Json|Write-Output|Remove-Item|Sort-Object|Select-Object)\b/;
	for (const [name, script] of SCRIPTS) assert.ok(!banned.test(script), `${name}: ${banned.exec(script)?.[0]}`);
});

test("#132: a process's start time is one WMI query through [wmisearcher], in the text Get-CimInstance gave (UTC, ISO 8601, milliseconds)", () => {
	assert.equal(START_FORMAT, "yyyy-MM-ddTHH:mm:ss.fffZ");
	assert.match(START_OF_PS, /^function StartOf\(\$p\) \{ \$s = \[wmisearcher\]\('SELECT CreationDate FROM Win32_Process WHERE ProcessId=' \+ \[int\]\$p\);/);
	assert.match(START_OF_PS, /\[System\.Management\.ManagementDateTimeConverter\]::ToDateTime\(\[string\]\$o\['CreationDate'\]\)\.ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ss\.fffZ', \[cultureinfo\]::InvariantCulture\)/);
	assert.match(START_OF_PS, /throw 'no such process' \}$/, "no such process is an error, as the null CreationDate of an empty answer was");
	const own = startCommand(4242).args.at(-1)!;
	assert.ok(own.endsWith(`${START_OF_PS}; StartOf 4242`), own);
	assert.match(ACL_SCRIPT, /try \{ \$started = StartOf \(\$env:SB_ACL_PID -as \[int\]\) \} catch \{ \}/);
	assert.match(LAUNCH_SCRIPT, /try \{ \$starterStarted = StartOf \(\[int\]\$env:SB_STARTER_PID\) \} catch \{ \}/);
	for (const script of [ACL_SCRIPT, LAUNCH_SCRIPT]) assert.ok(script.split("\n").includes(START_OF_PS), "the function is defined once, at the top level");
});

test("#132: the process table is one [wmisearcher] query that reads the same six columns", () => {
	const cim = cimCommand("abc").args.at(-1)!;
	assert.match(cim, /\[wmisearcher\]'SELECT ProcessId,ParentProcessId,CreationDate,Name,CommandLine FROM Win32_Process'\)\.Get\(\)/);
	assert.match(cim, /\(@\(\$o\['ProcessId'\],\$o\['ParentProcessId'\],\$d,\$o\['Name'\],\$c,\$q\) -join \[char\]9\)/);
	assert.match(cim, /\$cl=\[string\]\$o\['CommandLine'\]; \$c='0'; if \(\$cl\.Contains\('--sb-run ' \+ \$id\)\) \{ \$c='1' \}/, "a process with no command line is not a match and not an error");
});

test("#132: the JSON the scripts print is written by a function, with the string escapes JSON.parse reads back, and the answer is still ASCII-escaped", () => {
	assert.match(ACL_SCRIPT, /\$json = ToJson \$out\n\[regex\]::Replace\(\$json, /);
	assert.ok(ACL_SCRIPT.includes(TO_JSON_PS) && LAUNCH_SCRIPT.includes(TO_JSON_PS));
	assert.match(TO_JSON_PS, /\.Replace\('\\', '\\\\'\)\.Replace\('"', '\\"'\)/, "a backslash (every Windows path has them) and a quote");
	assert.match(TO_JSON_PS, /'\[\\x00-\\x1F\]'/, "a control character (an error text has a line break) becomes \\u00XX");
	for (const shape of ["'null'", "'true'", "'false'", "[System.Collections.IDictionary]", "[System.Collections.IEnumerable]"]) assert.ok(TO_JSON_PS.includes(shape), shape);
	assert.match(LAUNCH_SCRIPT, /\$mj = ToJson \$m\n\s+\$mj = \[regex\]::Replace\(\$mj, /);
});
