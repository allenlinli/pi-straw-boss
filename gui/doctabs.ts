// The label of each document's tab: the file name alone (the card's header names the session), and for a name two documents share, the
// shortest run of parent folders that tells them apart. Pure, so it has a table test.

const segments = (path: string) => path.split("/").filter(Boolean);

export function tabLabels(paths: string[]): string[] {
	const parts = paths.map(segments);
	const same = (i: number) => parts.flatMap((p, j) => (p.at(-1) === parts[i]!.at(-1) ? [j] : []));
	return parts.map((p, i) => {
		const name = p.at(-1) ?? paths[i]!, group = same(i);
		if (group.length < 2) return name;
		for (let k = 2; k <= p.length; k++) {
			const mine = p.slice(-k).join("/");
			if (group.every((j) => j === i || parts[j]!.slice(-k).join("/") !== mine)) return mine;
		}
		return paths[i]!;
	});
}
