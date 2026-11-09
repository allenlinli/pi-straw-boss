// @ts-nocheck: the plugin script is plain JavaScript.
// What differs on Windows: Herdr's socket is a named pipe behind a marker file, and the sb server's control socket is a named pipe. The pure parts are
// checked for every platform here; the live parts run on the platform the suite runs on (the Windows CI job runs this file).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, watch as fsWatch, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callControl, ControlError, listenControl, newSecret, PROTOCOL } from "../src/server/socket.ts";
import { instanceOf, localEndpoint as pluginEndpoint, socketCall } from "../herdr-plugin/net-view.mjs";
import { herdrSocket, localEndpoint } from "../src/endpoint.ts";
import { writeRecordFile } from "../src/handover.ts";
import { herdrCall } from "../src/herdr.ts";
import { cmdHidden } from "../src/hidden.ts";
import { listDirs, pickable } from "../src/spawn.ts";
import { createStartOf, READ_MS, startedLater, startOf } from "../src/startof.ts";
import { herdrEvents } from "../src/server-watch.ts";
import { answerFile, ensureDir, listRequests, readJson, requestFile, writeAtomic } from "../src/trust/files.ts";
import { digestOf } from "../src/trust/found.ts";

test("herdrSocket resolves the socket as Herdr does: HERDR_SOCKET_PATH, then HERDR_SESSION, in the config directory of the platform", () => {
	const win = String.raw`C:\Users\F\AppData\Roaming`;
	assert.equal(herdrSocket({ HERDR_SOCKET_PATH: "/s/h.sock", HERDR_SESSION: "work", HOME: "/h" }, "darwin"), "/s/h.sock");
	assert.equal(herdrSocket({ HOME: "/h" }, "darwin"), "/h/.config/herdr/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"), "/x/herdr/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "work" }, "linux"), "/h/.config/herdr/sessions/work/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "default" }, "linux"), "/h/.config/herdr/herdr.sock", "the default session is the default socket");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "a/b" }, "linux"), "/h/.config/herdr/herdr.sock", "Herdr ignores a name it would reject");
	assert.equal(herdrSocket({ APPDATA: win, HOME: "/h" }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(herdrSocket({ USERPROFILE: String.raw`C:\Users\F` }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(herdrSocket({ APPDATA: win, HERDR_SESSION: "work" }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\sessions\work\herdr.sock`);
	assert.equal(herdrSocket({ APPDATA: win, XDG_CONFIG_HOME: String.raw`D:\cfg` }, "win32"), String.raw`D:\cfg\herdr\herdr.sock`);
});

test("a client connects to the named pipe named by the socket path on Windows, and to the path itself elsewhere; the plugin agrees", () => {
	const path = String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`;
	assert.equal(localEndpoint(path, "win32"), String.raw`\\.\pipe\C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(localEndpoint("/h/.config/herdr/herdr.sock", "darwin"), "/h/.config/herdr/herdr.sock");
	for (const platform of ["win32", "linux", "darwin"] as const) assert.equal(pluginEndpoint(path, platform), localEndpoint(path, platform));
});

/** A fake Herdr on this platform's transport: on Windows the named pipe of the socket path and a marker file at the path, as Herdr makes them. */
async function fakeHerdr() {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-")), path = join(dir, "herdr.sock");
	const server = createServer((c) => {
		let text = "";
		c.on("data", (chunk) => {
			text += chunk;
			for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n")) {
				const request = JSON.parse(text.slice(0, at)) as { id: string; method: string };
				text = text.slice(at + 1);
				c.write(`${JSON.stringify({ id: request.id, result: request.method === "events.subscribe" ? { type: "subscription_started" } : { type: "pong" } })}\n`);
			}
		});
		c.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(localEndpoint(path), resolve));
	if (process.platform === "win32") writeFileSync(path, `${process.pid}:${Date.now()}`);
	return { path, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("the extension, its watch, and the plugin reach Herdr over this platform's transport, and the plugin names the server's run", async () => {
	const fake = await fakeHerdr();
	try {
		assert.deepEqual(await herdrCall(fake.path)("ping", {}), { type: "pong" });
		assert.deepEqual(await socketCall(fake.path)("ping", {}), { type: "pong" });
		const got: unknown[] = [];
		const stop = herdrEvents(fake.path, [10])(["pane.closed"], (event) => got.push(event));
		for (const end = Date.now() + 3000; got.length === 0 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
		stop();
		assert.deepEqual(got, [null], "the subscription was acknowledged");
		assert.match(instanceOf(fake.path), /^\d+:[\d.]+$/);
	} finally {
		fake.close();
	}
});

test("the server's control socket answers through the secret and proof on this platform, a squatter gets no request, and a closed one reads as no server", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-control-")), socket = process.platform === "win32" ? `\\\\.\\pipe\\straw-boss-${newSecret().slice(0, 32)}` : join(dir, "c.sock"), secret = newSecret();
	const control = await listenControl({ endpoint: socket, secret, hello: () => ({ pid: process.pid }), handle: (r) => ({ ok: true, echo: r.cmd }) });
	const refused = (failure: string) => (error: unknown) => error instanceof ControlError && error.failure === failure && !error.sent;
	try {
		assert.deepEqual((await callControl(socket, secret, { cmd: "status" }, 3000)).reply, { ok: true, echo: "status" });
		assert.equal((await callControl(socket, secret, undefined, 3000)).hello.pid, process.pid);
		await assert.rejects(callControl(socket, newSecret(), { cmd: "status" }, 3000), (error) => error instanceof ControlError && !error.sent, "a wrong secret gets no answer");
		await control.close();
		await assert.rejects(callControl(socket, secret, undefined, 3000), refused("no-server"));
		// A squatter on the freed name: it answers hello with no proof and records what else it is sent.
		const received: string[] = [];
		const squatter: Server = createServer((c) => c.setEncoding("utf8").on("data", (chunk: string) => (received.push(chunk), received.length === 1 && c.write(`${JSON.stringify({ ok: true, pid: process.pid })}\n`))).on("error", () => {}));
		await new Promise<void>((resolve) => squatter.listen(socket, resolve));
		try {
			await assert.rejects(callControl(socket, secret, { cmd: "send", message: "top secret" }, 3000), (error) => error instanceof ControlError && !error.sent);
			assert.equal(received.join("").includes("top secret"), false);
		} finally {
			squatter.close();
		}
	} finally {
		await control.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every module a Windows session loads links on this platform (a named import Windows lacks fails before any code runs)", async () => {
	for (const path of ["../src/index.ts", "../src/closing.ts", "../herdr-plugin/net-view.mjs"]) await import(path);
});

// The folder picker on a real Windows profile layout (src/hidden.ts): attributes set with attrib, junctions made as the old profile layout has them, and the
// default reader (cmd.exe) in between. The names are not the localised ones of a real profile, but a Chinese one is there to check the encoding.
test("the folder picker leaves out what Windows hides (Hidden or System, junctions among them) and keeps the other folders", { skip: process.platform !== "win32" }, async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-platform-home-")));
	try {
		for (const name of ["Desktop", "Documents", "AppData", "HiddenOnly", "SystemOnly", "\u9801\u9762", "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868"]) mkdirSync(join(home, name));
		symlinkSync(join(home, "Documents"), join(home, "My Documents"), "junction");
		symlinkSync(join(home, "Documents"), join(home, "Plain Link"), "junction");
		execFileSync("attrib", ["+h", join(home, "AppData")]);
		execFileSync("attrib", ["+h", join(home, "HiddenOnly")]);
		execFileSync("attrib", ["+s", join(home, "SystemOnly")]);
		execFileSync("attrib", ["+h", "+s", join(home, "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868")]);
		execFileSync("attrib", ["+h", "+s", "/L", join(home, "My Documents")]); // the junction itself, as the profile's compatibility links have it
		assert.deepEqual((await listDirs(home, home)).dirs.sort(), ["Desktop", "Documents", "Plain Link", "\u9801\u9762"].sort());
		for (const refused of ["AppData", "HiddenOnly", "SystemOnly", "My Documents", "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868"]) assert.equal(await pickable(join(home, refused), home), undefined, refused);
		for (const ok of ["Desktop", "Documents", "Plain Link", "\u9801\u9762"]) assert.ok(await pickable(join(home, ok), home), ok);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// The folder name reaches cmd.exe through an environment variable inside quotes: the characters cmd treats as syntax must stay text, and a folder that cannot be
// read must fail instead of reading as "nothing hidden".
test("the cmd reader takes a folder named with cmd's own syntax literally, and fails on one it cannot read", { skip: process.platform !== "win32" }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-platform-cmd-")));
	try {
		for (const name of ["a & b", "c ^ d", "100%", "%PATH%", "wow!", "paren)", "(open", "x & echo pwned & y"]) {
			const dir = join(root, name);
			mkdirSync(join(dir, "Hid"), { recursive: true });
			mkdirSync(join(dir, "Sys"));
			mkdirSync(join(dir, "Plain"));
			execFileSync("attrib", ["+h", join(dir, "Hid")]);
			execFileSync("attrib", ["+s", join(dir, "Sys")]);
			assert.deepEqual([...await cmdHidden(dir)].sort(), ["hid", "sys"], name);
		}
		assert.deepEqual([...await cmdHidden(root)], [], "no match is an empty answer");
		await assert.rejects(cmdHidden(join(root, "missing")), /could not say/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// S7: Windows has no `ps`, so a start time comes from PowerShell, in the background (one call took 2 to 3 s on the Windows 11 ARM VM). The ISO form is Windows-only; the rest holds on every platform.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
test("S7: this process's start time is known after the background read, the same on every call, and asking never waits on PowerShell", async () => {
	const t0 = Date.now(), first = startOf(process.pid);
	assert.ok(Date.now() - t0 < 500, "the first call returns at once (on Windows undefined, with the read going on in the background)");
	const known = await startedLater(process.pid);
	assert.ok(known, "startOf(process.pid) is defined once the read is in");
	assert.equal(startOf(process.pid), known);
	assert.equal(startOf(process.pid), known, "the same on two calls");
	if (first) assert.equal(first, known);
	if (process.platform === "win32") assert.match(known!, ISO);
	assert.equal(await startedLater(2 ** 22 + 1), undefined, "no such process");
});

test("S7: another process's start time is told, not earlier than this process's, and cached by PID", async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		const mine = await startedLater(process.pid), theirs = await startedLater(child.pid!);
		assert.ok(theirs, "a live process's start time");
		if (process.platform === "win32") assert.match(theirs!, ISO);
		assert.ok(Date.parse(/Z$/.test(theirs!) ? theirs! : `${theirs} UTC`) >= Date.parse(/Z$/.test(mine!) ? mine! : `${mine} UTC`) - 1000, "the child started after this process");
		assert.equal(startOf(child.pid!), theirs, "answered from the cache");
	} finally {
		child.kill();
	}
});

// R13e-F003: what the sb server's rule (client.ts probe, endLegacy) rests on, on a real Windows: a cold read of a fresh process's start time lands within READ_MS (the figure is logged: the rule's 3 s wait and its READ_MS
// are judged against it), a forgotten time is read again to the same value, a dead process has none, and the command the held words give ends a process with no window.
test("R13e-F003: a cold start-time read of a fresh child lands within READ_MS, is read again after forget, and `taskkill /F /PID` ends the child", { skip: process.platform !== "win32" }, async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
	const exited = new Promise((resolve) => child.once("exit", resolve));
	const times = createStartOf();
	try {
		const t0 = Date.now(), first = await times.startedLater(child.pid!), cold = Date.now() - t0;
		console.log(`cold start-time read: ${cold} ms (READ_MS ${READ_MS})`);
		assert.ok(first, "a fresh child has a start time");
		assert.match(first!, ISO);
		assert.ok(cold < READ_MS, `the cold read took ${cold} ms, not under READ_MS (${READ_MS})`);
		assert.equal(times.startOf(child.pid!), first, "answered from the cache");
		times.forget(child.pid!);
		const t1 = Date.now(), again = await times.startedLater(child.pid!);
		console.log(`re-read after forget: ${Date.now() - t1} ms`);
		assert.equal(again, first, "the same time when it is read again");
		// The words of a held server name this command: it must end a process that has no window.
		const killed = spawnSync("taskkill", ["/F", "/PID", String(child.pid)], { encoding: "utf8" });
		assert.equal(killed.status, 0, `${killed.stdout}${killed.stderr}`);
		await exited;
		times.forget(child.pid!);
		assert.equal(await times.startedLater(child.pid!), undefined, "a process that ended has no start time");
	} finally {
		child.kill();
	}
});

test("S7 (R1-F003): a protected process's (services.exe, lsass.exe) start time is told without elevation", { skip: process.platform !== "win32" }, async () => {
	const told: string[] = [];
	for (const image of ["services.exe", "lsass.exe"]) {
		const csv = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout, pid = Number(/^"[^"]*","(\d+)"/m.exec(csv)?.[1]);
		if (!pid) continue; // not listed to this user
		const started = await startedLater(pid);
		assert.ok(started, `${image} (${pid}) has a start time`);
		assert.match(started!, ISO);
		assert.equal(startOf(pid), started, "answered from the cache");
		told.push(image);
	}
	assert.ok(told.length > 0, "tasklist listed at least one of services.exe and lsass.exe");
});

// S4 on Windows: a rename onto a file that a reader has open can fail for a moment (EPERM, EBUSY); the writer tries again.
test("S4: gui.json is replaced by rename while another process reads it in a loop, and no read fails to parse", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-rename-"));
	try {
		const record = (port: number) => ({ pid: process.pid, port, token: "t".repeat(32), owner: "o" });
		writeRecordFile(dir, record(1));
		const reader = spawn(process.execPath, ["-e", `
			const { readFileSync } = require("node:fs");
			let reads = 0, bad = 0, stop = false;
			process.stdin.on("data", () => (stop = true));
			process.stdout.write("ready\\n");
			const loop = () => {
				for (let i = 0; i < 50; i++) { reads++; try { JSON.parse(readFileSync(process.argv[1], "utf8")); } catch { bad++; } }
				if (stop) return process.stdout.write(JSON.stringify({ reads, bad }) + "\\n", () => process.exit(0));
				setImmediate(loop);
			};
			loop();
		`, join(dir, "gui.json")], { stdio: ["pipe", "pipe", "inherit"] });
		let out = "";
		reader.stdout.on("data", (chunk) => (out += chunk));
		for (const end = Date.now() + 10_000; !out.includes("ready") && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
		for (let i = 0; i < 300; i++) writeRecordFile(dir, record(i));
		const done = new Promise<void>((resolve) => reader.on("exit", () => resolve()));
		reader.stdin.end("stop");
		await done;
		const { reads, bad } = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as { reads: number; bad: number };
		assert.ok(reads > 0);
		assert.equal(bad, 0);
		assert.deepEqual(readdirSync(dir), ["gui.json"], "no temporary file is left");
		assert.equal(existsSync(join(dir, "gui.json")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The project trust channel (src/trust/): request and answer files replaced by rename, found by watch or by stat, and a request whose start time is not known (Windows reads it in the background).
const TRUST_ID = "00000000-0000-4000-8000-000000000001";
const trustRequest = (over = {}) => ({ version: 1, id: TRUST_ID, pid: process.pid, herdr: "h", pane: "p1", role: "member", cwd: "/work/demo", at: 1, found: [], digest: digestOf("/work/demo", []), ...over });

test("trust: a request replaced by rename while another process reads it in a loop never fails to parse, and no temporary file is left", async () => {
	const dir = join(mkdtempSync(join(tmpdir(), "psb-platform-trust-")), "trust");
	try {
		assert.equal(ensureDir(dir), true);
		writeAtomic(dir, requestFile(TRUST_ID), trustRequest());
		const reader = spawn(process.execPath, ["-e", `
			const { readFileSync } = require("node:fs");
			let reads = 0, bad = 0, stop = false;
			process.stdin.on("data", () => (stop = true));
			process.stdout.write("ready\\n");
			const loop = () => {
				for (let i = 0; i < 50; i++) { reads++; try { JSON.parse(readFileSync(process.argv[1], "utf8")); } catch { bad++; } }
				if (stop) return process.stdout.write(JSON.stringify({ reads, bad }) + "\\n", () => process.exit(0));
				setImmediate(loop);
			};
			loop();
		`, join(dir, requestFile(TRUST_ID))], { stdio: ["pipe", "pipe", "inherit"] });
		let out = "";
		reader.stdout.on("data", (chunk) => (out += chunk));
		for (const end = Date.now() + 10_000; !out.includes("ready") && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
		for (let i = 0; i < 300; i++) writeAtomic(dir, requestFile(TRUST_ID), trustRequest({ at: i }));
		const done = new Promise<void>((resolve) => reader.on("exit", () => resolve()));
		reader.stdin.end("stop");
		await done;
		const { reads, bad } = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as { reads: number; bad: number };
		assert.ok(reads > 0);
		assert.equal(bad, 0);
		assert.deepEqual(readdirSync(dir), [requestFile(TRUST_ID)]);
	} finally {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	}
});

test("trust: an answer written by rename is seen within 1 s, by the directory watch or by the 500 ms stat the asking pi falls back to", async () => {
	const dir = join(mkdtempSync(join(tmpdir(), "psb-platform-trust-")), "trust");
	try {
		assert.equal(ensureDir(dir), true);
		let woke = false;
		const watcher = (() => { try { return fsWatch(dir, () => (woke = true)); } catch { return undefined; } })();
		const at = Date.now();
		writeAtomic(dir, answerFile(TRUST_ID), { version: 1, id: TRUST_ID, digest: "a".repeat(64), choice: "once", answerId: "a".repeat(20) });
		let seen: number | undefined;
		while (seen === undefined && Date.now() - at < 1000) {
			if (woke || readJson(join(dir, answerFile(TRUST_ID)))) seen = Date.now() - at;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		watcher?.close();
		assert.ok(seen !== undefined && seen < 1000, "seen within a second");
		assert.deepEqual(readJson(join(dir, answerFile(TRUST_ID)))?.value, { version: 1, id: TRUST_ID, digest: "a".repeat(64), choice: "once", answerId: "a".repeat(20) });
	} finally {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	}
});

test("trust: a request with no start time is judged by its PID alone, so a live process is listed and a dead one is not", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "psb-platform-trust-")), "trust");
	try {
		assert.equal(ensureDir(dir), true);
		writeAtomic(dir, requestFile(TRUST_ID), trustRequest());
		const dead = "00000000-0000-4000-8000-000000000002";
		writeAtomic(dir, requestFile(dead), trustRequest({ id: dead, pid: 2_000_000_000 }));
		assert.deepEqual(listRequests(dir).map((r) => r.id), [TRUST_ID]);
	} finally {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	}
});
