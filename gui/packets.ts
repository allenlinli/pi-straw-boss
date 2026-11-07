// Points spaced evenly along a cubic wire whose control points share the middle x, so a linear timing keeps a dot's pace. The map's wires are orthogonal routes now and their packets are headband.ts `routePackets`; this is the curve sampler only.

export interface Wire { x1: number; y1: number; x2: number; y2: number; mid: number }

/** `n` + 1 points spaced evenly along the wire's curve. */
export function along({ x1, y1, x2, y2, mid }: Wire, n = 64): (readonly [number, number])[] {
	const dense = Array.from({ length: 201 }, (_, i) => {
		const t = i / 200, u = 1 - t;
		return [u ** 3 * x1 + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * x2, u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2] as const;
	});
	const reach = dense.reduce<number[]>((sum, p, i) => (sum.push(i ? sum[i - 1]! + Math.hypot(p[0] - dense[i - 1]![0], p[1] - dense[i - 1]![1]) : 0), sum), []);
	return Array.from({ length: n + 1 }, (_, k) => {
		const want = (k / n) * reach.at(-1)!, i = Math.max(1, reach.findIndex((r) => r >= want)), [a, b] = [dense[i - 1]!, dense[i]!];
		const f = reach[i]! > reach[i - 1]! ? (want - reach[i - 1]!) / (reach[i]! - reach[i - 1]!) : 0; // between the two samples, so the spacing is even
		return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] as const;
	});
}
