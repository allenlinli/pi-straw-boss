// Whether the boss is answering the card on Zen's screen (Z-D18, docs/specs/2026-11-01-zen-view.md, Blocking first). A blocking question takes the screen from a card that blocks no agent unless the boss touched that card lately.

/**
 * Reads the card's touched state: the answer is on its way, or a tap, a touch, a key, a wheel, or an input reached the card in the last `hold` ms (the draft guard's window, `DRAFT_MS`; this also covers a field the boss focused).
 * An open fold or reply box, a draft, and a pick hold nothing once the boss has let go (boss ruling 2026-11-06 「Touched expires after 20 s; draft kept」: walking away from a card does not hold the screen, and the card keeps its draft for when it returns).
 * A card the page focused by itself, or that the boss only watches, is not touched.
 */
export function watchTouch(card: HTMLElement, o: { now(): number; hold: number; /** The answer is on its way. */ busy(): boolean }): () => boolean {
	let at = -Infinity;
	for (const type of ["pointerdown", "touchstart", "keydown", "input", "wheel"]) card.addEventListener(type, () => (at = o.now()), { capture: true, passive: true });
	return () => o.busy() || o.now() - at < o.hold;
}
