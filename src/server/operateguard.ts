import type { Policy } from "../link/policy.ts";
import { admitOperate, checkOperate, type EndReason, type MemberOf, narrow, type Owner, type Refusal, type Scope } from "./operatescope.ts";

// The operate sessions of an unattended box and the grant each stands on (docs/specs/2026-11-07-link-operate.md §3.2, §5.6). The session layer (task 5) admits a session here when an `open` arrives, asks `check` for every request,
// and gives the guard its `end`: what carries a `close` with the reason to the operator, stops the session's watches and mirrors, drops its keys, and writes `operate-close` to link.log. The guard never writes that line itself, so a
// session ends once and is logged once.
//
// What ends a session on the box's own:
//   - a policy change: `onPolicy`, which the policy watch (policy.ts `watchPolicy`: `fs.watch` plus a 2 s poll of the file's stamp) calls on any change;
//   - a roster change of a team the session touches: `onRoster`, which the link holder calls right after it stored the entries, or stopped the team (`HolderOptions.onRoster`);
//   - a request whose recheck finds the grant gone: `check` ends the session itself, with no wait for either.
// One bad read ends. Ending a view loses no work, and a session that outlives its grant is the one failure that must not happen: a policy that cannot be read reads as refused, and a roster that cannot be read has no members.
// A team that leaves a session's reach (its operator is no longer an admin of it) is taken out of the scope and the session goes on; a session with nothing left to reach ends.

export interface GuardSession { id: string; team: string; from: string; want: "team" | "box"; scope: Scope; /** When it was admitted (the guard's clock). */ since: number }

export interface GuardDeps {
	/** The policy as the file reads now (a fresh read: policy.ts `readPolicy`); a throw reads as refused. */
	policy(): Policy;
	/** The roster now (`LinkHolder.member`). */
	member: MemberOf;
	/** The owner of a unit by its box key (operatescope.ts `ownerOf`), nothing for a key the net does not know. */
	owner(key: string): Owner | undefined;
	now(): number;
	/** The box ends `session`: called once, after the guard forgot it. A throw is logged by its name and does not keep other sessions from ending. */
	end(session: GuardSession, reason: EndReason): void;
	log?(entry: Record<string, unknown>): void;
}

export function createOperateGuard(d: GuardDeps) {
	const sessions = new Map<string, GuardSession>();
	let unreadable = false;
	const copy = (s: GuardSession): GuardSession => ({ ...s, scope: { teams: [...s.scope.teams], box: s.scope.box } });
	const policy = (): Policy => {
		try {
			const read = d.policy();
			unreadable = false;
			return read;
		} catch {
			if (!unreadable) d.log?.({ event: "operate-policy-unreadable" });
			unreadable = true;
			return { mode: "refused", reason: "the policy could not be read" };
		}
	};
	const end = (s: GuardSession, reason: EndReason): void => {
		sessions.delete(s.id);
		try {
			d.end(copy(s), reason);
		} catch (error) {
			d.log?.({ event: "operate-end-failed", session: s.id, error: (error as Error)?.name ?? "Error" });
		}
	};
	/** Rechecks the grant of each session in `of` against `read`: ends the ones that lost it, narrows the scope of the rest. */
	const settle = (of: GuardSession[], read: Policy): void => {
		for (const s of of) {
			const n = narrow({ policy: read, member: d.member }, s);
			if (!n.ok) end(s, n.ends);
			else s.scope = n.scope;
		}
	};
	return {
		/** Checks 1 to 3 for an `open`; on success the session is registered with the scope computed now. A session id already in use is a caller's error, not a refusal. */
		admit(q: { id: string; team: string; from: string; want: "team" | "box" }): { ok: true; scope: Scope } | { ok: false; reason: Refusal } {
			if (sessions.has(q.id)) throw new Error(`operate session ${q.id} is already open`);
			const r = admitOperate({ policy: policy(), member: d.member }, q);
			if (!r.ok) return r;
			sessions.set(q.id, { ...q, scope: r.scope, since: d.now() });
			return { ok: true, scope: { teams: [...r.scope.teams], box: r.scope.box } };
		},
		/** All four checks of a request of session `id`, now. A failure of the grant ends the session as well; a session that is not open answers `not-granted`. Only the word comes back. */
		check(id: string, q: { unit?: string; localOnly?: boolean }): { ok: true } | { ok: false; reason: Refusal } {
			const s = sessions.get(id);
			if (!s) return { ok: false, reason: "not-granted" };
			const read = policy(), v = checkOperate({ policy: read, member: d.member, owner: d.owner }, s, q);
			if (!v.ok && v.ends) end(s, v.ends);
			else settle([s], read);
			return v.ok ? { ok: true } : { ok: false, reason: v.reason };
		},
		/** The operator closed the session itself: nothing ends it later. */
		release(id: string): void {
			sessions.delete(id);
		},
		/** A copy of the open sessions, with their scopes as they stand. */
		sessions: (): GuardSession[] => [...sessions.values()].map(copy),
		/** The policy changed (or may have): every session is rechecked against one fresh read. */
		onPolicy(): void {
			if (sessions.size) settle([...sessions.values()], policy());
		},
		/** `team`'s roster changed, or the team stopped: the sessions that touch it are rechecked. */
		onRoster(team: string): void {
			const touched = [...sessions.values()].filter((s) => s.team === team || s.scope.teams.includes(team));
			if (touched.length) settle(touched, policy());
		},
	};
}
export type OperateGuard = ReturnType<typeof createOperateGuard>;
