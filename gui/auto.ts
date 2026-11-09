import type { Net } from "../src/net.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";
import { type Answer, post } from "./post.ts";

// The head tower's request to start auto mode, as the page shows it (docs/specs/2026-11-09-auto-mode.md, sections 2 and 7; D9): while the net snapshot carries a pending record (`net.auto.pending`), the head page and Zen's strip show one
// button, 「確認進入自動模式」, that confirms it by its id. The id and the words are the server's; the page decides nothing: a tap on a record that lapsed or was replaced gets the server's refusal. Nothing here switches auto mode on by itself.

/** The seam a test replaces: the page's post. */
export const io = { post: (path: string, body: Record<string, unknown>): Promise<Answer> => post(path, body) };

type Opts = { locale?: "en" | "zh-TW" };
/** The request waiting for the boss in this snapshot; the server leaves a lapsed one out. */
export const pendingOf = (net: Net | undefined) => net?.auto?.pending;

const failure = (r: Answer, o?: Opts) => (r.body.error === "stale" ? m.auto_stale({}, o) : r.body.reason ?? (r.status ? m.refused({ status: r.status }, o) : m.no_answer({}, o)));

/** Fills `box` (a `div` the page keeps for it): hidden with no pending request, else the words the boss said, the button, and the line a refusal reads in. Rebuilt only when the request changes, so a tap in flight keeps its button. */
export function fillAuto(box: HTMLElement, net: Net | undefined, o?: Opts): void {
	const pending = pendingOf(net);
	box.hidden = !pending;
	if (!pending) return void (delete box.dataset.id, box.replaceChildren());
	if (box.dataset.id === pending.id) return;
	box.dataset.id = pending.id;
	const note = h("p", { class: "auto-note", role: "alert" }), button = h("button", { type: "button", class: "auto-confirm" }, m.auto_confirm_button({}, o));
	button.onclick = async () => {
		button.disabled = true;
		note.textContent = "";
		const r = await io.post("auto/confirm", { id: pending.id }).catch(() => ({ ok: false, status: 0, body: {} }) as Answer);
		if (r.ok) return void (note.textContent = m.auto_confirmed({}, o));
		button.disabled = false;
		note.textContent = failure(r, o);
	};
	box.replaceChildren(h("p", { class: "auto-title" }, m.auto_confirm_title({}, o)), h("p", { class: "auto-said" }, m.auto_confirm_said({ said: pending.said }, o)), button, note);
}
