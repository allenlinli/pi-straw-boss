import type { LinkService } from "../link/service.ts";
import type { AllyItem, AllyPort } from "./runs.ts";

// What the tower service takes from the link holder to run allies (docs/specs/2026-10-26-sb-backend.md, Ally runs): the messages that wait in the inbox for a tower identity the server runs, their leaving the
// inbox, who may still be served, the project a team binds, and the thread with a device. The holder exists only in the primary server and only once its record is taken, so every call asks for it afresh.

const THREAD_ROWS = 6;
export function allyPort(link: () => LinkService | undefined): AllyPort {
	return {
		waiting(identity) {
			const service = link(), holder = service?.holder;
			if (!service || !holder?.active) return [];
			const teams = service.config().teams;
			return holder.servedFor(identity).map((i): AllyItem => ({
				id: i.id, device: i.from, label: i.fromLabel, short: i.fromShort, team: i.team, teamName: teams.get(i.team)?.name ?? i.team.slice(0, 6), fromWorkspace: i.fromWorkspace, replyExpected: i.replyExpected, text: i.text, at: i.received,
				...(i.awaitsReply ? { awaitsReply: i.awaitsReply } : {}), ...(i.askedBy ? { askedBy: i.askedBy } : {}),
			}));
		},
		async taken(id, identity) {
			await link()?.holder?.taken(id, identity);
		},
		delivered(id, run) {
			link()?.holder?.delivered(id, run);
		},
		// A device is taken as gone only while the box can tell who is in the team: the policy file reads (a refused one answers `reply` for everybody, g346-F003) and the holder reads the roster. A team the unattended policy
		// no longer names has no holder run and never will: nobody is in it, so its controllers are gone (g346-F005b).
		known(team) {
			const service = link();
			if (!service) return false;
			const mode = service.policyMode();
			if (mode === "refused") return false;
			if (mode === "unattended" && !service.config().teams.has(team)) return service.holder?.active === true;
			return service.holder?.rosterKnown(team) ?? false;
		},
		standing(device, team) {
			const service = link();
			if (!service || (service.policyMode() === "unattended" && !service.config().teams.has(team))) return undefined;
			return service.holder?.isMember(team, device) ? { level: service.levelOf(device) } : undefined;
		},
		project: (team) => link()?.config().teams.get(team)?.project,
		thread: (device) => link()?.store.readThread(device).slice(-THREAD_ROWS).map((r) => ({ dir: r.dir, at: r.at, kind: r.kind, text: r.text })) ?? [],
	};
}
