import type { Post } from "./mirrorconn.ts";
import type { Answer } from "./post.ts";
import { m } from "./paraglide/messages.js";

// The writes of a terminal's keys (POST …/keys, src/keys.ts), one at a time, at most one every 130 ms (the server takes 8 a second per session), in order;
// characters typed meanwhile join the next write. A refusal, a network failure, or a confirm drops what was still queued, so an Enter never goes after a text that
// did not land. The pad (keypad.ts) and the terminal card (termcard.ts) share it; each draws its own confirm and its own words for a refusal.

export type Write = { key: string } | { text: string } | { paste: string };
export const GAP = 130, MAX_TYPED = 64, MAX_PASTE = 4000;
/** What a writer tells its owner. `busy`: a write went out or came back; `ask`: the server asked to confirm a key (`token` names it); `error`: a refusal or a failure in the page's words; `sent`/`failed`: a write is on its way / did not run (`r`: the server's refusal; none for a network failure); `taken`: the server took it (200). */
export interface WriterEvents { busy?(): void; clear?(): void; ask?(write: { key: string }, reason: string, token: string): void; error?(text: string): void; sent?(w: Write): void; taken?(w: Write): void; failed?(w: Write, r?: Answer): void }

export function keywriter({ post, stream, ...on }: { post: Post; stream(): string } & WriterEvents) {
	let queue: Write[] = [], last = 0, busy = false, wait: ReturnType<typeof setTimeout> | undefined;
	async function send(write: Write, confirmed?: string) {
		busy = true;
		on.busy?.();
		on.clear?.();
		last = Date.now();
		on.sent?.(write);
		try {
			const r = await post("keys", { ...write, stream: stream(), ...(confirmed ? { confirmed } : {}) });
			if (r.ok) on.taken?.(write);
			else on.failed?.(write, r);
			if (r.status === 409 && r.body.error === "confirm" && typeof r.body.confirm === "string" && "key" in write) (queue = []), on.ask?.(write, String(r.body.reason ?? ""), r.body.confirm);
			else if (!r.ok) (queue = []), on.error?.(r.body.reason ?? m.refused({ status: r.status }));
		} catch {
			on.failed?.(write);
			queue = [];
			on.error?.(m.unreachable());
		} finally {
			busy = false;
			on.busy?.();
			pump();
		}
	}
	function pump() {
		if (busy || wait || !queue.length) return;
		const due = last + GAP - Date.now();
		if (due > 0) return void (wait = setTimeout(() => ((wait = undefined), pump()), due));
		void send(queue.shift()!);
	}
	return {
		/** A write goes after the ones before it. */
		push(write: Write) { queue.push(write); pump(); },
		/** The same key again with the token the server named; nothing while a write is on its way. */
		confirm(key: string, token: string) { if (!busy) void send({ key }, token); },
		/** Characters typed (an input method's too), control characters dropped, joined to typed text still queued, in pieces the server takes; false when nothing was left to write. */
		text(typed: string) {
			const chars = [...typed.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")];
			for (const c of chars) {
				const tail = queue.at(-1);
				if (tail && "text" in tail && [...tail.text].length < MAX_TYPED) tail.text += c;
				else queue.push({ text: c });
			}
			pump();
			return chars.length > 0;
		},
		/** A paste, as one paste (several when it is long); false when nothing was left to write. */
		paste(pasted: string) {
			const chars = [...pasted.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")];
			for (let i = 0; i < chars.length; i += MAX_PASTE) queue.push({ paste: chars.slice(i, i + MAX_PASTE).join("") });
			pump();
			return chars.length > 0;
		},
		busy: () => busy,
		queued: () => queue.length,
	};
}
