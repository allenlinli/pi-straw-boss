import { HEAD_KEY } from "../src/headkey.ts";
import type { BossWait, WaitCardView, WaitPressView } from "../src/net.ts";
import { type Alert, unitOf } from "./alerts.ts";
import type { SessionPost } from "./answer.ts";
import { joined, outcome, type WaitActions, waitActions } from "./asks.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";
import { aim, text, waitTitle } from "./render.ts";
import { formatRoute, type NetRoute } from "./router.ts";
import { type ButtonId, type CardModel, cardModel, type Phase, pressedLine } from "./waitcardmodel.ts";
import { waitPanel } from "./waitpanel.ts";
import { towerWhy } from "./towerturns.ts";

// The card of a wait for the boss, drawn wherever one is drawn (docs/specs/2026-11-07-wait-cards.md, The card in the GUI): the dock's dialog, the tower card's rows and comms, the head page's rows, and Zen's card. What it shows and says is waitcardmodel.ts's;
// this file holds the DOM and the calls: a press goes to the memory route (asks.ts `waitActions`), a URL is text that a click opens, a command is text that a click copies, and nothing here runs, fetches, or opens anything by itself.

/** A text part longer than this is clamped to three lines with a More toggle (outside the dock's dialog, which shows every part whole). A card's fields are at most 160 characters; three lines of a phone's width hold about 90. */
const CLAMP_AT = 90;
const REASON_MAX = 120; // the server's cap on a decline's reason

type Host = "dialog" | "zen" | "row";
export interface WaitCardOptions {
	host: Host;
	actions: WaitActions;
	/** The wait as the snapshot carries it; `update` brings the next one. */
	wait: BossWait;
	/** A paired device cannot start a secret card (WC-D4): by the page's host name unless the host says. */
	remote?: boolean;
	/** The route of the raiser's session, when the page can open it: the card then offers Open <name>. */
	main?(key: string): NetRoute | undefined;
	/** A host that is not a page of routes (Zen leaves its layer for the session) takes the click of Open <raiser> itself; the router never sees it. */
	go?(route: NetRoute): void;
	/** The raiser's unit has a `secret_drop` dialog pending now (a host that has the net says so). */
	secretOpen?(): boolean;
	/** Zen wraps an ending press, so the card's outcome (the knock, the low bowl) follows it. */
	send?(reply: Promise<Answer>): Promise<Answer>;
	/** A press or an answer the server took, in words, for the host that shows it beside the card or closes its dialog. */
	done?(said: string): void;
	/** The dock's dialog puts Skip in its footer row: the card keeps the button and leaves placing it to the host. */
	skipOutside?: boolean;
	now?(): number;
}

/** A paired device reaches the page by another host name than this computer's own (as `mountAsk`'s default). */
export const isRemote = () => Boolean(globalThis.location?.hostname) && globalThis.location.hostname !== "127.0.0.1";
/** The URL as text for the card, `URL.href` (an IDN host shows in punycode and cannot pose as another host), only when it is an `http(s)` address without a user name or password. */
export function safeHref(url: string): string | undefined {
	try {
		const u = new URL(url);
		return (u.protocol === "http:" || u.protocol === "https:") && u.host && !u.username && !u.password ? u.href : undefined;
	} catch {
		return undefined;
	}
}
const selectText = (el: HTMLElement) => {
	const sel = globalThis.getSelection?.(), range = globalThis.document.createRange?.();
	if (!sel || !range) return;
	range.selectNodeContents(el);
	sel.removeAllRanges();
	sel.addRange(range);
};

export function waitCard(o: WaitCardOptions) {
	const wrap = o.send ?? ((reply: Promise<Answer>) => reply);
	const panel = waitPanel({ actions: o.actions, ...(o.send ? { send: o.send } : {}), done: (said) => o.done?.(said) });
	let cur = o.wait, live = true, blocked: string | undefined, over = false, inflight: { id: ButtonId; option?: number } | undefined, refusal = "", confirming = false, folded = o.host === "row", local: WaitPressView | undefined, full: { card?: WaitCardView; press?: WaitPressView } | undefined, read = false, last = "";
	const expanded = new Set<string>();
	const remote = () => o.remote ?? isRemote();
	// The persistent parts: the root, the reply fold's button (waitpanel.ts), Skip and its confirm, which keep their state across a redraw of the rest.
	const skip = h("button", { type: "button", class: "pair-btn wc-skip" }, m.wc_b_skip());
	const tells = h("p", { class: "wc-skip-tells" }), reason = h("textarea", { class: "wc-skip-reason", rows: "1", maxlength: String(REASON_MAX), "aria-label": m.wc_skip_reason(), placeholder: m.wc_skip_reason() }) as HTMLTextAreaElement;
	const yes = h("button", { type: "button", class: "pair-btn wc-skip-yes" }, m.wc_skip_yes()), no = h("button", { type: "button", class: "pair-btn wc-skip-no" }, m.cancel());
	const sure = h("div", { class: "wc-skip-box", role: "group" }, tells, reason, h("div", { class: "wc-skip-acts" }, yes, no));
	const head = h("div", { class: "wc-head" }), parts = h("div", { class: "wc-parts" }), state = h("p", { class: "wc-state", role: "status" }), hint = h("p", { class: "wc-remote" }), acts = h("div", { class: "wc-acts" });
	const note = h("small", { class: "tnote-fail wc-fail", role: "alert" });
	const root = h("div", { class: "wait-card", "data-host": o.host }, head, parts, state, hint, acts, panel.el, sure, note);
	sure.hidden = true;

	/** The wait with what the page learned beyond the snapshot: the whole card of a cut one, and the press a reply carried before the snapshot brings it. */
	const effective = (): BossWait => {
		const press = cur.press ?? full?.press ?? local;
		return { ...cur, ...(full?.card ? { card: full.card } : {}), ...(press ? { press } : {}), ...(full?.card ? { cut: undefined } : {}) } as BossWait;
	};
	const phase = (): Phase => (over || cur.state === "resolved" ? "ended" : inflight ? "sending" : !live ? "stale" : refusal ? "refused" : "open");
	const model = (): CardModel => cardModel({ wait: effective(), phase: phase(), remote: remote(), ...(inflight ? { sending: inflight } : {}), open: Boolean(o.main?.(effective().card?.from?.key ?? "")), ...(blocked ? { blocked } : {}), ...(o.secretOpen ? { secretOpen: o.secretOpen() } : {}), now: (o.now ?? Date.now)() });

	async function press(id: ButtonId, act: Parameters<WaitActions["press"]>[0], extra?: { option?: number; reason?: string }) {
		if (inflight) return;
		[inflight, refusal] = [{ id, ...(extra?.option !== undefined ? { option: extra.option } : {}) }, ""];
		render();
		try {
			const r = await (act === "secret" ? o.actions.press(act, extra) : wrap(o.actions.press(act, extra))); // the first step of a secret card ends nothing: the card stays for the second
			inflight = undefined;
			if (outcome(r) === "accepted") {
				local = (r.body.press as WaitPressView | undefined) ?? { act, at: new Date().toISOString(), ...(extra?.option !== undefined ? { option: extra.option } : {}) };
				confirming = false;
				render();
				if (act !== "secret") o.done?.(pressedLine(effective()));
			} else (refusal = joined(towerWhy(r) ?? r.body.reason ?? r.body.error ?? String(r.status)), render());
		} catch {
			inflight = undefined;
			refusal = m.unreachable();
			render();
		}
	}
	const target = (id: ButtonId, option?: number): (() => void) => {
		if (id === "done" || id === "entered") return () => void press(id, "done");
		if (id === "choose") return () => void press(id, "choose", { option });
		if (id === "secret") return () => void press(id, "secret");
		if (id === "restate") return () => void press(id, "restate");
		return () => {};
	};

	function partEl(p: CardModel["parts"][number], lang: string): HTMLElement {
		const body: (HTMLElement | string)[] = [];
		const clampable = o.host !== "dialog" && !p.url && !p.command && p.text.length > CLAMP_AT, clamped = clampable && !expanded.has(p.id);
		if (p.url) {
			const href = safeHref(p.url);
			body.push(h("span", { class: "wc-text wc-url", lang }, href ?? p.url));
			if (href) body.push(h("a", { class: "pair-btn wc-open", href, target: "_blank", rel: "noopener noreferrer" }, m.wc_b_link()));
		}
		if (p.command !== undefined) {
			const pre = h("pre", { class: "wc-cmd", lang }, p.command), said = h("small", { class: "wc-copied", role: "status" }), copy = h("button", { type: "button", class: "pair-btn wc-copy" }, m.wc_b_copy());
			copy.onclick = async () => {
				try {
					await navigator.clipboard.writeText(p.command!);
					said.textContent = m.wc_copied();
				} catch {
					selectText(pre); // a page that may not write the clipboard (a phone on plain http) selects the text instead
					said.textContent = m.wc_copy_select();
				}
			};
			body.push(pre, copy, h("small", { class: "wc-norun" }, m.wc_not_run()), said);
		}
		const words = !p.url && p.command === undefined ? h("span", { class: `wc-text${clamped ? " wc-clamp" : ""}`, lang }, p.text) : undefined;
		if (words) body.push(words);
		if (clampable && words) {
			const more = h("button", { type: "button", class: "wc-more", "aria-expanded": String(!clamped) }, clamped ? m.wc_more() : m.wc_less());
			more.onclick = () => (expanded.has(p.id) ? expanded.delete(p.id) : expanded.add(p.id), render());
			body.push(more);
			// The three-line clamp is only for text that needs it: once the part is laid out and fits, the toggle is not offered (a card in a wide window shows 90 characters on one line).
			if (clamped) globalThis.requestAnimationFrame?.(() => words.clientHeight > 0 && words.scrollHeight <= words.clientHeight + 1 && ((more.hidden = true), words.classList.remove("wc-clamp")));
		}
		return h("div", { class: "wc-part", "data-part": p.id }, h("b", { class: "wc-label" }, p.label), ...body);
	}
	function buttonEl(b: CardModel["buttons"][number]): HTMLElement {
		if (b.id === "reply") return panel.go;
		if (b.id === "skip") return skip;
		if (b.id === "main") {
			const route = o.main?.(effective().card?.from?.key ?? "");
			const link = h("a", { class: "pair-btn wc-main", href: route ? formatRoute(route) || "./" : "./", ...(route ? { "data-route": formatRoute(route) } : {}) }, b.label);
			if (route && o.go) link.onclick = (e: Event) => (e.preventDefault(), e.stopPropagation(), o.go!(route));
			return link;
		}
		const el = h("button", { type: "button", class: `pair-btn wc-btn${b.primary ? " wc-primary" : ""}${b.id === "choose" ? " wc-opt" : ""}${b.picked ? " wc-picked" : ""}`, "data-act": b.id, ...(b.option !== undefined ? { "data-option": String(b.option) } : {}) }, b.then ? h("b", null, b.label) : b.label, b.then ? h("small", null, b.then) : null) as HTMLButtonElement;
		el.disabled = Boolean(b.disabled);
		if (b.picked) el.setAttribute("aria-pressed", "true");
		el.onclick = target(b.id, b.option);
		return el;
	}

	function render() {
		const w = effective(), md = model(), lang = w.card?.lang ?? "";
		const doText = md.parts.find((p) => p.id === "do" || p.id === "words")?.text ?? "";
		const sig = JSON.stringify([md, folded, [...expanded], confirming, refusal, inflight, o.host]);
		root.dataset.kind = md.kind;
		root.dataset.phase = phase();
		root.dataset.folded = String(folded);
		root.dataset.pressed = String(Boolean(w.press && w.press.act !== "secret"));
		root.dataset.step = String(md.step ?? "");
		skip.hidden = md.buttons.every((b) => b.id !== "skip");
		skip.disabled = Boolean(md.buttons.find((b) => b.id === "skip")?.disabled); // the dock puts Skip in its footer, outside the buttons drawn here: it goes off with them
		if (sig === last) return;
		last = sig;
		const held = globalThis.document.activeElement as HTMLElement | null, keep = held && acts.contains(held) ? (held.dataset.act ? `${held.dataset.act}:${held.dataset.option ?? ""}` : undefined) : undefined;
		// The head: a row's folded line (tag, what to do, who raised it; a tap unfolds the rest), else the tag and the raiser above the parts.
		if (o.host === "row") {
			const fold = h("button", { type: "button", class: "wc-fold", "aria-expanded": String(!folded) }, h("b", { class: "wc-tag" }, md.tag), h("span", { class: "wc-do", lang }, doText), h("small", { class: "wc-raised" }, md.raised));
			fold.onclick = () => ((folded = !folded), render());
			head.replaceChildren(fold);
		} else head.replaceChildren(h("b", { class: "wc-tag" }, md.tag), h("small", { class: "wc-raised" }, md.raised));
		parts.hidden = folded;
		parts.replaceChildren(...md.parts.map((p) => partEl(p, lang)));
		state.textContent = md.line;
		state.hidden = !md.line;
		hint.textContent = md.remote ?? "";
		hint.hidden = !md.remote || folded;
		const buttons = md.buttons.filter((b) => !(b.id === "skip" && o.skipOutside)).filter((b) => !folded || b.primary);
		acts.replaceChildren(...buttons.map(buttonEl));
		acts.hidden = !buttons.length;
		sure.hidden = !confirming || folded;
		tells.textContent = (w.card?.from && !w.card.from.gone ? m.wc_skip_tells({ name: w.card.from.name }) : m.wc_skip_tells_tower());
		note.textContent = refusal ? m.wc_refused({ reason: refusal }) : "";
		if (keep) (Array.from(acts.querySelectorAll<HTMLElement>("[data-act]")).find((el) => `${el.dataset.act}:${el.dataset.option ?? ""}` === keep) as HTMLElement | undefined)?.focus();
		if (o.skipOutside) skip.dataset.confirming = String(confirming);
	}

	skip.onclick = () => {
		if (phase() === "ended" || inflight) return;
		confirming = true;
		render();
		yes.focus(); // the confirm is the act: the optional reason box would open a phone's keyboard over it
		sure.scrollIntoView?.({ block: "nearest" });
	};
	no.onclick = () => ((confirming = false), (reason.value = ""), render(), skip.focus());
	yes.onclick = () => void press("skip", "decline", reason.value.trim() ? { reason: reason.value.trim() } : undefined);

	/** A card the snapshot cut is read whole from the memory route, once. */
	function fetchWhole() {
		if (!cur.cut || full || read) return;
		read = true;
		void o.actions.read().then((r) => {
			const e = (r.body.entries as (BossWait & { card?: WaitCardView })[] | undefined)?.find((x) => x.id === cur.id);
			if (e?.card) (full = { card: { ...e.card, ...(e.card.from ? { from: { ...e.card.from, id: undefined } } : {}) } as WaitCardView, ...(e.press ? { press: e.press } : {}) }), render();
		}, () => {});
	}
	/** `why`: the card is off because its unit's box is away (the reason), not because the stream is down. */
	function update(next: BossWait, on = true, ended = false, why?: string) {
		cur = next;
		[live, over, blocked] = [on, ended, on ? undefined : why];
		if (cur.press && local && cur.press.at >= local.at) local = undefined; // the snapshot caught up
		panel.update(on, ended, blocked);
		fetchWhole();
		render();
	}
	fetchWhole();
	render();
	return {
		el: root,
		/** The tag of the card's kind (Needs you / Your choice / Needs a secret), which the dock's badge repeats. */
		tag: () => model().tag,
		/** The Skip button, for a host that places it itself (`skipOutside`). */
		skip,
		update,
		sending: () => Boolean(inflight) || panel.sending(),
		/** The answer box is unfolded. */
		isOpen: panel.isOpen,
		confirming: () => confirming,
		/** The host's reading of whether the raiser's `secret_drop` dialog is pending; it changes with each snapshot, so the host sets it again. */
		secretWhen(fn: (() => boolean) | undefined) {
			o.secretOpen = fn;
		},
		/** Folds the answer box, the draft kept (Esc); false when it was not open. */
		foldReply: () => panel.fold(true),
		/** The primary control takes the focus when the card is taken (Z-D20): the primary button, else the first choice, else the reply fold. */
		enter(): boolean {
			const first = Array.from(acts.querySelectorAll<HTMLButtonElement>(".wc-primary, .wc-opt")).find((b) => !b.disabled);
			return first ? (first.focus(), true) : panel.enter();
		},
	};
}

/** The wait the alert is about: the snapshot's entry, else (an alert built without one) its id and words. */
const entryOf = (a: Alert): BossWait => a.wait!.entry ?? { id: a.wait!.id, text: a.wait!.text, at: new Date(a.since ?? a.at).toISOString() };

const cards = new WeakMap<HTMLElement, ReturnType<typeof waitCard>>();
/** The dock's dialog of a wait takes the focus on its card's primary button (else its first option); false when it has none. */
export const enterWait = (el: HTMLElement) => cards.get(el)?.enter() ?? false;
/** A wait's dialog in the dock: the card in the answer slot, the link to the comms, Later and Skip in the footer's row, and none of the tower's old transmission; a wait that is over says so. */
export function waitDialog(el: HTMLElement, a: Alert, place: string, close: () => void, send: SessionPost, more: { remote?: boolean; /** The tower is a remote base's and its box takes no input now: the card answers nothing. */ away?: boolean; secretOpen?(): boolean; /** The workspace of the raiser's unit, found by its key (a head wait's alert is on the head's base, not the raiser's). */ where?(key: string): string | undefined } = {}) {
	const over = Boolean(a.gone), go = el.querySelector<HTMLElement>(".go")!;
	el.dataset.wait = ""; // the footer's link is the secondary act here (style.css): the card's buttons answer
	el.querySelector<HTMLElement>(".intel")!.hidden = true;
	text(el, "h3", waitTitle(a.role, place)); // the title says the role and the place once, so the header's place and the role under the title would repeat it
	for (const dup of [".where", ".role"]) el.querySelector<HTMLElement>(dup)!.hidden = true;
	go.textContent = m.wait_goto(); // the card is on the dialog; the footer's link is the way to the tower's comms
	aim(go, over ? undefined : { view: "session", ws: a.ws, key: unitOf(a) });
	text(el, ".state", over ? m.tower_wait_over() : m.memory_wait_boss());
	let card = cards.get(el);
	const entry = entryOf(a);
	if (!card) cards.set(el, (card = waitCard({ host: "dialog", wait: entry, actions: waitActions({ ws: a.ws, id: entry.id, tower: unitOf(a) }, send), main: (key) => ((ws) => (key && ws ? { view: "session", ws, key } : undefined))(more.where?.(key) ?? (a.ws === HEAD_KEY ? undefined : a.ws)), skipOutside: true, done: close, ...(more.remote !== undefined ? { remote: more.remote } : {}) })));
	card.secretWhen(more.secretOpen);
	if (!el.querySelector(".wait-card")) el.querySelector(".ask-root")!.replaceChildren(card.el);
	// The comms link, Later and Skip in one row of the dialog's footer, the quiet one last.
	el.querySelector("footer")!.insertBefore(card.skip, el.querySelector(".queued"));
	card.update(entry, !over && !more.away && document.body.dataset.stale !== "true", over, more.away && document.body.dataset.stale !== "true" ? m.box_answer_blocked() : undefined);
	text(el, ".tag", card.tag()); // the card's own word, not QUESTION (and not the stack's GONE: the tower did not leave, the wait ended)
}
