import type { Item } from "../src/items.ts";

/** From a session's newest items when the alert arrives: its last line, the open tool call it waits on, and `at`, the entry Open comms lands on. */
export function intel(items: Item[]): Intel {
	const answered = new Set(items.flatMap((i) => (i.kind === "result" && i.callId ? [i.callId] : [])));
	const replies = items.filter((i) => i.kind === "assistant"), last = replies.at(-1);
	const open = last?.tools?.find((t) => !answered.has(t.id));
	const said = replies.findLast((i) => i.text?.trim())?.text?.trim().split("\n").filter(Boolean).at(-1);
	return { said: said?.slice(0, 280), pending: open && `${open.name} · ${open.summary}`.slice(0, 200), at: (last ?? items.findLast((i) => i.kind !== "result"))?.id };
}
export interface Intel { said?: string; pending?: string; at?: string; failed?: boolean }
