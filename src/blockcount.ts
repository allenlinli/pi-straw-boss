// How many places a block can be in a Markdown document (pi-better-show's blocks: a fence whose first word names a kind, and a GitHub alert), counted with the parser's own line scan. The server cannot import the parser (the package is bundled into the page, not shipped to the
// server), and a block whose body does not fit its schema is drawn as source and has no index, so this is an upper bound on the page's indexes, not their count: an answer for a block past it is for a block that is not there. tests/blockcount.test.ts holds it equal to the parser's
// blocks plus its invalid ones.

const KINDS = new Set(["mermaid", "diff", "cards", "options", "form", "review", "mindmap", "suggest", "checklist", "table", "steps", "stats"]);
const ALERT_LINE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i, QUOTE = /^ {0,3}> ?/, BACKTICK_FENCE = /^( {0,3})(`{3,})[ \t]*([^`]*)$/, TILDE_FENCE = /^( {0,3})(~{3,})[ \t]*(.*)$/;

const closes = (line: string, marker: string) => {
	const fence = marker[0] === "`" ? /^ {0,3}(`{3,})[ \t]*$/.exec(line) : /^ {0,3}(~{3,})[ \t]*$/.exec(line);
	return fence !== null && marker[0] === fence[1]![0] && fence[1]!.length >= marker.length;
};

export function blockCount(markdown: string): number {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	let count = 0, i = 0;
	while (i < lines.length) {
		const line = lines[i]!, fence = BACKTICK_FENCE.exec(line) ?? TILDE_FENCE.exec(line);
		if (fence) {
			const marker = fence[2]!;
			let end = i + 1;
			while (end < lines.length && !closes(lines[end]!, marker)) end++;
			if (KINDS.has(fence[3]!.trim().split(/\s+/)[0]!.toLowerCase())) count++;
			i = Math.min(end + 1, lines.length);
			continue;
		}
		if (QUOTE.test(line)) {
			let end = i;
			while (end < lines.length && QUOTE.test(lines[end]!)) end++;
			if (ALERT_LINE.test(lines[i]!.replace(QUOTE, ""))) count++;
			i = end;
			continue;
		}
		i++;
	}
	return count;
}
