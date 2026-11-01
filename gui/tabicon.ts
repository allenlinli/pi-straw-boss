/** The tab icon as the page's own SVG text: the link's data URL decoded, or the built file's URL fetched (a build keeps `./icon.svg` as a file). */
export async function plainOf(href: string, get: (url: string) => Promise<{ text(): Promise<string> }> = fetch): Promise<string | undefined> {
	if (href.startsWith("data:")) return decodeURIComponent(href.slice(href.indexOf(",") + 1));
	return get(href).then((r) => r.text(), () => undefined);
}
/** The icon's data URL for `n` waiting: the plain icon, or with the amber dot and the count (9+ above nine). */
export function iconHref(plain: string, n: number) {
	const dot = `<circle cx='23' cy='9' r='9' fill='#e0af68' stroke='#1a1b26' stroke-width='2'/><text x='23' y='13' text-anchor='middle' font-family='sans-serif' font-size='${n > 9 ? 9 : 12}' font-weight='700' fill='#16161e'>${n > 9 ? "9+" : n}</text>`;
	return `data:image/svg+xml,${encodeURIComponent(n ? plain.replace("</svg>", `${dot}</svg>`) : plain)}`;
}
