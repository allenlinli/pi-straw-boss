import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkService } from "../src/link/service.ts";
import { allyPort } from "../src/server/allyport.ts";

// What the revocation of a controller's runs and mains asks the link (docs/specs/2026-11-05-link-shared-box.md, section 3): whether the box can tell who is in a team, and who is.

const T = "t".repeat(16), DEV = "n".repeat(26);
function port(world: { mode: "attended" | "unattended" | "refused"; teams: string[]; running: boolean; member: boolean }) {
	const service = {
		policyMode: () => world.mode, config: () => ({ teams: new Map(world.teams.map((t) => [t, {}])) }), levelOf: () => "dispatch",
		holder: { active: true, rosterKnown: () => world.running, isMember: () => world.member },
	} as unknown as LinkService;
	return allyPort(() => service);
}

test("known: a refused policy file means the box cannot tell (g346-F003)", () => {
	const world = { mode: "refused" as const, teams: [T], running: true, member: true };
	assert.equal(port(world).known?.(T), false);
	assert.equal(port({ ...world, mode: "unattended" as never }).known?.(T), true);
});

test("a team the unattended policy dropped is known to be empty, and nobody stands in it (g346-F005b)", () => {
	const world = { mode: "unattended" as const, teams: [], running: false, member: true };
	assert.equal(port(world).known?.(T), true);
	assert.equal(port(world).standing?.(DEV, T), undefined);
	const kept = { ...world, teams: [T] };
	assert.equal(port(kept).known?.(T), false, "a team the policy names but whose holder run is down is not known");
	assert.deepEqual(port({ ...kept, running: true }).standing?.(DEV, T), { level: "dispatch" });
});

test("an attended computer asks the holder alone", () => {
	assert.equal(port({ mode: "attended", teams: [], running: true, member: true }).known?.(T), true);
});
