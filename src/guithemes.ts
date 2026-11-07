import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The bundle's files in the GUI server's memory, with the themes' folders left out (docs/specs/2026-11-07-raven-view/spec.md §1.2, §6.5). Everything but `themes/**` is read at start, as a package update replaces dist/gui under a running server, whose page names the old
// assets. Only the names under `themes/` are listed (no contents); a theme's file is read from disk on its first request and kept, so a server whose devices never show a theme never holds its files. A name not in the list, or a read that fails, is
// `undefined` (a 404); no other path is ever joined to the folder. `themes.json` (the build's map, names only) lets the page's first frame link the default view's stylesheet and icon.

type Theme = { css?: string; icon?: string };

export function listBundle(dir: string) {
	const listed = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => f.split("\\").join("/"));
	const bundle = new Map(listed.filter((f) => !f.startsWith("themes/")).map((f) => [f, readFileSync(join(dir, f))]));
	const names = new Set(listed.filter((f) => f.startsWith("themes/"))), read = new Map<string, Buffer>();
	const map = ((): Record<string, Theme | undefined> => {
		try {
			return JSON.parse(bundle.get("themes.json")?.toString("utf8") ?? "{}");
		} catch {
			return {};
		}
	})();
	return {
		bundle,
		fileOf(file: string): Buffer | undefined {
			const held = bundle.get(file) ?? read.get(file);
			if (held || !names.has(file)) return held;
			try {
				const body = readFileSync(join(dir, file));
				read.set(file, body);
				return body;
			} catch {
				return undefined;
			}
		},
		/** The page for a default view: when it is a theme, its stylesheet link goes where the build left the marker (after the entry's own stylesheet, so the cascade is as it was) and the tab icon is its icon. Standard and Auto add nothing. */
		page(html: string, view: string): string {
			const theme = Object.hasOwn(map, view) ? map[view] : undefined;
			if (!theme) return html;
			return html.replace("<!--sb-theme-->", theme.css ? `<link rel="stylesheet" data-theme="${view}" href="${theme.css}">` : "").replace(/(<link rel="icon"[^>]*?) href="[^"]*"/, theme.icon ? `$1 href="${theme.icon}" data-standard="./icon.svg"` : "$&");
		},
	};
}
