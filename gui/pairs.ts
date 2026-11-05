import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// A pair request waiting at this computer, as `lan/pending` lists it (src/server/lanhost.ts `pendingBody`; never the number, which lives on the phone). The Wi-Fi tab (lan.ts), the header's notice (lanwait.ts) and Zen's card (zen.ts) read the same list.
export interface PairRequest { id: string; label: string; peer: string; iface?: string; age: string; ageMs?: number }

export const pairsOf = (v: unknown): PairRequest[] => (Array.isArray(v) ? v.map((p) => ({ id: String(p?.id), label: String(p?.label ?? ""), peer: String(p?.peer ?? ""), ...(p?.iface ? { iface: String(p.iface) } : {}), age: String(p?.age ?? ""), ...(typeof p?.ageMs === "number" ? { ageMs: p.ageMs } : {}) })) : []);
/** The list in a reply of `lan/pending`; none when the reply is not one. */
export const pairsIn = (r: Pick<Answer, "ok" | "body"> | undefined): PairRequest[] => (r?.ok ? pairsOf(r.body.pending) : []);

/** The age of a request in the page's language, from the server's milliseconds (its English text only when it sent none). */
export const ageOf = (p: PairRequest) => (p.ageMs === undefined ? p.age : p.ageMs < 60_000 ? m.lan_age_s({ n: String(Math.max(1, Math.round(p.ageMs / 1000))) }) : m.lan_age_min({ n: String(Math.round(p.ageMs / 60_000)) }));
export const peerOf = (p: PairRequest) => (p.iface ? `${p.peer} (${p.iface})` : p.peer);
export const labelOf = (p: PairRequest) => p.label || m.device_unknown();
/** The request in one line: who, from where, how long ago. */
export const pairLine = (p: PairRequest) => m.lan_pending({ label: labelOf(p), peer: peerOf(p), age: ageOf(p) });
