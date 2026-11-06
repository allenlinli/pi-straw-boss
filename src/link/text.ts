// Text a remote sender controls, as it may appear in a line a local model reads (docs/specs/2026-10-25-straw-link.md, Header; review R-F029).

/** A label's length limit (src/link/device.ts `labelOk`): the same limit holds for any sender-controlled field of a header. */
export const FIELD_MAX = 40;
const OUTSIDE = /[^A-Za-z0-9 ._-]/g;

/**
 * `text` restricted to the label character set (ASCII letters, digits, space, `.`, `_`, `-`; anything else becomes `_`) and to 40 characters,
 * with no space at either end. Never empty: `?` stands in. A header quotes the result, but it has no character left to break a field with.
 */
export function restrictLabel(text: string): string {
	const cut = text.replace(OUTSIDE, "_").trim().slice(0, FIELD_MAX).trim();
	return cut || "?";
}

const OUTSIDE_OWNER = /[^A-Za-z0-9 ._\u00b7-]/g;

/**
 * `restrictLabel` for the unit that asked a question (`main · trial13`): the label character set plus U+00B7, the separator a tab's own session name carries (`unitLabel` in `src/server/dispatcher.ts`), so the notice reads the card's and the Link row's text.
 * A middle dot forms no field, quote, or word of its own, and no other dot, bullet, or space is let through.
 */
export function restrictOwner(text: string): string {
	const cut = text.replace(OUTSIDE_OWNER, "_").trim().slice(0, FIELD_MAX).trim();
	return cut || "?";
}

/** A notice's text on printable ASCII (anything else becomes `_`), cut at `max` characters: a notice reaches agents through `boss_server`; peer fields in it are already label-restricted, so no byte of it is a peer's to choose. */
export function restrictNotice(text: string, max = 300): string {
	return text.replace(/[^\x20-\x7e]+/g, "_").slice(0, max);
}
