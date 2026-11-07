import { HEAD_KEY } from "../src/headkey.ts";
import type { Net } from "../src/net.ts";
import { type Alert, unitOf } from "./alerts.ts";
import { cardAlerts, cardSig, explainer } from "./cardalerts.ts";
import { answerPost, canAnswer, trustPost } from "./answer.ts";
import { forwardedAnswer, outcome, waitActions } from "./asks.ts";
import { type AnswerPost, mountAsk } from "./ask.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import { mountComposer } from "./composer.ts";
import { h } from "./dom.ts";
import { confirmLine } from "./linkmodel.ts";
import { type PairRequest, pairLine } from "./pairs.ts";
import { proposalText } from "./towermodel.ts";
import { confirmPanel, pairPanel, proposalPanel } from "./zendecide.ts";
import { hasHistory, mountHistory } from "./zenhistory.ts";
import { intel } from "./intel.ts";
import { m } from "./paraglide/messages.js"; import { noun } from "./nouns.ts";
import type { Answer } from "./post.ts";
import { roleName, waitTitle } from "./render.ts";
import { composerUnit } from "./sessionfacts.ts";
import { locate } from "./scene.ts";
import type { Hotkey } from "./hotkeys.ts";
import type { StepOpen } from "./terminalthen.ts";
import { type TrustPost, trustPanel, whereOf } from "./trust.ts";
import type { Exit, Mounts, Term, ZenDeps } from "./zentypes.ts";
import { domFs, mountFullscreen } from "./zenfs.ts";
import { mountCue, mountGestures, mountHead, mountRestTap, quietForwards } from "./zenhead.ts";
import { mountLine, stillNow } from "./zenlines.ts";
import { mountPalette } from "./palette.ts";
import { entriesOf } from "./paletteentries.ts";
import { ESC_MS, escStep } from "./zenkeys.ts";
import { mountZenTerm } from "./zenterm.ts";
import { waitPanel } from "./waitpanel.ts";
import { mountMenu } from "./zenmenu.ts";
import { mountMusic } from "./zenmusicbar.ts";
import { syncQuestions } from "./zenquestions.ts";
import { domRipples, mountRipples } from "./zenripple.ts";
import { companionOf, createZen, type Outcome, type Screen, type Sound, type With } from "./zenmodel.ts";

// The Zen layer (docs/specs/2026-11-01-zen-view.md): one waiting item on the page, the breathing pause after it, or the session for company. The model (zenmodel.ts)
// decides what is on the screen and which sound goes with a change; this file draws it and answers through the same cards and routes as Standard (ask.ts, trust.ts,
// the composer). A card is taken by the boss (Enter, or a tap on the cue) and never comes by itself or goes by itself (Z-D20): the cue says how many wait, and nothing else counts or lists them.

export type { Exit, Mounts, ZenDeps } from "./zentypes.ts";
export const real: Mounts = { ask: mountAsk, trust: trustPanel, composer: mountComposer, chat: () => import("./chat.ts").then((c) => c.mountChat) };
type Composer = ReturnType<typeof mountComposer>;
interface Card { key: string; /** What the card's answer is bound to (cardalerts.ts `cardSig`): another one is another question, and the card is made again. */ sig: string; el: HTMLElement; said: HTMLElement; out: HTMLElement; skip: HTMLButtonElement; update(a: Alert, outcome?: Outcome): void; enter(): boolean; /** Presses the question's Cancel when it has one. */ cancel(): boolean; /** Whether the card's answer is on its way. */ sending(): boolean; /** The question ended while the card was shown (`elsewhere`, `gone`, `error`): it stays until the boss closes it. */ ended?: boolean; /** The context (session log) expanded on the card, when the unit has one. */ hist?: ReturnType<typeof mountHistory>; /** Expands or collapses the context; false when the card has none. */ toggle(): boolean; /** Collapses it, the focus going back to its link. */ collapse(): void; /** The wait card's answer box is unfolded. */ replying?(): boolean; /** Folds it with the draft kept, the focus going back to Handle. */ foldReply?(): boolean }
interface Company { seen?: boolean; key: string; ws: string; name: HTMLElement; where: HTMLElement; /** The header, and the quiet line in it once the session ended or lost control: the screen stays, with its input off, until the boss leaves (Z-D20). */ header: HTMLElement; note: HTMLElement; over?: "ended" | "lost"; /** The way back to the breath, made when the session is over. */ leave?: HTMLButtonElement; /** The cue that says how many cards wait for Enter (zenhead.ts), under the name: a card never takes this screen by itself. */ cue: ReturnType<typeof mountCue>; chat?: Chat; composer?: Composer; queue: HistoryEvent[]; /** Appends that came while the newest page was in flight: applied again after it, which they may not be in. */ late?: HistoryEvent[]; state?: string }

const UPGRADE_MS = 1000; // how often a waiting new build looks for the breath
const DWELL_MS = 400; // how long the card the chain takes (Z-D22) holds off the key and the tap that answered the one before it: the confirm bar's dwell (confirmbar.ts, ZNR-F007), kept apart so the page's first file does not export it
export function mountZen(root: HTMLElement, deps: ZenDeps, mounts: Mounts = real) {
	const now = deps.now ?? Date.now, later = deps.later ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
	let line: ReturnType<typeof mountLine> | undefined, escAt: number | undefined, stopEsc = () => {}, net: Net | undefined, alerts = new Map<string, Alert>(), unitAlerts = new Map<string, Alert>(), pairList: PairRequest[] = [], pairsAt = 0, shown: Screen = { kind: "companion" }, card: Card | undefined, company: Company | undefined, view: Screen["kind"] | undefined, active = false, cancel = () => {}, turn = 0, picked: With | undefined, histOpen = false, chain: { key: string; at: number; stamp: number } | undefined, deadTap = false; // picked: this visit's companion (its start, or the one stepped to); none is the circle. histOpen: the head tower's whole conversation, as a companion, on the circle screen (zenhead.ts)
	/** The alerts Standard raises, and beside them the cards (cardalerts.ts): the Link confirms and forwarded dialogs and the towers' proposals from the snapshot, the pair requests from the page's poll. A pair request is this computer's to decide (the server refuses a paired device `lan/*`), so a paired device is given none. */
	const remote = deps.remote ?? globalThis.location?.hostname !== "127.0.0.1";
	const withCards = () => new Map([...unitAlerts, ...(net ? cardAlerts(net, now(), { pairs: remote ? [] : pairList, pairsAt }) : []).map((a) => [a.key, a] as const)]);
	const to = (key: string) => answerPost(key, deps.post), trustTo: TrustPost = trustPost(deps.trust);
	const model = createZen({ now, covered: () => !active || !document.hasFocus() || term.isOpen() || palette.isOpen() || menu.isOpen() || Boolean(music?.isOpen()) }), explain = explainer(deps.debug ?? ((line) => console.debug(line)), (key) => (active ? model.why(key) : "the Zen layer is not shown")); // a question that waits off the page says why in the console
	const head = mountHead({ now, later, post: (action, body) => answerPost(net?.head?.key ?? HEAD_KEY, deps.post)(action, body), latest: () => deps.data(net?.head?.key ?? HEAD_KEY).latest(), online: deps.online, sound: deps.sound, rest: (on) => void line?.away(!on), history: () => void openHistory(), cards: () => model.queued().length, take: () => void enter() });
	/** Enter, or a tap on the cue (Z-D19): the next card takes the screen; with none waiting on the circle, the head tower is called back (its input unfolds). */
	const enter = () => (model.queued().length ? (apply(model.take()), true) : onCircle() && head.unfold());
	/** Enter on a card with no control focused (the focus was lost): a card whose question ended closes; any other goes to its primary control, where the next Enter acts (the same rule as when the card is taken). */
	const primary = () => Boolean(card) && (card!.ended ? (card!.skip.click(), true) : card!.enter() || (card!.el.focus(), true));
	/** The palette or the terminal layer closed over the item's card: the focus goes back to its primary control, or, for a card whose question ended while it was covered, to its one button, where Enter closes it (ZNI-F004). */
	const refocus = () => active && shown.kind === "item" && idle() && card && (card.ended ? card.skip.focus() : card.enter() || card.el.focus());
	const stage = h("div", { class: "zen-stage" }), live = h("p", { class: "zen-live", role: "status", "aria-live": "polite" });
	const fs = mountFullscreen(deps.fs ?? domFs(later)), menu = mountMenu(deps.menu ?? {}, () => leave()), music = deps.music && mountMusic(deps.music);
	const ripples = mountRipples(root, deps.ripple ?? domRipples(now)); // ink-water ripples under the pointer, on a canvas behind the content
	const esc = h("p", { class: "zen-esc", role: "status", "aria-live": "polite" }); // the quiet line after a first Esc that nothing took
	const update = h("p", { class: "zen-update", role: "status", "aria-live": "polite" }); // the quiet line while a new build waits for the breath (`upgrade`)
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), delete esc.dataset.on, (esc.textContent = ""));
	const corner = h("div", { class: "zen-corner" }, fs.button, ...(music ? [music.el] : []), menu.el);
	const strip = h("p", { class: "zen-strip" }); // how many units work and how many are idle (the core's selector): nothing about what waits
	strip.hidden = true;
	const palette = mountPalette({ entries: () => paletteEntries(), inert: (on) => [stage, corner].forEach((el) => el.toggleAttribute("inert", on)), closed: () => refocus() });
	root.replaceChildren(h("div", { class: "zen-drift", "aria-hidden": "true" }, h("i", null), h("i", null)), ripples.el, corner, ...(fs.hint ? [fs.hint] : []), live, esc, update, stage, strip, palette.el);
	// The terminal layer (zenterm.ts) lies over all of it: what is under takes no focus while it is on, and the item's card gets it back on return.
	const term = mountZenTerm(root, { terminals: deps.terminals, now, later, inert: (on) => [stage, corner].forEach((el) => el.toggleAttribute("inert", on)), closed: () => refocus() });
	const openTerm = (key: string, armed?: boolean) => term.terminal({ key, armed }, net);
	const circle = (words?: string) => h("div", { class: "zen-circle", ...(words ? { role: "img", "aria-label": words } : { "aria-hidden": "true" }) }, h("i", null), h("i", null), h("i", null)); // the ink washes inside the ring
	const stopLine = () => (line?.stop(), (line = undefined), head.stop());
	// A new build (the server was taken over by a newer pi-straw-boss) is the page's to load, but never under the boss (Z-D20, 「永遠不要打斷」): it waits, with one quiet line, until Zen is back on the breathing circle with nothing open, and at once while the page is hidden or Zen is not shown.
	let reload: (() => void) | undefined, stopPoll = () => {};
	const resting = () => !active || (shown.kind === "companion" && onCircle() && !term.isOpen() && !palette.isOpen() && !menu.isOpen() && !music?.isOpen() && !head.isOpen()); // the pause after a card is not the breath yet
	function flush() {
		const go = reload;
		reload = undefined;
		stopPoll();
		update.textContent = "";
		root.removeAttribute("data-update");
		go?.();
	}
	function recheck() {
		if (!reload) return;
		if (document.hidden || resting()) return flush();
		stopPoll = later(recheck, UPGRADE_MS);
	}
	/** Ink dissolving: the card that was on the page stays a moment longer, fading and blurring out, while the next thing begins. */
	const fading = new Map<HTMLElement, () => void>(), reminded = new Set<string>(); // reminded: the cards that wait for Enter and were notified of while the page was away
	const dissolve = (el: HTMLElement) => (el.dataset.gone = "", el.setAttribute("inert", ""), stage.append(el), void fading.set(el, later(() => (fading.delete(el), el.remove()), 1400)));
	/** What the stage draws changed: the sound goes out, the screen follows, and the one timer is set for the next moment the model may change. */
	function apply(o: { screen: Screen; sound?: Sound; chained?: boolean }) {
		if (!active) return;
		const gone = view === "item" && (o.screen.kind !== "item" || o.screen.item.key !== card?.key || cardSig(o.screen.item) !== card?.sig) ? card?.el : undefined; // a card that leaves dissolves: the boss's answer or Not now ended it (the model never swaps one card for another)
		shown = o.screen;
		chain = o.chained && shown.kind === "item" ? { key: shown.item.key, at: now(), stamp: globalThis.performance?.now?.() ?? 0 } : chain?.key === (shown.kind === "item" ? shown.item.key : undefined) ? chain : undefined; // the card the chain took (Z-D22) keeps its guard while it is on the screen
		if (o.sound) deps.sound(o.sound);
		if (shown.kind === "item") drawItem(shown);
		else (card?.hist?.close(), card = undefined, shown.kind === "pause" ? drawPause() : drawCompany());
		if (gone) dissolve(gone);
		if (shown.kind !== "item") live.textContent = "";
		if (shown.kind !== "companion") (disposeCompany(), deps.watch(shown.kind === "item" && card?.hist?.isOpen() ? card.hist.key : null), stopLine());
		const a = shown.kind === "item" ? undefined : deps.activity?.(); // the strip: working and idle units, never an item card's neighbour
		strip.hidden = !a || a.working + a.idle === 0;
		if (a) strip.textContent = m.zen_strip(a);
		// A card that waits for Enter (Z-D19) makes no sound and no motion; a page nobody is looking at gets its system notification, once for each card that waits, the ones behind a card on the screen too (Z-D20: the boss who stepped away to answer in the terminal is told of what arrived meanwhile). A page that is looked at gets none.
		const waiting = model.queued(), nobody = document.hidden || !document.hasFocus();
		for (const k of reminded) if (!model.listed().includes(k)) reminded.delete(k); // against what the server lists, not `waiting`: the card on the screen is not in it, which would forget its reminder the moment Enter took it
		if (nobody) for (const x of waiting) if (!reminded.has(x.key)) (reminded.add(x.key), deps.remind(x));
		cancel();
		const due = model.due(), wait = due === undefined ? undefined : due - now();
		cancel = wait === undefined ? () => {} : later(() => apply(model.tick()), Math.max(0, wait) + 10);
	}
	/** An answer's reply: accepted ends the item with the knock; anything else the server refused, or no reply, plays the low bowl and leaves the card. */
	const tell = (key: string, reply: Promise<Answer>) => reply.then((r) => (apply(outcome(r) === "accepted" ? model.accepted(key) : model.refused(key)), r), (e: unknown) => (apply(model.refused(key)), Promise.reject(e))); // `key`: the item the answer was given on, so a late reply never settles another card
	/** What a card holds was swapped: it fades in over a short moment (opacity only, zen.css) while the box takes its new size at once. */
	const fade = (el: HTMLElement) => (el.removeAttribute("data-fade"), void el.offsetWidth, el.setAttribute("data-fade", "")); // the read restarts the animation
	/** The card's title: a project's question, a wait's tower once in the page's language (its raw name is English; the unit's role and place are the title), or the unit's name. */
	const cardTitle = (a: Alert) => (a.card?.kind === "pair" ? m.zen_pair_title({ label: a.name }) : a.card?.kind === "proposal" ? waitTitle(a.role, deps.label(a.ws)) : m.zen_link_title({ label: a.name })); // a proposal is the tower's, named once like its waits
	const titleOf = (a: Alert) => (a.trust ? m.trust_title() : a.wait ? waitTitle(a.role, deps.label(a.ws)) : a.card ? cardTitle(a) : a.name);
	/** Whether the card's question ended while it was shown (Z-D20): it stays with its words, and nothing on it answers. */
	const endedOf = (outcome?: Outcome) => outcome === "elsewhere" || outcome === "gone" || outcome === "error";
	/** What a card asks, in the page's language: the long sentence of the Link notice, the request's line, or the run's proposal with the message it comes from. */
	const cardSaid = (c: NonNullable<Alert["card"]>) => (c.kind === "confirm" ? confirmLine(c.confirm) : c.kind === "dialog" ? c.line : c.kind === "pair" ? pairLine(c.request) : proposalText(c.proposal));
	/** A control that can be pressed takes the focus; false when there is none, or it is off. */
	const focusOn = (b?: HTMLElement | null | false) => Boolean(b && b.isConnected && !(b as HTMLButtonElement).disabled && (b.focus(), true));
	function makeCard(a: Alert): Card {
		const trust = a.trust, key = unitOf(a), said = h("p", { class: "zen-said" }), out = h("p", { class: "zen-out", role: "status" });
		const slot = h("div", { class: "zen-answer" }), skip = h("button", { type: "button", class: "cmp-alt zen-skip" }, m.zen_not_now());
		const unit = unitOf(a), hist = trust || a.wait || a.card ? undefined : mountHistory({ key: unit, chat: mounts.chat, data: deps.data, who: () => locate(net, unit)?.u ?? { key: unit, name: a.name, role: a.role, mark: a.mark }, watch: deps.watch, changed: () => sync() });
		const ctx = h("button", { type: "button", class: "cmp-link zen-history-btn", "aria-keyshortcuts": "H", "aria-expanded": "false", "aria-controls": hist?.el.getAttribute("id") ?? "" }, m.zen_history());
		const inner = h("div", { class: "zen-card-in" }, h("h2", { class: "zen-who" }, titleOf(a)), a.wait || a.card ? null : h("p", { class: "zen-meta" }, trust ? whereOf(trust) : `${roleName(a.role)} · ${deps.label(a.ws)}`), trust ? null : said, slot, hist?.el, h("div", { class: "zen-acts" }, hist && ctx, skip), out);
		const el = h("section", { class: "zen-card", tabindex: "-1" }, inner);
		const sync = () => {
			const has = Boolean(hist) && hasHistory(net, unit);
			if (!has) hist?.close();
			ctx.hidden = !has;
			ctx.setAttribute("aria-expanded", String(Boolean(hist?.isOpen())));
			ctx.textContent = hist?.isOpen() ? m.zen_history_hide() : m.zen_history();
			if (hist && !hist.el.hidden) hist.el.setAttribute("aria-label", m.zen_history_label());
		};
		const toggle = () => (sync(), ctx.hidden || !hist ? false : (hist.toggle(ctx), fade(hist.el), hist.isOpen() && hist.el.scrollIntoView?.({ block: "nearest" }), true)); // a card taller than the page scrolls to show the box it just opened
		ctx.onclick = () => void toggle();
		ctx.hidden = true;
		skip.onclick = () => apply(model.skip());
		if (a.wait) said.textContent = a.wait.text; // a wait for the boss says what it waits for, not what the tower last said
		else if (a.card) said.textContent = cardSaid(a.card);
		else if (!trust) void deps.recent(key).then((items) => (said.textContent = intel(items).said ?? ""), () => {});
		const answer: AnswerPost = (action, body) => tell(a.key, to(key)(action, body));
		const online = deps.online;
		if (a.wait) {
			// The answer is typed on the card and goes where Standard's composer sends it: the tower's session `input` (asks.ts `waitActions`); the card never leaves Zen.
			const panel = waitPanel({ actions: waitActions({ ws: a.ws, id: a.wait.id, tower: key }, to(key)), reply: true, send: (reply) => tell(a.key, reply) });
			slot.replaceChildren(panel.el);
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: panel.enter, cancel: () => false, sending: () => panel.sending(), replying: panel.isOpen, foldReply: () => panel.fold(true), update: (x, outcome) => (panel.update(online() && !endedOf(outcome), endedOf(outcome)), say(out, outcome, x)) };
		}
		if (a.card) {
			// A question outside a unit's dialog (cardalerts.ts): each answers through the shared action of asks.ts, the call Standard's row makes, and the server's list decides when it is over.
			const c = a.card;
			if (c.kind === "dialog") {
				const send = forwardedAnswer(c), cast: AnswerPost = (action, body) => tell(a.key, send(action, body));
				let ask: ReturnType<typeof mountAsk> | undefined, hold: HTMLElement | undefined;
				return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: () => Boolean(ask?.enter()), cancel: () => Boolean(ask?.cancel()), sending: () => Boolean(ask?.sending()), update(x, outcome) {
					if (!ask) (slot.replaceChildren((hold = h("div", { class: "zen-ask" }))), (ask = mounts.ask(hold, cast, true)));
					ask.update(x.pending, canAnswer(x.mark, online() && !endedOf(outcome))); // a forwarded dialog's panel starts afresh for another dialog under the same alert
					syncQuestions(hold!, { later });
					say(out, outcome, x);
				} };
			}
			const wrap = (reply: Promise<Answer>) => tell(a.key, reply);
			let rev = c.kind === "proposal" ? c.rev : 0; // the memory moves while the card is shown: a Confirm names the rev of the newest snapshot
			const panel = c.kind === "confirm" ? confirmPanel(c.confirm, wrap) : c.kind === "pair" ? pairPanel(c.request, wrap) : proposalPanel({ ...c, rev: () => rev }, wrap);
			slot.replaceChildren(panel.el);
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: panel.enter, cancel: () => false, sending: panel.sending, update: (x, outcome) => (panel.update(online() && !endedOf(outcome)), x.card?.kind === "proposal" && (rev = x.card.rev), x.card?.kind === "pair" && (said.textContent = cardSaid(x.card)), say(out, outcome, x)) };
		}
		if (trust) {
			const panel = mounts.trust((body) => tell(a.key, trustTo(body)));
			slot.replaceChildren(panel);
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: panel.enter, cancel: () => false, sending: () => panel.sending(), update: (x, outcome) => (panel.update(x.trust, online() && !endedOf(outcome)), say(out, outcome, x)) };
		}
		let ask: ReturnType<typeof mountAsk> | undefined, hold: HTMLElement | undefined, noted = false, openBtn: HTMLButtonElement | undefined; // `openBtn`: the words' Open the terminal, their one control
		const words = () => {
			// A waiting unit with no dialog is a pane blocked on a terminal prompt, which takes no typing from here (the server refuses it): the card says to answer in its terminal and opens it.
			const open = (openBtn = h("button", { type: "button", class: "cmp-link" }, m.zen_open_terminal()) as HTMLButtonElement);
			open.onclick = () => openTerm(key, true); // the unit waits on this terminal: its next work ends the step
			slot.replaceChildren(h("p", { class: "zen-terminal" }, m.blocked_answer_terminal()), open);
			noted = true;
		};
		const dialog = () => {
			slot.replaceChildren((hold = h("div", { class: "zen-ask" })));
			return mounts.ask(hold, answer, deps.remote, { key, show: () => openTerm(key, true) }, undefined, m.zen_open_terminal); // the unit waits on this dialog now: its next work ends the step
		};
		return {
			key: a.key, sig: cardSig(a), el, said, out, skip, hist, toggle, collapse: () => hist?.close(ctx), enter: () => Boolean(ask?.enter()) || focusOn(ask ? hold?.querySelector<HTMLElement>(".ask-acts .cmp-link") : openBtn) || (Boolean(ask) && !hold?.querySelector(".ask-send") && focusOn(skip)), cancel: () => Boolean(ask?.cancel()), sending: () => Boolean(ask?.sending()),
			update(x, outcome) {
				if (x.pending) (noted = false, (ask ??= dialog()).update(x.pending, canAnswer(x.mark, online() && !endedOf(outcome))), syncQuestions(hold!, { later })); // several questions: one focused, the rest faded (zenquestions.ts)
				else if (!noted) (ask = undefined, words());
				if (openBtn) openBtn.disabled = endedOf(outcome);
				say(out, outcome, x);
				sync();
			},
		};
	}
	const say = (out: HTMLElement, outcome: Outcome | undefined, a: Alert) => {
		out.dataset.tone = outcome === "error" ? "error" : "";
		const text = outcome === "elsewhere" ? m.zen_elsewhere() : outcome === "gone" ? m.zen_gone() : outcome === "error" ? (alerts.get(a.key)?.note ?? m.mark_error()) : "";
		if (out.textContent !== text) (out.textContent = text, text && fade(out));
	};
	/** The free-focus rule: the item takes the focus only when the page has it, the boss is not typing somewhere else, and neither the terminal layer nor the palette is on. */
	const idle = () => !term.isOpen() && !palette.isOpen() && document.hasFocus() && (!document.activeElement || document.activeElement === document.body || root.contains(document.activeElement));
	/** The card of the screen's item: made when it is taken, then followed. A card that ended (`elsewhere`, `gone`, `error`) stays, its answers off, its one button Back to the breath (the model holds it until the boss closes it: Z-D20), and the focus goes there if it was in the card. */
	function drawItem(s: Extract<Screen, { kind: "item" }>) {
		if (card?.key !== s.item.key || card.sig !== cardSig(s.item) || view !== "item") {
			card?.hist?.close(); // the card that goes takes its context with it: no mount, fetch, or watch for a card that is gone
			card = makeCard(s.item);
			stage.replaceChildren(card.el);
			live.textContent = m.zen_asks({ name: s.item.card && s.item.card.kind !== "proposal" ? s.item.name : titleOf(s.item) });
			card.update(s.item, s.outcome);
			const away = document.hidden || !document.hasFocus();
			if (away && !reminded.has(s.item.key)) (reminded.add(s.item.key), deps.remind(s.item)); // a card the page already told of while it queued (a chained one included) is not told of again
			else if (idle()) card.enter() || card.el.focus();
		} else card.update(s.item, s.outcome);
		const ended = endedOf(s.outcome);
		card.skip.disabled = s.outcome === "answered";
		card.skip.textContent = ended ? m.zen_rest() : m.zen_not_now();
		if (ended && !card.ended && idle()) card.skip.focus(); // the controls that were answerable are off now, and the focus they had is gone: Enter and Esc close the card from here
		else if (!ended && card.ended && document.activeElement === card.skip) card.enter() || card.el.focus(); // the question is listed again (ZNI-F003): the button that read Back to the breath is Maybe later now, and Enter must not rest the card the boss came back to answer
		card.ended = ended;
		view = "item";
	}
	function drawPause() {
		if (view !== "pause") {
			const c = circle(m.zen_pause());
			c.tabIndex = -1;
			stage.replaceChildren(c);
			if (document.hasFocus() && (idle() || !document.activeElement?.isConnected)) c.focus(); // the card that held the focus is gone: Enter and Space must find the layer
		}
		view = "pause";
	}
	function disposeCompany() {
		turn++;
		company = undefined;
		histOpen = false;
	}
	const onCircle = () => shown.kind === "companion" && !company && !histOpen;
	/** The head tower's whole conversation, as a companion on the circle screen; and the way back, to the breath: the strip at rest, its input folded. */
	const openHistory = () => !!net?.head && active && onCircle() && (disposeCompany(), (histOpen = true), drawCompany(), true);
	const closeHistory = () => histOpen && (disposeCompany(), head.fold(), head.hush(), drawCompany(), true); // the way back is to the breath: the strip is at rest
	function drawCompany() {
		const live = histOpen ? { key: net?.head?.key ?? company?.key ?? HEAD_KEY, ws: HEAD_KEY } : companionOf(net, company ?? picked), c = live ?? (company && company.ws !== HEAD_KEY ? { key: company.key, ws: company.ws } : undefined); // a session on the screen that ended or lost control stays (Z-D20): it is not taken from the boss. The head's conversation is none of those: a snapshot without the head (an older server) leaves it open, its composer off, and its Back to the breath works (ZNR-F002)
		if (!c) {
			[company, view] = [undefined, "companion"];
			deps.watch(net?.head?.key ?? null); // the strip's lines come from the head's stream
			head.sync(net?.head, Boolean(net));
			if (line) return; // the empty state is already drawn
			line = mountLine(later, deps.still ?? stillNow, deps.random);
			line.away(!head.rested()); // one thing in paper at a time: the strip's lines first, the mindfulness line at rest
			stage.replaceChildren(circle(), line.el, head.el);
			return head.show();
		}
		stopLine();
		if (view !== "companion" || company?.key !== c.key) openCompany(c);
		view = "companion";
		const u = locate(net, c.key), over = live ? undefined : u && !("ended" in u.u && u.u.ended) ? "lost" : "ended";
		if (live || !over) company!.name.textContent = histOpen ? noun("head_tower") : (u?.u.name ?? c.key);
		if (live) company!.where.textContent = u && !histOpen ? deps.label(u.base.id) : "";
		company!.cue.set(model.queued().length); // a card never takes this screen by itself: the cue says how many wait, and a tap on it takes one
		markOver(company!, over);
		if (u || over || histOpen) {
			const facts = composerUnit(u?.u, { name: u?.u.name ?? company!.name.textContent ?? c.key, mk: u?.u.mark ?? "unknown", state: company!.state, online: deps.online(), head: histOpen });
			company!.composer?.update(over ? { ...facts, live: over === "lost" && facts.live, control: false, activity: undefined } : facts); // a session that is over takes no more words: Send is off and the composer's own line says why
			if (company!.composer) company!.composer.box.readOnly = Boolean(over); // the box keeps its draft but takes no typing: a session that lost control is off, not just unsendable (R2, ZNR)
		}
	}
	/** The session for company ended or lost control (Z-D20, never interrupted): the screen stays with a quiet line and the way back to the breath; the composer is off (its own words say why). */
	function markOver(co: Company, over: Company["over"]) {
		if (co.over === over) return;
		co.over = over;
		co.note.textContent = over === "ended" ? m.zen_company_ended() : over === "lost" ? m.zen_company_lost() : "";
		if (over && !co.leave) {
			co.leave = h("button", { type: "button", class: "zen-company-rest" }, m.zen_rest()) as HTMLButtonElement;
			co.leave.onclick = () => rest();
			co.header.insertBefore(co.leave, co.cue.el); // right under the note; the cue's room stays under it
		}
		if (co.leave) co.leave.hidden = !over;
	}
	/** The companion's log and composer for a session; the log is a chunk of its own, and the history that arrives before it does waits in `queue`. */
	function openCompany(c: { key: string; ws: string }) {
		const mine = ++turn, cue = mountCue(() => void enter()), header = h("header", null), co: Company = (company = { ...c, name: h("h2", { class: "zen-who" }), where: h("p", { class: "zen-meta" }), header, note: h("p", { class: "zen-company-note", role: "status", "aria-live": "polite" }), cue, queue: [] });
		const logRoot = h("div", { class: "zen-log" }), composerRoot = h("div", { class: "zen-compose" });
		const back = histOpen && h("button", { type: "button", class: "zen-rest" }, m.zen_rest()); // the head's history: the way back to the breath, at its top
		if (back) back.onclick = () => void closeHistory();
		header.append(co.name, co.where, ...(back ? [back] : []), co.note, cue.el);
		stage.replaceChildren(circle(), h("section", { class: "zen-company" }, header, logRoot, composerRoot));
		const sent = answerPost(c.key, deps.post);
		co.composer = mounts.composer(composerRoot, c.key, sent);
		deps.watch(c.key);
		void mounts.chat().then((mountChat) => {
			if (mine !== turn) return;
			co.chat = mountChat(logRoot, deps.data(c.key), { who: () => locate(net, c.key)?.u ?? { key: c.key, name: c.key, role: "member", mark: "unknown" }, link: () => undefined }), histOpen && quietForwards(logRoot);
			co.chat.reveal();
			co.queue.splice(0).forEach((e) => co.chat?.apply(e));
			if (!co.seen) {
				const late = (co.late = []); // the stream may already watch this key and send no reset
				void deps.data(c.key).latest().then((page) => {
					co.late = undefined;
					if (!co.seen && mine === turn) (co.chat?.apply({ key: c.key, reset: true, items: page.items, before: page.before }), late.forEach((e) => co.chat?.apply(e)));
				}, () => void (co.late = undefined));
			}
			drawCompany();
		});
	}
	// A held Enter must not press a card's button over and over: the Enter that takes a card (or a tap on the cue after it) leaves the focus on its first control, and the key's repeats arrive there. Only a fresh press acts.
	// The card the chain took (Z-D22) is the one that comes under the boss's hand mid-answer: the Enter that answered the card before it, held, repeated, or tapped twice, must not press it. For DWELL_MS after it is drawn it takes no Enter and no tap, and it takes no repeating Enter and no keydown that began before it was drawn at all (the confirm bar's guards, confirmbar.ts).
	const dwelling = () => Boolean(chain && shown.kind === "item" && card?.key === chain.key && now() < chain.at + DWELL_MS);
	const onCard = (e: Event) => Boolean(card?.el.contains(e.target as Node | null));
	root.addEventListener("keydown", (e) => {
		deadTap = false; // a key since the press: the next click is the key's own, not the dead press's
		if (e.key !== "Enter") return;
		if (chain && shown.kind === "item" && card?.key === chain.key && (e.repeat || dwelling() || (e.timeStamp ?? Infinity) < chain.stamp + DWELL_MS)) return (e.preventDefault(), e.stopPropagation());
		if (e.repeat && (e.target as Element | null)?.closest?.("button, a, summary, [role=button]")) e.preventDefault();
	}, true);
	root.addEventListener("pointerdown", (e) => void (deadTap = e.isTrusted === true && dwelling() && onCard(e)), true);
	root.addEventListener("pointercancel", () => void (deadTap = false), true); // a press the browser took for a scroll never becomes a click
	root.addEventListener("click", (e) => { const dead = e.isTrusted === true && onCard(e) && (dwelling() || (deadTap && (e as MouseEvent).detail > 0)); deadTap = false; if (dead) (e.preventDefault(), e.stopPropagation()); }, true); // a tap is a click the user made: one the layer's own code makes (Back to the breath, Not now, the panel's Enter) is not
	mountRestTap(root, { blank: (at) => at === root || stage.contains(at) || ripples.el.contains(at) || Boolean(at.closest?.(".zen-drift")), on: () => active && onCircle() && !term.isOpen() && !palette.isOpen() && !menu.isOpen() && !music?.isOpen(), head }); // a tap or click on the blank space rests the head's strip; mounted before the pause tap below, so its press is read first
	const tap = () => shown.kind === "pause" && !term.isOpen() && apply(model.tap());
	root.addEventListener("pointerdown", (e) => (tap(), head.tapAway(e.target)));
	mountGestures(stage, { on: () => (!net?.head || term.isOpen() ? undefined : histOpen ? "history" : onCircle() ? "circle" : undefined), open: openHistory, close: closeHistory }); // the head's history opens by a wheel gesture up or a swipe up, and closes by a gesture down past the log's end
	/** Leaving: the item's dialog opens over Standard, the companion's session opens, a pause just returns to the page. */
	function leave() {
		const item = shown.kind === "item" ? (alerts.get(shown.item.key) ?? shown.item) : undefined;
		// Standard has no dialog for a card: a proposal is answered among its tower's notices, the others at the Link button, the Wi-Fi notice or the Link notices on the page itself.
		if (item?.card) return deps.leave(item.card.kind === "proposal" ? { route: { view: "session", ws: item.card.ws, key: item.card.tower } } : {});
		deps.leave(item ? { item } : shown.kind === "companion" && company ? { route: { view: "session", ws: company.ws, key: company.key } } : {});
	}
	/** What the palette lists now: the page's actions that make sense for what is on the screen, then the corner menu's preferences. */
	function paletteEntries() {
		const c = shown.kind === "companion" ? company : undefined, n = deps.companions?.().length ?? 0;
		return entriesOf({
			standard: () => deps.leave({}), settings: deps.settings,
			companion: c && !histOpen ? { name: c.name.textContent ?? c.key, session: () => deps.leave({ route: { view: "session", ws: c.ws, key: c.key } }), terminal: () => openTerm(c.key), rest } : undefined,
			head: net?.head && shown.kind === "companion" && !company ? { talk: () => void head.unfold(), history: () => void openHistory(), page: () => deps.leave({ route: { view: "head" } }) } : undefined,
			cycle: shown.kind === "companion" && n > 0 ? { prev: () => void cycle(-1), next: () => void cycle(1) } : undefined,
		}, { ...deps.menu, music: music?.switch });
	}
	/** `[` and `]`: the companion steps to the previous or next candidate of the core's list, and the breathing circle sits where the list wraps (Z-D16); false when there is nothing to step on or to. */
	function cycle(dir: 1 | -1) {
		if (!active || !deps.companions || shown.kind !== "companion" || term.isOpen() || palette.isOpen()) return false;
		// Only candidates companionOf lands on: one it resolves elsewhere would leave the cycle on another unit.
		const ring = [undefined, ...deps.companions().filter((x) => companionOf(net, x)?.key === x.key)], at = Math.max(0, company ? ring.findIndex((x) => x?.key === company!.key) : 0);
		const to = ring[(at + dir + ring.length) % ring.length];
		if (!to && !company) return false;
		picked = to && { key: to.key, ws: to.ws };
		swapCompany();
		live.textContent = to ? m.zen_with({ name: company?.name.textContent ?? to.key }) : m.zen_rest();
		return true;
	}
	/** The palette's way back to the breathing circle for the rest of this visit. */
	function rest() {
		picked = undefined;
		swapCompany();
		live.textContent = m.zen_rest();
	}
	/** A step or a rest swaps the companion; a focus that was in the old one goes to the corner menu, not the body (ZVLR-F004). */
	function swapCompany() {
		const at = document.activeElement, had = Boolean(at && at !== root && root.contains(at));
		disposeCompany();
		drawCompany();
		const now = document.activeElement;
		if (had && (!now || now === document.body || !now.isConnected)) menu.button.focus();
	}
	const face = {
		cycle,
		/** The palette key: opens the palette, or closes it; false while hidden or while the terminal layer has the keyboard. */
		palette: () => (active && !term.isOpen() ? (palette.toggle(), true) : false),
		/** Whether Zen is the page's face now; the first time, and on coming back, it draws what the model holds. */
		show() {
			if (active) return;
			active = true;
			picked = deps.start?.(); // a visit starts at the circle unless told otherwise (Z-D16), read once per visit
			ripples.on();
			music?.show();
			root.hidden = false;
			view = undefined;
			apply(model.update(alerts, true));
		},
		hide() {
			active = false;
			term.close();
			ripples.off();
			root.hidden = true;
			cancel();
			clearEsc();
			reminded.clear();
			card?.hist?.close();
			card = undefined;
			stopLine();
			menu.close();
			music?.hide();
			palette.close();
			picked = undefined;
			head.reset(); // the draft goes with the visit
			disposeCompany();
			view = undefined;
			deps.watch(null);
			flush(); // Zen is not shown: nothing here is interrupted, and Standard loads a new build at once
		},
		/** A snapshot: its alerts (rank 0 are the items) and the net. */
		net(next: Map<string, Alert>, whole: Net) {
			[unitAlerts, net] = [next, whole];
			alerts = withCards();
			term.follow(whole);
			if (active) apply(model.update(alerts));
			explain(alerts);
		},
		/** The pair requests `lan/pending` lists now (the page polls it: lanwait.ts); a request the server no longer lists is no item. */
		pairs(list: PairRequest[]) {
			[pairList, pairsAt] = [list, now()];
			alerts = withCards();
			if (active) apply(model.update(alerts));
		},
		history(e: HistoryEvent) {
			card?.hist?.apply(e);
			if (e.key === net?.head?.key) head.history(e);
			if (company?.key !== e.key) return;
			company.state = e.state ?? company.state;
			company.seen ||= Boolean(e.reset);
			if (!e.reset) company.late?.push(e);
			if (company.chat) company.chat.apply(e);
			else company.queue.push(e);
			if (active) drawCompany();
		},
		/** The stream's state changed: a card answers only while it is live. */
		refresh: () => active && apply(model.tick()),
		visible: (on: boolean) => (ripples.visible(on), music?.visible(on), active ? apply(model.visible(on)) : void model.visible(on), on || flush()),
		/**
		 * Escape (zenkeys.ts has the table): it closes the menu, lets go of a field, cancels the question on the page (else "Not now"), or, when nothing above took it, is the first of the two that
		 * leave. True when the key was Zen's, which is always while Zen shows: the page never goes up a route from here.
		 */
		escape(e: Pick<KeyboardEvent, "preventDefault"> & { repeat?: boolean }) {
			if (!active) return false;
			if (term.isOpen()) return term.escape(e); // the terminal's own while it has the keyboard (zenterm.ts)
			e.preventDefault();
			const at = document.activeElement as HTMLInputElement | null, inside = Boolean(at && at !== document.body && root.contains(at));
			const type = inside ? (at!.getAttribute?.("type") ?? at!.type ?? "text") : "", editable = inside && (/^textarea$/i.test(at!.tagName) || (/^input$/i.test(at!.tagName) && !/^(checkbox|radio|range|button|submit|reset|file|color|image)$/i.test(type)));
			const armed = escAt !== undefined && now() - escAt < ESC_MS;
			const step = escStep({ menu: menu.isOpen() || palette.isOpen() || Boolean(music?.isOpen()), history: Boolean(card?.hist?.isOpen()) || histOpen, reply: Boolean(card?.replying?.()) && !card?.sending(), head: head.isOpen(), rest: onCircle() && head.restable(), field: !editable ? "none" : at!.value !== "" ? "text" : "empty", item: shown.kind === "item" && !shown.outcome && Boolean(card && !card.sending()), ended: shown.kind === "item" && endedOf(shown.outcome) && Boolean(card && !card.sending()), over: Boolean(company?.over) && shown.kind === "companion", armed, repeat: e.repeat });
			if (step === "none" || (step === "item" && dwelling())) return true; // Esc cancels the question or puts the card aside: not a card that was just drawn under the Esc that answered the one before (Z-D22)
			if (step !== "hint") clearEsc();
			if (step === "menu") (menu.close(), palette.close(), music?.close());
			else if (step === "history") histOpen ? closeHistory() : card!.collapse();
			else if (step === "reply") card!.foldReply!();
			else if (step === "head") head.fold(true);
			else if (step === "rest") head.rest();
			else if (step === "blur") at!.blur();
			else if (step === "item") card!.cancel() || card!.skip.click();
			else if (step === "close") card!.skip.click(); // a card whose question ended: Esc closes it, as Enter and the button do
			else if (step === "over") rest(); // a session that ended or lost control stays until the boss leaves: Esc is the way back to the breath
			else if (step === "leave") leave();
			else {
				clearEsc();
				escAt = now();
				esc.textContent = m.zen_esc_hint();
				esc.dataset.on = "";
				const fade = later(() => delete esc.dataset.on, ESC_MS), gone = later(clearEsc, ESC_MS + 400); // the line fades as the window closes (zen.css), and its words go after
				stopEsc = () => (fade(), gone());
			}
			return true;
		},
		leave,
		/** H: expands or collapses the shown item's context; false when the screen has none. */
		toggleHistory: () => active && !term.isOpen() && !menu.isOpen() && (shown.kind === "item" ? Boolean(card?.toggle()) : histOpen ? closeHistory() : (onCircle() && head.recall()) || openHistory()), // on the circle a rested strip is called back first (a second H opens the history)
		/** Enter off a control and off a box (hotkeys `talk`): ends a pause when one runs; on a card, goes to its primary control (a card whose question ended closes); on the breath, a session for company, or the head's history, takes the next card that waits (Z-D19) and, on the circle with none, unfolds the head tower's input; false when none. */
		talk: () => face.tap() || (active && !term.isOpen() && !palette.isOpen() && !menu.isOpen() && (shown.kind === "item" ? primary() : enter())),
		/** The keymap's Enter and Space (hotkeys.ts): end the pause. False when no pause is shown or the terminal layer has the keys. */
		tap: () => (shown.kind === "pause" && !term.isOpen() ? (tap(), true) : false),
		/** A terminal in Zen's own layer (zenterm.ts): a session's, or a pane an answer opened. */
		terminal: (t: Term) => void (active && term.terminal(t, net)),
		/** A step an accepted answer left: the layer's terminal card (zenterm.ts). */
		step: (s: StepOpen) => void (active && term.step(s, net)),
		companion: () => (company ? { key: company.key, ws: company.ws } : undefined),
		/** The server's build changed: `go` (the page's reload) runs at once on the breathing circle with nothing open or on a hidden page; else it waits, with a quiet line, and runs when Zen is back on the breath. */
		upgrade(go: () => void) {
			if (document.hidden || resting()) return go();
			reload = go;
			update.textContent = m.zen_update();
			root.setAttribute("data-update", ""); // the page keeps its foot clear for the line (zen.css)
			stopPoll();
			stopPoll = later(recheck, UPGRADE_MS);
		},
	};
	/** A Zen key of the keymap (hotkeys.ts), done: the page hands every one of them to this one call. False when it had nothing to do (the key stays the browser's). */
	const key = (hotkey: Hotkey) => (hotkey === "pause" ? face.tap() : hotkey === "talk" ? face.talk() : hotkey === "history" ? face.toggleHistory() : hotkey === "palette" ? face.palette() : face.cycle(hotkey === "next-companion" ? 1 : -1));
	return { ...face, key };
}
