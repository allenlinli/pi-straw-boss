import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The one-tap prompt run. An accepted answer that put a shell command in a session's prompt ("Put it in my prompt", owners.ts `then.terminal`) leaves one grant here: the answer id, the session, a random nonce of its own,
// and the MAC of the line as the owner puts it there (`! <command>`). The page's 執行 names the answer id on its Enter (keys.ts `run`); the server gives the session's bridge the grant's nonce with that Enter's probe, the bridge
// answers HMAC-SHA-256(nonce, its prompt line) (probe.ts), and only a line equal to that command lets the Enter pass the `command` confirm (never an ending command's: the bridge's `ending` is checked first). A bridge tells
// no MAC of a draft unless it was given a nonce, so the Enters that carry no `run` tell nothing of the line. A grant answers once, whatever it answers, and expires. A command that starts with `/` gets no grant: it is a pi command
// (or a path, which robot_hand places as `! /path`), the two cannot be told apart here, and a `/` line keeps its confirm because pi's command menu may be open on it (OT-F002, OT-F003). Only MACs are kept: the command is not.

export const RUN_TTL_MS = 120_000, MAX_RUNS = 64;
export type Taken = "match" | "nohash" | "unknown" | "expired" | "changed";

/** HMAC-SHA-256 of a prompt line under a grant's nonce, hex: what the bridge reports and the grant keeps. */
export const lineMac = (nonce: string, text: string) => createHmac("sha256", nonce).update(text, "utf8").digest("hex");
/** A nonce as the server gives it: 32 lowercase hex digits. The bridge makes no MAC under anything else. */
export const NONCE = /^[0-9a-f]{32}$/;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Grant { session: string; nonce: string; mac: string; until: number }

export function createRuns(now: () => number = Date.now) {
	const grants = new Map<string, Grant>();
	return {
		/** Records the grant for an answer; `copy` is the command the dialog showed, which robot_hand puts as `! <command>`. False (no grant) when there is no command or it starts with `/`. */
		issue(session: string, answerId: string, copy: string | undefined): boolean {
			if (!copy?.trim() || copy.trimStart().startsWith("/")) return false;
			const t = now();
			for (const [id, g] of grants) if (g.until <= t) grants.delete(id);
			while (grants.size >= MAX_RUNS) grants.delete(grants.keys().next().value!);
			const nonce = randomBytes(16).toString("hex");
			grants.set(answerId, { session, nonce, mac: lineMac(nonce, `! ${copy}`), until: t + RUN_TTL_MS });
			return true;
		},
		/** The nonce to give the bridge with the probe of an Enter that names `answerId` in `session`: none for another session's, an unknown, or a stale grant. The grant is not spent. */
		nonce(session: string, answerId: string): string | undefined {
			const g = grants.get(answerId);
			return g && g.session === session && g.until > now() ? g.nonce : undefined;
		},
		/** The answer for an Enter that names `answerId` in `session` while the session's prompt line has MAC `mac` under the grant's nonce (none: no MAC came back, an old bridge or a line that is no command). The grant is spent by any answer but `unknown`, which finds none (another session's is left alone). */
		take(session: string, answerId: string, mac: string | undefined): Taken {
			const g = grants.get(answerId);
			if (!g || g.session !== session) return "unknown";
			grants.delete(answerId);
			if (g.until <= now()) return "expired";
			if (mac === undefined) return "nohash";
			return same(g.mac, mac) ? "match" : "changed";
		},
		size: () => grants.size,
	};
}
