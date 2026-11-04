import { readFileSync } from "node:fs";

// Whether a restored subagent's session ends mid-turn, read from the jsonl pi keeps for it, and what to tell the child then.
//
// pi writes an assistant message when the model has finished it, before its tool calls run, and each tool result when the tool returns. A Herdr restart or a reboot in between leaves the
// transcript ending in an assistant tool call with no result (`call`), in a result the model never read (`result`), or in a message nobody answered (`prompt`). The restored pi waits at
// its prompt and does nothing of its own, so the child has to be told to go on. An assistant message that stopped for any other reason ended its turn (also an error or an abort, which a
// restart does not cause): nothing is said then. Only `message` entries count; a custom entry, a model change, or a system message says nothing of the turn.

export interface Cut {
	kind: "call" | "result" | "prompt";
	/** The tool calls with no result (`call`), or the tool whose result was not read (`result`). */
	tools: string[];
	/** When the last step of the transcript was recorded. */
	at: string;
}

/** The cut the session at `file` ends in, or undefined when it ends its turn, cannot be read, or has no step. */
export function cutOf(file: string): Cut | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const steps: { at: unknown; message: { role?: unknown; content?: unknown; stopReason?: unknown; toolName?: unknown; toolCallId?: unknown } }[] = [];
	for (const line of text.split("\n")) {
		try {
			const row = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: unknown };
			if (row.type === "message" && row.message && typeof row.message === "object") steps.push({ at: row.timestamp, message: row.message });
		} catch {} // a line cut off by the restart itself says nothing
	}
	const turn = steps.filter((s) => s.message.role === "user" || s.message.role === "assistant" || s.message.role === "toolResult");
	const last = turn.at(-1);
	if (!last || typeof last.at !== "string") return undefined;
	if (last.message.role === "user") return { kind: "prompt", tools: [], at: last.at };
	// The tool calls of the last assistant message that have no result after it; results come one by one, so the last step may be a result and calls still be open.
	const from = turn.findLastIndex((s) => s.message.role === "assistant");
	const calls = (from < 0 || !Array.isArray(turn[from]!.message.content) ? [] : (turn[from]!.message.content as unknown[])).filter((block): block is { id?: unknown; name?: unknown } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "toolCall");
	const answered = new Set(turn.slice(from + 1).filter((s) => s.message.role === "toolResult").map((s) => s.message.toolCallId));
	const open = calls.filter((c) => !answered.has(c.id));
	if (open.length) return { kind: "call", tools: open.map((c) => (typeof c.name === "string" ? c.name : "a tool")), at: last.at };
	if (last.message.role === "toolResult") return { kind: "result", tools: [typeof last.message.toolName === "string" ? last.message.toolName : "a tool"], at: last.at };
	return undefined;
}

const quote = (tools: string[]) => tools.map((t) => `\`${t}\``).join(", ");

/** What happened to the child's last turn, in a clause. */
export function describe(cut: Cut): string {
	if (cut.kind === "prompt") return "its last message got no answer";
	if (cut.kind === "result") return `the result of the tool call ${quote(cut.tools)} arrived, but its turn did not go on`;
	return `the tool ${cut.tools.length === 1 ? "call" : "calls"} ${quote(cut.tools)} got no result`;
}

/** The one message that tells a restored child its turn was cut, and to check before it re-runs anything. */
export function continueText(cut: Cut): string {
	const what = cut.kind === "prompt" ? "The last message you were given got no answer."
		: cut.kind === "result" ? `The result of the tool call ${quote(cut.tools)} arrived, but your turn did not go on.`
		: `The tool ${cut.tools.length === 1 ? "call" : "calls"} ${quote(cut.tools)} got no result.`;
	return `Straw Boss: your last turn was cut by a Herdr restart or reboot (your last recorded step was at ${cut.at}). ${what} Check the current state before re-running anything that changes state, then continue the task you were given and report your result.`;
}
