import { callControl } from "./server/socket.ts";
import { makeCtx, probe } from "./server/client.ts";
import { slotOf } from "./server/record.ts";
import { serverCli, VERSION } from "./server/version.ts";
import type { Ask } from "./host.ts";
import type { Kit } from "./state.ts";

/** A plain ask of the live sb server, for a session with no look at it (a subagent, which never starts one): it starts nothing and answers `no server` when none runs. */
export function serverAsk({ cfg, guiDir, me }: Pick<Kit, "cfg" | "guiDir" | "me">): Ask {
	return async (request) => {
		try {
			const ctx = makeCtx({ slot: slotOf(cfg.stateDir ?? guiDir, cfg.env), version: VERSION, cli: serverCli(), by: `session ${me().slice(0, 8) || "no id"} (auto mode)`, env: cfg.env, now: cfg.now }), seen = await probe(ctx);
			if (!seen.live || !seen.record) return { ok: false, error: "no server" };
			return (await callControl(seen.record.socket, seen.record.secret, { ...request, cmd: String(request.cmd) }, 10_000)).reply ?? { ok: false, error: "the sb server gave no answer" };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	};
}
