// A dialog with several questions in Zen (docs/specs/2026-11-01-zen-view.md, Several questions): the question blocks of the answer panel (ask.ts builds them, Standard keeps them stacked) sit in
// one vertical scroller that snaps each block to its centre. One block is focused, centred, at full strength; the others stay in view, faded (`data-dim`, zen.css) and inert to a pointer except
// a tap, which brings that block in. The scroller has a fixed height (zen.css), so the card's size (zensize.ts) never follows the focus. The send row is outside the scroller and stays in view.
//
// The focused block follows three things: where the keyboard focus lands (askkeys.ts moves it from a question to the next on Tab and Enter, and the browser does elsewhere), a tap on a faded
// block or on a single choice's option (the next question that has no answer comes in after a beat), and the scroll itself (a wheel or a swipe: the block nearest the middle when it stops
// is the focused one). A scroll this file starts holds the focus where it is going until it arrives, so the blocks it passes on the way do not flicker.

export interface QEnv {
	/** The page's timer: runs `fn` after `ms` and returns what cancels it. */
	later(fn: () => void, ms: number): () => void;
	/** Whether the system asks for less motion: the scroll is then instant. */
	reduced(): boolean;
}
export const reducedNow = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** How long a tap on a single choice waits before the next question comes in, so the pick is seen first. */
export const BEAT_MS = 240;
/** The longest a scroll we started holds the focus (a smooth scroll that never arrives, as when the layer is hidden). */
export const HOLD_MS = 900;
const marked = new WeakSet<object>();
const CHOICE = '[role="radio"],[role="checkbox"]';
const is = (el: Element, cls: string) => (el.getAttribute("class") ?? "").split(" ").includes(cls);

/** The panel `hold` carries, enhanced once when it has two questions or more; a panel with one (or none) is left as Standard draws it. Safe to call after every update of the dialog. */
export function syncQuestions(hold: HTMLElement, env: QEnv) {
	const panel = [...hold.children].find((el): el is HTMLElement => is(el, "ask"));
	if (!panel || marked.has(panel)) return;
	const kids = [...panel.children], blocks = kids.filter((el): el is HTMLElement => is(el, "ask-one"));
	if (blocks.length < 2) return;
	marked.add(panel);
	const scroller = document.createElement("div");
	scroller.setAttribute("class", "zen-qs");
	scroller.append(...blocks);
	panel.replaceChildren(...kids.slice(0, kids.indexOf(blocks[0]!)), scroller, ...kids.slice(kids.indexOf(blocks.at(-1)!) + 1));
	let at = 0, target: number | undefined, release = () => {};
	const mark = () => blocks.forEach((b, k) => (k === at ? delete b.dataset.dim : (b.dataset.dim = "")));
	const answered = (b: HTMLElement) => b.querySelectorAll('[aria-checked="true"]').length > 0 || [...b.querySelectorAll<HTMLTextAreaElement>("textarea")].some((t) => t.value.trim() !== "");
	const choice = (b: HTMLElement) => b.querySelector<HTMLElement>('[aria-checked="true"]') ?? b.querySelector<HTMLElement>(CHOICE) ?? b.querySelector<HTMLElement>("textarea");
	const inside = () => blocks.some((b) => b.contains(document.activeElement));
	const nearest = () => {
		const mid = scroller.scrollTop + scroller.clientHeight / 2;
		return blocks.reduce((best, b, k) => (Math.abs(b.offsetTop + b.offsetHeight / 2 - mid) < Math.abs(blocks[best]!.offsetTop + blocks[best]!.offsetHeight / 2 - mid) ? k : best), 0);
	};
	const centre = (k: number, behavior: ScrollBehavior) => {
		const b = blocks[k]!;
		scroller.scrollTo({ top: Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, b.offsetTop - (scroller.clientHeight - b.offsetHeight) / 2)), behavior });
	};
	const settle = () => (release(), (release = () => {}), (target = undefined));
	/** Question `k` is the focused one: it fades in, the others fade, and the scroller moves it to the middle; `focus` also puts the keyboard focus inside it. */
	const go = (k: number, focus: boolean) => {
		settle();
		[at, target] = [k, k];
		mark();
		centre(k, env.reduced() ? "auto" : "smooth");
		release = env.later(settle, HOLD_MS);
		if (focus) choice(blocks[k]!)?.focus({ preventScroll: true });
	};
	const blockOf = (t: EventTarget | null) => blocks.findIndex((b) => b.contains(t as Node));
	mark();
	env.later(() => at === 0 && target === undefined && centre(0, "auto"), 0); // the first block in the middle once the panel has its layout
	scroller.addEventListener("scroll", () => {
		const k = nearest();
		if (target !== undefined) return void (k === target && settle()); // our own scroll: the focus is already where it goes
		if (k === at) return;
		const had = inside();
		at = k;
		mark();
		if (had) choice(blocks[k]!)?.focus({ preventScroll: true }); // the keyboard focus does not stay in a faded block
	}, { passive: true });
	for (const type of ["wheel", "touchstart"]) scroller.addEventListener(type, settle, { passive: true }); // a hand on the scroller takes over from ours
	panel.addEventListener("focusin", (e) => {
		const k = blockOf(e.target);
		if (k >= 0 && k !== at) go(k, false);
	});
	scroller.addEventListener("click", (e) => {
		const k = blockOf(e.target);
		if (k < 0) return;
		if (k !== at) return go(k, true); // a tap on a faded block
		if (e.detail > 0 && (e.target as HTMLElement).closest('[role="radio"]')) // a pointer's pick of one choice, on the button or the words in it (the arrow keys' and Enter's go through askkeys.ts)
			env.later(() => {
				const next = blocks.map((_, i) => (k + 1 + i) % blocks.length).find((i) => i !== k && !answered(blocks[i]!));
				if (at === k && next !== undefined) go(next, true);
			}, BEAT_MS);
	});
}
