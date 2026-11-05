import type { Item } from "../src/items.ts";
import type { HeadUnit } from "../src/nethead.ts";
import type { HistoryEvent } from "./chat.ts";
import { joined } from "./asks.ts";
import { h } from "./dom.ts";
import { CLEAR_MS, createFade, type HeadLine, headLines, SHOWN, SHOWN_SMALL } from "./headlines.ts";
import { m } from "./paraglide/messages.js";
import type { Answer } from "./post.ts";

// The strip under Zen's breathing circle (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle): the last lines of the head's conversation, fading from the moment each is first on screen, and the input that is a hairline
// until a click or Enter unfolds it. The strip knows no page: zen.ts gives it the stream's events, the head unit of each snapshot, and the few things it calls back (the post, the model's look, the history).

/** How long a hover or focus is let go of after the pointer or focus leaves, and how long a tap holds the lines clear. */
export const LET_GO_MS = 1500, TAP_MS = 10_000;
const KEEP = 60, NOTCH = 24, SWIPE = 40, GESTURE_MS = 100;

export interface HeadIo {
	now(): number;
	later(fn: () => void, ms: number): () => void;
	/** The head's session post: `input` with `{ text, as }`. */
	post(action: string, body: Record<string, unknown>): Promise<Answer>;
	/** The head's newest page of history, for a strip that no stream event has filled. */
	latest(): Promise<{ items: Item[] }>;
	online(): boolean;
	sound(s: "low"): void;
	/** The box filled or emptied, or a send began or ended: the model looks again at what holds the screen. */
	changed(): void;
	/** The strip is at rest (every line faded, nothing held) or not: the mindfulness line shows only at rest. */
	rest(on: boolean): void;
	/** The Whole conversation link: the head's history opens. */
	history(): void;
	/** Whether the page is a phone or a window 560 px tall or less: two lines, not three. */
	small?(): boolean;
}

/** A wheel gesture over the circle screen: the sign of the travel once it passes a notch (24 px), once per gesture (events within 100 ms of each other are one, inertia included). `edge` is true when the gesture began at the end of what scrolls. */
export function wheelGesture() {
	let last = -Infinity, travel = 0, locked = false, edge = false;
	return (dy: number, at: number, atEdge: boolean): { dir: -1 | 0 | 1; edge: boolean } => {
		if (!dy) return { dir: 0, edge };
		if (at - last >= GESTURE_MS) [locked, travel, edge] = [false, 0, atEdge];
		last = at;
		travel = Math.sign(travel) === Math.sign(dy) ? travel + dy : dy;
		if (locked || Math.abs(travel) < NOTCH) return { dir: 0, edge };
		locked = true;
		return { dir: Math.sign(dy) as -1 | 1, edge };
	};
}
/**
 * The gestures over the circle screen that open and close the history: a wheel gesture up (past a notch) or a swipe up (over 40 px) opens it on the circle; a wheel gesture down that began at the end of the log closes it.
 * `on` says what the stage is for them now: the circle, the open history, or neither.
 */
export function mountGestures(stage: HTMLElement, g: { on(): "circle" | "history" | undefined; open(): unknown; close(): unknown }) {
	const wheel = wheelGesture();
	let from: number | undefined;
	stage.addEventListener("wheel", (e: WheelEvent) => {
		if (e.ctrlKey || !g.on()) return;
		const scroller = (e.target as HTMLElement | null)?.closest?.(".chat-scroll"), end = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
		const r = wheel(e.deltaY * (e.deltaMode === 1 ? 16 : 1), e.timeStamp, end);
		if (r.dir < 0) g.open();
		else if (r.dir > 0 && r.edge) g.close();
	}, { passive: true });
	stage.addEventListener("touchstart", (e: TouchEvent) => void (from = e.touches?.[0]?.clientY), { passive: true });
	stage.addEventListener("touchend", (e: TouchEvent) => {
		const start = from, to = e.changedTouches?.[0]?.clientY ?? 0;
		from = undefined;
		if (start !== undefined && start - to > SWIPE && g.on() === "circle") g.open();
	}, { passive: true });
}

/** What is a control: a tap on one is its own, never the blank space's. */
const CONTROLS = 'button, a, input, textarea, select, summary, label, [role="button"], [tabindex]:not([tabindex="-1"])';
/**
 * A tap or click on the blank space rests the head's strip (docs/specs/2026-11-04-head-tower.md, Resting the strip). `blank` says whether an element is the stage, the page behind it, or the circle, and `on` whether the circle screen is on with nothing open over it.
 * A control, the strip, the end of a drag that selected text, and the press that folded the head's open input (Esc's order: the fold first) are not it. `click`, not `pointerdown`: a swipe, a wheel gesture, and a scroll never rest the strip.
 */
export function mountRestTap(root: HTMLElement, o: { blank(at: Element): boolean; on(): boolean; head: Pick<ReturnType<typeof mountHead>, "el" | "isOpen" | "rest"> }) {
	let folded = false;
	root.addEventListener("pointerdown", () => (folded = o.head.isOpen()), true);
	root.addEventListener("click", (e) => {
		const wasOpen = folded, at = e.target as Element | null, selected = globalThis.getSelection?.();
		folded = false;
		if (wasOpen || !at || !o.on() || (selected && !selected.isCollapsed)) return;
		if (o.blank(at) && !o.head.el.contains(at) && !at.closest?.(CONTROLS)) o.head.rest();
	});
}

export function mountHead(io: HeadIo) {
	const small = io.small ?? (() => typeof matchMedia === "function" && matchMedia("(max-width: 600px), (max-height: 560px)").matches);
	const fade = createFade(io.now), live = h("p", { class: "zen-live zen-head-live", role: "status", "aria-live": "polite" });
	const list = h("ol", { class: "zen-head-lines" }), working = h("p", { class: "zen-head-working" }, m.zen_head_working()), whole = h("button", { type: "button", class: "zen-head-history", "aria-keyshortcuts": "H" }, `${m.zen_head_history()} `, h("span", { class: "zen-head-key", "aria-hidden": "true" }, m.zen_head_key()));
	const hint = h("button", { type: "button", class: "zen-head-hint" }, m.zen_head_hint());
	const box = h("textarea", { class: "zen-head-box", rows: "1", maxlength: "20000", "aria-label": m.zen_head_placeholder(), placeholder: m.zen_head_placeholder(), enterkeyhint: "send" }) as HTMLTextAreaElement;
	const note = h("p", { class: "zen-head-note", role: "alert" }), form = h("form", { class: "zen-head-form" }, box, note);
	const el = h("section", { class: "zen-head", role: "group", "aria-label": m.zen_head_label() }, list, working, live, whole, hint, form);
	[working.hidden, form.hidden, el.hidden] = [true, true, true];
	let items: Item[] = [], ids = new Set<string>(), seen = false, showing = false, unfolded = false, busy = false, off = false;
	let hushed = false, hushLines = new Set<string>(), hushWaits = new Set<string>(); // resting (Esc, or a tap on the blank space): the lines are sent away until the head answers him, asks him something, or he calls it back. Page-local: the next visit starts awake.
	let unit: HeadUnit | undefined, restOn: boolean | undefined, rested = false, kept = 0, stopTimer = () => {}, hover = false, focus = false, touching = false, stopHover = () => {}, stopTouch = () => {}, local = 0;
	const known = new Set<string>(), shown = new Map<string, HTMLElement>(), pending: { id: string; text: string; seen: number }[] = [];
	const one = (text: string) => text.replace(/\s+/g, " ").trim();
	const openWaits = () => new Set(unit?.service?.memory?.bossWaits.filter((w) => !w.answered).map((w) => w.id));
	const bosses = (text: string) => headLines(items).filter((l) => l.who === "boss" && l.text === text).length;

	/** All the lines: the history's, then what the boss just sent that the stream has not brought back yet. */
	function lines(): HeadLine[] {
		const all = headLines(items);
		for (let i = pending.length - 1; i >= 0; i--) if (bosses(one(pending[i]!.text)) > pending[i]!.seen) pending.splice(i, 1); // a sent line goes when the stream brings its copy
		return [...all, ...pending.map((p) => ({ id: p.id, who: "boss" as const, text: one(p.text), at: io.now() }))];
	}
	/** Delays of a line's animation from its age: a line first on screen long ago carries on from where it is. Set when its element is made and when the animation starts again (the strip back on screen). A hover, focus, or tap never stops it (zen.css `--lift`), so none of them sets a delay. */
	const delay = (id: string) => `${(CLEAR_MS - fade.age(id)) / 1000}s`;
	function restart() {
		for (const [id, li] of shown) {
			li.style.animationName = "none"; // the animation really starts again, so the new delay is from its start
			void li.offsetWidth;
			li.style.animationName = "";
			li.style.animationDelay = delay(id);
		}
	}
	const announce = (text: string) => ((live.textContent = ""), (live.textContent = text));

	function draw() {
		const keep = lines().slice(-(small() ? SHOWN_SMALL : SHOWN));
		const waits = Boolean(unit?.service?.memory?.bossWaits.some((w) => !w.answered)), held = waits && keep.at(-1)?.who !== "boss";
		fade.see(keep.map((l) => l.id));
		for (const [id, li] of shown) if (!keep.some((l) => l.id === id)) (li.remove(), shown.delete(id));
		keep.forEach((l, i) => {
			let li = shown.get(l.id);
			if (!li) (li = h("li", { class: "zen-hl" }), shown.set(l.id, li), (li.style.animationDelay = delay(l.id)));
			const rank = keep.length - 1 - i;
			if (li.textContent !== l.text) li.textContent = l.text;
			li.setAttribute("data-who", l.who);
			li.setAttribute("data-rank", String(rank));
			li.toggleAttribute("data-held", held && rank === 0);
			if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
		});
		// The head's next reply is said once to a reader of the page: the lines that were there when the strip first filled are known and never announced.
		if (seen) for (const l of keep) if (l.who === "head" && !known.has(l.id)) (known.add(l.id), announce(l.text));
		working.hidden = unit?.mark !== "working" || hushed;
		[rested, kept] = [hushed || fade.rested(keep.map((l) => l.id), held), keep.length];
		settle();
		stopTimer();
		const when = fade.restAt(keep.map((l) => l.id), held);
		stopTimer = when === undefined ? () => {} : io.later(draw, Math.max(0, when - io.now()) + 10);
		hint.hidden = unfolded && !off;
		form.hidden = !unfolded || off;
	}

	function load(reset: boolean, next: Item[]) {
		const fresh = reset ? next : next.filter((it) => !ids.has(it.id));
		if (reset) ids = new Set();
		items = (reset ? [] : items).concat(fresh).slice(-KEEP);
		for (const it of fresh) ids.add(it.id);
		for (const id of [...ids]) if (!items.some((it) => it.id === id)) ids.delete(id);
		if (reset && !seen) (headLines(items).forEach((l) => known.add(l.id)), (seen = true)); // what the first page holds is what was already said
		if (hushed) wakes();
		if (showing) draw();
	}

	/** A resting strip wakes for what the boss is owed and nothing else: a head line that answers something he sent, or a wait for him that was not open when it rested. The head's own reports (a tower's answer, a timer) are not. */
	function wakes() {
		if (headLines(items).some((l) => l.reply && !hushLines.has(l.id)) || [...openWaits()].some((id) => !hushWaits.has(id))) wake();
	}
	/** Esc, or a tap on the blank space: the lines go and the mindfulness line comes back, whatever a hover, focus, or touch holds clear. False when the strip is not on show with lines to send away. */
	function rest() {
		if (!restable()) return false;
		[hushed, hushLines, hushWaits] = [true, new Set(headLines(items).map((l) => l.id)), openWaits()];
		el.dataset.hushed = "";
		bright();
		draw();
		return true;
	}
	/** The head tower is called back: the lines show again with the age they have. */
	function wake() {
		if (!hushed) return false;
		hushed = false;
		delete el.dataset.hushed;
		bright();
		if (showing) draw();
		return true;
	}
	/** There is something to rest: the strip is on show, awake, with lines that are not already at their rest level. */
	const restable = () => showing && !off && !hushed && kept > 0 && restOn !== true;

	/** The strip is quiet (the mindfulness line shows, the link fades out) when every line has faded and nothing brings them back: a hover, focus, or tap makes the lines clear, and then one thing is in paper, not two. */
	function settle() {
		if (!showing) return;
		const quiet = hushed || (rested && !(hover || focus || touching));
		whole.hidden = !kept;
		quiet ? (whole.dataset.away = "") : delete whole.dataset.away; // at rest it fades out and keeps its room: nothing moves when the lines come clear
		if (quiet !== restOn) io.rest((restOn = quiet));
	}
	function bright() {
		el.toggleAttribute("data-bright", !hushed && (hover || focus || touching));
		settle();
	}
	const letGo = (set: () => void) => (stopHover(), (stopHover = io.later(() => (set(), bright()), LET_GO_MS)));
	el.addEventListener("pointerenter", (e: PointerEvent) => e.pointerType !== "touch" && (stopHover(), (hover = true), bright()));
	el.addEventListener("pointerleave", (e: PointerEvent) => e.pointerType !== "touch" && letGo(() => (hover = false)));
	el.addEventListener("focusin", () => (stopHover(), (focus = true), bright()));
	el.addEventListener("focusout", () => letGo(() => (focus = false)));
	el.addEventListener("pointerdown", (e: PointerEvent) => {
		if (e.pointerType !== "touch") return;
		stopTouch();
		touching = true;
		bright();
		stopTouch = io.later(() => ((touching = false), bright()), TAP_MS);
	});

	function grow() {
		box.style.height = "auto";
		box.style.height = `${box.scrollHeight}px`; // style.css caps it at four lines
	}
	const say = (text: string) => ((note.textContent = text), (note.dataset.tone = text ? "error" : ""));
	function fold(focusHint = false) {
		if (!unfolded) return false;
		unfolded = false;
		hint.hidden = off;
		form.hidden = true;
		if (focusHint) hint.focus();
		return true;
	}
	function unfold() {
		if (!showing || !unit || off) return false;
		wake(); // calling the head back wakes the strip
		unfolded = true;
		draw();
		box.focus();
		return true;
	}
	/** The stage went to something else: its timers stop, its draft stays. */
	function stop() {
		showing = false;
		stopTimer();
		stopHover();
		stopTouch();
		[hover, focus, touching] = [false, false, false];
		bright();
	}
	function mix() {
		const down = !io.online();
		box.disabled = down || off;
		if (down) say(m.link_offline());
		else if (note.textContent === m.link_offline()) say("");
	}
	async function send() {
		const text = box.value;
		if (!text.trim() || busy || !io.online()) return;
		[busy, box.value] = [true, ""];
		grow();
		say("");
		const mine = { id: `local-${++local}`, text, seen: bosses(one(text)) };
		pending.push(mine);
		draw();
		io.changed();
		const refuse = (why: string) => {
			if (pending.includes(mine)) pending.splice(pending.indexOf(mine), 1);
			box.value = box.value ? `${text}\n${box.value}` : text;
			grow();
			say(why);
			io.sound("low");
		};
		try {
			const r = await io.post("input", { text, as: "send" });
			if (!r.ok) refuse(m.zen_head_refused({ reason: joined(r.body.reason ?? r.body.error ?? String(r.status)) }));
		} catch {
			refuse(m.zen_head_unreachable());
		}
		busy = false;
		if (showing) draw();
		io.changed();
	}
	box.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		e.preventDefault();
		void send();
	});
	box.addEventListener("input", () => (say(""), grow(), io.changed()));
	form.addEventListener("submit", (e) => (e.preventDefault(), void send()));
	hint.onclick = () => void unfold();
	whole.onclick = () => io.history();
	// A blur with an empty box folds; with a draft it stays. The hint's own blur is not the box's: a click on the folded hint focuses it, and unfolding hides it, which Chrome reports as a focusout of the hint just before the box takes the focus.
	el.addEventListener("focusout", (e: FocusEvent) => e.target !== hint && unfolded && box.value === "" && !busy && fold());

	return {
		el,
		/** The head unit of the latest snapshot (none: the server runs no tower service); `ready` is whether a snapshot has come at all. */
		sync(next: HeadUnit | undefined, ready: boolean) {
			unit = next;
			off = ready && !next;
			el.hidden = !ready;
			hint.textContent = off ? m.zen_head_off() : m.zen_head_hint();
			hint.disabled = off;
			if (off) fold();
			mix();
			if (hushed) wakes();
			if (showing) draw();
		},
		/** The strip is on the stage: its lines start (or carry on) their fade, and the head's newest page is read when no event has filled it. */
		show() {
			showing = true;
			draw();
			restart();
			if (!seen) void io.latest().then((page) => !seen && load(true, page.items), () => {});
		},
		stop,
		/** Zen hid: the draft is dropped and the input folded. */
		reset() {
			stop();
			fold();
			[hushed, hushLines, hushWaits] = [false, new Set(), new Set()];
			delete el.dataset.hushed;
			box.value = "";
			say("");
			pending.length = 0;
		},
		history(e: HistoryEvent) {
			if (e.reset || e.items?.length) load(Boolean(e.reset), e.items ?? []);
		},
		unfold,
		fold,
		rest,
		wake,
		/** The strip is resting (Esc or a tap on the blank space sent its lines away). */
		hushed: () => hushed,
		/** The lines are on show and Esc can send them away (zenkeys.ts `rest`). */
		restable,
		isOpen: () => unfolded && showing,
		/** The box holds a draft: the screen is his until DRAFT_MS after his last touch (zen.ts). */
		drafting: () => unfolded && showing && box.value !== "",
		/** Nothing is clear and nothing is held. */
		rested: () => restOn ?? true,
		/** A press somewhere on the page: a tap elsewhere ends the touch that holds the lines clear. */
		tapAway(target: unknown) {
			if (!touching || el.contains(target as Node)) return;
			stopTouch();
			touching = false;
			bright();
		},
	};
}

/** The head's history in Zen reads as talk: a `tower_send` row (`(workspace: X)`) becomes one quiet line, "Sent to the X tower"; the card's arguments stay behind its disclosure. Standard's log (chat.ts) is not touched. */
export function quietForwards(root: HTMLElement): () => void {
	const fix = () => root.querySelectorAll<HTMLElement>("details.act > summary").forEach((row) => {
		const name = row.querySelector("code"), sum = row.querySelector<HTMLElement>(".sum"), to = /^\(workspace: (.+?)\)$/.exec(sum?.textContent ?? "")?.[1];
		if (name?.textContent === "tower_send" && sum && to) (name.hidden = true, sum.textContent = m.zen_head_sent({ workspace: to }), row.closest("details")?.classList.add("quiet"));
	});
	const watch = new MutationObserver(fix);
	watch.observe(root, { childList: true, subtree: true });
	fix();
	return () => watch.disconnect();
}
