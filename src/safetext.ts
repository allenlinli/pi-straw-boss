// What a teammate's device wrote, as the boss reads it: written out, so a box's string cannot repaint the screen the boss approves on, and no terminal control sequence (an OSC 52 clipboard write, a cursor move) leaves pi.
// bosslink.ts (confirms, questions, labels) and bossopen.ts (`link units`, the stop confirm) read every string a teammate wrote through these two.

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;
/** `text` with every control, bidi, and invisible formatting character written out (`\x1b`, `\u202e`); line breaks stay (for arguments and question text, which have lines). */
export const plain = (text: string) => text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").replace(UNSAFE, (c) => (c.charCodeAt(0) < 256 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
/** `text` as one line: as `plain`, with its line breaks written out too (`\n`), so a field that is one line of a screen cannot start another. */
export const line = (text: string) => plain(text).replace(/\n/g, "\\n");
