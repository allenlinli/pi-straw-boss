import { h, nodes } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import { post } from "./post.ts";

// The paired devices under the pairing panel (this computer's page only): each with its name, when it was paired and last used, and Unpair; Unpair all beside the heading; a row is the name and its Unpair, then the network and the times across the row (style.css), so a narrow screen wraps them under the name;
// and Turn off remote access while it is on. Turning it off keeps the devices paired (the list says so); only Unpair ends a pairing.

interface Device { id: string; label: string; paired: number; seen: number; net?: string; host?: string }
const when = (at: number) => (at ? new Date(at).toLocaleString([], { hour12: false, dateStyle: "medium", timeStyle: "short" }) : m.never());

/** The list and its buttons; `off` is told when remote access was turned off from here, so the tile can offer to turn it on. `remoteTab` says whether the tile shows the Tailscale tab, the only one that has Turn off remote access. */
export function deviceList(off: () => void, remoteTab: () => boolean = () => true) {
	const box = h("div", { class: "devices" });
	const note = h("p", { class: "chat-empty", role: "status" });
	const button = (text: string, label: string, run: () => Promise<unknown>) => {
		const b = h("button", { type: "button", class: "later", "aria-label": label }, text);
		b.onclick = () => ((b.disabled = true), void run().finally(() => ((b.disabled = false), void refresh())));
		return b;
	};
	/** A refusal says why under the list; the list is read again either way. */
	const act = (path: string, body: Record<string, unknown> = {}) => post(path, body).then((r) => (r.ok ? note.replaceChildren() : note.replaceChildren(r.body.reason ?? m.refused({ status: r.status }))), () => note.replaceChildren(m.no_answer()));
	async function refresh() {
		const r = await post("remote/devices", {}).catch(() => undefined), list = r?.ok ? (r.body.devices as Device[]) : [];
		if (!r?.ok) return void box.replaceChildren(h("p", { class: "chat-empty" }, r?.body.reason ?? m.no_answer()));
		const rows = list.map((d) => h("li", null, h("b", null, d.label || m.device_unknown()), button(m.unpair(), m.unpair_device({ name: d.label || m.device_unknown() }), () => act("remote/unpair", { id: d.id })), h("small", null, d.net === "lan" ? m.device_net_lan({ host: d.host ?? "" }) : m.device_net_tailscale()), h("small", null, m.device_when({ paired: when(d.paired), seen: when(d.seen) }))));
		const turnOff = r.body.on === true && remoteTab() && button(m.remote_turn_off(), m.remote_turn_off(), () => act("remote/off").then(off));
		box.replaceChildren(...nodes(h("div", { class: "devices-head" }, h("h4", null, m.devices_title()), list.length > 1 && button(m.unpair_all(), m.unpair_all(), () => act("remote/unpair-all"))), list.length ? h("ul", null, ...rows) : h("p", { class: "chat-empty" }, m.devices_none()), note, turnOff && h("div", { class: "devices-acts" }, turnOff), turnOff && h("small", null, m.remote_stays())));
	}
	void refresh();
	return { box, refresh };
}
