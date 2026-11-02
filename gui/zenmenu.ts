import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";
import type { Choice } from "./view.ts";

// Zen's corner menu: one quiet button that opens a small panel of the settings a page in Zen would otherwise have to leave for (language, view, sound, the way back to Standard). Every row
// calls what the settings page calls, so the two never disagree. It opens only on a press of its button (a click, a tap, Enter, or Space), never on hover, and takes the focus inside. It closes on Esc,
// a second press of the button, a press outside, and a choice of language, view, or the way back (the sound's switch and volume stay, so the volume can be set after the switch).

export interface MenuDeps {
	language?: { get(): string; names(): { id: string; name: string }[]; set(id: string): void };
	/** `choice` is the device's (Auto, Standard, Geek, Zen); `auto` words the Auto row (Auto, or Follow server with the default's name). */
	view?: { choice(): Choice; set(c: Choice): void; auto(): string };
	sound?: { on(): boolean; volume(): number; set(on: boolean): void; setVolume(v: number): void; try(): void; /** Another tab changed Sound or Volume: the open panel redraws. */ onChange?(fn: () => void): void };
}
export function mountMenu(deps: MenuDeps, leave: () => void) {
	const button = h("button", { type: "button", class: "zen-menubtn", "aria-haspopup": "true", "aria-expanded": "false", "aria-label": m.zen_menu(), title: m.zen_menu() }, "…");
	const panel = h("div", { class: "zen-menu", role: "group", "aria-label": m.zen_menu(), hidden: "" }), host = h("div", { class: "zen-menuhost" }, button, panel);
	const redraw: (() => void)[] = [], controls: HTMLElement[] = [];
	const row = (label: string, ...ctl: HTMLElement[]) => (controls.push(...ctl), h("div", { class: "zen-row" }, h("span", { class: "zen-rowlab" }, label), h("span", { class: "zen-ctl" }, ...ctl)));
	const pick = (text: string, pressed: () => boolean, run: () => void) => {
		const b = h("button", { type: "button", class: "zen-opt" }, text);
		b.onclick = () => (run(), close()); // a choice is made: the menu has done its work
		redraw.push(() => b.setAttribute("aria-pressed", String(pressed())));
		return b;
	};
	const { language, view, sound } = deps;
	if (language) panel.append(row(m.language(), ...language.names().map((l) => pick(l.name, () => language.get() === l.id, () => language.set(l.id)))));
	if (view) {
		// A pick shows at once (viewface.ts): Standard and Geek leave Zen, Auto follows the server's default or the screen, and the pressed marks redraw (the panel goes with the layer when the view leaves Zen).
		const choose = (c: Choice) => (view.set(c), redraw.forEach((r) => r()));
		const auto = pick(view.auto(), () => view.choice() === "auto", () => choose("auto"));
		redraw.push(() => (auto.textContent = view.auto()));
		panel.append(row(m.view_label(), auto, ...(["standard", "geek", "zen"] as const).map((c) => pick({ zen: m.view_zen, standard: m.view_standard, geek: m.view_geek }[c](), () => view.choice() === c, () => choose(c)))));
	}
	if (sound) {
		const on = h("button", { type: "button", class: "zen-opt" }), vol = h("input", { type: "range", min: "0", max: "100", step: "5", "aria-label": m.sound_volume() }) as HTMLInputElement;
		const draw = () => ((on.textContent = sound.on() ? m.state_on() : m.state_off()), on.setAttribute("aria-pressed", String(sound.on())), (vol.value = String(sound.volume())));
		on.onclick = () => (sound.set(!sound.on()), draw());
		vol.oninput = () => sound.setVolume(Number(vol.value));
		vol.onchange = () => sound.try();
		redraw.push(draw), sound.onChange?.(() => open && draw());
		panel.append(row(m.sound(), on), row(m.sound_volume(), vol));
	}
	const away = h("button", { type: "button", class: "zen-leave" }, m.zen_leave_title());
	away.onclick = () => (leave(), close());
	controls.push(away);
	panel.append(h("div", { class: "zen-row" }, away), h("div", { class: "zen-music", hidden: "" })); // the music rows (on or off, track, the catalogue) take this slot in Z6
	let open = false;
	const show = () => {
		[open, panel.hidden] = [true, false];
		button.setAttribute("aria-expanded", "true");
		redraw.forEach((r) => r());
		controls[0]?.focus();
	};
	function close() {
		if (!open) return false;
		const inside = host.contains(document.activeElement);
		[open, panel.hidden] = [false, true];
		button.setAttribute("aria-expanded", "false");
		if (inside) button.focus();
		return true;
	}
	button.onclick = () => (open ? close() : show());
	host.addEventListener("keydown", (e) => {
		const k = e as unknown as KeyboardEvent;
		if (k.key === "Escape" && open) (k.preventDefault(), k.stopPropagation?.(), close());
		else if (k.key === "Tab" && open && controls.length) {
			const at = controls.indexOf(document.activeElement as HTMLElement), to = k.shiftKey ? (at <= 0 ? controls.length - 1 : at - 1) : at < 0 || at === controls.length - 1 ? 0 : at + 1;
			k.preventDefault();
			controls[to]!.focus();
		}
	});
	document.addEventListener("pointerdown", (e) => open && !host.contains(e.target as Node | null) && close());
	return { el: host, button, isOpen: () => open, close };
}
