// Reading the header at the very start of a message (header.ts writes it): its fields, and the message without one of them.

interface Span { key: string; value: string; start: number; end: number }
/** The fields of the header at the very start of a message with where each lies in the text, and where the header ends (after its `]`); undefined when the message does not open with a well-formed header. */
function scan(message: string): { spans: Span[]; end: number } | undefined {
	const open = "[straw net ";
	if (!message.startsWith(open)) return undefined;
	const spans: Span[] = [];
	let i = open.length;
	for (;;) {
		while (message[i] === " ") i++;
		if (message[i] === "]") return { spans, end: i + 1 };
		const start = i, key = /^[a-z_-]+=/.exec(message.slice(i, i + 40))?.[0];
		if (!key) return undefined;
		i += key.length;
		let value: string;
		if (message[i] === '"') {
			const end = message.indexOf('"', i + 1);
			if (end < 0) return undefined;
			value = message.slice(i + 1, end);
			i = end + 1;
		} else {
			const end = /[\s\]"]/.exec(message.slice(i))?.index;
			if (end === undefined) return undefined;
			value = message.slice(i, i + end);
			i += end;
		}
		spans.push({ key: key.slice(0, -1), value, start, end: i });
	}
}

/**
 * The fields of the header at the very start of a message, or undefined when the message does not open with one. A quoted value keeps its spaces, `=`, and `]`, so a name that spells out
 * `why=blocked` stays inside its own field; the text under the header is never read.
 */
export function fieldsOf(message: string): Record<string, string> | undefined {
	const scanned = scan(message);
	if (!scanned) return undefined;
	const fields: Record<string, string> = {};
	for (const { key, value } of scanned.spans) fields[key] ??= value;
	return fields;
}

/** The message with every field named `key` taken out of its leading header (untouched when it has none); the text under the header is never read. */
export function withoutField(message: string, key: string): string {
	const scanned = scan(message);
	if (!scanned || !scanned.spans.some((x) => x.key === key)) return message;
	const kept = scanned.spans.filter((x) => x.key !== key).map((x) => message.slice(x.start, x.end));
	return `[straw net ${kept.join(" ")}${message.slice(scanned.end - 1)}`;
}
