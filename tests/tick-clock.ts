// A clock the test moves by hand, for code that waits on its injected `sleep` while real children run beside it. `fakeClock` (fake-clock.ts) advances at once on every sleep, which would spin a wait that
// nothing ends in microtasks, and starve the I/O a real child needs. Here a sleep waits until the test calls `advance`; timers fire in order, with the event loop given a turn after each so the code under test
// reacts to one timer before the next fires.

export class TickClock {
	t: number;
	private timers: { at: number; fire: () => void }[] = [];
	constructor(start = Date.parse("2026-11-07T08:00:00Z")) {
		this.t = start;
	}
	now = () => this.t;
	sleep = (ms: number) => new Promise<void>((done) => void this.timers.push({ at: this.t + ms, fire: done }));
	/** How many sleeps are waiting. */
	get pending() {
		return this.timers.length;
	}
	async advance(ms: number): Promise<void> {
		const end = this.t + ms;
		for (;;) {
			const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.timers.splice(this.timers.indexOf(due), 1);
			this.t = Math.max(this.t, due.at);
			due.fire();
			await turn();
		}
		this.t = end;
		await turn();
	}
}

/** One turn of the event loop after the microtasks: what a promise chain in the code under test needs to run to its next await on a timer. */
export const turn = () => new Promise<void>((done) => setImmediate(done));

/** Waits for a condition that real I/O (a child, a file) makes true; the bound only fails a test that would hang. */
export async function until(check: () => unknown, what: string, ms = 30_000): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise<void>((done) => setTimeout(done, 5))) if (await check()) return;
	throw new Error(`Timed out waiting for ${what}`);
}
