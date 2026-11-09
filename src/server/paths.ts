import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the sb server's state lives, and where pi-intercom is.

/** The `straw-boss` directory of pi's agent directory, where the GUI's record and the server's files live. */
export const stateDirOf = (env: NodeJS.ProcessEnv = process.env) => join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "straw-boss");

/** pi-intercom's directory: named by STRAW_BOSS_INTERCOM, else beside this package (both live in pi's npm node_modules), else in the agent directory's npm node_modules. */
export function findIntercom(env: NodeJS.ProcessEnv = process.env, here = dirname(fileURLToPath(import.meta.url))): string {
	const agent = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const found = [env.STRAW_BOSS_INTERCOM, join(here, "..", "..", "..", "pi-intercom"), join(agent, "npm", "node_modules", "pi-intercom")].find((dir) => dir && existsSync(join(dir, "broker", "client.ts")));
	if (!found) throw new Error("pi-intercom (>= 0.17.1) was not found: install it with pi, or name its directory in STRAW_BOSS_INTERCOM");
	return found;
}
