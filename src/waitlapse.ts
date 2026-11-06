// When a wait for the boss is no longer shown to them (docs/specs/2026-11-06-head-page-minimal.md, Lapsed waits): it has a `due` and that has passed, or it has none and it is a day old. No node imports: the server's memory
// (src/server/towermemory.ts) and the demo's fixture (gui/demo-head.ts) apply the same rule.

/** A wait with no `due` stays this long (the page's FRESH window, gui/waits.ts). */
export const WAIT_FRESH_MS = 86_400_000;

export const lapsedWait = (w: { at: string; due?: string }, now: number): boolean => (w.due ? Date.parse(w.due) <= now : now - Date.parse(w.at) >= WAIT_FRESH_MS);
