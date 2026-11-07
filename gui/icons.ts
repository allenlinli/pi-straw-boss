// The role icons: one chokepoint, `iconRef(role)`. Standard's sprite is inline in index.html (`#i-<role>`, with its game-icons credit) and stays for every view. A theme's sprite is injected into a hidden <svg id="theme-sprite">
// with ids prefixed by the view (`raven-tower`); while it is loaded and has the role, that view's icon is used, else Standard's. Elements made from a template or set once carry `data-icon="<role>"`, so a theme arriving
// (or the view changing) points them again with `repoint`.

const sprites = new Map<string, Set<string>>();
let view = "standard";

/** The `<use>` target for a role in the view the page shows now. */
export const iconRef = (role: string) => (sprites.get(view)?.has(`${view}-${role}`) ? `#${view}-${role}` : `#i-${role}`);

/** Sets `href` on the `<use data-icon>` elements under `root` (an element made from a template calls it for itself). */
export function repoint(root: ParentNode = document) {
	for (const use of root.querySelectorAll<SVGUseElement>("use[data-icon]")) {
		const href = iconRef(use.dataset.icon!);
		if (use.getAttribute("href") !== href) use.setAttribute("href", href);
	}
}

/** The view whose icons `iconRef` names from now on. */
export function useIcons(next: string, svg?: string) {
	if (svg !== undefined && !sprites.has(next)) {
		const sheet = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" id="theme-sprite-${next}" width="0" height="0" style="position:absolute" aria-hidden="true">${svg}</svg>`, "image/svg+xml").documentElement;
		document.body.append(document.importNode(sheet, true));
		sprites.set(next, new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((id) => id[1]!)));
	}
	view = next;
	repoint();
}
