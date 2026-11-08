// The page's messages: every page file reads them through this `m`, which is Paraglide's namespace with one more layer, so the active theme's sentences (gui/themes/<view>/sentences.ts, taken by the registry) can say a message in the
// view's own words (gui/sentencepack.ts). `npm run gui:i18n` writes the layer beside Paraglide's output, one module per message, which keeps the bundler's tree shaking: a page carries the messages it uses.
export * as m from "./paraglide/said/_index.js";
