import type { Readable } from "node:stream";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, sep } from "node:path";

// Zen's music folder (docs/specs/2026-11-01-zen-view.md, Music): the boss drops audio files into one folder (`music/` in the sb state folder) and the GUI's /api/music routes list and stream them. The folder is
// read at each ask. Only a file that the folder's own listing holds, by its exact name, of an audio type, that is a regular file and whose real path stays inside the folder's real path, is a track:
// a path that climbs out, a name in a sub folder, a link that leaves the folder, and every other type are not there. Range requests answer the <audio> element's seeks (an iPhone asks nothing else).

/** The types a track may be, by extension; the content type follows the extension, never the file's bytes. */
const TYPES: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac" };
/** How many tracks the list holds: a folder of thousands is not a Zen playlist. */
export const LIMIT = 200;
export interface Track { file: string; size: number }
/** `body` is absent for a 416. A track carries an ETag and Last-Modified (from its size and mtime) and is cached privately, so a loop or a seek of the same file is not fetched again. The caller ends the stream if the request goes away first. */
export interface Served { status: 200 | 206 | 416; headers: Record<string, string>; body?: Readable }

/** A name the listing may hold: no hidden file (AppleDouble `._x.mp3` too), no control character or backslash, an audio extension. */
const plain = (name: string) => !name.startsWith(".") && !/[\\\0-\x1f]/.test(name) && extname(name).toLowerCase() in TYPES;
const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

/** `all`: serve the whole file (no range, or one this route does not answer); `bad`: 416; else the first and last byte. */
function slice(header: string | undefined, size: number): "all" | "bad" | [number, number] {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? ""); // one range only: several are answered with the whole file, as RFC 9110 allows
	if (!m || (m[1] === "" && m[2] === "")) return "all";
	if (m[1] === "") return Number(m[2]) === 0 ? "bad" : [Math.max(0, size - Number(m[2])), size - 1];
	const from = Number(m[1]);
	if (m[2] !== "" && Number(m[2]) < from) return "all"; // a range that ends before it starts is no range
	return from >= size ? "bad" : [from, m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)];
}

/** Where the music lives: `straw-boss-music/` beside the state folder in the agent folder, not inside it (the owner-only ACL step on Windows refuses links in the state folder). The server never creates it. */
export const musicDirOf = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss-music");

/** The music folder at `dir`; with no folder, or one that is not there, the library is empty. */
export function createMusic(dir?: string) {
	/** The track's real file when it is one: inside the folder, regular, not empty. */
	async function track(name: string): Promise<{ real: string; size: number } | undefined> {
		if (!dir) return undefined;
		try {
			const [root, real] = await Promise.all([realpath(dir), realpath(join(dir, name))]);
			if (!real.startsWith(root + sep)) return undefined;
			const s = await stat(real);
			return s.isFile() && s.size > 0 ? { real, size: s.size } : undefined;
		} catch {
			return undefined; // a dangling link, a vanished file, a folder that is not there
		}
	}
	async function names() {
		if (!dir) return [];
		return (await readdir(dir).catch(() => [] as string[])).filter(plain);
	}
	return {
		async list(): Promise<Track[]> {
			const found = await Promise.all((await names()).map(async (file) => ({ file, hit: await track(file) })));
			return found.flatMap((f) => (f.hit ? [{ file: f.file, size: f.hit.size }] : [])).sort((a, b) => byName(a.file, b.file)).slice(0, LIMIT);
		},
		/** The track named `name` (one path segment, as the folder spells it), or undefined. `range` is the request's Range header. */
		async open(name: string, range?: string): Promise<Served | undefined> {
			if (!plain(name) || !(await names()).includes(name)) return undefined; // the listing is the allow-list: a name it does not hold, in another case or with a trailing space, is not served
			const hit = await track(name);
			if (!hit) return undefined;
			const type = TYPES[extname(name).toLowerCase()]!, want = slice(range, hit.size);
			if (want === "bad") return { status: 416, headers: { "content-range": `bytes */${hit.size}`, "content-length": "0" } };
			const [from, to] = want === "all" ? [0, hit.size - 1] : want;
			const file = await open(hit.real, "r").catch(() => undefined);
			if (!file) return undefined;
			const now = await file.stat();
			if (!now.isFile() || now.size !== hit.size) return void (await file.close()); // it changed between the check and the open
			return {
				status: want === "all" ? 200 : 206,
				headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(to - from + 1), "cache-control": "private, max-age=3600", etag: `"${now.size.toString(36)}-${Math.floor(now.mtimeMs).toString(36)}"`, "last-modified": now.mtime.toUTCString(), ...(want === "all" ? {} : { "content-range": `bytes ${from}-${to}/${hit.size}` }) },
				body: file.createReadStream({ start: from, end: to }),
			};
		},
	};
}
export type Music = ReturnType<typeof createMusic>;
