import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { TrustPrompt } from "./deploy.ts";
import type { GuiRecord } from "./handover.ts";
import type { LinkView } from "./link/holder.ts";
import { hereOnlyOpts } from "./intercept.ts";
import type { Lang } from "./memorycmd.ts";
import type { Kit } from "./state.ts";

// The boss's typed twins of the page's + Base, + Member, + Main (`/boss open base|member|main`) and of the Straw Link join requests (`/boss link [status]`, `link decide <id> approve|refuse`). Like bosspaths.ts
// each posts to the route the page posts to, so the server keeps every check (a folder under home, one opening at a time, project trust, who may decide a join request); this side parses the line, words the
// answer, and asks in pi what the page asks in its dialogs. They are the boss's typed input only: boss.ts refuses them in a tower run or an ally run, and no tool reaches this module. A paired device may open and
// read the teams (the routes allow it) but not decide: `link decide` is in control.ts's BOSS_LOCAL.

const OPEN_MS = 12 * 60_000, POLL_MS = 500, SHOWN = 5;
type Reply = { status: number; body: Record<string, unknown> };
type Post = (record: GuiRecord, path: string, json: Record<string, unknown>, timeoutMs: number) => Promise<Reply>;
const WORDS = {
	en: {
	openUsage: "/boss open base <dir> [label] | open member [dir] | open main <dir> [prompt]: a new base with one member, a member (beside this session, or in a tab of its own in <dir>), or a main in a tab of this base",
		openNeedDir: (kind: string) => `open ${kind} needs a folder: /boss open ${kind} <dir>`,
		openNoDir: (d: string) => `"${d}" is not a folder`,
		openNoBase: "This session is not in a base yet, so there is nothing to add a unit to",
		openMemberText: "open member takes only a folder; the first message goes to the member once it is open",
		opening: (kind: string, name: string) => `Opening ${kind} ${name}…`,
		kindBase: "base", kindMain: "main", kindMember: "member",
		opened: (kind: string, name: string, session: unknown) => `Opened ${kind} ${name}${typeof session === "string" ? ` (session ${session})` : ""}`,
		openFailed: (step: string, why: string) => `Failed at "${step}": ${why}`,
		openTimeout: "The server did not answer in time. The unit may still open: look at the map",
		steps: { createBase: "Create the base", createTab: "Open a tab", createPane: "Split a pane", start: "Start the agent", join: "Join the Straw Net", deliver: "Deliver the task", trust: "Waiting for your OK to trust this folder" } as Record<string, string>,
		trustTitle: "Trust this folder?",
		trustBody: "Trusting lets the agent load this folder's settings, extensions, skills, prompts, themes, and MCP servers, and install the packages its settings list. Extensions and MCP servers run as programs on this computer. Do not trust a folder you do not know.",
		trustFound: "It would load:",
		trustMore: (n: number) => `${n} more`,
		trustUnreadable: "unreadable",
		trustChoices: { trust: "Trust this folder", once: "Trust it this once", no: "Do not trust" } as Record<string, string>,
		trustAnswered: "Answered",
		trustStale: "Already answered in the terminal",
		trustGone: "The agent ended before the answer arrived; nothing was decided",
		trustChanged: "The folder changed after the question was shown, so the answer was not used; the new question is shown next",
		trustBusy: "The answer is being taken; try again in a moment",
		trustUnknown: "The answer was not confirmed; look at the opening",
		trustNoScreen: "The new pi waits on a trust question; answer it in the GUI or in its terminal (this session has no pi screen to ask in)",
		linkUsage: "/boss link [status] | link decide <id> approve|refuse | confirms | confirm <id> allow|deny | asks | answer <id> <choice number | text> | invite show|cancel <hash> | join <invite|@file> | join cancel | create <relay> <dir> | leave <team>",
		linkOff: "Straw Link is not on in this server",
		linkDevice: (label: string, short: string) => `This device: ${label} (${short})`,
		linkNoTeams: "No team yet",
		linkTeam: (name: string, role: string, running: boolean, why: string) => `Team ${name}: you are ${role}; ${running ? "running" : `stopped${why ? ` (${why})` : ""}`}`,
		linkMember: (label: string, short: string, role: string, attended: boolean, online: boolean, self: boolean) => `  ${label} (${short}) · ${role} · ${attended ? "attended" : "unattended"} · ${self ? "this computer" : online ? "online" : "offline"}`,
		linkNoRequests: "No join request is waiting",
		linkRequests: "Join requests waiting (decide with /boss link decide <id> approve|refuse):",
		linkRequest: (id: string, label: string, short: string, team: string, unattended: boolean) => `  ${id}  ${label} (${short}) asks to join ${team}${unattended ? " · unattended" : ""}`,
		linkNoRequest: (q: string) => `No join request is waiting under "${q}": /boss link lists them`,
		linkManyRequests: (q: string) => `More than one join request starts with "${q}"; nothing was done. Give more of the id`,
		linkRoleAdmin: "admin", linkRoleMember: "member",
		linkApproveUnattended: (label: string, short: string, team: string) => `${label} (${short}) is an unattended device (nobody operates it) and asks to join the team ${team}. The device id in the invite stands in for the four words. Let it join?`,
		linkApproveTitle: "Let this device join?",
		linkWords: (label: string, short: string, team: string) => `${label} (${short}) asks to join the team ${team}. Look at ${label}'s screen and choose the four words it shows. A wrong choice ends the invite.`,
		linkNone: "None of these: refuse",
		linkJoined: (label: string, team: string) => `${label} joined ${team}`,
		linkRefused: (label: string) => `Refused ${label}: nobody joined`,
		linkDeclined: "Nothing was decided",
	},
	"zh-TW": {
	openUsage: "/boss open base <資料夾> [名稱] | open member [資料夾] | open main <資料夾> [提示]：開新基地（含一位成員）、加一位成員（在本工作階段旁，或在 <資料夾> 的新分頁），或在本基地開一位主智慧體",
		openNeedDir: (kind: string) => `open ${kind} 需要資料夾：/boss open ${kind} <資料夾>`,
		openNoDir: (d: string) => `「${d}」不是資料夾`,
		openNoBase: "本工作階段還不在任何基地裡，沒有地方可以加單位",
		openMemberText: "open member 只接資料夾；第一則訊息等成員開好後再交給它",
		opening: (kind: string, name: string) => `正在開啟${kind} ${name}…`,
		kindBase: "基地", kindMain: "主智慧體", kindMember: "成員",
		opened: (kind: string, name: string, session: unknown) => `已開啟${kind} ${name}${typeof session === "string" ? `（工作階段 ${session}）` : ""}`,
		openFailed: (step: string, why: string) => `在「${step}」失敗：${why}`,
		openTimeout: "伺服器沒有及時回應。單位可能仍會開好，請看地圖確認",
		steps: { createBase: "建立基地", createTab: "開啟分頁", createPane: "分割窗格", start: "啟動智慧體", join: "加入稻草網", deliver: "交付任務", trust: "等你確認是否信任這個資料夾" } as Record<string, string>,
		trustTitle: "要信任這個資料夾嗎？",
		trustBody: "信任後，智慧體會載入這個資料夾的設定、擴充、技能、提示、佈景主題與 MCP 伺服器，並安裝設定裡列出的套件。擴充與 MCP 伺服器會在這台電腦上當成程式執行。不認得來源的資料夾，請不要信任。",
		trustFound: "會載入的內容：",
		trustMore: (n: number) => `還有 ${n} 項`,
		trustUnreadable: "讀不出來",
		trustChoices: { trust: "信任這個資料夾", once: "只信任這一次", no: "不信任" } as Record<string, string>,
		trustAnswered: "已回答",
		trustStale: "已在終端機回答",
		trustGone: "代理在答案送達前已結束，沒有做任何決定",
		trustChanged: "問題顯示後資料夾又變了，所以沒有採用你的答案；接著會顯示新的問題",
		trustBusy: "正在處理答案，請稍後再試",
		trustUnknown: "答案沒有得到確認，請看這次開啟的結果",
		trustNoScreen: "新的 pi 在等信任問題；請在 GUI 或它的終端機回答（本工作階段沒有 pi 畫面可以問）",
		linkUsage: "/boss link [status] | link decide <id> approve|refuse | confirms | confirm <id> allow|deny | asks | answer <id> <選項編號 | 文字> | invite show|cancel <hash> | join <邀請|@檔案> | join cancel | create <中繼站> <資料夾> | leave <團隊>",
		linkOff: "這個伺服器沒有開 Straw Link",
		linkDevice: (label: string, short: string) => `本裝置：${label}（${short}）`,
		linkNoTeams: "還沒有團隊",
		linkTeam: (name: string, role: string, running: boolean, why: string) => `團隊 ${name}：你是${role}；${running ? "運作中" : `已停止${why ? `（${why}）` : ""}`}`,
		linkMember: (label: string, short: string, role: string, attended: boolean, online: boolean, self: boolean) => `  ${label}（${short}）· ${role} · ${attended ? "有人值守" : "無人值守"} · ${self ? "這台電腦" : online ? "在線" : "離線"}`,
		linkNoRequests: "沒有等待中的加入要求",
		linkRequests: "等待中的加入要求（用 /boss link decide <id> approve|refuse 決定）：",
		linkRequest: (id: string, label: string, short: string, team: string, unattended: boolean) => `  ${id}  ${label}（${short}）要求加入 ${team}${unattended ? " · 無人值守" : ""}`,
		linkNoRequest: (q: string) => `沒有以「${q}」開頭的加入要求：/boss link 會列出`,
		linkManyRequests: (q: string) => `不只一個加入要求的 id 以「${q}」開頭，什麼都沒做。請多給幾碼`,
		linkRoleAdmin: "管理員", linkRoleMember: "成員",
		linkApproveUnattended: (label: string, short: string, team: string) => `${label}（${short}）是無人值守的裝置（沒有人在操作），要求加入團隊 ${team}。邀請裡的裝置 id 取代了四個單字的比對。要讓它加入嗎？`,
		linkApproveTitle: "要讓這台裝置加入嗎？",
		linkWords: (label: string, short: string, team: string) => `${label}（${short}）要求加入團隊 ${team}。看 ${label} 的螢幕，選它顯示的那一組四個單字。選錯會結束這張邀請。`,
		linkNone: "都不是：拒絕",
		linkJoined: (label: string, team: string) => `${label} 已加入 ${team}`,
		linkRefused: (label: string) => `已拒絕 ${label}：沒有人加入`,
		linkDeclined: "什麼都沒有決定",
	},
} as const;

/** One word of a typed line: a quoted run (single or double quotes) or a run without spaces, and what follows it. */
export function firstWord(text: string): { word: string; rest: string } {
	const quoted = /^(["'])(.*?)\1(?:\s+|$)([\s\S]*)$/.exec(text);
	if (quoted) return { word: quoted[2]!, rest: quoted[3]!.trim() };
	const plain = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	return { word: plain?.[1] ?? "", rest: (plain?.[2] ?? "").trim() };
}

/** `/boss open base|main|member [dir] [text]`: the kind, the folder as typed, and the rest of the line (a base's label, a main's first message). Undefined for any other kind. */
export function parseOpen(rest: string | undefined): { kind: "base" | "main" | "member"; dir?: string; text: string } | undefined {
	const kind = firstWord((rest ?? "").trim());
	if (kind.word !== "base" && kind.word !== "main" && kind.word !== "member") return;
	const dir = firstWord(kind.rest);
	return { kind: kind.word, ...(dir.word ? { dir: dir.word } : {}), text: dir.rest };
}

/** `/boss link [status]` or `link decide <id> approve|refuse`. */
export function parseLink(rest: string | undefined): { action: "status" } | { action: "decide"; id: string; verdict: "approve" | "refuse" } | undefined {
	const text = (rest ?? "").trim();
	if (!text || text === "status") return { action: "status" };
	const m = /^decide\s+(\S+)\s+(approve|refuse)$/.exec(text);
	return m ? { action: "decide", id: m[1]!, verdict: m[2] as "approve" | "refuse" } : undefined;
}

/** A typed folder against the session's own: `~` is home, a relative path starts at the session's folder. */
export function folderOf(typed: string, cwd: string): string {
	const home = homedir(), expanded = typed === "~" ? home : /^~[\\/]/.test(typed) ? resolve(home, typed.slice(2)) : typed;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export interface OpenDeps {
	/** The server's recorded GUI, or the refusal in the boss's words. */
	record(): Promise<GuiRecord>;
	post: Post;
	why(reply: Reply): string;
	/** Asked on this computer only: a paired device cannot answer it (`hereOnly`). */
	confirm(title: string, body: string, here?: boolean): Promise<boolean>;
	noScreen(): string;
	lang(): Lang;
	/** The label of a base, for naming a unit opened in it; undefined when it cannot be read. */
	baseName?(workspace: string): Promise<string | undefined>;
	/** How often an opening is asked for a trust question. */
	pollMs?: number;
	/** More lines for `link status` (bosslink.ts: the open invites, the join in progress, the confirms and questions that wait). */
	extra?(view: LinkView): string[];
}

export function createBossOpen({ s, tell }: Kit, { record, post, why, confirm, noScreen, lang, baseName, pollMs = POLL_MS, extra }: OpenDeps) {
	const t = () => WORDS[lang()];

	/** The trust question an opening waits on, asked in pi; the answer goes to the route the page's dialog posts to. A dismissed question stays open for the GUI or the terminal. */
	async function answerTrust(r: GuiRecord, ask: TrustPrompt, signal: AbortSignal) {
		if (!s.ui) return tell(t().trustNoScreen, "warning");
		const groups = ask.found.map((g) => `  ${g.kind} ${g.path}${g.unreadable ? ` (${t().trustUnreadable})` : ""}${g.items.length ? `: ${g.items.slice(0, SHOWN).join(", ")}${g.items.length > SHOWN || g.more ? ` (${t().trustMore(Math.max(0, g.items.length - SHOWN) + g.more)})` : ""}` : ""}`);
		const labels = t().trustChoices, picked = await s.ui.select([t().trustTitle, ask.folder, t().trustBody, t().trustFound, ...groups].join("\n"), Object.values(labels), { signal });
		const choice = Object.keys(labels).find((k) => labels[k] === picked);
		if (!choice) return;
		const reply = await post(r, "trust/answer", { id: ask.id, digest: ask.digest, choice, answerId: randomUUID().replaceAll("-", "") }, 30_000), outcome = reply.body.outcome;
		if (outcome === "accepted") return tell(t().trustAnswered);
		if (outcome === "stale") return tell(reply.body.by === "gone" ? t().trustGone : reply.body.by === "changed" ? t().trustChanged : t().trustStale, "warning");
		if (outcome === "busy") return tell(t().trustBusy, "warning");
		tell(outcome === "unknown" || reply.status === 504 || reply.status === 0 ? t().trustUnknown : why(reply), "error");
	}

	return {
	/** `/boss open base <dir> [label] | member [dir] | main <dir> [prompt]`: the page's + Base, + Member, and + Main. The server keeps every check (a folder under home, trust, one opening at a time); this side words the answer and asks the trust question in pi. */
		async open(rest: string | undefined, cwd: string) {
			const given = parseOpen(rest);
			if (!given) return tell(t().openUsage, "error");
			const { kind, dir: typed, text } = given;
			if (kind !== "member" && !typed) return tell(t().openNeedDir(kind), "error");
			if (kind === "member" && text) return tell(t().openMemberText, "error");
			const dir = typed ? folderOf(typed, cwd) : undefined;
			if (dir && !(statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false)) return tell(t().openNoDir(dir), "error");
			const at = s.at;
			if (kind !== "base" && !at?.workspaceId) return tell(t().openNoBase, "error");
			const body: Record<string, unknown> = kind === "base" ? { dir, label: text, prompt: "" }
				: kind === "main" ? { workspace: at.workspaceId, dir, prompt: text }
				: { workspace: at.workspaceId, ...(dir ? { dir } : { tab: at.tabId }) };
			const r = await record(), deploy = `pi-${randomUUID()}`, asked = new Set<string>(), stop = new AbortController();
			const kindWord = kind === "base" ? t().kindBase : kind === "main" ? t().kindMain : t().kindMember, name = dir ?? (at?.workspaceId ? ((await baseName?.(at.workspaceId)) ?? at.workspaceId) : "");
			tell(t().opening(kindWord, name));
			const watching = (async () => {
				while (!stop.signal.aborted) {
					await new Promise((done) => setTimeout(done, pollMs));
					if (stop.signal.aborted) return;
					const asking = (await post(r, "open/progress", { id: deploy }, 10_000)).body.trust as TrustPrompt | undefined;
					if (asking && !asked.has(asking.id + asking.digest)) (asked.add(asking.id + asking.digest), await answerTrust(r, asking, stop.signal));
				}
			})();
			const reply = await post(r, `open/${kind}`, { ...body, deploy }, OPEN_MS);
			stop.abort();
			void watching;
			if (reply.status === 200) return tell(t().opened(kindWord, name, reply.body.session));
			if (reply.status === 0) return tell(t().openTimeout, "warning");
			// The page words the create step by kind: the base, a tab, or a split pane.
			const create = kind === "base" ? "createBase" : kind === "member" && !dir ? "createPane" : "createTab", failed = typeof reply.body.step === "string" ? reply.body.step : "create";
			tell(t().openFailed(t().steps[failed === "create" ? create : failed] ?? failed, why(reply)), "error");
		},

		/** `/boss link [status]`: this device's teams and the join requests waiting; `link decide <id> approve|refuse`: the page's Approve / Refuse. */
		async link(rest: string | undefined) {
			const parsed = parseLink(rest);
			if (!parsed) return tell(t().linkUsage, "error");
			const r = await record(), state = await post(r, "link/state", {}, 10_000);
			if (state.status !== 200) return tell(why(state), "error");
			const view = state.body.view as LinkView | undefined;
			if (!view) return tell(t().linkOff, "warning");
			if (parsed.action === "status") {
				const role = (x: string) => (x === "admin" ? t().linkRoleAdmin : t().linkRoleMember);
				const teams = view.teams.flatMap((x) => [t().linkTeam(x.name, role(x.self.role), x.status === "running", x.stoppedWhy ?? ""), ...x.members.map((m) => t().linkMember(m.label, m.short, role(m.role), m.attended, m.online, m.self))]);
				const requests = view.joinRequests.length ? [t().linkRequests, ...view.joinRequests.map((q) => t().linkRequest(q.id.slice(0, 8), q.label, q.short, q.teamName, q.unattended))] : [t().linkNoRequests];
				return tell([t().linkDevice(view.label, view.short), ...(teams.length ? teams : [t().linkNoTeams]), ...requests, ...(extra?.(view) ?? [])].join("\n"));
			}
			const hit = view.joinRequests.filter((q) => q.id === parsed.id || (parsed.id.length >= 4 && q.id.startsWith(parsed.id)));
			if (!hit.length) return tell(t().linkNoRequest(parsed.id), "error");
			if (hit.length > 1 && !hit.some((q) => q.id === parsed.id)) return tell(t().linkManyRequests(parsed.id), "error");
			const q = hit.find((x) => x.id === parsed.id) ?? hit[0]!;
			let sent: Record<string, unknown> = { id: q.id, approve: false };
			if (parsed.verdict === "approve") {
				if (!s.ui) return tell(noScreen(), "error");
				if (q.unattended) {
					if (!(await confirm(t().linkApproveTitle, t().linkApproveUnattended(q.label, q.short, q.teamName), true))) return tell(t().linkDeclined);
					sent = { id: q.id, approve: true };
				} else {
					const words = q.sets.map((w) => w.join(" ")), none = t().linkNone, picked = await s.ui.select(t().linkWords(q.label, q.short, q.teamName), [...words, none], hereOnlyOpts());
					if (picked === undefined) return tell(t().linkDeclined);
					if (picked !== none) sent = { id: q.id, pick: words.indexOf(picked) };
				}
			}
			const reply = await post(r, "link/decide", sent, 30_000);
			if (reply.status !== 200) return tell(why(reply), "error");
			tell(reply.body.joined === true ? t().linkJoined(q.label, q.teamName) : t().linkRefused(q.label));
		},
	};
}
