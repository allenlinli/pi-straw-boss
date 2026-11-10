import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { type Pending, SECRET } from "./ask.ts";
import type { Post } from "./bosspaths.ts";
import type { Dlg } from "./bosslink.ts";
import { firstWord } from "./bossopen.ts";
import type { GuiRecord } from "./handover.ts";
import type { Lang } from "./memorycmd.ts";
import type { Net, Unit } from "./net.ts";
import { line, plain } from "./safetext.ts";
import type { Kit } from "./state.ts";

// `/boss answer [<name|key> [--cancel | <choice number | text>]]`: the boss's typed twin of the page's answer to a session's open dialog (a select, a confirm, or questions). The list reads the net as the page's own stream
// sends it (the first reading of `events`, which carries each waiting unit's `pending.answer`), and an answer posts to `sessions/<key>/answer`, the route the page posts to, so the server keeps every check: the
// digest of the question as shown, one open dialog per session, the choices a paired device may not make, the answer's own shape. This side words the list, builds the answer as `link answer` does (bosslink.ts), and asks first, on
// this computer only (hereOnly). A secret stays terminal-only (SB-F001, the boss's decision of 2026-11-10): a wait on a secret is listed as present and refused here, whatever `pending` carries, and no `value` is ever sent.
// It is the boss's typed input only: boss.ts refuses it in a tower run or an ally run, control.ts's BOSS_LOCAL keeps a paired device's composer from typing it, and no tool reaches this module. The units of an unattended box
// (operate) are left to the page. What a session wrote (its name, its question, its choices) is shown with control and bidi characters written out (safetext.ts).

const STREAM_MS = 8000, MAX_NET = 16 * 1024 * 1024, ANSWER_MS = 30_000;
const WORDS = {
	en: {
		usage: "/boss answer | answer <name|key> <choice number | text> | answer <name|key> (asks in pi) | answer <name|key> --cancel (quote a name that has spaces)",
		noScreen: "This needs the pi screen to ask you first",
		none: "No other session waits on a dialog",
		head: "Dialogs open in other sessions (answer with /boss answer <name|key> <choice number | text>):",
		unit: (name: string, base: string, key: string) => `  ${name} (in ${base}) [${key}]`,
		secret: "    it waits for a secret: only its terminal takes it, and /boss answer never does",
		cannot: (why: string) => `    it cannot be answered from here: ${why}`,
		several: "(several)",
		cancelLine: (name: string) => `    (cancel it: /boss answer "${name}" --cancel)`,
		noMatch: (q: string) => `No other session waits on a dialog under "${q}": /boss answer lists them`,
		many: (q: string, list: string) => `More than one session matches "${q}"; nothing was done. Say which (its key):\n${list}`,
		secretRefused: (name: string) => `${name} waits for a secret, and a secret is entered in its terminal only. Nothing was sent`,
		cannotRefused: (name: string, why: string) => `${name}'s dialog cannot be answered from here (${why}). Nothing was sent`,
		noCancel: "This dialog takes no cancel here",
		sendTitle: "Send this answer?",
		sendBody: (name: string, base: string, question: string, answer: string) => `${name} (in ${base}) waits on:\n${question}\n\nYour answer: ${answer}\n\nIt is sent to that session, which acts on it.`,
		cancelWord: "(cancel the dialog)",
		notSent: "Nothing was sent",
		sent: (name: string) => `Answered ${name}`,
		then: " It goes on in that session's terminal.",
		stale: (by: string) => `The dialog was closed already (${by}); nothing was changed`,
		unsure: "The session did not confirm the answer; look at its terminal",
		oldDialog: "The question changed or is no longer open; /boss answer lists what is open now",
	},
	"zh-TW": {
		usage: "/boss answer | answer <名稱|key> <選項編號 | 文字> | answer <名稱|key>（在 pi 裡問）| answer <名稱|key> --cancel（名稱含空白時加引號）",
		noScreen: "需要 pi 畫面才能先問你",
		none: "沒有其他工作階段在等對話框",
		head: "其他工作階段開著的對話框（用 /boss answer <名稱|key> <選項編號 | 文字> 回答）：",
		unit: (name: string, base: string, key: string) => `  ${name}（在 ${base}）[${key}]`,
		secret: "    它在等一個秘密：只有它自己的終端機能收，/boss answer 永遠不收",
		cannot: (why: string) => `    這裡無法回答：${why}`,
		several: "（可複選）",
		cancelLine: (name: string) => `    （取消它：/boss answer "${name}" --cancel）`,
		noMatch: (q: string) => `沒有名為「${q}」而且在等對話框的其他工作階段：/boss answer 會列出`,
		many: (q: string, list: string) => `「${q}」對到不只一個工作階段，什麼都沒做。請指明（用它的 key）：\n${list}`,
		secretRefused: (name: string) => `${name} 在等一個秘密，秘密只在它的終端機輸入。什麼都沒送出`,
		cannotRefused: (name: string, why: string) => `${name} 的對話框無法在這裡回答（${why}）。什麼都沒送出`,
		noCancel: "這個對話框在這裡不能取消",
		sendTitle: "要送出這個答案嗎？",
		sendBody: (name: string, base: string, question: string, answer: string) => `${name}（在 ${base}）在等：\n${question}\n\n你的答案：${answer}\n\n答案會送給那個工作階段，由它照著做。`,
		cancelWord: "（取消這個對話框）",
		notSent: "沒有送出",
		sent: (name: string) => `已回答 ${name}`,
		then: "接下來在那個工作階段的終端機繼續。",
		stale: (by: string) => `這個對話框已經結束（${by}），沒有改動任何東西`,
		unsure: "那個工作階段沒有確認答案，請看它的終端機",
		oldDialog: "問題已變動或已不在，/boss answer 會列出現在開著的",
	},
} as const;

/** The words after `/boss answer`: no session (the list), or one (quoted when it has spaces) and what to answer: nothing (pi asks), `--cancel`, or the choice number or text. */
export function parseAnswer(rest: string | undefined): { query: string; cancel: boolean; text: string } {
	const named = firstWord((rest ?? "").trim()), said = named.rest.trim();
	return { query: named.word, cancel: said === "--cancel", text: said === "--cancel" ? "" : said };
}

/** The net as the page's stream sends it: its first reading, then the stream is closed. `r.token` rides in the path only, as the page's own load does. */
export function readStream(r: GuiRecord, ms = STREAM_MS): Promise<Net> {
	return new Promise((done, fail) => {
		let over = false;
		const end = (result: Net | Error) => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			req.destroy();
			result instanceof Error ? fail(result) : done(result);
		};
		const timer = setTimeout(() => end(new Error("the GUI server did not send the net in time")), ms);
		const req = request({ host: "127.0.0.1", port: r.port, path: `/${r.token}/events`, headers: { host: `127.0.0.1:${r.port}`, accept: "text/event-stream" }, agent: false }, (res) => {
			if (res.statusCode !== 200) return end(new Error(`the GUI server answered ${res.statusCode}`));
			let text = "";
			res.setEncoding("utf8").on("data", (chunk: string) => {
				text += chunk;
				if (text.length > MAX_NET) return end(new Error("the net is too big to read here"));
				for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
					const rows = text.slice(0, at).split("\n");
					text = text.slice(at + 2);
					const event = rows.find((x) => x.startsWith("event: "))?.slice(7), data = rows.filter((x) => x.startsWith("data: ")).map((x) => x.slice(6)).join("\n");
					if (event === "problem") return end(new Error(data));
					if (event || !data) continue; // hello, ping
					try {
						const net = JSON.parse(data) as Net;
						return end(Array.isArray(net?.bases) ? net : new Error("the GUI server sent something that is no net"));
					} catch { return end(new Error("the GUI server sent something that is no net")); }
				}
			}).on("end", () => end(new Error("the GUI server closed the stream"))).on("error", () => end(new Error("the GUI server closed the stream")));
		});
		req.on("error", () => end(new Error("the GUI server did not answer")));
		req.end();
	});
}

interface Row { key: string; name: string; base: string; pending: Pending }
const flat = (units: Unit[]): Unit[] => units.flatMap((u) => [u, ...flat(u.subs)]);
/** The waiting units of this computer's bases (a box's are the page's: its operate session carries them), the tower and its subagents first in each base. */
function rows(net: Net, self: string): Row[] {
	const out: Row[] = [];
	for (const b of net.bases) {
		if (b.box) continue;
		for (const u of [...(b.tower ? [b.tower, ...flat(b.tower.subs)] : []), ...b.tabs.flatMap((tab) => flat(tab.units)), ...flat(b.outside)]) {
			if (u.pending && u.key !== self) out.push({ key: u.key, name: u.name, base: b.label, pending: u.pending });
		}
	}
	return out;
}
/** A wait on a secret: the secret_drop tool, or the reading dialogs.ts gives a secret dialog. Never answerable, whatever else `pending` carries. */
const secret = (p: Pending) => p.tool === "secret_drop" || p.why === SECRET;
/** The dialog as `link answer` builds an answer for it. */
const dialogOf = (p: Pending): Dlg | undefined => {
	const a = p.answer, cancel = a?.cancel === true;
	if (a?.select) return { kind: "select", title: a.select.title, choices: a.select.choices.map((c) => c.label), cancel };
	return a?.questions ? { kind: "questions", qs: a.questions.map((q) => ({ question: q.question, multiple: q.multiple, options: q.options.map((o) => o.title) })), cancel } : undefined;
};

export interface AnswerDeps {
	/** The server's recorded GUI, or the refusal in the boss's words. */
	record(): Promise<GuiRecord>;
	post: Post;
	why(reply: { status: number; body: Record<string, unknown> }): string;
	/** Asked on this computer only: a paired device cannot answer it (`hereOnly`). */
	confirm(title: string, body: string, here?: boolean): Promise<boolean>;
	lang(): Lang;
	/** bosslink.ts's `build`: the boss's answer to a dialog, from the typed words or from pi's own prompts. */
	build(d: Dlg, text: string): Promise<{ answer: Record<string, unknown>; said: string } | string | undefined>;
	/** The net as the page's stream reads it. */
	net?(r: GuiRecord): Promise<Net>;
}

export function createBossAnswer({ s, tell, me }: Pick<Kit, "s" | "tell" | "me">, { record, post, why, confirm, lang, build, net = readStream }: AnswerDeps) {
	const t = () => WORDS[lang()];
	const label = (x: Row) => `  ${line(x.name)} (in ${line(x.base)}) [${x.key}]`;
	return async function answer(query: string, cancel: boolean, text: string) {
		const r = await record(), all = rows(await net(r), me());
		if (!query) {
			if (!all.length) return tell(t().none);
			return tell([t().head, ...all.flatMap((x) => {
				const d = dialogOf(x.pending), head = t().unit(line(x.name), line(x.base), x.key);
				if (secret(x.pending)) return [head, t().secret];
				if (!d) return [head, t().cannot(line(x.pending.why ?? "it waits on a dialog"))];
				const numbered = (options: string[]) => options.map((o, i) => `      ${i + 1}. ${line(o)}`);
				const body = d.kind === "select" ? [`    ${plain(d.title)}`, ...numbered(d.choices)] : d.qs.flatMap((q, i) => [`    ${d.qs.length > 1 ? `${i + 1}) ` : ""}${plain(q.question)}${q.multiple ? ` ${t().several}` : ""}`, ...numbered(q.options)]);
				return [head, ...body, ...(d.cancel ? [t().cancelLine(line(x.name))] : [])];
			})].join("\n"));
		}
		const low = query.toLowerCase(), hit = all.filter((x) => x.name.toLowerCase() === low || x.key === query || (query.length >= 6 && x.key.startsWith(query)));
		if (hit.length !== 1) return tell(hit.length ? t().many(query, hit.map(label).join("\n")) : t().noMatch(query), "error");
		const [at] = hit, name = line(at!.name), p = at!.pending, a = p.answer;
		if (secret(p)) return tell(t().secretRefused(name), "error");
		const d = dialogOf(p);
		if (!a || !d) return tell(t().cannotRefused(name, line(p.why ?? "it waits on a dialog")), "error");
		if (!s.ui) return tell(t().noScreen, "error");
		if (cancel && !d.cancel) return tell(t().noCancel, "error");
		const built = cancel ? { answer: { cancel: true }, said: t().cancelWord } : await build(d, text);
		if (built === undefined) return tell(t().notSent);
		if (typeof built === "string") return tell(built, "error");
		const question = d.kind === "select" ? plain(d.title) : d.qs.map((q) => plain(q.question)).join("\n");
		if (!(await confirm(t().sendTitle, t().sendBody(name, line(at!.base), question, built.said), true))) return tell(t().notSent);
		// The digest is the question's as it was read above and shown: the server refuses the answer when the dialog has since changed.
		const reply = await post(r, `sessions/${encodeURIComponent(at!.key)}/answer`, { dialog: a.dialog, digest: a.digest, answerId: randomUUID().replace(/-/g, ""), ...built.answer }, ANSWER_MS);
		if (reply.status !== 200) return tell(reply.status === 409 && reply.body.error === "changed" ? t().oldDialog : why(reply), "error");
		const { outcome, reason, by } = reply.body as { outcome?: string; reason?: string; by?: string };
		if (outcome === "accepted") return tell(`${t().sent(name)}${reply.body.then ? t().then : ""}`);
		tell(outcome === "stale" ? t().stale(line(String(by ?? "gone"))) : outcome === "unknown" ? t().unsure : line(String(reason ?? outcome ?? "")), "error");
	};
}
