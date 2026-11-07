import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Reply } from "./control.ts";
import type { Found } from "./net.ts";

// A file pasted, dropped, or picked in a session's composer: the page posts its bytes, the server stores them in a private folder under the
// temp directory, and the page puts the path into the message, the way a picture pasted into pi's terminal lands as a temp file path. The
// session reads it with its own tools. The checks before it (origin, CSRF, paired device) are control.ts's; the name only names the file.
//   POST /<token>/api/sessions/<key>/upload  (application/octet-stream, X-Sb-Name: the URI-encoded file name)  {path}

export const MAX_UPLOAD = 20 * 1024 * 1024;
export const UPLOADS = join(tmpdir(), "pi-straw-boss-uploads");
const no = (status: number, error: string, reason: string): Reply => ({ status, body: { error, reason } });

/** A file name safe to keep: its last part, letters, digits, and `._ -` only, no leading dot, at most 120 characters. */
export function safeName(raw: unknown) {
	let name = "";
	try {
		name = decodeURIComponent(String(raw ?? ""));
	} catch {} // not URI-encoded: it gets the default name
	return basename(name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^[.\s]+/, "").slice(-120) || "file";
}

/** Writes the bytes to a file of its own in the private folder: its path, or the reply that refuses an empty file. */
export async function store(bytes: Buffer, rawName: unknown, dir = UPLOADS): Promise<Reply> {
	if (!bytes.length) return no(400, "bad_request", "The file is empty.");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName(rawName)}`);
	await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
	return { status: 200, body: { path } };
}

/** The session an upload goes to, or why not. */
export const target = (found: Found | undefined): Reply | undefined => (!found ? no(404, "not_found", "No such session.") : !found.live || !found.pane ? no(409, "not_live", "This session is no longer live in a pane.") : undefined);

export async function upload(req: IncomingMessage, found: Found | undefined, dir = UPLOADS): Promise<Reply> {
	const refused = target(found);
	if (refused) return refused;
	if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD) return (req.resume(), no(413, "too_large", "The file is larger than 20 MB."));
	const parts: Buffer[] = [];
	let size = 0;
	const whole = await new Promise<boolean>((done) => {
		req.on("data", (chunk: Buffer) => ((size += chunk.length) <= MAX_UPLOAD && parts.push(chunk)));
		req.on("end", () => done(size <= MAX_UPLOAD));
		req.on("error", () => done(false));
	});
	if (!whole) return no(413, "too_large", "The file is larger than 20 MB, or it did not arrive whole.");
	return store(Buffer.concat(parts), req.headers["x-sb-name"], dir);
}
