import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionAPI, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannedInMessage } from "../src/planmsg.ts";

// docs/specs/2026-11-09-agent-kinds.md §2a, AK7-F002 and AK8-F005: the same-message plan read, once on its own and once against the pinned pi's own agent loop, which is the tripwire for a pi bump (AGENTS.md "Bumping pi").

const msg = (...content: unknown[]) => [{ type: "message", message: { role: "assistant", content } }];
const todo = (args: unknown, id = "t") => ({ type: "toolCall", id, name: "todo", arguments: args });
const worker = { type: "toolCall", id: "w", name: "subagent", arguments: { agent: "worker" } };

test("plannedInMessage: the three todo shapes, JSON-string arguments, order, a codemode call, and no graph", () => {
	const yes = (...c: unknown[]) => plannedInMessage(msg(...c), "w");
	assert.equal(yes(todo({ action: "create", subject: "p", metadata: { graph: "fan-out" } }), worker), true);
	assert.equal(yes(todo({ action: "create", tasks: [{ subject: "p", metadata: { graph: "orchestrator-worker" } }] }), worker), true);
	assert.equal(yes(todo({ action: "update", id: 1, metadata: { graph: "single-loop" } }), worker), true);
	assert.equal(yes(todo(JSON.stringify({ action: "create", tasks: JSON.stringify([{ subject: "p", metadata: { graph: "fan-out" } }]) })), worker), true, "tasks as a JSON string, as models send it");
	assert.equal(yes(todo({ action: "create", subject: "p", metadata: JSON.stringify({ graph: "fan-out" }) }), worker), true, "metadata as a JSON string");
	assert.equal(yes(worker, todo({ action: "create", subject: "p", metadata: { graph: "fan-out" } })), false, "a todo after the call does not count");
	assert.equal(yes(todo({ action: "create", subject: "p", metadata: { graph: "chain" } }), worker), false);
	assert.equal(yes(todo("{not json"), worker), false);
	assert.equal(plannedInMessage(msg(todo({ action: "create", subject: "p", metadata: { graph: "fan-out" } }), worker), "w", "parent-1"), false, "a codemode call is in no message: state alone judges it");
	assert.equal(plannedInMessage([], "w"), false);
});

// A real pi agent session with a faux model: one assistant message holds a todo call and a subagent call, run by pi's own loop in parallel; the gate is sb's, reading the branch pi keeps.
async function gated(order: "todo-first" | "todo-last") {
	const root = mkdtempSync(join(tmpdir(), "sb-planmsg-")), agentDir = join(root, "agent"), project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	try {
		const faux = createFauxCore({ models: [{ id: "faux-1" }] });
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("faux", { api: faux.api as never, baseUrl: "http://faux.invalid", apiKey: "x", streamSimple: faux.streamSimple as never, models: [{ id: "faux-1", name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4000 }] });
		const seen: string[] = [];
		const loader = new DefaultResourceLoader({
			cwd: project, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi: ExtensionAPI) => {
				for (const name of ["todo", "subagent"]) pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}, { additionalProperties: true }), execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: undefined }) });
				pi.on("tool_call", (event, ctx) => {
					if (event.toolName !== "subagent") return undefined;
					const planned = plannedInMessage(ctx.sessionManager.getBranch(), event.toolCallId, (event as { parentToolCallId?: string }).parentToolCallId);
					seen.push(planned ? "planned" : "blocked");
					return planned ? undefined : { block: true, reason: "plan first" };
				});
			}],
		});
		await loader.reload();
		const { session } = await createAgentSession({ cwd: project, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "faux-1")!, resourceLoader: loader, sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({}) } as never);
		await session.bindExtensions({ shutdownHandler: () => {} } as never);
		const plan = fauxToolCall("todo", { action: "create", subject: "p", metadata: { graph: "fan-out" } }), dispatch = fauxToolCall("subagent", { agent: "worker" });
		faux.setResponses([fauxAssistantMessage(order === "todo-first" ? [plan, dispatch] : [dispatch, plan]), fauxAssistantMessage("finished")]);
		await session.prompt("go");
		session.dispose();
		return seen;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("against pinned pi's own agent loop: a todo call with a graph before the subagent call in one assistant message is on the branch when the tool_call handler runs; one after it is not counted", async () => {
	assert.deepEqual(await gated("todo-first"), ["planned"]);
	assert.deepEqual(await gated("todo-last"), ["blocked"]);
});
