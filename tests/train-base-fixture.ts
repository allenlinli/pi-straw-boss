import type { Pane, Session } from "../src/herdr.ts";

// A base with a tower and a train in a tab of its own, as the pure readers (stash.ts, closer.ts) see Herdr: panes, tabs, and live sessions, with every call recorded.

const at = (id: string, name: string, paneId: string): Session => ({ id, name, herdrLocation: { status: "ok", paneId, workspace: { id: "wA", label: "Base A" }, tab: { id: paneId === "wA:p1" ? "wA:t1" : "wA:t2", label: "x" } } as Session["herdrLocation"] });
const pi = (id: string, tab: string, role: string, tokens: Record<string, string> = {}): Pane => ({ pane_id: id, tab_id: tab, workspace_id: "wA", agent: "pi", agent_status: "idle", agent_session: { value: "/nonexistent/x.jsonl" }, cwd: "/w/alpha", tokens: { sb_role: role, ...tokens } });

export function trainBase() {
	const panes: Pane[] = [pi("wA:p1", "wA:t1", "tower"), pi("wA:p2", "wA:t2", "train", { sb_train: "acme/2026-11-06-m", sb_opened_by: "sender-1" })];
	const tabs = [{ tab_id: "wA:t1", workspace_id: "wA", label: "T" }, { tab_id: "wA:t2", workspace_id: "wA", label: "train 1106m" }];
	const ran: string[][] = [];
	const run = async (args: string[]) => {
		ran.push(args);
		const ok = (result: unknown) => JSON.stringify({ result });
		if (args[0] === "workspace" && args[1] === "list") return ok({ workspaces: [{ workspace_id: "wA", label: "Base A" }] });
		if (args[0] === "tab" && args[1] === "list") return ok({ tabs });
		if (args[0] === "pane" && args[1] === "list") return ok({ panes: args[3] ? panes.filter((p) => p.workspace_id === args[3]) : panes });
		return "{}";
	};
	const live = [at("tower", "tower · A", "wA:p1"), at("train-1", "train 1106m", "wA:p2")];
	return { panes, tabs, ran, run, live };
}
