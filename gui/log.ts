import type { NetEvent } from "../src/activity.ts";
import type { Mark } from "../src/netdata.ts";
import { roleWord } from "./render.ts";
import { m } from "./sentences.ts";

const WORDS: Record<Mark, (i: { name: string }) => string> = { commanding: m.log_commanding, working: m.log_working, waiting: m.log_waiting, idle: m.log_idle, done: m.log_done, error: m.log_error, unknown: m.log_unknown };

/** An event of the net (the server's activity.ts) in words. */
export const said = (e: NetEvent) => (e.kind === "duty" ? ({ name }: { name: string }) => m.duty_event({ name, from: roleWord("main", e.from), to: roleWord("main", e.to) }) : e.kind === "joined" ? m.log_joined : e.kind === "left" ? m.log_left : WORDS[e.mark])({ name: e.name });
