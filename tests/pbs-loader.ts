import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// pi-better-show ships TypeScript source, which the page's bundler (Vite) reads and Node refuses to strip under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). A test that loads the GUI's block code imports this module first: it strips the package's types
// and gives a stylesheet import (the lazy chunk's `import "./pbs.css"`, which Vite turns into a file) an empty module, as zenchunk.ts's is for Zen.
registerHooks({
	load(url, context, next) {
		if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export {};" };
		if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/node_modules/pi-better-show/")) return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")) };
		return next(url, context);
	},
});
