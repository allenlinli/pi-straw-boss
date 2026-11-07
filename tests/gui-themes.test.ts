import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { ServerView } from "../src/server/guiprefs.ts";

// The server and the theme files (docs/specs/2026-11-07-raven-view/spec.md §1.2, §6.5): a theme's files are listed at start and read from disk on their first request only, and the default view's first frame links its theme.

const scratch = mkdtempSync(join(tmpdir(), "psb-themes-test-"));
const dir = join(scratch, "bundle");
mkdirSync(join(dir, "themes", "geek"), { recursive: true });
mkdirSync(join(dir, "assets"), { recursive: true });
const HEAD = '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="./icon.svg"><link rel="stylesheet" href="./assets/app.css"><!--sb-theme--><script src="./assets/boot.js"></script></head><body></body></html>';
writeFileSync(join(dir, "index.html"), HEAD);
writeFileSync(join(dir, "assets", "app.css"), "body{}");
writeFileSync(join(dir, "themes.json"), JSON.stringify({ geek: { css: "themes/geek/geek-ab12.css", module: "themes/geek/geek-cd34.js", icon: "themes/geek/favicon-ef56.svg" }, zen: { css: "themes/zen/zen-ab12.css", icon: "icon.svg" } }));
writeFileSync(join(dir, "themes", "geek", "geek-ab12.css"), "first");
writeFileSync(join(dir, "themes", "geek", "pic-aa11.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
writeFileSync(join(dir, "themes", "geek", "gone-bb22.css"), "soon gone");
writeFileSync(join(scratch, "secret.txt"), "outside the bundle");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});
const serve = async (view: ServerView = "auto") => {
	const gui = await startGui({ read: async () => ({ bases: [] }), dir, view, pollMs: 20, pingMs: 50 });
	running.push(gui);
	return gui;
};
const raw = (gui: Gui, path: string) =>
	new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
		request({ host: "127.0.0.1", port: gui.port, path, headers: { host: `127.0.0.1:${gui.port}` }, agent: false }, (res) => {
			let body = "";
			res.on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
		}).on("error", reject).end();
	});

test("a theme's file is read from disk on its first request, not at start, and kept after; a name the listing lacks, and one that cannot be read, are 404", async () => {
	const gui = await serve();
	const at = (name: string) => raw(gui, `/${gui.token}/${name}`);
	// Rewritten after the server started and before anyone asked: what is served is what the disk says at the first request, so nothing was held.
	writeFileSync(join(dir, "themes", "geek", "geek-ab12.css"), "second");
	const first = await at("themes/geek/geek-ab12.css");
	assert.deepEqual([first.status, first.body], [200, "second"], "read at the first request");
	writeFileSync(join(dir, "themes", "geek", "geek-ab12.css"), "third");
	assert.equal((await at("themes/geek/geek-ab12.css")).body, "second", "and kept from then on");
	assert.deepEqual([first.headers["content-type"], first.headers["cache-control"]], ["text/css; charset=utf-8", "private, max-age=31536000, immutable"], "a hashed file is kept by the phone");
	const pic = await at("themes/geek/pic-aa11.webp");
	assert.deepEqual([pic.status, pic.headers["content-type"]], [200, "image/webp"]);
	unlinkSync(join(dir, "themes", "geek", "gone-bb22.css"));
	assert.equal((await at("themes/geek/gone-bb22.css")).status, 404, "a listed file that cannot be read now");
	assert.equal((await at("themes/geek/unknown.css")).status, 404, "a name that was not listed at start");
	writeFileSync(join(dir, "themes", "geek", "late-cc33.css"), "added after start");
	assert.equal((await at("themes/geek/late-cc33.css")).status, 404, "nor one that appeared later: the list is the start's");
	for (const path of ["themes/%2e%2e/secret.txt", "themes/geek/%2e%2e/%2e%2e/%2e%2e/secret.txt", "themes/geek/..%2f..%2f..%2fsecret.txt", "themes//geek/geek-ab12.css", "themes"]) {
		const r = await at(path);
		assert.ok([308, 403, 404].includes(r.status), `${path}: ${r.status}`);
		assert.notEqual(r.body, "outside the bundle", path);
	}
	assert.equal((await at("assets/app.css")).body, "body{}", "the rest of the bundle is still held from start");
});

test("the default view's first frame links its theme after the entry's stylesheet and takes its icon; Standard and Auto add nothing", async () => {
	const page = async (view: ServerView) => {
		const gui = await serve(view);
		return (await raw(gui, `/${gui.token}/`)).body;
	};
	const geek = await page("geek");
	assert.match(geek, /<link rel="stylesheet" href="\.\/assets\/app\.css"><link rel="stylesheet" data-theme="geek" href="themes\/geek\/geek-ab12\.css"><script src="\.\/assets\/boot\.js">/, "the theme's link sits after the entry's stylesheet and before boot.js");
	assert.match(geek, /<link rel="icon" type="image\/svg\+xml" href="themes\/geek\/favicon-ef56\.svg" data-standard="\.\/icon\.svg">/);
	assert.match(geek, /<meta name="sb-view" content="geek">/);
	for (const view of ["standard", "auto"] as const) assert.ok(!(await page(view)).includes("data-theme"), `${view}: no theme link`);
	const zen = await page("zen");
	assert.ok(zen.includes('data-theme="zen" href="themes/zen/zen-ab12.css"') && zen.includes('href="icon.svg" data-standard'), "a theme without an icon of its own takes the one the map names");
});
