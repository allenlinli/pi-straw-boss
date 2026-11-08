import { m } from "./sentences.ts";
import { type PairRequest, pairsIn } from "./pairs.ts";
import { get } from "./post.ts";

// The header's notice for a pair request that waits while the Same Wi-Fi tab is not open (docs/specs/2026-10-30-sb-gui-lan.md, Approval, "When nothing is open"; this computer's page only). It reads `lan/pending?peek=1` every five
// seconds, which the server does not count as an open tile, so the sessions' own notice stays; the button opens the tile on that tab, where the number is typed. While the tab is open it has the requests itself, and the notice goes.

export function mountLanWait(button: HTMLButtonElement, open: () => void, every = 5000, report?: (list: PairRequest[]) => void) {
	let text = "";
	const show = (peer: string) => {
		const next = peer ? m.lan_pending_waiting({ peer }) : "";
		button.hidden = !peer;
		if (next !== text) (text = next, button.replaceChildren(next));
	};
	button.onclick = open;
	const read = async () => {
		if (document.hidden) return;
		const r = await get("lan/pending?peek=1").catch(() => undefined);
		const list = pairsIn(r), first = list[0];
		if (r?.ok) report?.(list); // Zen's card reads the same list (pagecore.ts `pairing`)
		show(first && !document.querySelector(".lan:not([hidden])") ? first.peer : "");
	};
	void read();
	return setInterval(() => void read(), every);
}
