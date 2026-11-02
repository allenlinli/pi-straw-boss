import { createHash, timingSafeEqual } from "node:crypto";

// The one-tap prompt run. An accepted answer that put a command in a session's prompt ("Put it in my prompt", owners.ts `then.terminal`) leaves one grant here: the answer id, the session, and the hash of the
// command as the owner puts it there. The page's 執行 names the answer id on its Enter (keys.ts `run`); the session's bridge reports a hash of its prompt line (probe.ts), and only a line equal to that command
// lets the Enter pass the `command` confirm (never an ending command's: the bridge's `ending` is checked first). A grant answers once, whatever it answers, and expires. Only hashes are kept: the command is not.

export const RUN_TTL_MS = 120_000, MAX_RUNS = 64;
export type Taken = "match" | "nohash" | "unknown" | "expired" | "changed";

/** SHA-256 of a prompt line, hex: what the bridge reports and the grant keeps. */
export const commandHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface Grant { session: string; hashes: string[]; until: number }

export function createRuns(now: () => number = Date.now) {
	const grants = new Map<string, Grant>();
	return {
		/** Records the grant for an answer; `copy` is the command the dialog showed. robot_hand puts a shell command as `! <command>` and a pi command (it starts with `/`) as it is; a command that starts with `/` may be either, so both lines match it. False when there is no command. */
		issue(session: string, answerId: string, copy: string | undefined): boolean {
			if (!copy?.trim()) return false;
			const t = now();
			for (const [id, g] of grants) if (g.until <= t) grants.delete(id);
			while (grants.size >= MAX_RUNS) grants.delete(grants.keys().next().value!);
			grants.set(answerId, { session, hashes: copy.startsWith("/") ? [commandHash(`! ${copy}`), commandHash(copy)] : [commandHash(`! ${copy}`)], until: t + RUN_TTL_MS });
			return true;
		},
		/** The answer for an Enter that names `answerId` in `session` while the session's prompt line hashes to `hash` (none: an old bridge). The grant is spent by any answer but `unknown`, which finds none (another session's is left alone). */
		take(session: string, answerId: string, hash: string | undefined): Taken {
			const g = grants.get(answerId);
			if (!g || g.session !== session) return "unknown";
			grants.delete(answerId);
			if (g.until <= now()) return "expired";
			if (hash === undefined) return "nohash";
			return g.hashes.some((h) => same(h, hash)) ? "match" : "changed";
		},
		size: () => grants.size,
	};
}
