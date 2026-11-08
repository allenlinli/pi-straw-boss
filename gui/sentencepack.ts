import type { m as base } from "./paraglide/messages.js";

// The page's sentences, the runtime half (gui/sentences.ts is the module the page imports): a message that a theme's pack names is said in the pack's words, and every other message is Paraglide's. The pack's text names its inputs as `{name}`,
// the way the message files do (tests/raven-words.test.ts checks they match). With no pack loaded (Standard, a theme still on its way) a message is the base's, so a page never waits on the network for a sentence.
// gui/nouns.ts does the same for the strings that name a role. This module imports no Paraglide runtime: a module that imports it is kept in the entry whole, and the messages with it (the bundler cannot split them any more);
// the registry hands over the locale getter with the pack instead.

export type SentenceId = keyof typeof base;
/** A theme's sentences by locale (`en`, `zh-TW`): the message id and its text with `{input}` slots. */
export type SentencePack = Partial<Record<string, Partial<Record<SentenceId, string>>>>;

let pack: SentencePack | undefined, locale: () => string;
/** The pack of the view the page shows now, with the getter of the page's locale; no pack for Standard. */
export const useSentences = (next: SentencePack | undefined, getLocale: () => string) => void ((pack = next), (locale = getLocale));

type Message = (inputs?: Record<string, unknown>, options?: { locale?: string }) => string;
const fill = (text: string, inputs: Record<string, unknown> | undefined) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(inputs?.[key]));
/** A message as the page says it: `scripts/gui-sentences.mjs` writes one module per message (gui/paraglide/said/) that calls this, each module its own so a chunk carries the messages it uses. */
export function say(id: string, message: Message, inputs?: Record<string, unknown>, options?: { locale?: string }): string {
	const text = pack?.[options?.locale ?? locale()]?.[id as SentenceId];
	return text === undefined ? message(inputs, options) : fill(text, inputs);
}
