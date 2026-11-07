/** The tab icon as the page's own SVG text: the link's data URL decoded, or the built file's URL fetched (a build keeps `./icon.svg` as a file). */
export async function plainOf(href: string, get: (url: string) => Promise<{ text(): Promise<string> }> = fetch): Promise<string | undefined> {
	if (href.startsWith("data:")) return decodeURIComponent(href.slice(href.indexOf(",") + 1));
	return get(href).then((r) => r.text(), () => undefined);
}
/** The waiting badge's colours: the dot, its ring, and the count. Standard's are the default; a theme brings its own (gui/themes/theme.ts). */
export const STANDARD_BADGE = { dot: "#e0af68", ring: "#1a1b26", text: "#16161e" } as const;
/** The icon's data URL for `n` waiting: the plain icon, or with the dot and the count (9+ above nine). */
export function iconHref(plain: string, n: number, badge: { dot: string; ring: string; text: string } = STANDARD_BADGE) {
	const dot = `<circle cx='23' cy='9' r='9' fill='${badge.dot}' stroke='${badge.ring}' stroke-width='2'/><text x='23' y='13' text-anchor='middle' font-family='sans-serif' font-size='${n > 9 ? 9 : 12}' font-weight='700' fill='${badge.text}'>${n > 9 ? "9+" : n}</text>`;
	return `data:image/svg+xml,${encodeURIComponent(n ? plain.replace("</svg>", `${dot}</svg>`) : plain)}`;
}
/** The tab icon file of a view, from the build's theme map (`<meta name="sb-themes">`); none when the map does not name one. */
export function iconOf(map: string | null | undefined, view: string): string | undefined {
	try {
		const icon = (JSON.parse(map ?? "{}") as Record<string, { icon?: unknown } | undefined>)[view]?.icon;
		return typeof icon === "string" ? icon : undefined;
	} catch {
		return undefined;
	}
}
