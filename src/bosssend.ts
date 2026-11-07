// The words of `/boss send <name|key> [--after] <text>` and `/boss stop <name|key>`. One reader for the pi command (boss.ts) and for the server's text guard (control.ts), which must judge the text a `/boss send`
// will type the way the command reads it. A name with spaces is quoted: `/boss send "fix login" --after hi`.

export interface Send { query: string; after: boolean; text: string }

const TARGET = String.raw`(?:"([^"]+)"|(\S+))`;
const SEND = new RegExp(String.raw`^\s+${TARGET}\s+([\s\S]+)$`), STOP = new RegExp(String.raw`^\s+${TARGET}\s*$`), AFTER = /^--after(?:\s+([\s\S]*))?$/;

/** What follows `send`: the target, then `--after` when it comes first, then the text; undefined (the usage line) when the target or the text is missing, so `send foo --after` sends no `--after`. */
export function parseSend(rest: string | undefined): Send | undefined {
	const m = SEND.exec(rest ?? "");
	if (!m) return undefined;
	const flag = AFTER.exec(m[3]!), text = flag ? (flag[1] ?? "") : m[3]!;
	return text.trim() ? { query: (m[1] ?? m[2])!, after: flag !== null, text } : undefined;
}

/** What follows `stop`: the target alone; undefined (the usage line) for none or for words that are not one name. */
export function parseStop(rest: string | undefined): string | undefined {
	const m = STOP.exec(rest ?? "");
	return m ? (m[1] ?? m[2]) : undefined;
}
