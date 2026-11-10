import type { Mark } from "../src/netdata.ts";
import type { Base, Net, RemoteBox, Unit } from "../src/net.ts";

// The demo's remote (operate) bases for `npm run gui:dev` (docs/specs/2026-11-07-link-operate.md §8): `?operate=<list>`, with `live` (agent-tower-01: one working main that asks a question, a member, a finished subagent, the Earlier runs fold and the box's ally card folded in),
// `unreachable` (agent-tower-02, last seen four minutes ago; its main asks a question, which takes no answer), `revoked` (agent-tower-03, the grant withdrawn), `refused` (agent-tower-04, the box does not let this device operate), `more` (live with 53 finished runs: the fold's Show more), or `all`. Without the parameter the demo has none.
// Keys and ids are the controller's own form (`x` and 16 hex); the box's words are plain text.

export const BOX_SCENES = ["live", "unreachable", "revoked", "refused", "more"] as const;
type Scene = (typeof BOX_SCENES)[number];
const hex = (n: number) => `x${n.toString(16).padStart(16, "0")}`;
const CAN = ["history", "input", "keys", "answer", "dequeue", "commands", "upload", "mirror", "dismiss", "close-unit", "close-tab"];
const unit = (n: number, name: string, role: Unit["role"], mark: Mark, note?: string, over: Partial<Unit> = {}): Unit => ({ id: hex(n), key: hex(n), control: true, name, role, mark, note, subs: [], ...over });
const box = (device: string, short: string, label: string, over: Partial<RemoteBox> = {}): RemoteBox => ({ device, short, label, team: "moldplan", scope: "team", can: CAN, state: "live", ...over });
const bare = (id: number, label: string, b: RemoteBox): Base => ({ id: hex(id), label, mark: "unknown", tower: null, tabs: [], outposts: [], outside: [], box: b });

/** The remote bases for the scenes in `param` (a comma list, or `all`), appended to the local ones. */
export function boxDemo(net: Net, param: string | null, now = Date.now()) {
	const want = new Set<Scene>(param === null ? [] : param === "all" || param === "" ? BOX_SCENES.filter((s) => s !== "more") : (param.split(",").filter((s): s is Scene => (BOX_SCENES as readonly string[]).includes(s))));
	if (want.has("more")) want.add("live");
	const ask = { callId: "demo-box-1", tool: "ask_user_question", asks: [{ header: "Window", question: "Run the nightly export on the box tonight?", options: [{ title: "Tonight 23:00" }, { title: "Tomorrow 06:00" }], multiple: false, freeform: true }], answer: { dialog: "dbox1", digest: "0".repeat(64), cancel: true as const, questions: [{ header: "Window", question: "Run the nightly export on the box tonight?", options: [{ title: "Tonight 23:00" }, { title: "Tomorrow 06:00" }], multiple: false, freeform: true }] } };
	if (want.has("live")) {
		net.bases.push({
			id: hex(1), label: "Work", mark: "waiting", tower: null, outposts: [], outside: [], box: box("boxd1", "7c2e90", "agent-tower-01"),
			tabs: [{ id: hex(11), label: "exports", units: [
				unit(21, "export-main", "main", "waiting", "waiting on a question", { pending: ask, duty: "integrator", todo: { done: 1, total: 3, now: "Preparing the nightly export" } }),
				unit(22, "export-checks", "member", "idle"),
				unit(23, "export-old", "main", "done", "finished", { ended: true, control: false }),
			] }, { id: hex(12), label: "reports", units: [unit(24, "report-main", "main", "working", "tool:read", { duty: "coordinator", subs: [unit(25, "report-scan", "subagent", "done", "finished", { ended: true })] })] }],
		});
		// The box's own ally card (its unit-status, folded under the base while the session is live): a notice of the box and its units' states.
		net.link ??= { allies: [], alerts: [], confirms: [], units: [] } as never;
		net.link!.allies.push({ id: "t/boxd1/Work", team: "t", teamName: "moldplan", device: "boxd1", short: "7c2e90", label: "agent-tower-01", online: true, unattended: true, workspace: "Work", tower: "working", tabs: [{ label: "exports", state: "blocked" }, { label: "reports", state: "working" }] } as never);
		net.link!.units.push({ team: "t", device: "boxd1", at: now - 20_000, units: [{ unit: "Work", state: "running", monitors: ["nightly export"], report: "Nightly export queued.\nWaiting for the window." }] } as never);
	}
	if (want.has("unreachable")) net.bases.push({ ...bare(2, "Build farm", box("boxd2", "3d19ab", "agent-tower-02", { state: "unreachable", seen: now - 4 * 60_000 })), mark: "working", tabs: [{ id: hex(31), label: "ci", units: [unit(41, "ci-main", "main", "waiting", "waiting on a question", { pending: ask }), unit(42, "ci-lint", "member", "idle")] }] });
	if (want.has("revoked")) net.bases.push(bare(3, "agent-tower-03", box("boxd3", "55f0c2", "agent-tower-03", { state: "ended", why: "policy", can: [], team: "moldplan" })));
	if (want.has("refused")) net.bases.push(bare(4, "agent-tower-04", box("boxd4", "a8e641", "agent-tower-04", { state: "ended", why: "not-granted", can: [], team: "moldplan" })));
	const names = ["nightly export", "invoice scan <img src=x onerror=alert(1)>", "schema check", "release notes", "backup verify", "log sweep"];
	const run = (i: number) => ({ key: hex(0x100 + i), name: names[i % names.length]!, role: (["main", "run", "ally"] as const)[i % 3]!, workspace: "Work", first: now - (i + 1) * 3_600_000 - 900_000, last: now - (i + 1) * 3_600_000, size: 2048 + i * 311, ...(i % 2 ? { dispatcher: "ci-box" } : {}) });
	const total = want.has("more") ? 53 : 3;
	const known = (key: string) => /^x[0-9a-f]{16}$/.test(key) && parseInt(key.slice(1), 16) >= 0x100 && parseInt(key.slice(1), 16) < 0x100 + total;
	return {
		/** What the box's history event says of a finished run's key (the ledger's name and role; it is not live), so its comms view is named for it. */
		info: (key: string) => (known(key) ? { name: run(parseInt(key.slice(1), 16) - 0x100).name, role: "member", state: "recent" } : {}),
		/** `api/<path>` for the demo: the finished runs of the live base, 50 to a page. */
		api(path: string): unknown | undefined {
			const m = /^transcripts\?base=(x[0-9a-f]{16})(?:&before=(.*))?$/.exec(path);
			if (!m) return undefined;
			if (m[1] !== hex(1)) return { rows: [] };
			const start = m[2] ? 50 : 0, end = Math.min(total, start + 50);
			return { rows: Array.from({ length: end - start }, (_, i) => run(start + i)), ...(end < total ? { before: `${now}:${hex(0x100 + end - 1)}` } : {}) };
		},
	};
}
