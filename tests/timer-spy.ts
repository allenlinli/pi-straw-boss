// The timers a test world starts, counted while they live (a mutation check of "this timer is never armed" needs more than a log line): `live(ms)` is how many setInterval or setTimeout timers of that delay run now.
export function timerSpy() {
	const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
	const live = new Map<unknown, { ms: number; kind: "interval" | "timeout" }>();
	globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => { const t = real.setInterval(fn, ms, ...rest); live.set(t, { ms: ms ?? 1, kind: "interval" }); return t; }) as never;
	globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => { const t = real.setTimeout((...a: unknown[]) => { live.delete(t); fn(...a); }, ms, ...rest); live.set(t, { ms: ms ?? 1, kind: "timeout" }); return t; }) as never;
	globalThis.clearInterval = ((t: never) => (live.delete(t), real.clearInterval(t))) as never;
	globalThis.clearTimeout = ((t: never) => (live.delete(t), real.clearTimeout(t))) as never;
	return {
		live: (ms: number, kind: "interval" | "timeout") => [...live.values()].filter((x) => x.ms === ms && x.kind === kind).length,
		restore() { Object.assign(globalThis, real); },
	};
}
