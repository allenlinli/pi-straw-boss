// Writes gui/paraglide/said/ after Paraglide compiled the messages (`npm run gui:i18n`): the page's `m` (gui/sentences.ts), Paraglide's messages again with one layer more. A message that a theme's sentence pack names
// (gui/themes/<view>/sentences.ts) is a module that calls `say` (gui/sentencepack.ts), which says the pack's text while that theme is shown; every other message is Paraglide's own, re-exported, so a page carries the same code for it.
// One module per message, as Paraglide writes them, with no call at load: the bundler splits and drops messages by module, and a chunk carries only the messages it uses.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const gui = join(import.meta.dirname, "..", "gui"), out = process.argv[2] ?? join(gui, "paraglide"), dir = join(out, "said"); // the compiled folder, gui/paraglide unless a test names another
const ids = [...readFileSync(join(out, "messages", "_index.js"), "utf8").matchAll(/^export \* from '\.\/(\w+)\.js'/gm)].map((hit) => hit[1]);
if (ids.length === 0) throw new Error("gui/paraglide/messages/_index.js lists no message: did the compile run?");
const themes = join(gui, "themes"), named = new Set();
for (const view of readdirSync(themes)) {
	if (!existsSync(join(themes, view, "sentences.ts"))) continue;
	const { SENTENCES } = await import(join(themes, view, "sentences.ts"));
	for (const pack of Object.values(SENTENCES)) for (const id of Object.keys(pack)) named.add(id);
}
const unknown = [...named].filter((id) => !ids.includes(id));
if (unknown.length) throw new Error(`a theme's sentence pack names messages that do not exist: ${unknown.join(", ")}`);
mkdirSync(dir, { recursive: true });
// a message the compile dropped or renamed leaves its module behind otherwise, and the bundler would still reach it
const current = new Set(ids.flatMap((id) => [`${id}.js`, `${id}.d.ts`]).concat(["_index.js", "_index.d.ts"]));
for (const file of readdirSync(dir)) if (!current.has(file)) rmSync(join(dir, file), { force: true });
const head = "/* eslint-disable */\n";
for (const id of ids) {
	const wrapped = named.has(id);
	writeFileSync(join(dir, `${id}.js`), head + (wrapped
		? `import { ${id} as base } from "../messages/${id}.js";\nimport { say } from "../../sentencepack.ts";\nexport const ${id} = (inputs, options) => say("${id}", base, inputs, options);\n`
		: `export { ${id} } from "../messages/${id}.js";\n`));
	writeFileSync(join(dir, `${id}.d.ts`), `${head}import { ${id} as base } from "../messages/${id}.js";\nexport declare const ${id}: typeof base;\n`);
}
const list = ids.map((id) => `export * from './${id}.js'`).join("\n");
writeFileSync(join(dir, "_index.js"), `${head}${list}\n`);
writeFileSync(join(dir, "_index.d.ts"), `${head}${list}\n`);
