// A card's box grows and shrinks to the size its content needs, never jumps (docs/specs/2026-11-01-zen-view.md, The card's size). The card is two boxes: the outer one (`.zen-card`) is the page's
// width and takes an explicit height, which zen.css eases over SIZE_MS; the inner one (`.zen-card-in`) holds the content at its own size. An observer on the inner box writes its height to the
// outer one whenever it changes: the card entering with its dialog, the said line arriving, an outcome, a second question, a new dialog on the same unit. The first reading is set without a
// transition (nothing to ease from), a reading of 0 (the layer is hidden) is ignored, and reduced motion has no transition in zen.css, so the box then follows at once.

export const SIZE_MS = 520;
type Watch = new (fn: () => void) => { observe(el: Element): void; disconnect(): void };
const stops = new WeakMap<object, () => void>();

/** Sizes `outer` to `inner`'s height from now on. Without an observer (a test, an old browser) the box simply keeps its natural size. */
export function glide(outer: HTMLElement, inner: HTMLElement, Observer: Watch | undefined = (globalThis as { ResizeObserver?: Watch }).ResizeObserver) {
	if (!Observer) return;
	const watch = new Observer(() => {
		const to = inner.offsetHeight;
		if (to > 0) outer.style.height = `${to}px`;
	});
	watch.observe(inner);
	stops.set(outer, () => watch.disconnect());
}

/** The card is leaving the page (dissolving, or gone): its size stays where it is. */
export function settle(outer: HTMLElement) {
	stops.get(outer)?.();
	stops.delete(outer);
}
