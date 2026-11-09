import { AsyncLocalStorage } from "node:async_hooks";

// The mark of the boss's own commands (docs/specs/2026-11-09-auto-mode.md, §3; AM2-F002). pi runs a typed extension command at once, even while a turn streams, so a dialog opened while a tool call is in flight is not
// proof that the call opened it. sb runs its own `/boss` handlers, and the head pane's confirm, under this mark: the wrap of ctx.ui answers Escape only for a dialog opened outside it.
const mark = new AsyncLocalStorage<true>();
export const asBoss = <T>(work: () => T): T => mark.run(true, work);
export const underBoss = (): boolean => mark.getStore() === true;
