import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The head tower's `tower_send`: one workspace's tower, no broadcast and no device (headtools.ts); the server opens that tower when it has none and opens the ask. */
export function registerHeadSend(pi: ExtensionAPI, tool: (name: string, args: unknown, toolCallId?: string) => Promise<{ text: string; details?: unknown }>): void {
	pi.registerTool({
		name: "tower_send", label: "tower_send",
		description: "Forward a message to the tower of one workspace (its id or exact label; a sub workspace goes to its parent). The tower is opened when the workspace has none. Quote the boss's words and decisions verbatim. The result names the ask (H12) the tower's answer will carry; the answer comes back to you as a new event. You cannot send to every tower, to a teammate's device, or to a main.",
		parameters: Type.Object({
			workspace: Type.String({ description: "The workspace's id or exact label." }),
			message: Type.String({ description: "What the tower needs to do or know, 1 to 12,000 characters, the boss's instruction quoted verbatim." }),
			reply: Type.Optional(Type.Boolean({ description: "Whether the tower is asked to answer. Default true." })),
		}),
		execute: async (id, params) => {
			const done = await tool("tower_send", params, id);
			return { content: [{ type: "text", text: done.text }], details: done.details };
		},
	});
}
