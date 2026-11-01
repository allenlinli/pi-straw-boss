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
import { companionOf, createZen, type Outcome, type Screen, type Sound } from "./zenmodel.ts";
import { recall, recording, sendTarget, type With } from "./zenwith.ts";

// The Zen layer (docs/specs/2026-11-01-zen-view.md): one waiting item on the page, the breathing pause after it, or the session for company. The model (zenmodel.ts)
// decides what is on the screen and which sound goes with a change; this file draws it and answers through the same cards and routes as Standard (ask.ts, trust.ts,
// the composer). Nothing here counts or lists the items that wait: the model hands out the current one alone.

export type { Exit, Mounts, ZenDeps } from "./zentypes.ts";
export const real: Mounts = { ask: mountAsk, trust: trustPanel, composer: mountComposer, chat: () => import("./chat.ts").then((c) => c.mountChat) };
type Composer = ReturnType<typeof mountComposer>;
interface Card { key: string; el: HTMLElement; said: HTMLElement; out: HTMLElement; skip: HTMLButtonElement; update(a: Alert, outcome?: Outcome): void; enter(): boolean }
interface Company { seen?: boolean; key: string; ws: string; name: HTMLElement; where: HTMLElement; chat?: Chat; composer?: Composer; queue: HistoryEvent[]; /** Appends that came while the newest page was in flight: applied again after it, which they may not be in. */ late?: HistoryEvent[]; state?: string }

export function mountZen(root: HTMLElement, deps: ZenDeps, mounts: Mounts = real) {
	const now = deps.now ?? Date.now, later = deps.later ?? ((fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); });
	let net: Net | undefined, alerts = new Map<string, Alert>(), shown: Screen = { kind: "companion" }, card: Card | undefined, company: Company | undefined, view: Screen["kind"] | undefined, active = false, cancel = () => {}, turn = 0;
	const to = (key: string) => deps.post?.(key) ?? postTo(key), trustTo: TrustPost = deps.trust ?? ((body) => post("trust/answer", body));
	const typing = () => Boolean(company?.composer && document.activeElement === company.composer.box && company.composer.box.value !== "");
	const model = createZen({ now, typing });
	const stage = h("div", { class: "zen-stage" }), live = h("p", { class: "zen-live", role: "status", "aria-live": "polite" });
	const leaveBtn = h("button", { type: "button", class: "zen-leave", title: m.zen_leave_title() }, m.zen_leave());
	root.replaceChildren(leaveBtn, live, stage);
	const circle = (words?: string) => h("div", { class: "zen-circle", ...(words ? { role: "img", "aria-label": words } : { "aria-hidden": "true" }) });
	/** What the stage draws changed: the sound goes out, the screen follows, and the one timer is set for the next moment the model may change. */
	function apply(o: { screen: Screen; sound?: Sound }) {
		if (!active) return;
		shown = o.screen;
		if (o.sound) deps.sound(o.sound);
		if (shown.kind === "item") drawItem(shown);
		else (card = undefined, shown.kind === "pause" ? drawPause() : drawCompany());
		if (shown.kind !== "item") live.textContent = "";
		if (shown.kind !== "companion") (disposeCompany(), deps.watch(null));
		cancel();
		const due = model.due(), wait = shown.kind === "companion" && typing() ? 500 : due === undefined ? undefined : due - now();
		cancel = wait === undefined ? () => {} : later(() => apply(model.tick()), Math.max(0, wait) + 10);
	}
	/** An answer's reply: accepted ends the item with the knock; anything else the server refused, or no reply, plays the low bowl and leaves the card. */
	const tell = (reply: Promise<Answer>) => reply.then((r) => (apply(r.body.outcome === "accepted" ? model.accepted() : model.refused()), r), (e: unknown) => (apply(model.refused()), Promise.reject(e)));
	function makeCard(a: Alert): Card {
		const trust = a.trust, key = unitOf(a), said = h("p", { class: "zen-said" }), out = h("p", { class: "zen-out", role: "status" });
		const slot = h("div", { class: "zen-answer" }), skip = h("button", { type: "button", class: "cmp-alt zen-skip" }, m.zen_not_now());
		const el = h("section", { class: "zen-card", tabindex: "-1" }, h("h2", { class: "zen-who" }, trust ? m.trust_title() : a.name), h("p", { class: "zen-meta" }, trust ? whereOf(trust) : `${roleName(a.role)} · ${deps.label(a.ws)}`), trust ? null : said, slot, h("div", { class: "zen-acts" }, skip), out);
		skip.onclick = () => apply(model.skip());
		if (!trust) void deps.recent(key).then((items) => (said.textContent = intel(items).said ?? ""), () => {});
		const answer: AnswerPost = (action, body) => tell(to(key)(action, body));
		const online = deps.online;
		if (trust) {
			const panel = mounts.trust((body) => tell(trustTo(body)));
			slot.replaceChildren(panel);
			return { key: a.key, el, said, out, skip, enter: () => false, update: (x, outcome) => (panel.update(x.trust, online()), say(out, outcome, x)) };
		}
		let ask: ReturnType<typeof mountAsk> | undefined, noted = false;
		const words = () => {
			// A waiting unit with no dialog is a pane blocked on a terminal prompt, which takes no typing from here (the server refuses it): the card says to answer in its terminal and opens it.
			const open = h("button", { type: "button", class: "cmp-link" }, m.zen_open_standard());
			open.onclick = () => deps.leave({ route: { view: "session", ws: a.ws, key }, terminal: key });
			slot.replaceChildren(h("p", { class: "zen-terminal" }, m.blocked_answer_terminal()), open);
			noted = true;
		};
		const dialog = () => {
			const hold = h("div", { class: "zen-ask" });
			slot.replaceChildren(hold);
			return mounts.ask(hold, answer, deps.remote, () => deps.leave({ route: { view: "session", ws: a.ws, key }, terminal: key }), undefined, m.zen_open_standard);
		};
		return {
			key: a.key, el, said, out, skip, enter: () => Boolean(ask?.enter()),
			update(x, outcome) {
				if (x.pending) (noted = false, (ask ??= dialog()).update(x.pending, x.mark === "waiting" && online()));
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
		if (!c) return (company = undefined), (view = "companion"), stage.replaceChildren(circle(), h("p", { class: "zen-nothing", role: "status" }, m.zen_nothing())), deps.watch(null);
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
		for (const type of ["input", "focusout"]) co.composer.box.addEventListener(type, () => later(() => apply(model.tick()), 0));
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
	const tap = () => shown.kind === "pause" && apply(model.tap());
	root.addEventListener("pointerdown", tap);
	root.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && shown.kind === "pause" && !/^button$/i.test((e.target as HTMLElement | null)?.tagName ?? "") && (e.preventDefault(), tap()));
	/** Leaving: the item's dialog opens over Standard, the companion's session opens, a pause just returns to the page. */
	const leave = () => deps.leave(shown.kind === "item" ? { item: alerts.get(shown.item.key) ?? shown.item } : shown.kind === "companion" && company ? { route: { view: "session", ws: company.ws, key: company.key } } : {});
	leaveBtn.onclick = leave;
	return {
		/** Whether Zen is the page's face now; the first time, and on coming back, it draws what the model holds. */
		show() {
			if (active) return;
			active = true;
			root.hidden = false;
			view = undefined;
			apply(model.update(alerts));
		},
		hide() {
			active = false;
			root.hidden = true;
			cancel();
			card = undefined;
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
		visible: (on: boolean) => (active ? apply(model.visible(on)) : void model.visible(on)),
		/** Escape: a field with text in it takes the first one as a blur, the next leaves. True when the key was Zen's. */
		escape(e: Pick<Event, "preventDefault">) {
			if (!active) return false;
			const at = document.activeElement as HTMLInputElement | null;
			e.preventDefault();
			if (at && at !== document.body && root.contains(at) && typeof at.value === "string" && at.value !== "") at.blur();
			else leave();
			return true;
		},
		leave,
		companion: () => (company ? { key: company.key, ws: company.ws } : undefined),
	};
}
