// Whether the boss has begun to answer the card on Zen's screen (Z-D18, docs/specs/2026-11-01-zen-view.md, Blocking first). A blocking question takes the screen from a card that blocks no agent only while the boss has not touched that card.

/** A pick or text already on the card: a text in a field of it, or a choice picked in its panel (a button with `aria-checked="true"`). Nothing here holds for a card the boss only looks at. */
export const begun = (el: ParentNode): boolean =>
	[...el.querySelectorAll<HTMLInputElement>("textarea, input")].some((f) => !/^(checkbox|radio|button|submit|reset|hidden|file|color|image|range)$/i.test(f.type ?? "") && f.value !== "") || el.querySelector('[aria-checked="true"]') !== null;

/**
 * Reads the card's touched state: the answer is on its way, a fold or the reply box is open, something is typed or picked, or a tap, a key, or an input reached the card in the last `hold` ms (the draft guard's window, `DRAFT_MS`) (which also covers a field the boss focused). A card the page focused by itself, or that
 * the boss only watches, is not touched.
 */
export function watchTouch(card: HTMLElement, o: { now(): number; hold: number; /** The answer is on its way, or a fold or the reply box is open. */ busy(): boolean }): () => boolean {
	let at = -Infinity;
	for (const type of ["pointerdown", "touchstart", "keydown", "input"]) card.addEventListener(type, () => (at = o.now()), { capture: true, passive: true });
	return () => o.busy() || o.now() - at < o.hold || begun(card);
}
