import type { BossWait, WaitCardView, WaitPressView } from "../src/net.ts";
import { getLocale } from "./paraglide/runtime.js";

// The demo's wait cards (`?waits=cards`, docs/specs/2026-11-07-wait-cards.md): the fonstar case first, then one card of each kind and state a tower can hold: an action with a URL, one with a command, a choice, a secret before and after its first step, a card
// the tower raised itself, one whose raiser left, a legacy wait, and two that were pressed already. The presses are this stand-in's: `pressCard` changes the card as the server would and answers its memory. The words follow the page's language, as the card's labels do.

const MIN = 60_000;
type Lang = "en" | "zh-TW";
const T: Record<Lang, Record<string, string>> = {
	en: {
		fonHappened: "The Tailscale login key of the machine fonstar-staging expired at about 10:30, so it is offline. The print feature of ticket MP-3946 is deployed there, but nobody can reach it to test it.",
		fonDo: "Open the Tailscale admin page and re-authorize fonstar-staging, or set its key to never expire.",
		fonAfter: "Once the machine is back, the tower asks the MP-3946 main to verify the print feature.",
		cmdHappened: "The staging database for ticket MP-4102 still has the old schema, so the new report page fails to load.",
		cmdDo: "Run this migration on the staging server, then reload the report page.",
		cmdAfter: "The MP-4102 main checks the report page and tells the tower.",
		chHappened: "The ledger rounding fix is merged on main and passed every check.",
		chDo: "Roll the ledger fix out to production tonight, or wait for Friday?",
		chA: "Tonight", chAThen: "The tower asks the Harbor API main to deploy now and watch the first hour.",
		chB: "Friday", chBThen: "The tower holds the fix and reminds you on Friday morning.",
		secHappened: "The print service of fonstar-staging needs a new Tailscale auth key to join the network again.",
		secDo: "Create a reusable auth key in the Tailscale admin page, then enter it when the entry box opens.",
		secAfter: "The MP-3946 main stores the key and brings the print service back.",
		secName: "fonstar-staging Tailscale auth key",
		selfHappened: "A 40-minute wait for the nightly import to finish has passed, and the tower cannot tell whether it ran.",
		selfDo: "Look at the import log on the Orchard server and tell the tower whether last night's run finished.",
		selfAfter: "The tower closes the import ticket or restarts the run.",
		goneHappened: "The checkout main asked for a go to merge its branch into main, and then its session ended.",
		goneDo: "Decide whether the branch may be merged without its author; the tower will merge it for you.",
		goneAfter: "The tower merges the branch, or closes it and tells the team.",
		legacy: "Roll the ledger fix out tonight, or wait for Friday?",
		headHappened: "Three towers asked the head tower for the same migration window tonight, and it cannot give it to all of them.",
		headDo: "Pick which workspace gets tonight's migration window.",
		headAfter: "The head tower tells the other two towers when their turn comes.",
		pressedHappened: "The deploy key for the docs site was rotated and the old one stopped working.",
		pressedDo: "Paste the new deploy key into the docs repository settings.",
		pressedAfter: "The docs main redeploys the site.",
		choHappened: "Two reviewers disagree about the order of the migration steps.",
		choDo: "Which order should the migration use?",
		choA: "Schema first", choAThen: "The tower tells the main to apply the schema change before the data copy.",
		choB: "Data first", choBThen: "The tower tells the main to copy the data before the schema change.",
	},
	"zh-TW": {
		fonHappened: "fonstar-staging 這台機器的 Tailscale 登入金鑰約 10:30 過期，它現在離線。MP-3946 的列印功能已經部署到那台，但連不上，沒辦法測。",
		fonDo: "到 Tailscale 管理頁重新授權 fonstar-staging，或把它的金鑰設成不會過期。",
		fonAfter: "機器連回來後，塔台會請 MP-3946 的 main 驗證列印功能。",
		cmdHappened: "MP-4102 的測試區資料庫還是舊的結構，所以新的報表頁打不開。",
		cmdDo: "在測試區伺服器執行這段遷移指令，再重新整理報表頁。",
		cmdAfter: "MP-4102 的 main 會檢查報表頁，再回報塔台。",
		chHappened: "帳本進位的修正已經合併到 main，所有檢查都過了。",
		chDo: "帳本修正要今晚上正式區，還是等到週五？",
		chA: "今晚上線", chAThen: "塔台請 Harbor API 的 main 現在部署，並盯第一個小時。",
		chB: "等到週五", chBThen: "塔台先保留這個修正，週五早上提醒你。",
		secHappened: "fonstar-staging 的列印服務需要一把新的 Tailscale 授權金鑰，才能重新加入網路。",
		secDo: "到 Tailscale 管理頁建立一把可重複使用的授權金鑰，輸入框開啟後再輸入。",
		secAfter: "MP-3946 的 main 會存好金鑰，並讓列印服務恢復。",
		secName: "fonstar-staging 的 Tailscale 授權金鑰",
		selfHappened: "等夜間匯入完成的 40 分鐘已經過了，塔台無法確定它有沒有跑完。",
		selfDo: "到 Orchard 伺服器看匯入紀錄，告訴塔台昨晚那次有沒有跑完。",
		selfAfter: "塔台會關閉匯入的票，或重新跑一次。",
		goneHappened: "結帳那條線的 main 請求同意把它的分支合併到 main，之後它的工作階段就結束了。",
		goneDo: "決定這個分支能不能在作者離開後合併；塔台會替你合併。",
		goneAfter: "塔台會合併分支，或關掉它並告訴團隊。",
		legacy: "帳本修正今晚上線，還是等到週五？",
		headHappened: "三個塔台今晚都向主塔台要同一段遷移時間，沒辦法全給。",
		headDo: "決定今晚的遷移時間給哪個工作區。",
		headAfter: "主塔台會告訴另外兩個塔台輪到它們的時間。",
		pressedHappened: "文件網站的部署金鑰已經換過，舊的金鑰失效了。",
		pressedDo: "把新的部署金鑰貼到文件儲存庫的設定頁。",
		pressedAfter: "文件的 main 會重新部署網站。",
		choHappened: "兩位審查者對遷移步驟的順序有不同意見。",
		choDo: "遷移要用哪個順序？",
		choA: "先改結構", choAThen: "塔台請 main 先套用結構變更，再複製資料。",
		choB: "先複製資料", choBThen: "塔台請 main 先複製資料，再做結構變更。",
	},
};
const FROM = { name: "ops-main", role: "main", workspace: "Harbor", tab: "Ops", key: "a3" };
const FONSTAR_FROM = { name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946", key: "a1" };

/** The demo's boss waits, newest first on the card; `now` is the page's clock. */
export function cardWaits(now: number): BossWait[] {
	const lang: Lang = getLocale() === "zh-TW" ? "zh-TW" : "en", t = T[lang];
	const at = (min: number) => new Date(now - min * MIN).toISOString();
	const card = (c: Omit<WaitCardView, "lang">): WaitCardView => ({ lang, ...c });
	const wait = (id: string, min: number, c: WaitCardView | undefined, extra: Partial<BossWait> = {}): BossWait => ({ id, text: c?.do ?? t.legacy, at: at(min), ...(c ? { card: c } : {}), ...extra });
	const done: WaitPressView = { act: "done", at: at(2), main: { status: "delivered", at: at(2) } }, picked: WaitPressView = { act: "choose", option: 1, at: at(3), main: { status: "delivered", at: at(3) } };
	return [
		wait("W1", 12, card({ type: "action", happened: t.fonHappened, do: t.fonDo, url: "https://login.tailscale.com/admin/machines", after: t.fonAfter, from: FONSTAR_FROM })),
		wait("W2", 14, card({ type: "action", happened: t.cmdHappened, do: t.cmdDo, command: "npm run db:migrate -- --env staging --only 20261107-report-schema", after: t.cmdAfter, from: FROM })),
		wait("W3", 16, card({ type: "choice", happened: t.chHappened, do: t.chDo, options: [{ label: t.chA, then: t.chAThen }, { label: t.chB, then: t.chBThen }], from: FROM })),
		wait("W4", 18, card({ type: "secret", happened: t.secHappened, do: t.secDo, after: t.secAfter, secret: { name: t.secName }, from: FONSTAR_FROM })),
		wait("W5", 20, card({ type: "secret", happened: t.secHappened, do: t.secDo, after: t.secAfter, secret: { name: t.secName }, from: FONSTAR_FROM }), { press: { act: "secret", at: at(1), secretAsked: at(1), main: { status: "delivered", at: at(1) } } }),
		wait("W6", 22, card({ type: "action", happened: t.selfHappened, do: t.selfDo, after: t.selfAfter })),
		wait("W7", 24, card({ type: "action", happened: t.goneHappened, do: t.goneDo, after: t.goneAfter, from: { name: "checkout-main", role: "main", workspace: "Harbor", tab: "Checkout", gone: true } })),
		wait("W8", 26, undefined),
		wait("W9", 30, card({ type: "action", happened: t.pressedHappened, do: t.pressedDo, after: t.pressedAfter, from: FROM }), { answered: at(2), press: done }),
		wait("W10", 32, card({ type: "choice", happened: t.choHappened, do: t.choDo, options: [{ label: t.choA, then: t.choAThen }, { label: t.choB, then: t.choBThen }], from: FROM }), { answered: at(3), press: picked }),
	];
}

/** The head tower's own card (`?waits=cards&head=<state>`): an action card on the head's memory, so the card says the head tower where a workspace's says the tower (docs/specs/2026-11-10-wait-cards-tui.md, Q3). */
export function headCardWait(now: number): BossWait {
	const lang: Lang = getLocale() === "zh-TW" ? "zh-TW" : "en", t = T[lang];
	const card: WaitCardView = { lang, type: "action", happened: t.headHappened, do: t.headDo, after: t.headAfter, from: FROM };
	return { id: "H1", text: card.do, at: new Date(now - 9 * MIN).toISOString(), card };
}

/**
 * The memory route's stand-in for `press` and `read` (the server's waitpress.ts does this for real): the wait changes as the press says, and the answer is what the route answers (`entries`, and the `press` the page keeps until the next
 * snapshot). A card that is gone, or a press that does not fit the card, is a refusal in the server's words.
 */
export function pressCard(waits: BossWait[], body: { op?: string; id?: string; act?: string; option?: number; reason?: string }, now: number): { status: number; body: Record<string, unknown> } {
	const entries = () => waits.map((w) => ({ id: w.id, kind: "wait", text: w.text, at: w.at, for: "boss", state: w.state ?? (w.answered ? "answered" : "open"), ...(w.card ? { card: w.card } : {}), ...(w.press ? { press: w.press } : {}) }));
	if (body.op === "read") return { status: 200, body: { rev: 3, proposals: [], entries: entries() } };
	const w = waits.find((x) => x.id === body.id);
	if (!w || w.state === "resolved") return { status: 409, body: { error: "refused", reason: `No such wait ${body.id}` } };
	const at = new Date(now).toISOString(), main = w.card?.from && !w.card.from.gone ? { main: { status: "delivered" as const, at } } : w.card?.from?.gone ? { main: { status: "gone" as const, at } } : {};
	if (w.press && w.press.act !== "secret" && body.act !== "decline") return { status: 409, body: { error: "refused", reason: `${w.id} was pressed already` } };
	const act = body.act as WaitPressView["act"];
	const press: WaitPressView = { act, at, ...(act === "choose" ? { option: body.option } : {}), ...(act === "decline" && body.reason ? { reason: body.reason } : {}), ...(act === "secret" ? { secretAsked: at } : {}), ...(act === "restate" ? {} : main) };
	w.press = press;
	if (act === "decline") Object.assign(w, { state: "resolved", outcome: `declined by the boss${body.reason ? `: ${body.reason}` : ""}`, ended: at });
	else if (act !== "secret") w.answered = at;
	return { status: 200, body: { rev: 4, proposals: [], entries: entries(), id: w.id, press } };
}

/** The route's answer as a Response, for the fixture's fetch stand-in. */
export function cardsReply(waits: BossWait[], body: BodyInit | null | undefined, now: number): Response {
	const r = pressCard(waits, JSON.parse(String(body)), now);
	return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}
