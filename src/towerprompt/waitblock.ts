import type { DigestRow } from "../server/waitlist.ts";
import type { Locale } from "./messages.ts";

// The lines that show the open wait cards of a tower where the boss is (docs/specs/2026-11-10-wait-cards-tui.md, §3): the stand-in prompt's block under its state line, and the widget above the editor of a run's pi in a standing
// pane. Both are drawn from the digest a poll carries (waitlist.ts) and say what the boss does and who raised it; neither carries a button. Plain Node and no pi package, like the rest of towerprompt/. Every field is cleaned again here: this
// is what reaches a terminal, and the stand-in writes it raw.

/** The most cards one block names; the rest are counted. */
export const BLOCK_MAX = 5;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
/** A field of the digest as one line of text, whatever it held. */
export const plain = (value: unknown, max = 200): string => String(value ?? "").replace(CONTROLS, "").slice(0, max);

const WORDS = {
	en: {
		title: (n: number) => `waits for you (${n})`, more: (n: number, command: string) => `${n} more: ${command}`, from: (who: string) => `from ${who}`, parked: "parked",
		type: { action: "action", choice: "choice", secret: "secret", legacy: "old" } as Record<string, string>, press: (command: string) => `${command} press a wait card`,
	},
	"zh-TW": {
		title: (n: number) => `等你處理（${n}）`, more: (n: number, command: string) => `還有 ${n} 張：${command}`, from: (who: string) => `由 ${who}`, parked: "已暫放",
		type: { action: "動作", choice: "選擇", secret: "密鑰", legacy: "舊式" } as Record<string, string>, press: (command: string) => `${command} 處理等你的卡片`,
	},
};

/** The block for a digest: its title, one line per card (at most `BLOCK_MAX`), and the line that counts the rest. Empty for none. `command` is what the boss types to press one (`/wait`, or `/boss wait` in a run's pi). */
export function waitBlock(rows: readonly DigestRow[], locale: Locale, command: string): string[] {
	if (!rows.length) return [];
	const w = WORDS[locale];
	const lines = rows.slice(0, BLOCK_MAX).map((r) => {
		const parts = [plain(r.do, 120), ...(r.from ? [w.from(plain(r.from, 60))] : []), ...(r.parked ? [w.parked] : [])];
		return `  ${plain(r.id, 12)} ${w.type[plain(r.type, 20)] ?? plain(r.type, 20)} · ${parts.join(" · ")}`;
	});
	return [w.title(rows.length), ...lines, ...(rows.length > BLOCK_MAX ? [`  ${w.more(rows.length - BLOCK_MAX, command)}`] : [])];
}
/** The hint row that says how to press a card. */
export const waitHint = (locale: Locale, command: string): string => WORDS[locale].press(command);
