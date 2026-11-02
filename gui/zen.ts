import type { Item } from "../src/items.ts";
import type { Net } from "../src/net.ts";
import { type Alert, unitOf } from "./alerts.ts";
import { type AnswerPost, mountAsk } from "./ask.ts";
import type { Chat, Data, HistoryEvent, Who } from "./chat.ts";
import { mountComposer, postTo, wakeOf } from "./composer.ts";
import { h } from "./dom.ts";
import { intel } from "./intel.ts";
import { m } from "./paraglide/messages.js";
import { type Answer, post } from "./post.ts";
import { liveNote, roleName } from "./render.ts";
import type { Route } from "./router.ts";
import { closed, locate } from "./scene.ts";
import { type TrustPost, trustPanel, whereOf } from "./trust.ts";
import type { Exit, Mounts, ZenDeps } from "./zentypes.ts";
import { domFs, mountFullscreen } from "./zenfs.ts";
import { mountLine, stillNow } from "./zenlines.ts";
import { ESC_MS, escStep } from "./zenkeys.ts";
import { mountMenu } from "./zenmenu.ts";
import { syncQuestions } from "./zenquestions.ts";
import { glide, settle } from "./zensize.ts";
import { domRipples, mountRipples } from "./zenripple.ts";
import { companionOf, createZen, type Outcome, type Screen, type Sound } from "./zenmodel.ts";
import { recall, recording, sendTarget, type With } from "./zenwith.ts";

// The Zen layer (docs/specs/2026-11-01-zen-view.md): one waiting item on the page, the breathing pause after it, or the session for company. The model (zenmodel.ts)
// decides what is on the screen and which sound goes with a change; this file draws it and answers through the same cards and routes as Standard (ask.ts, trust.ts,
// the composer). Nothing here counts or lists the items that wait: the model hands out the current one alone.

export type { Exit, Mounts, ZenDeps } from "./zentypes.ts";
/** How long a draft in the companion's box keeps holding the screen after the last touch of the companion (a waiting item takes it after that). */
export const DRAFT_MS = 20_000;
export const real: Mounts = { ask: mountAsk, trust: trustPanel, composer: mountComposer, chat: () => import("./chat.ts").then((c) => c.mountChat) };
type Composer = ReturnType<typeof mountComposer>;
interface Card { key: string; el: HTMLElement; said: HTMLElement; out: HTMLElement; skip: HTMLButtonElement; update(a: Alert, outcome?: Outcome): void; enter(): boolean; /** Presses the question's Cancel when it has one. */ cancel(): boolean; /** Whether the card's answer is on its way. */ sending(): boolean }
interface Company { seen?: boolean; key: string; ws: string; name: HTMLElement; where: HTMLElement; chat?: Chat; composer?: Composer; queue: HistoryEvent[]; /** Appends that came while the newest page was in flight: applied again after it, which they may not be in. */ late?: HistoryEvent[]; state?: string }

export function mountZen(root: HTMLElement, deps: ZenDeps, mounts: Mounts = real) {
	const now = deps.now ?? Date.now, later = deps.later ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
	let line: ReturnType<typeof mountLine> | undefined, escAt: number | undefined, stopEsc = () => {}, net: Net | undefined, alerts = new Map<string, Alert>(), shown: Screen = { kind: "companion" }, card: Card | undefined, company: Company | undefined, view: Screen["kind"] | undefined, active = false, cancel = () => {}, turn = 0;
	const to = (key: string) => deps.post?.(key) ?? postTo(key), trustTo: TrustPost = deps.trust ?? ((body) => post("trust/answer", body));
	// A draft holds the screen while the boss is at it: the box has text and he touched the companion (a tap or a drag on the log, a wheel, a key, or text that arrives with no key, as dictation and a suggestion tap do) in the last DRAFT_MS, focused or not. Typing keeps renewing it; walking away from a focused box does not hold the screen.
	let touched = -Infinity;
	const typing = () => Boolean(company?.composer && company.composer.box.value !== "" && now() - touched < DRAFT_MS);
	const model = createZen({ now, typing });
	const stage = h("div", { class: "zen-stage" }), live = h("p", { class: "zen-live", role: "status", "aria-live": "polite" });
	const fs = mountFullscreen(deps.fs ?? domFs(later)), menu = mountMenu(deps.menu ?? {}, () => leave(), later);
	const ripples = mountRipples(root, deps.ripple ?? domRipples(now)); // ink-water ripples under the pointer, on a canvas behind the content
	const esc = h("p", { class: "zen-esc", role: "status", "aria-live": "polite" }); // the quiet line after a first Esc that nothing took
	const clearEsc = () => (stopEsc(), (stopEsc = () => {}), (escAt = undefined), delete esc.dataset.on, (esc.textContent = ""));
	root.replaceChildren(h("div", { class: "zen-drift", "aria-hidden": "true" }, h("i", null), h("i", null)), ripples.el, h("div", { class: "zen-corner" }, fs.button, menu.el), ...(fs.hint ? [fs.hint] : []), live, esc, stage);
	const circle = (words?: string) => h("div", { class: "zen-circle", ...(words ? { role: "img", "aria-label": words } : { "aria-hidden": "true" }) }, h("i", null), h("i", null), h("i", null)); // the ink washes inside the ring
	const stopLine = () => (line?.stop(), (line = undefined));
	/** Ink dissolving: the card that was on the page stays a moment longer, fading and blurring out, while the next thing begins. */
	const dissolve = (el: HTMLElement) => (settle(el), el.dataset.gone = "", el.setAttribute("inert", ""), stage.append(el), later(() => el.remove(), 1400));
	/** What the stage draws changed: the sound goes out, the screen follows, and the one timer is set for the next moment the model may change. */
	function apply(o: { screen: Screen; sound?: Sound }) {
		if (!active) return;
		const gone = view === "item" && (o.screen.kind !== "item" || o.screen.item.key !== card?.key) ? card?.el : undefined; // a card that leaves, or is swapped for another, dissolves
		shown = o.screen;
		if (o.sound) deps.sound(o.sound);
		if (shown.kind === "item") drawItem(shown);
		else (card = undefined, shown.kind === "pause" ? drawPause() : drawCompany());
		if (gone) dissolve(gone);
		if (shown.kind !== "item") live.textContent = "";
		if (shown.kind !== "companion") (disposeCompany(), deps.watch(null), stopLine());
		cancel();
		const due = model.due(), wait = shown.kind === "companion" && typing() ? 500 : due === undefined ? undefined : due - now();
		cancel = wait === undefined ? () => {} : later(() => apply(model.tick()), Math.max(0, wait) + 10);
	}
	/** An answer's reply: accepted ends the item with the knock; anything else the server refused, or no reply, plays the low bowl and leaves the card. */
	const tell = (reply: Promise<Answer>) => reply.then((r) => (apply(r.body.outcome === "accepted" ? model.accepted() : model.refused()), r), (e: unknown) => (apply(model.refused()), Promise.reject(e)));
	function makeCard(a: Alert): Card {
		const trust = a.trust, key = unitOf(a), said = h("p", { class: "zen-said" }), out = h("p", { class: "zen-out", role: "status" });
		const slot = h("div", { class: "zen-answer" }), skip = h("button", { type: "button", class: "cmp-alt zen-skip" }, m.zen_not_now());
		const inner = h("div", { class: "zen-card-in" }, h("h2", { class: "zen-who" }, trust ? m.trust_title() : a.name), h("p", { class: "zen-meta" }, trust ? whereOf(trust) : `${roleName(a.role)} · ${deps.label(a.ws)}`), trust ? null : said, slot, h("div", { class: "zen-acts" }, skip), out);
		const el = h("section", { class: "zen-card", tabindex: "-1" }, inner);
		glide(el, inner); // the box follows its content's height, eased (zensize.ts)
		skip.onclick = () => apply(model.skip());
		if (!trust) void deps.recent(key).then((items) => (said.textContent = intel(items).said ?? ""), () => {});
		const answer: AnswerPost = (action, body) => tell(to(key)(action, body));
		const online = deps.online;
		if (trust) {
			const panel = mounts.trust((body) => tell(trustTo(body)));
			slot.replaceChildren(panel);
			return { key: a.key, el, said, out, skip, enter: () => false, cancel: () => false, sending: () => panel.sending(), update: (x, outcome) => (panel.update(x.trust, online()), say(out, outcome, x)) };
		}
		let ask: ReturnType<typeof mountAsk> | undefined, hold: HTMLElement | undefined, noted = false;
		const words = () => {
			// A waiting unit with no dialog is a pane blocked on a terminal prompt, which takes no typing from here (the server refuses it): the card says to answer in its terminal and opens it.
			const open = h("button", { type: "button", class: "cmp-link" }, m.zen_open_standard());
			open.onclick = () => deps.leave({ route: { view: "session", ws: a.ws, key }, terminal: key });
			slot.replaceChildren(h("p", { class: "zen-terminal" }, m.blocked_answer_terminal()), open);
			noted = true;
		};
		const dialog = () => {
			slot.replaceChildren((hold = h("div", { class: "zen-ask" })));
			return mounts.ask(hold, answer, deps.remote, () => deps.leave({ route: { view: "session", ws: a.ws, key }, terminal: key }), undefined, m.zen_open_standard);
		};
		return {
			key: a.key, el, said, out, skip, enter: () => Boolean(ask?.enter()), cancel: () => Boolean(ask?.cancel()), sending: () => Boolean(ask?.sending()),
			update(x, outcome) {
				if (x.pending) (noted = false, (ask ??= dialog()).update(x.pending, x.mark === "waiting" && online()), syncQuestions(hold!, { later })); // several questions: one focused, the rest faded (zenquestions.ts)
				else if (!noted) (ask = undefined, words());
				say(out, outcome, x);
			},
		};
	}
	const say = (out: HTMLElement, outcome: Outcome | undefined, a: Alert) => {
		out.dataset.tone = outcome === "error" ? "error" : "";
		out.textContent = outcome === "elsewhere" ? m.zen_elsewhere() : outcome === "error" ? (alerts.get(a.key)?.note ?? m.mark_error()) : "";
	};
	/** The free-focus rule: the item takes the focus only when the page has it and the boss is not typing somewhere else. */
	const idle = () => document.hasFocus() && (!document.activeElement || document.activeElement === document.body || root.contains(document.activeElement));
	function drawItem(s: Extract<Screen, { kind: "item" }>) {
		if (card?.key !== s.item.key || view !== "item") {
			card = makeCard(s.item);
			stage.replaceChildren(card.el);
			live.textContent = m.zen_asks({ name: s.item.trust ? m.trust_title() : s.item.name });
			card.update(s.item, s.outcome);
			if (document.hidden || !document.hasFocus()) deps.remind(s.item);
			else if (idle()) card.enter() || card.el.focus();
		} else card.update(s.item, s.outcome);
		card.skip.disabled = Boolean(s.outcome);
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
	}
	function drawCompany() {
		const c = companionOf(net, company ? { key: company.key, ws: company.ws, at: 0 } : (deps.stored ?? recall)());
		if (!c) {
			[company, view] = [undefined, "companion"];
			deps.watch(null);
			if (line) return; // the empty state is already drawn
			line = mountLine(later, deps.still ?? stillNow, deps.random);
			return stage.replaceChildren(circle(), line.el);
		}
		stopLine();
		if (view !== "companion" || company?.key !== c.key) openCompany(c);
		view = "companion";
		const u = locate(net, c.key);
		company!.name.textContent = u?.u.name ?? c.key;
		company!.where.textContent = u ? deps.label(u.base.id) : "";
		if (u) {
			company!.chat?.setLive(liveNote(u.u, company!.state, u.u.mark), u.u.mark);
			company!.composer?.update({ name: u.u.name, control: Boolean(u.u.control), agent: u.u.agent, live: !closed(u.u, company!.state), mark: u.u.mark, online: deps.online(), answerable: Boolean(u.u.pending?.answer), ...wakeOf(u.u.service) });
		}
	}
	/** The companion's log and composer for a session; the log is a chunk of its own, and the history that arrives before it does waits in `queue`. */
	function openCompany(c: { key: string; ws: string }) {
		const mine = ++turn, co: Company = (company = { ...c, name: h("h2", { class: "zen-who" }), where: h("p", { class: "zen-meta" }), queue: [] });
		const logRoot = h("div", { class: "zen-log" }), composerRoot = h("div", { class: "zen-compose" });
		stage.replaceChildren(circle(), h("section", { class: "zen-company" }, h("header", null, co.name, co.where), logRoot, composerRoot));
		const sent = recording(to(c.key), () => sendTarget(net, c.key, c.ws));
		co.composer = mounts.composer(composerRoot, c.key, async (action, body) => { const r = await sent(action, body); later(() => apply(model.tick()), 60); return r; }); // the box empties after the answer: the model looks again
		co.composer.box.addEventListener("input", () => later(() => apply(model.tick()), 0)); // the box emptied or filled: the model looks again (a blur changes nothing)
		deps.watch(c.key);
		void mounts.chat().then((mountChat) => {
			if (mine !== turn) return;
			co.chat = mountChat(logRoot, deps.data(c.key), { who: () => locate(net, c.key)?.u ?? { key: c.key, name: c.key, role: "member", mark: "unknown" }, link: () => undefined });
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
	const tap = () => shown.kind === "pause" && apply(model.tap());
	root.addEventListener("pointerdown", tap);
	root.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && shown.kind === "pause" && !/^button$/i.test((e.target as HTMLElement | null)?.tagName ?? "") && (e.preventDefault(), tap()));
	/** Leaving: the item's dialog opens over Standard, the companion's session opens, a pause just returns to the page. */
	function leave() {
		deps.leave(shown.kind === "item" ? { item: alerts.get(shown.item.key) ?? shown.item } : shown.kind === "companion" && company ? { route: { view: "session", ws: company.ws, key: company.key } } : {});
	}
	return {
		/** Whether Zen is the page's face now; the first time, and on coming back, it draws what the model holds. */
		show() {
			if (active) return;
			active = true;
			ripples.on();
			root.hidden = false;
			view = undefined;
			apply(model.update(alerts));
		},
		hide() {
			active = false;
			ripples.off();
			root.hidden = true;
			cancel();
			clearEsc();
			card = undefined;
			stopLine();
			menu.close();
			disposeCompany();
			view = undefined;
			deps.watch(null);
		},
		/** A snapshot: its alerts (rank 0 are the items) and the net. */
		net(next: Map<string, Alert>, whole: Net) {
			[alerts, net] = [next, whole];
			if (active) apply(model.update(next));
		},
		history(e: HistoryEvent) {
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
		visible: (on: boolean) => (ripples.visible(on), active ? apply(model.visible(on)) : void model.visible(on)),
		/**
		 * Escape (zenkeys.ts has the table): it closes the menu, lets go of a field, cancels the question on the page (else "Not now"), or, when nothing above took it, is the first of the two that
		 * leave. True when the key was Zen's, which is always while Zen shows: the page never goes up a route from here.
		 */
		escape(e: Pick<KeyboardEvent, "preventDefault"> & { repeat?: boolean }) {
			if (!active) return false;
			e.preventDefault();
			const at = document.activeElement as HTMLInputElement | null, inside = Boolean(at && at !== document.body && root.contains(at));
			const type = inside ? (at!.getAttribute?.("type") ?? at!.type ?? "text") : "", editable = inside && (/^textarea$/i.test(at!.tagName) || (/^input$/i.test(at!.tagName) && !/^(checkbox|radio|range|button|submit|reset|file|color|image)$/i.test(type)));
			const armed = escAt !== undefined && now() - escAt < ESC_MS;
			const step = escStep({ menu: menu.isOpen(), field: !editable ? "none" : at!.value !== "" ? "text" : "empty", item: shown.kind === "item" && !shown.outcome && Boolean(card && !card.sending()), armed, repeat: e.repeat });
			if (step === "none") return true;
			if (step !== "hint") clearEsc();
			if (step === "menu") menu.close();
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
		companion: () => (company ? { key: company.key, ws: company.ws } : undefined),
	};
}
