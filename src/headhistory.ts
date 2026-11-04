import { PAGE, type Reader } from "./history.ts";
import type { Item } from "./items.ts";
import type { Found } from "./net.ts";
import type { Hub } from "./watch.ts";

// The head tower's history reads every chapter of its one conversation (docs/specs/2026-11-04-head-tower.md, The GUI channel, Reading). A key with `chapters` is paged newest chapter first: a page that reaches the start of a
// chapter's file opens with a divider item (`type: "chapter"`: when the chapter began and why) and hands back the cursor `chapter:<n>` of the chapter before it; a cursor that is an entry id is looked up in the chapters
// newest first. Every other key is one file, paged as the reader pages it.

export interface Page { items: Item[]; before?: string }
const CURSOR = /^chapter:(\d{1,9})$/;

/** The reader's page of a file, or of the chapter chain; `held` is a reader already acquired for the newest file (the stream's). */
export async function pageThrough(hub: Pick<Hub, "readers">, found: Found, before: string | undefined, limit = PAGE, held?: Reader): Promise<Page> {
	const chain = found.chapters ?? [];
	const read = async <T>(file: string, use: (r: Reader) => Promise<T>): Promise<T> => {
		const reader = file === found.file && held ? held : hub.readers.acquire(file);
		try { return await use(reader); } finally { if (reader !== held) hub.readers.release(file); }
	};
	if (!chain.length) return found.file ? read(found.file, (r) => r.page(before, limit)) : { items: [] };
	let at = chain.length - 1, id: string | undefined;
	if (before !== undefined) {
		const named = CURSOR.exec(before)?.[1];
		if (named !== undefined) at = chain.findIndex((c) => c.n === Number(named));
		else {
			id = before;
			at = -1;
			for (let i = chain.length - 1; i >= 0 && at < 0; i--) if (await read(chain[i]!.file, (r) => r.entry(before))) at = i;
		}
	}
	if (at < 0) return { items: [] };
	const c = chain[at]!, page = await read(c.file, (r) => r.page(id, limit));
	if (page.before !== undefined || at === 0) return page;
	return { items: [{ id: `chapter-${c.n}`, kind: "divider", type: "chapter", at: c.from, text: c.why }, ...page.items], before: `chapter:${chain[at - 1]!.n}` };
}

/** The file that holds an entry of this key: the chapter that has it for the head, the key's own file for everything else. */
export async function fileOfEntry(hub: Pick<Hub, "readers">, found: Found, id: string): Promise<string | undefined> {
	for (const c of [...(found.chapters ?? [])].reverse()) {
		const reader = hub.readers.acquire(c.file);
		try { if (await reader.entry(id)) return c.file; } finally { hub.readers.release(c.file); }
	}
	return found.chapters?.length ? undefined : found.file;
}
