import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Gui, startGui } from "../src/gui.ts";
import type { Net } from "../src/net.ts";

// The music folder's route (src/music.ts, wired in src/gui.ts): GET /api/music lists the audio files of one folder, GET /api/music/<file> streams one with range requests. It sits behind the same token, Host, and
// paired-device checks as every other /api read; nothing outside the folder, no other type, and no link that leaves the folder is served.
const scratch = mkdtempSync(join(tmpdir(), "psb-music-test-"));
const bundle = join(scratch, "bundle"), music = join(scratch, "music"), outside = join(scratch, "outside");
for (const d of [bundle, music, outside, join(music, "sub"), join(music, "folder.mp3")]) mkdirSync(d, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const BYTES = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"); // 36 bytes: easy to slice by eye
const files: Record<string, string> = { "b-rain.mp3": "audio/mpeg", "a-bowl.M4A": "audio/mp4", "c-sea.ogg": "audio/ogg", "d-wind.wav": "audio/wav", "e-fire.flac": "audio/flac", "f-moon.opus": "audio/ogg", "g-tide.aac": "audio/aac", "Ünï code 音樂.mp3": "audio/mpeg" };
for (const name of Object.keys(files)) writeFileSync(join(music, name), BYTES);
for (const name of ["notes.txt", "page.html", "pic.svg", "a.mp3.html", "script.js", ".hidden.mp3", "._apple.mp3", "empty.mp3"]) writeFileSync(join(music, name), name === "empty.mp3" ? "" : "<script>1</script>");
writeFileSync(join(music, "sub", "inner.mp3"), BYTES);
writeFileSync(join(outside, "stolen.mp3"), "STOLEN-MP3");
writeFileSync(join(scratch, "secret.txt"), "outside the music folder");
symlinkSync(join(outside, "stolen.mp3"), join(music, "link-out.mp3")); // a link that leaves the folder
symlinkSync(outside, join(music, "linkdir")); // a folder link that leaves it
symlinkSync(join(music, "b-rain.mp3"), join(music, "link-in.mp3")); // a link that stays in
symlinkSync(join(scratch, "nowhere.mp3"), join(music, "dangling.mp3"));

const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});
const net: Net = { bases: [{ id: "w", label: "a", mark: "idle", head: true, tower: null, tabs: [], outposts: [], outside: [] }] };
async function serve(options: { music?: string } = {}) {
	const gui = await startGui({ read: async () => net, dir: bundle, pollMs: 20, pingMs: 50, ...options });
	running.push(gui);
	return gui;
}
interface Got { status: number; headers: Record<string, string | string[] | undefined>; bytes: Buffer }
const get = (gui: Gui, path: string, o: { port?: number; method?: string; headers?: Record<string, string> } = {}) =>
	new Promise<Got>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: o.port ?? gui.port, path, method: o.method ?? "GET", agent: false, headers: { host: `127.0.0.1:${gui.port}`, ...o.headers } }, (res) => {
			const parts: Buffer[] = [];
			res.on("data", (c: Buffer) => parts.push(c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(parts) }));
		});
		req.on("error", reject).end();
	});
const names = (r: Got) => (JSON.parse(r.bytes.toString("utf8")) as { tracks: { file: string; size: number }[] }).tracks.map((t) => t.file);

test("the list holds the audio files of the folder, sorted, with their sizes, and nothing else", async () => {
	const gui = await serve({ music });
	const r = await get(gui, `/${gui.token}/api/music`);
	assert.deepEqual([r.status, r.headers["content-type"], r.headers["cache-control"]], [200, "application/json", "no-store"]);
	const tracks = (JSON.parse(r.bytes.toString("utf8")) as { tracks: { file: string; size: number }[] }).tracks;
	assert.deepEqual(tracks.map((t) => t.file), ["a-bowl.M4A", "b-rain.mp3", "c-sea.ogg", "d-wind.wav", "e-fire.flac", "f-moon.opus", "g-tide.aac", "link-in.mp3", "Ünï code 音樂.mp3"].sort((a, b) => a.localeCompare(b, "en", { numeric: true })), "audio extensions in any case; no text, html, svg, script, hidden, AppleDouble, empty, folder, or leaving link");
	assert.ok(tracks.every((t) => t.size === BYTES.length));
});

test("no folder, a folder that does not exist, and an empty one list nothing; a file is a 404", async () => {
	const none = await serve();
	assert.deepEqual(names(await get(none, `/${none.token}/api/music`)), []);
	assert.equal((await get(none, `/${none.token}/api/music/b-rain.mp3`)).status, 404);
	const missing = await serve({ music: join(scratch, "no-such-folder") });
	assert.deepEqual(names(await get(missing, `/${missing.token}/api/music`)), []);
	assert.equal((await get(missing, `/${missing.token}/api/music/b-rain.mp3`)).status, 404);
	const empty = join(scratch, "empty-music");
	mkdirSync(empty);
	const quiet = await serve({ music: empty });
	assert.deepEqual(names(await get(quiet, `/${quiet.token}/api/music`)), []);
});

test("a file streams whole with its type, length, and range support; the type follows the extension", async () => {
	const gui = await serve({ music });
	for (const [name, type] of Object.entries(files)) {
		const r = await get(gui, `/${gui.token}/api/music/${encodeURIComponent(name)}`);
		assert.deepEqual([r.status, r.headers["content-type"], r.headers["content-length"], r.headers["accept-ranges"], r.headers["x-content-type-options"]], [200, type, String(BYTES.length), "bytes", "nosniff"], name);
		assert.deepEqual(r.bytes, BYTES, name);
	}
	assert.deepEqual((await get(gui, `/${gui.token}/api/music/link-in.mp3`)).bytes, BYTES, "a link that stays in the folder is the file it points to");
});

test("range requests answer 206 with the slice, clamp the end, and refuse a start past the end with 416", async () => {
	const gui = await serve({ music }), path = `/${gui.token}/api/music/b-rain.mp3`, size = BYTES.length;
	const ask = (range: string) => get(gui, path, { headers: { range } });
	const slice = async (range: string, from: number, to: number) => {
		const r = await ask(range);
		assert.deepEqual([r.status, r.headers["content-range"], r.headers["content-length"], r.bytes.toString("utf8")], [206, `bytes ${from}-${to}/${size}`, String(to - from + 1), BYTES.subarray(from, to + 1).toString("utf8")], range);
		assert.equal(r.headers["accept-ranges"], "bytes");
		assert.equal(r.headers["content-type"], "audio/mpeg");
	};
	await slice("bytes=2-5", 2, 5);
	await slice("bytes=0-0", 0, 0);
	await slice("bytes=30-", 30, size - 1);
	await slice("bytes=-4", size - 4, size - 1);
	await slice("bytes=30-9999", 30, size - 1);
	await slice("bytes=-9999", 0, size - 1);
	await slice(`bytes=${size - 1}-${size - 1}`, size - 1, size - 1);
	for (const range of [`bytes=${size}-`, `bytes=${size + 5}-${size + 9}`, "bytes=-0"]) {
		const r = await ask(range);
		assert.deepEqual([r.status, r.headers["content-range"]], [416, `bytes */${size}`], range);
	}
	for (const range of ["bytes=5-2", "bytes=abc", "items=1-2", "bytes=1-2,4-5", "bytes=", "bytes=--3"]) {
		const r = await ask(range);
		assert.deepEqual([r.status, r.bytes.length], [200, size], `${range}: not a range this route answers, so the whole file`);
	}
});

test("nothing outside the folder is served: traversal, absolute and encoded paths, sub folders, and every spelling of a name the folder does not hold", async () => {
	const gui = await serve({ music }), t = `/${gui.token}/api/music/`;
	const spellings = ["..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "%2E%2E/secret.txt", "..%5Csecret.txt", "..%2F..%2Fsecret.txt", "%2Fetc%2Fpasswd", "sub%2Finner.mp3", "sub/inner.mp3", "linkdir%2Fstolen.mp3", "linkdir/stolen.mp3", "b-rain.mp3%00.txt", "b-rain.mp3%00", "..", "%2e%2e", "", "b-rain.mp3/", "B-RAIN.MP3", "b-rain.mp3%20", "%E0%A4%A", "folder.mp3", "sub", "..%2Fmusic%2Fb-rain.mp3", "C%3A%5Cwindows%5Cwin.ini", "%5C%5Cserver%5Cshare%5Cb-rain.mp3"];
	for (const s of spellings) {
		const r = await get(gui, t + s);
		const body = r.bytes.toString("utf8");
		assert.ok(!body.includes("outside the music folder") && !body.includes("STOLEN-MP3") && !body.includes("root:"), `${s} leaked`);
		if (s === "") {
			assert.deepEqual([r.status, r.headers["content-type"]], [200, "application/json"], "the bare route is the list, which holds no file's bytes");
			continue;
		}
		assert.ok(r.status === 404 || r.status === 403, `${s}: ${r.status}`);
	}
	// A raw request path that climbs out before the token is nobody's route.
	for (const raw of [`/${gui.token}/api/music/../../secret.txt`, `/${gui.token}/api/music/%2e%2e/%2e%2e/secret.txt`]) assert.notEqual((await get(gui, raw)).bytes.toString("utf8"), "outside the music folder", raw);
});

test("a link that leaves the folder, a dangling one, and a file of another type are not served, even by name", async () => {
	const gui = await serve({ music }), t = `/${gui.token}/api/music/`;
	for (const name of ["link-out.mp3", "linkdir", "dangling.mp3", "notes.txt", "page.html", "pic.svg", "a.mp3.html", "script.js", ".hidden.mp3", "._apple.mp3", "empty.mp3"]) assert.equal((await get(gui, t + encodeURIComponent(name))).status, 404, name);
	assert.equal((await get(gui, t + "link-out.mp3", { headers: { range: "bytes=0-3" } })).status, 404, "a range changes nothing");
});

test("the same checks as every other read: the token, the Host, and a method that reads", async () => {
	const gui = await serve({ music });
	for (const path of ["/api/music", "/api/music/b-rain.mp3", `/${gui.token.slice(0, -1)}x/api/music`, `/x${gui.token}/api/music/b-rain.mp3`]) assert.equal((await get(gui, path)).status, 403, path);
	assert.equal((await get(gui, `/${gui.token}/api/music`, { headers: { host: "evil.example" } })).status, 403, "a rebound DNS name is refused");
	assert.equal((await get(gui, `/${gui.token}/api/music/b-rain.mp3`, { headers: { host: "evil.example" } })).status, 403);
	assert.equal((await get(gui, `/${gui.token}/api/music/b-rain.mp3`, { headers: { "x-forwarded-for": "100.1.1.1" } })).status, 403, "a forwarded request is not this computer's page");
	for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
		assert.equal((await get(gui, `/${gui.token}/api/music`, { method })).status, 403, method);
		assert.equal((await get(gui, `/${gui.token}/api/music/b-rain.mp3`, { method })).status, 403, method);
	}
});

test("a paired device reads the list and the files; an unpaired one is refused", async () => {
	const host = "box.tail1.ts.net:8443", gui = await serve({ music });
	gui.access.enable({ host, login: "me@example.com" });
	const tailnet = { host, "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97" };
	const code = gui.access.pair();
	const paired = await get(gui, `/${gui.token}/pair/${code}`, { port: gui.remotePort, headers: tailnet });
	const cookie = String(paired.headers["set-cookie"]).split(";")[0]!;
	const list = await get(gui, `/${gui.token}/api/music`, { port: gui.remotePort, headers: { ...tailnet, cookie } });
	assert.equal(list.status, 200);
	assert.ok(names(list).includes("b-rain.mp3"));
	const file = await get(gui, `/${gui.token}/api/music/b-rain.mp3`, { port: gui.remotePort, headers: { ...tailnet, cookie, range: "bytes=0-3" } });
	assert.deepEqual([file.status, file.bytes.toString("utf8")], [206, "0123"]);
	assert.equal((await get(gui, `/${gui.token}/api/music`, { port: gui.remotePort, headers: tailnet })).status, 401, "no cookie");
	assert.equal((await get(gui, `/${gui.token}/api/music/b-rain.mp3`, { port: gui.remotePort, headers: tailnet })).status, 401, "no cookie");
	assert.equal((await get(gui, `/${gui.token}/api/music`, { port: gui.remotePort, headers: { ...tailnet, cookie }, method: "POST" })).status, 403, "and nothing here writes");
});

test("the folder is read at each ask: a file dropped in later shows, one taken out is gone", async () => {
	const live = join(scratch, "live-music");
	mkdirSync(live);
	const gui = await serve({ music: live });
	assert.deepEqual(names(await get(gui, `/${gui.token}/api/music`)), []);
	writeFileSync(join(live, "new.mp3"), BYTES);
	assert.deepEqual(names(await get(gui, `/${gui.token}/api/music`)), ["new.mp3"]);
	assert.equal((await get(gui, `/${gui.token}/api/music/new.mp3`)).status, 200);
	rmSync(join(live, "new.mp3"));
	assert.deepEqual(names(await get(gui, `/${gui.token}/api/music`)), []);
	assert.equal((await get(gui, `/${gui.token}/api/music/new.mp3`)).status, 404);
});
