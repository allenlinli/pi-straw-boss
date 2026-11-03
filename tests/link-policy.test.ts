import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLinkConfig } from "../src/link/config.ts";
import { type PolicyDeps, POLICY_PATH, policyProblem, readEffectiveConfig, readPolicy } from "../src/link/policy.ts";

// Trust levels: config.json on an attended device, the policy file on an unattended one, which refuses to run unless that file and its folder are
// owned by another user and not writable by its own (docs/specs/2026-10-25-straw-link.md, Storage and policy).

const ctrl = "cccccccccccccccccccccccccc", other = "dddddddddddddddddddddddddd";
const file = (over: Record<string, unknown> = {}) => JSON.stringify({ unattended: true, trust: { [ctrl]: "dispatch", [other]: "forward" }, ...over });
/** A file system where `owner` owns every path and `writable` says which paths this user could write. */
const fs = (o: { uid?: number; owner?: number; writable?: string[]; symlink?: string[]; text?: string } = {}): PolicyDeps => ({
	path: "/etc/straw-link/policy.json", uid: o.uid ?? 501,
	stat: (p) => ({ uid: o.owner ?? 0, symlink: (o.symlink ?? []).includes(p) }),
	writable: (p) => (o.writable ?? []).includes(p),
	read: () => o.text ?? file(),
});

test("the policy path is fixed", () => {
	assert.equal(POLICY_PATH, "/etc/straw-link/policy.json");
});

test("an unattended policy owned by another user and not writable by this one is read: levels by device id, true meaning dispatch", () => {
	const p = readPolicy(fs({ text: file({ trust: { [ctrl]: true, [other]: "forward", eeeeeeeeeeeeeeeeeeeeeeeeee: "root", short: "dispatch" } }) }));
	assert.equal(p.mode, "unattended");
	if (p.mode === "unattended") assert.deepEqual([...p.trust], [[ctrl, "dispatch"], [other, "forward"]], "a level that is not one and an id that is not a device id are left out");
});

test("the policy is refused when its file or its folder is owned by this user, writable by it, or a symlink", () => {
	const r = (o: Parameters<typeof fs>[0]) => readPolicy(fs(o));
	assert.deepEqual(r({ owner: 501 }), { mode: "refused", reason: "/etc/straw-link/policy.json is owned by this device's own user" });
	assert.match((r({ writable: ["/etc/straw-link/policy.json"] }) as { reason: string }).reason, /file is writable|policy\.json is writable by this device's own user/);
	assert.match((r({ writable: ["/etc/straw-link"] }) as { reason: string }).reason, /\/etc\/straw-link is writable by this device's own user/);
	assert.match((r({ symlink: ["/etc/straw-link"] }) as { reason: string }).reason, /\/etc\/straw-link is a symlink/);
	assert.equal(r({ owner: 0 }).mode, "unattended");
});

test("a policy file that is there but unreadable, or not JSON, refuses unattended mode; one that is absent, or does not say unattended, leaves the device attended", () => {
	const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
	assert.deepEqual(readPolicy({ ...fs(), read: () => { throw missing; } }), { mode: "attended" });
	assert.equal(readPolicy({ ...fs(), read: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }).mode, "refused");
	assert.equal(readPolicy(fs({ text: "{" })).mode, "refused");
	assert.deepEqual(readPolicy(fs({ text: JSON.stringify({ trust: { [ctrl]: "dispatch" } }) })), { mode: "attended" });
	assert.deepEqual(readPolicy(fs({ text: JSON.stringify({ unattended: false }) })), { mode: "attended" });
});

test("the real check on a real file: a file this user owns is refused", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-link-policy-"));
	try {
		const path = join(dir, "policy.json");
		writeFileSync(path, file());
		assert.match(policyProblem(path) ?? "", /owned by this device's own user/);
		const link = join(dir, "link.json");
		symlinkSync(path, link);
		assert.match(policyProblem(link) ?? "", /is a symlink/);
		assert.match(policyProblem(join(dir, "missing.json")) ?? "", /cannot be read/);
		chmodSync(path, 0o444);
		assert.equal(readPolicy({ path, read: undefined }).mode, "refused");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("attended trust comes from config.json's link.trust; a sender with no entry, a bad id, or a bad level is not raised", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-link-trust-"));
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { trust: { [ctrl]: "forward", [other]: "dispatch", "short-id": "dispatch", ffffffffffffffffffffffffff: "root", gggggggggggggggggggggggggg: true } } }));
		const c = readLinkConfig(dir, { home: dir, agentDir: dir });
		assert.deepEqual([...c.trust], [[ctrl, "forward"], [other, "dispatch"]]);
		assert.equal(c.problems.length, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- Teams in the policy ---------------------------------------------------------------------------------------------------------------------------------

const hex = "0123456789abcdef0123456789abcdef", hex2 = "fedcba9876543210fedcba9876543210";
/** A real project folder (`projectProblem` wants it to exist) and a home folder apart from it. */
function folders(run: (project: string, dirs: { home: string; agentDir: string }) => void) {
	const dir = mkdtempSync(join(tmpdir(), "psb-link-policy-teams-"));
	try {
		const project = join(dir, "srv", "work"), home = join(dir, "home");
		mkdirSync(project, { recursive: true });
		mkdirSync(home, { recursive: true });
		run(project, { home, agentDir: join(home, ".pi", "agent") });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("an unattended policy carries its teams: an absolute project that passes projectProblem, share defaulting to status; a controller set to true is at dispatch", () => {
	folders((project, dirs) => {
		const p = readPolicy({ ...fs({ text: file({ trust: { [ctrl]: true }, teams: { [hex]: { project }, [hex2]: { project, share: "presence" } } }) }), ...dirs });
		assert.equal(p.mode, "unattended");
		if (p.mode !== "unattended") return;
		assert.deepEqual([...p.trust], [[ctrl, "dispatch"]]);
		assert.deepEqual([...p.teams], [[hex, { project, share: "status", name: "work" }], [hex2, { project, share: "presence", name: "work" }]]);
		const none = readPolicy({ ...fs({ text: file() }), ...dirs });
		assert.equal(none.mode === "unattended" && none.teams.size, 0, "no teams key means no teams, still unattended");
	});
});

test("a malformed teams makes the whole policy refused, with the reason", () => {
	folders((project, dirs) => {
		const refused = (teams: unknown, reason: RegExp) => {
			const p = readPolicy({ ...fs({ text: file({ teams }) }), ...dirs });
			assert.equal(p.mode, "refused");
			assert.match(p.mode === "refused" ? p.reason : "", reason);
		};
		refused([], /teams has to be an object/);
		refused("x", /teams has to be an object/);
		refused(null, /teams has to be an object/);
		refused({ [hex]: { project }, short: { project } }, /team short: the team id has to be 32 hex digits/);
		refused({ [hex]: {} }, /it has no project/);
		refused({ [hex]: { project: "work" } }, /absolute path/);
		refused({ [hex]: { project: "~/work" } }, /absolute path/);
		refused({ [hex]: { project: join(project, "missing") } }, /does not exist/);
		refused({ [hex]: { project: dirs.home } }, /home folder/);
		refused({ [hex]: { project, share: "all" } }, /share has to be/);
	});
});

test("readEffectiveConfig: the policy's teams and trust on an unattended device, config.json's link section ignored; config.json's on an attended one; nothing on a refused one", () => {
	folders((project, dirs) => {
		const state = join(dirs.home, "state");
		mkdirSync(state, { recursive: true });
		writeFileSync(join(state, "config.json"), JSON.stringify({ link: { relay: "http://r", trust: { [other]: "dispatch" }, teams: { [hex2]: { project } } } }));
		const un = readEffectiveConfig(readPolicy({ ...fs({ text: file({ trust: { [ctrl]: "forward" }, teams: { [hex]: { project } } }) }), ...dirs }), state, dirs);
		assert.deepEqual([...un.teams.keys()], [hex]);
		assert.deepEqual([...un.trust], [[ctrl, "forward"]]);
		assert.equal(un.relay, undefined);
		assert.deepEqual(un.problems, []);
		const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
		const at = readEffectiveConfig(readPolicy({ ...fs(), read: () => { throw missing; } }), state, dirs);
		assert.deepEqual([...at.teams.keys()], [hex2]);
		assert.equal(at.trust.get(other), "dispatch");
		const re = readEffectiveConfig({ mode: "refused", reason: "x" }, state, dirs);
		assert.equal(re.teams.size + re.trust.size, 0);
	});
});
