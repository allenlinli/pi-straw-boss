import type { TowerService } from "../src/net.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { noun } from "./nouns.ts";
import { post } from "./post.ts";
import { guarded, towerRoute } from "./towermodel.ts";

// What acts on the head's conversation, in one row above the composer (docs/specs/2026-11-06-head-page-minimal.md): End and New while a boss conversation is live (the routes whose pi twins are `/boss tower leave` and `/boss tower new`,
// the same server functions a workspace tower's box posts to) and the head's own Close (head/close, asked once by quit.ts). The head page has no `⋯` popover and no conversation line.

/** Draws the row from the head's service; it is hidden while the head does not exist. Redrawn only when what it shows changes, so a click never lands on a button that was replaced. */
export function fillHeadActs(box: HTMLElement, service: TowerService | undefined, exists: boolean) {
	const c = service?.conversation, sig = JSON.stringify([exists, c && { closing: c.closing ?? false }]);
	if (box.dataset.sig === sig) return;
	box.dataset.sig = sig;
	box.hidden = !exists;
	if (!exists) return box.replaceChildren();
	// What a click said stays across the redraw it causes (Leave ends the conversation, which changes the row).
	const kept = [box.querySelector(".tnote-fail")?.textContent ?? "", box.querySelector(".conv-done")?.textContent ?? ""];
	const fail = h("small", { class: "tnote-fail", role: "alert" }, kept[0]), done = h("small", { class: "conv-done", role: "status" }, kept[1]);
	const say = (text?: string) => ((fail.textContent = text ?? ""), (done.textContent = ""));
	const act = (label: string, title: string, path: "leave" | "new", ok: () => string) => {
		const b = h("button", { type: "button", class: "pair-btn", title }, label);
		b.onclick = () => void guarded(b, say, async () => { const r = await post(`${towerRoute(HEAD_KEY)}/${path}`, {}); if (r.ok) done.textContent = ok(); return r; }, 0);
		return b;
	};
	box.replaceChildren(
		...(c && !c.closing ? [act(m.head_end(), m.conv_leave_title(), "leave", m.conv_left)] : []),
		...(c ? [act(m.conv_new_button(), m.conv_new_title(), "new", m.conv_fresh)] : []),
		h("button", { type: "button", class: "quit-btn head-close", "data-close": "head", "data-name": noun("head_tower"), "aria-label": m.head_close(), title: m.head_close() }, m.head_close_short()),
		fail, done,
	);
}
