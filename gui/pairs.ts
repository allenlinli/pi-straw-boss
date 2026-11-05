import type { Answer } from "./post.ts";

// A pair request waiting at this computer, as `lan/pending` lists it (src/server/lanhost.ts `pendingBody`; never the number, which lives on the phone). The Wi-Fi tab (lan.ts), the header's notice (lanwait.ts) and Zen's card (zen.ts) read the same list.
export interface PairRequest { id: string; label: string; peer: string; iface?: string; age: string; ageMs?: number }

export const pairsOf = (v: unknown): PairRequest[] => (Array.isArray(v) ? v.map((p) => ({ id: String(p?.id), label: String(p?.label ?? ""), peer: String(p?.peer ?? ""), ...(p?.iface ? { iface: String(p.iface) } : {}), age: String(p?.age ?? ""), ...(typeof p?.ageMs === "number" ? { ageMs: p.ageMs } : {}) })) : []);
/** The list in a reply of `lan/pending`; none when the reply is not one. */
export const pairsIn = (r: Pick<Answer, "ok" | "body"> | undefined): PairRequest[] => (r?.ok ? pairsOf(r.body.pending) : []);
