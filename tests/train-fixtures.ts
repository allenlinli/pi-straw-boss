import type { Kind } from "../src/train/spec.ts";

// Builders shared by the train contract tests (train-*.test.ts). Hashes are plain repeated hex digits, never anything that looks like a credential.

export const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_C = "c".repeat(40);
export const CODE = "2026-11-06-m";
export type Json = Record<string, unknown>;

/** One run check with every required field. */
export const runCheck = (extra: Json = {}): Json => ({ type: "run", cwd: "/work/train", run: "npm test", log: "/work/train/unit.log", ...extra });

/** A well-formed `metadata.sb` of a train step; `over` replaces top-level keys, `spec` replaces keys of its spec. */
export function sb(over: Json = {}, spec: Json = {}): Json {
	return {
		v: 1, project: "acme", app: "web", train: CODE, round: 1, kind: "full-check" satisfies Kind, name: "unit",
		spec: { check: runCheck(), on: { head: SHA_A }, ...spec },
		...over,
	};
}

/** The result a step completes with. */
export const result = (over: Json = {}): Json => ({ outcome: "passed", evidence: "exit 0 in 18m", at: "2026-11-07T08:40:00Z", ...over });

/** A car slip in the block format of receive-car, with the two new lines. */
export function slip(over: Record<string, string | undefined> = {}): string {
	const f: Record<string, string | undefined> = {
		car: "web", tickets: "T-15", branch: "fix/t-15", head: SHA_A, "tested-on": SHA_B,
		review: `P0=0 P1=0 (/r/review.md)`, light: "pass (npm run check)",
		migrations: "none", lane: "normal",
		deploy: "none", departs: "next", accept: "/r/accept.json",
		auth: `"ship it"`, coordinator: "sess-coord-1",
		...over,
	};
	const line = (...keys: string[]) => keys.filter((k) => f[k] !== undefined).map((k) => `${k}: ${f[k]}`).join(" | ");
	const known = ["car", "tickets", "branch", "head", "tested-on", "review", "light", "migrations", "lane", "deploy", "departs", "accept", "uat", "auth", "coordinator"];
	return [line("car", "tickets", "branch", "head", "tested-on"), line("review", "light"), line("migrations", "lane"), line("deploy", "departs", "accept", "uat"), line("auth", "coordinator"), line(...Object.keys(f).filter((k) => !known.includes(k)))].filter(Boolean).join("\n");
}

/** An acceptance evidence file (§5.2); `entry` replaces keys of the first entry. */
export function evidence(over: Json = {}, entry: Json = {}): Json {
	return {
		v: 1, car: { app: "web", tickets: ["T-15"], branch: "fix/t-15", head: SHA_A },
		accepted: [{ kind: "e2e", what: "checkout flow, browser run", on: { head: SHA_A }, result: "passed", evidence: "/r/e2e.log", at: "2026-11-07T07:10:00Z", nod: "looks right, go", ...entry }],
		...over,
	};
}
