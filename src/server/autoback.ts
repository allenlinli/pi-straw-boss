import { randomUUID } from "node:crypto";
import { cancelledText } from "../autotext.ts";
import type { Offer } from "../dialogs.ts";
import type { Answer } from "../owners.ts";
import type { AutoMode } from "./automode.ts";
import { secretShaped } from "./waitcard.ts";

// The server's backstop (docs/specs/2026-11-09-auto-mode.md, §5.2; AM-F009), for sessions on an older sb that do not cancel their own waits at the transition: while auto mode is on, a dialog that has been open for 30 s
// gets the GUI's cancel through the hub, if its Answerable has one. Each dialog is cancelled once, paired with an intercom message that carries the `Cancelled:` text; a session that asks again is listed, not
// cancelled again; a dialog with no cancel is listed as still waiting.

export const BACKSTOP_MS = 30_000;
export interface BackstopDeps {
	auto: Pick<AutoMode, "view" | "note">;
	/** A fresh reading of the net, which binds the hub's dialogs to units. */
	read(): Promise<void>;
	answerable(): Offer[];
	send(key: string, target: Offer["target"], answer: Answer): Promise<unknown>;
	tell(session: string, text: string): Promise<unknown>;
	now(): number;
	firstMs?: number;
}
const gistOf = (o: Offer): string => {
	const a = o.target.answer, raw = a.questions?.[0]?.header ?? a.questions?.[0]?.question ?? a.select?.title ?? "", line = raw.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 120);
	return line && secretShaped(line) ? "(withheld)" : line;
};

export function createBackstop(d: BackstopDeps) {
	const first = new Map<string, number>(), done = new Set<string>(), listed = new Set<string>(), keys = new Set<string>();
	let since: string | undefined;
	const forget = () => (first.clear(), done.clear(), listed.clear(), keys.clear());
	return {
		async tick(): Promise<void> {
			const view = d.auto.view();
			if (!view.on) return forget();
			if (view.since !== since) (forget(), (since = view.since));
			await d.read();
			const offers = d.answerable(), now = d.now(), open = new Set(offers.map((o) => o.target.answer.dialog));
			for (const id of first.keys()) if (!open.has(id)) first.delete(id);
			for (const o of offers) {
				const id = o.target.answer.dialog, began = first.get(id) ?? (first.set(id, now), now);
				if (now - began < (d.firstMs ?? BACKSTOP_MS) || done.has(id) || listed.has(id)) continue;
				const note = (kind: "still-waiting" | "re-asked" | "backstop") => d.auto.note({ session: o.key, tool: o.owner, kind, gist: gistOf(o) });
				if (!o.target.answer.cancel) { listed.add(id); note("still-waiting"); continue; }
				if (keys.has(o.key)) { listed.add(id); note("re-asked"); continue; }
				done.add(id);
				keys.add(o.key);
				await d.send(o.key, o.target, { id, answerId: `auto-${randomUUID()}`, digest: o.target.answer.digest, cancel: true });
				note("backstop");
				await d.tell(o.key, cancelledText(view.since, o.owner, "main")).catch(() => undefined);
			}
		},
	};
}
