// The first frame's view, before the body exists (docs/specs/2026-11-07-raven-view/spec.md §1.2). A classic script with no imports, so it blocks nothing but the parser: the page entry's module has not run yet.
// It resolves the device's view as gui/view.ts does on a fresh load (the stored choice, then the server's default in <meta name="sb-view">, then prefers-contrast; `held` and `zen-away` cannot exist yet), puts it on <html> as data-view, sets the
// theme-color and the tab icon, and, when the view is a theme whose stylesheet the server did not already link, writes that link (parser-inserted, so it blocks the first paint). tests/view.test.ts runs this file against view.ts's `resolve`.
// The theme map is <meta name="sb-themes"> (the build writes it into index.html). Anything wrong here (no storage, no map) leaves the page as the server wrote it: main.ts corrects the view and loads the theme as today.
(function () {
	var d = document, root = d.documentElement;
	function meta(name) {
		var m = d.querySelector('meta[name="' + name + '"]');
		return m ? m.getAttribute("content") : null;
	}
	var themes = {};
	try {
		themes = JSON.parse(meta("sb-themes") || "{}") || {};
	} catch (e) {}
	var names = ["standard"];
	for (var k in themes) if (Object.prototype.hasOwnProperty.call(themes, k)) names.push(k);
	/** A name of a view, anything else is Auto. */
	function choice(value) {
		return typeof value === "string" && names.indexOf(value) >= 0 ? value : "auto";
	}
	/** gui/view.ts `resolve(choiceOf(stored), contrast, choiceOf(server))`. */
	function resolve(stored, contrast, server) {
		var own = choice(stored), shared = choice(server);
		if (own !== "auto") return own;
		if (shared !== "auto") return shared;
		return contrast && names.indexOf("geek") >= 0 ? "geek" : "standard";
	}
	// The theme-color of each view that has one of its own (gui/view.ts THEME); Standard keeps the color the page came with.
	var colors = { geek: "#000000", zen: "#14110e" };
	globalThis.sbBoot = { resolve: resolve, colors: colors };
	try {
		var stored = null;
		try {
			stored = localStorage.getItem("sb.view");
		} catch (e) {} // storage refused: the screen and the server decide
		var view = resolve(stored, matchMedia("(prefers-contrast: more)").matches, meta("sb-view"));
		root.dataset.view = view;
		var theme = themes[view];
		if (colors[view]) {
			var bar = d.querySelector('meta[name="theme-color"]');
			if (bar) bar.setAttribute("content", colors[view]);
		}
		var icon = d.querySelector('link[rel="icon"]');
		if (icon && !(theme && theme.icon) && icon.hasAttribute("data-standard")) icon.setAttribute("href", icon.getAttribute("data-standard")); // the server wrote its default's icon; this device's view has none
		if (theme && theme.icon) {
			if (icon) {
				if (!icon.hasAttribute("data-standard")) icon.setAttribute("data-standard", icon.getAttribute("href") || ""); // main.ts draws Standard's icon from it
				icon.setAttribute("href", theme.icon);
			}
		}
		if (theme && theme.css && !d.querySelector('link[data-theme="' + view + '"]')) d.write('<link rel="stylesheet" data-theme="' + view + '" href="' + theme.css + '">');
	} catch (e) {}
})();
