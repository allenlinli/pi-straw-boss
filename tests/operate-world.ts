import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import { canonical } from "../src/history.ts";
import type { Editor } from "../src/probe.ts";
import type { Found, Net, Unit } from "../src/net.ts";
import type { OperateScope } from "../src/operateroutes.ts";
import { header, lines, user } from "./sessions.ts";

// A box's GUI for the operate seam (docs/specs/2026-11-07-link-operate.md §6): a server with a net of three tabs, a fake Herdr that records every call, a hub whose probe records what it was asked,
// and fakes of every side-effecting dep (spawn, close, link, trust, server, towers, dismiss) that record theirs. A request the seam refuses leaves `calls` and `effects` empty.

const scratch = mkdtempSync(join(tmpdir(), "psb-operate-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

export const unit = (key: string, over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark: "idle", subs: [], ...over });
/** Base wA: tab t1 holds sess-1, tab t2 holds other-1 (another team's), tab t3 holds both. */
export const NET = (): Net => ({
	bases: [{ id: "wA", label: "billing", mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: "t1", label: "one", units: [unit("sess-1")] }, { id: "t2", label: "two", units: [unit("other-1")] }, { id: "t3", label: "three", units: [unit("sess-1"), unit("other-1")] }] }],
});
/** The scope of an operator who reaches `keys` (and the box's own units when `box`). */
export const scopeOf = (keys: string[], box = false): OperateScope => ({ box, has: (key) => keys.includes(key) });

export interface Probe { key: string; nonce: string | undefined; flags: unknown }
export async function world(opts: { editor?: Editor | undefined; status?: string } = {}) {
	const editor = "editor" in opts ? opts.editor : ({ editor: "empty" } as Editor), status = opts.status ?? "idle"; // `editor: undefined` is a bridge that did not answer
	const path = join(scratch, `op-${Math.random().toString(36).slice(2)}_sess-1.jsonl`);
	writeFileSync(path, lines([header(), user("u1", null, "go")]));
	const file = canonical(path)!, calls: [string, Record<string, unknown>][] = [], effects: unknown[][] = [], probes: Probe[] = [];
	const w = { editor, status, relayed: false, answerable: false, choices: [{ label: "Allow", hereOnly: true }, { label: "Deny" }, { label: "Open a pane", next: "pane" }, { label: "Put it in my prompt", next: "terminal" }] as { label: string; hereOnly?: boolean; next?: "pane" | "terminal" }[], sent: 0 };
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, params]);
		if (method === "pane.get") return { pane: { pane_id: "wA:p1", agent: "pi", agent_status: w.status, agent_session: { value: file } } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: "wA:p1", rect: { width: 40 } }] } };
		return method === "pane.read" ? { read: { text: "pi\r\n> " } } : {};
	};
	const target = (): Target => ({ from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), cancel: true, select: { title: "T", choices: w.choices } } }) as Target;
	const hub = { running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }), has: (_key: string, owner: string) => w.relayed && owner === "straw-link-request", replay: () => undefined, ended: () => undefined, send: async () => (w.sent++, { status: 200, body: { outcome: "accepted" } }), target: () => (w.answerable ? target() : undefined), probe: async (key: string, nonce?: string, flags?: unknown) => (probes.push({ key, nonce, flags }), w.editor), commands: async () => [{ name: "compact", description: "" }], pull: async () => ({ pending: false }) };
	const found = (key: string): Found | undefined => (["sess-1", "other-1"].includes(key) ? { key, base: "wA", name: key, role: "main", file, pane: "wA:p1", live: true } : undefined);
	const tower = { has: () => true, live: () => false, event: async (...a: unknown[]) => (effects.push(["tower.event", ...a]), { ok: true }), act: async (...a: unknown[]) => (effects.push(["tower.act", ...a]), { ok: true }), conversation: async (...a: unknown[]) => (effects.push(["tower.conversation", ...a]), { ok: true, left: true }), memory: async (...a: unknown[]) => (effects.push(["tower.memory", ...a]), { status: 200, body: {} }), isHead: () => false };
	const gui = await startGui({
		read: async () => NET(), net: { lookup: found, workspace: (id) => (id === "wA" ? ["sess-1", "other-1"].map((key) => ({ key, base: "wA", name: key, role: "main", file })) : []), dismiss: (key) => (effects.push(["dismiss", key]), true), dismissAll: () => (effects.push(["dismissAll"]), 1) },
		call, hub: hub as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 50,
		spawn: async (parts, json) => (effects.push(["spawn", parts, json]), { status: 200, body: {} }),
		close: async (kind, json) => (effects.push(["close", kind, json]), { status: 200, body: {} }),
		link: { call: async (name) => (effects.push(["link", name]), { ok: true }), enable: async () => void effects.push(["link", "enable"]) },
		trust: { answer: async (json) => (effects.push(["trust", json]), { status: 200, body: {} }), watch: () => () => {} },
		server: { status: () => (effects.push(["server.status"]), {}), restart: async (r) => (effects.push(["server.restart", r]), { status: 200, body: {} }), log: () => (effects.push(["server.log"]), []) },
		tower,
		onRemote: async () => void effects.push(["remote.on"]),
	});
	running.push(gui);
	const seen: [string, string, unknown][] = [], session = gui.operate.open((id, event, data) => void seen.push([id, event, data]));
	const wait = async (what: () => boolean) => { for (let i = 0; i < 150 && !what(); i++) await new Promise((r) => setTimeout(r, 20)); if (!what()) throw new Error("timed out"); };
	/** What reached Herdr apart from reading the pane's state. */
	const typed = () => calls.filter(([m]) => !["pane.get", "pane.layout", "pane.read"].includes(m));
	/** The pad's key, as the controller's page would send it (its own stream id, which the box replaces with the session's). */
	const key = (session_: typeof session, scope: OperateScope, k: string, extra: Record<string, unknown> = {}) => session_.request("POST", ["sessions", "sess-1", "keys"], new URLSearchParams(), { key: k, stream: "page-stream", ...extra }, scope);
	const attach = async (scope: OperateScope) => {
		const done = await session.mirror("sess-1", true, scope);
		if (done.status !== 200) throw new Error(JSON.stringify(done));
		await wait(() => seen.some(([id, e]) => id === "m:sess-1" && e === "mirror"));
	};
	return { gui, operate: gui.operate, session, seen, calls, effects, probes, w, typed, key, attach, wait };
}
