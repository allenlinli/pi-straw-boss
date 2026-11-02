// A dialog with several questions in Zen (docs/specs/2026-11-01-zen-view.md, Several questions): the question blocks of the answer panel (ask.ts builds them, Standard keeps them stacked) sit in
// one column (zen.css). One block is focused: open, at full strength. The others are faded to one line, their summary: the header (or the question) and, once it has one, the answer after a dot. The
// faded blocks' controls are not drawn, so only a tap, Enter, or Tab on the line is heard, and it brings that block in. The column has a fixed height (zen.css), so the card's size (zensize.ts)
// never follows the focus; a focused block taller than the room scrolls inside itself and always opens at its top, with a deeper soft edge at its foot while more lies below. The send row is outside the column and stays in view.
//
// The focus moves by a page, never by free scrolling: one wheel gesture or one swipe moves one question (the focused block's own scroll takes the wheel first, until it reaches its end), and so do
// a tap on a line, a pointer's pick of a single choice (the next question without an answer comes in after a beat), and the keys of askkeys.ts (Tab, Shift+Tab, Enter), which ask for the block to be shown
// (`ask-reveal`) before they put the keyboard focus in it, because a browser cannot focus what is not drawn.

export interface QEnv {
	/** The page's timer: runs `fn` after `ms` and returns what cancels it. */
	later(fn: () => void, ms: number): () => void;
}
/** How long a tap on a single choice waits before the next question comes in, so the pick is seen first. */
export const BEAT_MS = 240;
/** Wheel events closer than this are one gesture, and the ones that follow a move are its inertia. */
const GESTURE_MS = 100;
/** The wheel travel (px) that makes a move, and the swipe (px) that does; a quicker, shorter flick (px per ms) does too. */
const NOTCH = 24, SWIPE = 40, FLICK = 0.3;
const marked = new WeakSet<object>();
const CHOICE = '[role="radio"],[role="checkbox"]';
const is = (el: Element, cls: string) => (el.getAttribute("class") ?? "").split(" ").includes(cls);
const short = (s: string) => (s.length > 32 ? `${s.slice(0, 31)}…` : s);

/** `data-more` is on `el` while more of it lies below the fold, so the soft edge at its foot is deeper (zen.css) and a list that goes on under the send row is not taken for the whole list. */
function more(el: HTMLElement) {
	const check = () => el.toggleAttribute("data-more", el.scrollHeight - el.scrollTop - el.clientHeight > 4);
	for (const type of ["scroll", "input"]) el.addEventListener(type, check, { passive: true }); // typing grows a textarea
	if (typeof ResizeObserver !== "undefined") new ResizeObserver(check).observe(el);
}

/** The panel `hold` carries, enhanced once when it has two questions or more; a panel with one (or none) is left as Standard draws it. Safe to call after every update of the dialog. */
export function syncQuestions(hold: HTMLElement, env: QEnv) {
	const panel = [...hold.children].find((el): el is HTMLElement => is(el, "ask"));
	if (!panel || marked.has(panel)) return;
	const kids = [...panel.children], blocks = kids.filter((el): el is HTMLElement => is(el, "ask-one"));
	marked.add(panel);
	for (const el of kids) if (!is(el, "ask-acts") && !is(el, "ask-note")) more(el as HTMLElement); // whatever lies above the send row may scroll inside the room that is left
	if (blocks.length < 2) return;
	const scroller = document.createElement("div");
	scroller.setAttribute("class", "zen-qs");
	// Each block begins with its summary line: the question's name, and its answer once there is one.
	const lines = blocks.map((b) => {
		const [name, said, line] = ["span", "span", "button"].map((tag) => document.createElement(tag));
		name!.setAttribute("class", "zen-sum-q");
		said!.setAttribute("class", "zen-sum-a");
		name!.textContent = b.querySelector(".ask-head")?.textContent || b.querySelector(".ask-q")?.textContent || "";
		line!.setAttribute("class", "zen-sum");
		line!.setAttribute("type", "button");
		line!.append(name!, said!);
		b.replaceChildren(line!, ...b.children);
		return said!;
	});
	scroller.append(...blocks);
	panel.replaceChildren(...kids.slice(0, kids.indexOf(blocks[0]!)), scroller, ...kids.slice(kids.indexOf(blocks.at(-1)!) + 1));
	let at = 0, last = -Infinity, travel = 0, locked = false, touch: { y: number; at: number; top: number } | undefined;
	const answer = (b: HTMLElement) => [...[...b.querySelectorAll('[aria-checked="true"]')].map((o) => o.querySelector("b")?.textContent ?? ""), ...[...b.querySelectorAll<HTMLTextAreaElement>("textarea")].map((t) => short(t.value.trim()))].filter(Boolean).join(", ");
	const mark = () => blocks.forEach((b, k) => {
		if (k === at) return void delete b.dataset.dim;
		b.dataset.dim = "";
		lines[k]!.textContent = answer(b) && ` · ${answer(b)}`;
	});
	const choice = (b: HTMLElement) => b.querySelector<HTMLElement>('[aria-checked="true"]') ?? b.querySelector<HTMLElement>(CHOICE) ?? b.querySelector<HTMLElement>("textarea");
	const done = (b: HTMLElement) => answer(b) !== "";
	const inside = () => blocks.some((b) => b.contains(document.activeElement));
	const room = (b: HTMLElement, dir: number) => (dir < 0 ? b.scrollTop > 0 : b.scrollTop + b.clientHeight < b.scrollHeight - 1);
	/** Question `k` is the focused one: it opens at its top, the others fold to their lines; `focus` also puts the keyboard focus inside it, kept in view if the question is taller than the room. */
	const go = (k: number, focus: boolean) => {
		at = k;
		mark();
		blocks[k]!.scrollTop = 0; // after mark(): a block that is not drawn keeps the place it was left at
		const to = focus ? choice(blocks[k]!) : undefined;
		to?.focus({ preventScroll: true });
		const [r, v] = [to?.getBoundingClientRect?.(), blocks[k]!.getBoundingClientRect?.()];
		if (r && v && r.bottom > v.bottom) blocks[k]!.scrollTop += r.bottom - v.bottom;
	};
	/** A move of one question from the focused one, or nothing at an end. */
	const step = (dir: number) => at + dir >= 0 && at + dir < blocks.length && go(at + dir, inside());
	const blockOf = (t: unknown) => blocks.findIndex((b) => b.contains(t as Node));
	mark();
	scroller.addEventListener("wheel", (e) => {
		const cur = blocks[at]!, dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientHeight : 1);
		if (!dy) return;
		const same = e.timeStamp - last < GESTURE_MS; // the next event of a gesture, or of the inertia that follows it
		last = e.timeStamp;
		if (!same) [locked, travel] = [false, 0];
		if (room(cur, dy)) { // the question's own scroll goes first, and the gesture that began in it ends in it
			locked = true;
			if (!cur.contains(e.target as Node)) (e.preventDefault(), (cur.scrollTop += dy)); // over a line, the browser would scroll nothing
			return;
		}
		e.preventDefault();
		travel = Math.sign(travel) === Math.sign(dy) ? travel + dy : dy;
		if (locked || Math.abs(travel) < NOTCH) return;
		[locked, travel] = [true, 0];
		step(Math.sign(dy));
	}, { passive: false });
	scroller.addEventListener("touchstart", (e) => void (touch = { y: e.touches[0]!.clientY, at: e.timeStamp, top: blocks[at]!.scrollTop }), { passive: true });
	scroller.addEventListener("touchend", (e) => {
		const [from, dy] = [touch, e.changedTouches[0]!.clientY - (touch?.y ?? 0)];
		touch = undefined;
		if (!from || from.top !== blocks[at]!.scrollTop) return; // the finger scrolled the question: that was its scroll
		const [far, quick] = [Math.abs(dy) > SWIPE, Math.abs(dy) >= 16 && Math.abs(dy) / Math.max(1, e.timeStamp - from.at) >= FLICK];
		if (far || quick) step(dy < 0 ? 1 : -1);
	}, { passive: true });
	panel.addEventListener("ask-reveal", (e) => { // a key is about to focus a control in another question
		const k = blockOf((e as CustomEvent<Element>).detail);
		if (k >= 0 && k !== at) go(k, false);
	});
	panel.addEventListener("focusin", (e) => {
		const k = blockOf(e.target);
		if (k >= 0 && k !== at) go(k, is(e.target as Element, "zen-sum")); // Tab onto a line shows its question and goes in
	});
	scroller.addEventListener("click", (e) => {
		const k = blockOf(e.target);
		if (k < 0) return;
		if (k !== at) return go(k, true); // a tap on a line
		if (e.detail > 0 && (e.target as HTMLElement).closest('[role="radio"]')) // a pointer's pick of one choice, on the button or the words in it (the arrow keys' and Enter's go through askkeys.ts)
			env.later(() => {
				const next = blocks.map((_, i) => (k + 1 + i) % blocks.length).find((i) => i !== k && !done(blocks[i]!));
				if (at === k && next !== undefined) go(next, true);
			}, BEAT_MS);
	});
}
