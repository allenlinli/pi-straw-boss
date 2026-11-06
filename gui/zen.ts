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
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { roleName, waitTitle } from "./render.ts";
import { composerUnit, liveOf } from "./sessionfacts.ts";
import { locate } from "./scene.ts";
import type { Hotkey } from "./hotkeys.ts";
import type { StepOpen } from "./terminalthen.ts";
import { type TrustPost, trustPanel, whereOf } from "./trust.ts";
import type { Exit, Mounts, Term, ZenDeps } from "./zentypes.ts";
import { domFs, mountFullscreen } from "./zenfs.ts";
import { mountGestures, mountHead, mountRestTap, quietForwards } from "./zenhead.ts";
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
// the composer). Nothing here counts or lists the items that wait: the model hands out the current one alone.

export type { Exit, Mounts, ZenDeps } from "./zentypes.ts";
/** How long a draft in the companion's box keeps holding the screen after the last touch of the companion (a waiting item takes it after that). */
export const DRAFT_MS = 20_000;
/** How long a card that replaces another is inert: the old card's dissolve (`zen-ink-out` in zen.css, 1.3 s), or half a second under reduced motion, where it is gone at once. A tap or a key aimed at the old card is over by then (ZBF-F001). */
const INERT_MS = 1300, INERT_CALM_MS = 500;
export const real: Mounts = { ask: mountAsk, trust: trustPanel, composer: mountComposer, chat: () => import("./chat.ts").then((c) => c.mountChat) };
type Composer = ReturnType<typeof mountComposer>;
interface Card { key: string; /** What the card's answer is bound to (cardalerts.ts `cardSig`): another one is another question, and the card is made again. */ sig: string; el: HTMLElement; said: HTMLElement; out: HTMLElement; skip: HTMLButtonElement; update(a: Alert, outcome?: Outcome): void; enter(): boolean; /** Presses the question's Cancel when it has one. */ cancel(): boolean; /** Whether the card's answer is on its way. */ sending(): boolean; /** The context (session log) expanded on the card, when the unit has one. */ hist?: ReturnType<typeof mountHistory>; /** Expands or collapses the context; false when the card has none. */ toggle(): boolean; /** Collapses it, the focus going back to its link. */ collapse(): void; /** The wait card's answer box is unfolded. */ replying?(): boolean; /** Folds it with the draft kept, the focus going back to Handle. */ foldReply?(): boolean }
interface Company { seen?: boolean; key: string; ws: string; name: HTMLElement; where: HTMLElement; chat?: Chat; composer?: Composer; queue: HistoryEvent[]; /** Appends that came while the newest page was in flight: applied again after it, which they may not be in. */ late?: HistoryEvent[]; state?: string }

export function mountZen(root: HTMLElement, deps: ZenDeps, mounts: Mounts = real) {
	const now = deps.now ?? Date.now, later = deps.later ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
	let line: ReturnType<typeof mountLine> | undefined, escAt: number | undefined, stopEsc = () => {}, net: Net | undefined, alerts = new Map<string, Alert>(), unitAlerts = new Map<string, Alert>(), pairList: PairRequest[] = [], pairsAt = 0, shown: Screen = { kind: "companion" }, card: Card | undefined, company: Company | undefined, view: Screen["kind"] | undefined, active = false, cancel = () => {}, turn = 0, picked: With | undefined, histOpen = false, inertCard: Card | undefined, stopInert = () => {}; // picked: this visit's companion (its start, or the one stepped to); none is the circle. histOpen: the head tower's whole conversation, as a companion, on the circle screen (zenhead.ts)
	/** The alerts Standard raises, and beside them the cards (cardalerts.ts): the Link confirms and forwarded dialogs and the towers' proposals from the snapshot, the pair requests from the page's poll. A pair request is this computer's to decide (the server refuses a paired device `lan/*`), so a paired device is given none. */
	const remote = deps.remote ?? globalThis.location?.hostname !== "127.0.0.1";
	const withCards = () => new Map([...unitAlerts, ...(net ? cardAlerts(net, now(), { pairs: remote ? [] : pairList, pairsAt }) : []).map((a) => [a.key, a] as const)]);
	const to = (key: string) => answerPost(key, deps.post), trustTo: TrustPost = trustPost(deps.trust);
	// A draft holds the screen while the boss is at it: the box has text and he touched the companion (a tap or a drag on the log, a wheel, a key, or text that arrives with no key, as dictation and a suggestion tap do) in the last DRAFT_MS, focused or not. Typing keeps renewing it; walking away from a focused box does not hold the screen.
	let touched = -Infinity;
	const typing = () => Boolean((company?.composer && company.composer.box.value !== "") || head.drafting()) && now() - touched < DRAFT_MS; // the head tower's folded-out input holds the screen the same way
	const model = createZen({ now, typing, breathing: () => !companionOf(net, company ?? picked) && !histOpen }), explain = explainer(deps.debug ?? ((line) => console.debug(line)), (key) => (active ? model.why(key) : "the Zen layer is not shown")); // a question that waits off the page says why in the console
	const head = mountHead({ now, later, post: (action, body) => answerPost(net?.head?.key ?? HEAD_KEY, deps.post)(action, body), latest: () => deps.data(net?.head?.key ?? HEAD_KEY).latest(), online: deps.online, sound: deps.sound, changed: () => void later(() => apply(model.tick()), 0), rest: (on) => void line?.away(!on), history: () => void openHistory(), cards: () => model.queued().length, take: () => void enter() });
	/** Enter, or a tap on the cue (Z-D19): the next card takes the screen; with none waiting, the head tower is called back (its input unfolds). */
	const enter = () => (model.queued().length ? (apply(model.take()), true) : head.unfold());
	const stage = h("div", { class: "zen-stage" }), live = h("p", { class: "zen-live", role: "status", "aria-live": "polite" });
	const fs = mountFullscreen(deps.fs ?? domFs(later)), menu = mountMenu(deps.menu ?? {}, () => leave()), music = deps.music && mountMusic(deps.music);
	const ripples = mountRipples(root, deps.ripple ?? domRipples(now)); // ink-water ripples under the pointer, on a canvas behind the content
	const esc = h("p", { class: "zen-esc", role: "status", "aria-live": "polite" }); // the quiet line after a first Esc that nothing took
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), delete esc.dataset.on, (esc.textContent = ""));
	const corner = h("div", { class: "zen-corner" }, fs.button, ...(music ? [music.el] : []), menu.el);
	const strip = h("p", { class: "zen-strip" }); // how many units work and how many are idle (the core's selector): nothing about what waits
	strip.hidden = true;
	const palette = mountPalette({ entries: () => paletteEntries(), inert: (on) => [stage, corner].forEach((el) => el.toggleAttribute("inert", on)), closed: () => active && shown.kind === "item" && idle() && card && (card.enter() || card.el.focus()) });
	root.replaceChildren(h("div", { class: "zen-drift", "aria-hidden": "true" }, h("i", null), h("i", null)), ripples.el, corner, ...(fs.hint ? [fs.hint] : []), live, esc, stage, strip, palette.el);
	// The terminal layer (zenterm.ts) lies over all of it: what is under takes no focus while it is on, and the item's card gets it back on return.
	const term = mountZenTerm(root, { terminals: deps.terminals, now, later, inert: (on) => [stage, corner].forEach((el) => el.toggleAttribute("inert", on)), closed: () => active && shown.kind === "item" && idle() && card && (card.enter() || card.el.focus()) });
	const openTerm = (key: string, armed?: boolean) => term.terminal({ key, armed }, net);
	const circle = (words?: string) => h("div", { class: "zen-circle", ...(words ? { role: "img", "aria-label": words } : { "aria-hidden": "true" }) }, h("i", null), h("i", null), h("i", null)); // the ink washes inside the ring
	const stopLine = () => (line?.stop(), (line = undefined), head.stop());
	/** Ink dissolving: the card that was on the page stays a moment longer, fading and blurring out, while the next thing begins. */
	const fading = new Map<HTMLElement, () => void>(), reminded = new Set<string>(); // reminded: the cards that wait for Enter and were notified of while the page was away
	const dissolve = (el: HTMLElement) => (el.dataset.gone = "", el.setAttribute("inert", ""), stage.append(el), void fading.set(el, later(() => (fading.delete(el), el.remove()), 1400)));
	/** What the stage draws changed: the sound goes out, the screen follows, and the one timer is set for the next moment the model may change. */
	function apply(o: { screen: Screen; sound?: Sound }) {
		if (!active) return;
		const gone = view === "item" && (o.screen.kind !== "item" || o.screen.item.key !== card?.key || cardSig(o.screen.item) !== card?.sig) ? card?.el : undefined; // a card that leaves, or is swapped for another, dissolves
		shown = o.screen;
		if (o.sound) deps.sound(o.sound);
		if (shown.kind === "item") drawItem(shown, Boolean(gone));
		else (card?.hist?.close(), card = undefined, shown.kind === "pause" ? drawPause() : drawCompany());
		if (gone) dissolve(gone);
		if (shown.kind !== "item") live.textContent = "";
		if (shown.kind !== "companion") (disposeCompany(), deps.watch(shown.kind === "item" && card?.hist?.isOpen() ? card.hist.key : null), stopLine());
		const a = shown.kind === "item" ? undefined : deps.activity?.(); // the strip: working and idle units, never an item card's neighbour
		strip.hidden = !a || a.working + a.idle === 0;
		if (a) strip.textContent = m.zen_strip(a);
		// A card that waits for Enter (Z-D19) makes no sound and no motion; a page nobody is looking at gets its system notification, once for each.
		const waiting = model.queued(), nobody = document.hidden || !document.hasFocus();
		for (const k of reminded) if (!waiting.some((x) => x.key === k)) reminded.delete(k);
		if (nobody) for (const x of waiting) if (!reminded.has(x.key)) (reminded.add(x.key), deps.remind(x));
		cancel();
		const due = model.due(), wait = shown.kind === "companion" && typing() ? 500 : due === undefined ? undefined : due - now();
		cancel = wait === undefined ? () => {} : later(() => apply(model.tick()), Math.max(0, wait) + 10);
	}
	/** An answer's reply: accepted ends the item with the knock; anything else the server refused, or no reply, plays the low bowl and leaves the card. */
	const tell = (key: string, reply: Promise<Answer>) => reply.then((r) => (apply(outcome(r) === "accepted" ? model.accepted(key) : model.refused(key)), r), (e: unknown) => (apply(model.refused(key)), Promise.reject(e))); // `key`: the item the answer was given on, so a late reply never settles another card
	/** What a card holds was swapped: it fades in over a short moment (opacity only, zen.css) while the box takes its new size at once. */
	const fade = (el: HTMLElement) => (el.removeAttribute("data-fade"), void el.offsetWidth, el.setAttribute("data-fade", "")); // the read restarts the animation
	/** The card's title: a project's question, a wait's tower once in the page's language (its raw name is English; the unit's role and place are the title), or the unit's name. */
	const cardTitle = (a: Alert) => (a.card?.kind === "pair" ? m.zen_pair_title({ label: a.name }) : a.card?.kind === "proposal" ? waitTitle(a.role, deps.label(a.ws)) : m.zen_link_title({ label: a.name })); // a proposal is the tower's, named once like its waits
	const titleOf = (a: Alert) => (a.trust ? m.trust_title() : a.wait ? waitTitle(a.role, deps.label(a.ws)) : a.card ? cardTitle(a) : a.name);
	/** What a card asks, in the page's language: the long sentence of the Link notice, the request's line, or the run's proposal with the message it comes from. */
	const cardSaid = (c: NonNullable<Alert["card"]>) => (c.kind === "confirm" ? confirmLine(c.confirm) : c.kind === "dialog" ? c.line : c.kind === "pair" ? pairLine(c.request) : proposalText(c.proposal));
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
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: () => false, cancel: () => false, sending: () => panel.sending(), replying: panel.isOpen, foldReply: () => panel.fold(true), update: (x, outcome) => (panel.update(online()), say(out, outcome, x)) };
		}
		if (a.card) {
			// A question outside a unit's dialog (cardalerts.ts): each answers through the shared action of asks.ts, the call Standard's row makes, and the server's list decides when it is over.
			const c = a.card;
			if (c.kind === "dialog") {
				const send = forwardedAnswer(c), cast: AnswerPost = (action, body) => tell(a.key, send(action, body));
				let ask: ReturnType<typeof mountAsk> | undefined, hold: HTMLElement | undefined;
				return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: () => Boolean(ask?.enter()), cancel: () => Boolean(ask?.cancel()), sending: () => Boolean(ask?.sending()), update(x, outcome) {
					if (!ask) (slot.replaceChildren((hold = h("div", { class: "zen-ask" }))), (ask = mounts.ask(hold, cast, true)));
					ask.update(x.pending, canAnswer(x.mark, online())); // a forwarded dialog's panel starts afresh for another dialog under the same alert
					syncQuestions(hold!, { later });
					say(out, outcome, x);
				} };
			}
			const wrap = (reply: Promise<Answer>) => tell(a.key, reply);
			let rev = c.kind === "proposal" ? c.rev : 0; // the memory moves while the card is shown: a Confirm names the rev of the newest snapshot
			const panel = c.kind === "confirm" ? confirmPanel(c.confirm, wrap) : c.kind === "pair" ? pairPanel(c.request, wrap) : proposalPanel({ ...c, rev: () => rev }, wrap);
			slot.replaceChildren(panel.el);
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: panel.enter, cancel: () => false, sending: panel.sending, update: (x, outcome) => (panel.update(online()), x.card?.kind === "proposal" && (rev = x.card.rev), x.card?.kind === "pair" && (said.textContent = cardSaid(x.card)), say(out, outcome, x)) };
		}
		if (trust) {
			const panel = mounts.trust((body) => tell(a.key, trustTo(body)));
			slot.replaceChildren(panel);
			return { key: a.key, sig: cardSig(a), el, said, out, skip, toggle: () => false, collapse() {}, enter: () => false, cancel: () => false, sending: () => panel.sending(), update: (x, outcome) => (panel.update(x.trust, online()), say(out, outcome, x)) };
		}
		let ask: ReturnType<typeof mountAsk> | undefined, hold: HTMLElement | undefined, noted = false, shown: string | undefined; // `shown`: which dialog the slot holds ("" for the words)
		const words = () => {
			// A waiting unit with no dialog is a pane blocked on a terminal prompt, which takes no typing from here (the server refuses it): the card says to answer in its terminal and opens it.
			const open = h("button", { type: "button", class: "cmp-link" }, m.zen_open_terminal());
			open.onclick = () => openTerm(key, true); // the unit waits on this terminal: its next work ends the step
			slot.replaceChildren(h("p", { class: "zen-terminal" }, m.blocked_answer_terminal()), open);
			noted = true;
		};
		const dialog = () => {
			slot.replaceChildren((hold = h("div", { class: "zen-ask" })));
			return mounts.ask(hold, answer, deps.remote, { key, show: () => openTerm(key, true) }, undefined, m.zen_open_terminal); // the unit waits on this dialog now: its next work ends the step
		};
		return {
			key: a.key, sig: cardSig(a), el, said, out, skip, hist, toggle, collapse: () => hist?.close(ctx), enter: () => Boolean(ask?.enter()), cancel: () => Boolean(ask?.cancel()), sending: () => Boolean(ask?.sending()),
			update(x, outcome) {
				if (x.pending) (noted = false, (ask ??= dialog()).update(x.pending, canAnswer(x.mark, online())), syncQuestions(hold!, { later })); // several questions: one focused, the rest faded (zenquestions.ts)
				else if (!noted) (ask = undefined, words());
				const now = x.pending ? `${x.pending.callId}:${x.pending.answer?.dialog ?? ""}` : "";
				if (shown !== undefined && shown !== now) fade(slot);
				shown = now;
				say(out, outcome, x);
				sync();
			},
		};
	}
	const say = (out: HTMLElement, outcome: Outcome | undefined, a: Alert) => {
		out.dataset.tone = outcome === "error" ? "error" : "";
		const text = outcome === "elsewhere" ? m.zen_elsewhere() : outcome === "error" ? (alerts.get(a.key)?.note ?? m.mark_error()) : "";
		if (out.textContent !== text) (out.textContent = text, text && fade(out));
	};
	/** The free-focus rule: the item takes the focus only when the page has it, the boss is not typing somewhere else, and neither the terminal layer nor the palette is on. */
	const idle = () => !term.isOpen() && !palette.isOpen() && document.hasFocus() && (!document.activeElement || document.activeElement === document.body || root.contains(document.activeElement));
	/** `swap`: the card replaces another one that is still fading out (the unit asked another question). Until that is over it is inert, and takes no focus, so a tap or a key aimed at the old card answers nothing on this one (ZBF-F001). */
	function drawItem(s: Extract<Screen, { kind: "item" }>, swap = false) {
		if (card?.key !== s.item.key || card.sig !== cardSig(s.item) || view !== "item") {
			card?.hist?.close(); // the card that goes takes its context with it: no mount, fetch, or watch for a card that is gone
			const c = (card = makeCard(s.item));
			stage.replaceChildren(card.el);
			live.textContent = m.zen_asks({ name: s.item.card && s.item.card.kind !== "proposal" ? s.item.name : titleOf(s.item) });
			card.update(s.item, s.outcome);
			const away = document.hidden || !document.hasFocus();
			if (away) deps.remind(s.item);
			if (swap) inert(c);
			else if (!away && idle()) card.enter() || card.el.focus();
		} else card.update(s.item, s.outcome);
		card.skip.disabled = Boolean(s.outcome);
		view = "item";
	}
	function inert(c: Card) {
		stopInert();
		inertCard = c;
		c.el.setAttribute("inert", "");
		stopInert = later(() => (c.el.dataset.gone === undefined && c.el.removeAttribute("inert"), (inertCard = undefined), active && card === c && idle() && (c.enter() || c.el.focus())), globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? INERT_CALM_MS : INERT_MS);
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
		histOpen &&= Boolean(net?.head);
		const c = histOpen ? { key: net!.head!.key, ws: HEAD_KEY } : companionOf(net, company ?? picked);
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
		const u = locate(net, c.key);
		company!.name.textContent = histOpen ? m.head_tower() : (u?.u.name ?? c.key);
		company!.where.textContent = u && !histOpen ? deps.label(u.base.id) : "";
		if (u) (company!.chat?.setLive(...liveOf(u.u, company!.state, u.u.mark)), company!.composer?.update(composerUnit(u.u, { name: u.u.name, mk: u.u.mark, state: company!.state, online: deps.online(), head: histOpen })));
	}
	/** The companion's log and composer for a session; the log is a chunk of its own, and the history that arrives before it does waits in `queue`. */
	function openCompany(c: { key: string; ws: string }) {
		const mine = ++turn, co: Company = (company = { ...c, name: h("h2", { class: "zen-who" }), where: h("p", { class: "zen-meta" }), queue: [] });
		const logRoot = h("div", { class: "zen-log" }), composerRoot = h("div", { class: "zen-compose" });
		const back = histOpen && h("button", { type: "button", class: "zen-rest" }, m.zen_rest()); // the head's history: the way back to the breath, at its top
		if (back) back.onclick = () => void closeHistory();
		stage.replaceChildren(circle(), h("section", { class: "zen-company" }, h("header", null, co.name, co.where, back), logRoot, composerRoot));
		const sent = answerPost(c.key, deps.post);
		co.composer = mounts.composer(composerRoot, c.key, async (action, body) => { const r = await sent(action, body); later(() => apply(model.tick()), 60); return r; }); // the box empties after the answer: the model looks again
		co.composer.box.addEventListener("input", () => later(() => apply(model.tick()), 0)); // the box emptied or filled: the model looks again (a blur changes nothing)
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
	for (const type of ["pointerdown", "wheel", "touchstart", "keydown", "input"]) root.addEventListener(type, () => (touched = now()), { capture: true, passive: true });
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
			stopInert();
			inertCard = undefined;
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
		visible: (on: boolean) => (ripples.visible(on), music?.visible(on), active ? apply(model.visible(on)) : void model.visible(on)),
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
			const step = escStep({ menu: menu.isOpen() || palette.isOpen() || Boolean(music?.isOpen()), history: Boolean(card?.hist?.isOpen()) || histOpen, reply: Boolean(card?.replying?.()) && !card?.sending(), head: head.isOpen(), rest: onCircle() && head.restable(), field: !editable ? "none" : at!.value !== "" ? "text" : "empty", item: shown.kind === "item" && !shown.outcome && Boolean(card && !card.sending()), armed, repeat: e.repeat });
			if (step === "none" || (step === "item" && inertCard === card)) return true; // an Esc aimed at the old card is not "Maybe later" for the one that just took the screen
			if (step !== "hint") clearEsc();
			if (step === "menu") (menu.close(), palette.close(), music?.close());
			else if (step === "history") histOpen ? closeHistory() : card!.collapse();
			else if (step === "reply") card!.foldReply!();
			else if (step === "head") head.fold(true);
			else if (step === "rest") head.rest();
			else if (step === "blur") at!.blur();
			else if (step === "item") card!.cancel() || card!.skip.click();
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
		/** Enter on the circle screen (hotkeys `talk`): ends a pause when one runs, else takes the next card that waits (Z-D19), else unfolds the head tower's input; false when none. */
		talk: () => face.tap() || (active && !term.isOpen() && !palette.isOpen() && !menu.isOpen() && onCircle() && enter()),
		/** The keymap's Enter and Space (hotkeys.ts): end the pause. False when no pause is shown or the terminal layer has the keys. */
		tap: () => (shown.kind === "pause" && !term.isOpen() ? (tap(), true) : false),
		/** A terminal in Zen's own layer (zenterm.ts): a session's, or a pane an answer opened. */
		terminal: (t: Term) => void (active && term.terminal(t, net)),
		/** A step an accepted answer left: the layer's terminal card (zenterm.ts). */
		step: (s: StepOpen) => void (active && term.step(s, net)),
		companion: () => (company ? { key: company.key, ws: company.ws } : undefined),
	};
	/** A Zen key of the keymap (hotkeys.ts), done: the page hands every one of them to this one call. False when it had nothing to do (the key stays the browser's). */
	const key = (hotkey: Hotkey) => (hotkey === "pause" ? face.tap() : hotkey === "talk" ? face.talk() : hotkey === "history" ? face.toggleHistory() : hotkey === "palette" ? face.palette() : face.cycle(hotkey === "next-companion" ? 1 : -1));
	return { ...face, key };
}
