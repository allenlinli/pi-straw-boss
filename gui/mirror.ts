import { h, replay } from "./dom.ts";
import type { Tile } from "./layer.ts";
import { m } from "./paraglide/messages.js";
import { type Conn, type Frame, MAX_ROWS, mountConns, type Post, type TermState } from "./mirrorconn.ts";

export type { Frame, Post, TermState } from "./mirrorconn.ts";

// The terminal tile: what a session's pane shows, drawn from the server's `mirror` frames (src/mirror.ts) on this tab's one stream. Rows are
// display only: each becomes spans of text nodes, SGR colours and attributes as classes or checked colour styles, never markup, and the
// mirror takes no input. The connection (attach on open and on a new stream's `hello`, detach 5 s after the tab is hidden and when the last
// view closes, the rows) is mirrorconn.ts; a tile draws it. Fit width scales the font to the tile and goes to the bottom; otherwise rows keep their size and scroll sideways.
// The keyboard: a pane is not a text field, so a phone's soft keyboard never opens on a tap into it. The tile has a hidden text box (the sink) and a
// Keyboard button that focuses it (a second tap, or the tile closing, blurs it); on a desktop a click into the mirror focuses it too.

export interface Span { text: string; cls: string; fg?: string; bg?: string }
const SENTINEL = "\u200b";
type Color = number | string | undefined; // a palette index (0–15), an rgb() colour, or the terminal's own
interface Style { fg?: Color; bg?: Color; b?: boolean; d?: boolean; i?: boolean; u?: boolean; v?: boolean; s?: boolean }
const CUBE = [0, 95, 135, 175, 215, 255];
const byte = (n: number) => Number.isInteger(n) && n >= 0 && n <= 255;
/** A 256-colour index as a palette index or an rgb() colour; anything else is no colour. */
const indexed = (n: number): Color => (!byte(n) ? undefined : n < 16 ? n : n < 232 ? `rgb(${CUBE[Math.floor((n - 16) / 36)]},${CUBE[Math.floor((n - 16) / 6) % 6]},${CUBE[(n - 16) % 6]})` : `rgb(${8 + 10 * (n - 232)},${8 + 10 * (n - 232)},${8 + 10 * (n - 232)})`);
const rgb = ([r, g, b]: number[]): Color => ([r, g, b].every((n) => byte(n!)) ? `rgb(${r},${g},${b})` : undefined);

/** One SGR's parameters applied to a style. Unknown codes and malformed colours change nothing. */
export function sgr(st: Style, params: string): Style {
	const next: Style = { ...st }, parts = params.split(";");
	for (let i = 0; i < parts.length; i++) {
		const sub = parts[i]!.split(":").map((x) => (x === "" ? 0 : Number(x))), code = sub[0]!;
		if (code === 38 || code === 48 || code === 58) {
			// Extended colours: 38;5;n and 38;2;r;g;b, or with colons (38:5:n, 38:2::r:g:b). 58 (underline colour) is read and dropped.
			const mode = sub.length > 1 ? sub[1] : Number(parts[i + 1]), args = sub.length > 1 ? sub.slice(2) : parts.slice(i + 2, i + (mode === 5 ? 3 : 5)).map(Number);
			if (sub.length === 1) i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
			const c = mode === 5 ? indexed(args[0]!) : mode === 2 ? rgb(args.slice(-3)) : undefined;
			if (c !== undefined && code !== 58) next[code === 38 ? "fg" : "bg"] = c;
		} else if (code === 0) for (const k of Object.keys(next)) delete next[k as keyof Style];
		else if (code === 1 || code === 2) next[code === 1 ? "b" : "d"] = true;
		else if (code === 22) next.b = next.d = false;
		else if (code === 3 || code === 23) next.i = code === 3;
		else if (code === 4 || code === 21 || code === 24) next.u = code !== 24 && sub[1] !== 0;
		else if (code === 7 || code === 27) next.v = code === 7;
		else if (code === 9 || code === 29) next.s = code === 9;
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next.fg = code - (code < 90 ? 30 : 82);
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) next.bg = code - (code < 100 ? 40 : 92);
		else if (code === 39 || code === 49) delete next[code === 39 ? "fg" : "bg"];
	}
	return next;
}
/** A row as spans: text between SGRs with the style in force. Any other escape or control is dropped, so nothing malformed shows. */
export function rowSpans(row: string): Span[] {
	const out: Span[] = [];
	let st: Style = {}, at = 0;
	const push = (raw: string) => {
		const text = raw.replace(/\x1b(\[[0-?]*[ -/]*[@-~]?)?|[\u0000-\u001f\u007f-\u009f]/g, "");
		if (!text) return;
		// Inverse swaps the colours, the terminal's own included (classes cz and kz).
		const [fg, bg] = st.v ? [st.bg ?? "z", st.fg ?? "z"] : [st.fg, st.bg];
		const cls = [typeof fg === "number" || fg === "z" ? `c${fg}` : "", typeof bg === "number" || bg === "z" ? `k${bg}` : "", ...(["b", "d", "i", "u", "s"] as const).filter((k) => st[k]).map((k) => `t${k}`)].filter(Boolean).join(" ");
		out.push({ text, cls, ...(typeof fg === "string" && fg !== "z" && { fg }), ...(typeof bg === "string" && bg !== "z" && { bg }) });
	};
	for (const m of row.matchAll(/\x1b\[([0-9;:]{0,64})m/g)) {
		push(row.slice(at, m.index));
		st = sgr(st, m[1]!);
		at = m.index + m[0].length;
	}
	push(row.slice(at));
	return out;
}
/** A frame into the rows of `box`: the row count first, then each row it sets, built from text nodes. */
export function applyFrame(box: HTMLElement, f: Frame) {
	const n = Math.min(Math.max(0, Number(f.rows) || 0), MAX_ROWS);
	while (box.children.length < n) box.append(h("div", { class: "tr" }));
	while (box.children.length > n) box.lastElementChild!.remove();
	for (const [i, row] of Array.isArray(f.set) ? f.set : []) {
		if (!Number.isInteger(i) || i < 0 || i >= n || typeof row !== "string") continue;
		box.children[i]!.replaceChildren(...rowSpans(row).map((s) => {
			if (!s.cls && !s.fg && !s.bg) return s.text;
			const span = h("span", s.cls ? { class: s.cls } : null, s.text);
			if (s.fg) span.style.color = s.fg;
			if (s.bg) span.style.backgroundColor = s.bg;
			return span;
		}));
	}
}

interface Term { key: string; conn: Conn; stop(): void; box: HTMLElement; scroll: HTMLElement; state: HTMLElement; fit: HTMLButtonElement; kb: HTMLButtonElement; typing: HTMLElement; sink: HTMLTextAreaElement; first: boolean; tile?: Tile; pad?: Pad; end?: () => void; entered?: (sent: boolean) => void }
/** The key pad under a mirror (keypad.ts): its element, and `update` when what the pad may do changes. */
export interface Pad { el: HTMLElement; update(): void; type?(e: KeyboardEvent): boolean; key?(key: string): void; text?(typed: string): void; paste?(pasted: string): void }
/** The terminal tiles of this page: `stream()` is the newest `hello` as it came (JSON); `pad` puts the key pad under a mirror. */
export function mountTerminals({ tiles, post, stream, pad }: { tiles: { open(tile: Tile, focus?: boolean): void }; post(key: string): Post; stream(): string; pad?(t: { name: string; state(): TermState; post: Post; stream(): string; blip(): void; entered(sent: boolean): void }): Pad }) {
	const open = new Map<string, Term>();
	const conns = mountConns({ post, stream });
	/** The sink carries what the pad may do, so a layer that owns Esc (Zen's) can tell a terminal that takes it from a dead one. */
	const sync = (t: Term) => void (t.sink.dataset.pad = t.conn.state());
	const words = (c: Conn): [string, string] => (c.phase === "live" ? [m.mirror_live({ cols: c.cols, rows: c.rows.length }), "ok"] : c.phase === "refused" ? [m.retry_terminal({ why: c.why }), "error"] : [c.phase === "hidden" ? m.mirror_hidden() : c.phase === "paused" ? m.paused_hidden() : m.connecting(), ""]);
	const say = (t: Term) => {
		const c = t.conn, [text, tone] = words(c);
		t.box.classList.toggle("stale", c.stale());
		t.box.classList.toggle("hidden", c.hidden);
		t.pad?.update();
		sync(t);
		(t.state.textContent !== text || t.state.dataset.tone !== tone) && ((t.state.dataset.tone = tone), (t.state.textContent = text)); // a status that stays is not announced again
	};
	// The widest of the pane's columns and its longest row: rows drawn before the pane narrowed stay wider until they are redrawn.
	const fit = (t: Term, n = Math.max(t.conn.cols, ...[...t.box.children].map((r) => r.textContent?.length ?? 0))) => (t.box.style.fontSize = t.fit.getAttribute("aria-pressed") === "true" && n ? `${Math.max(6, Math.floor((t.scroll.clientWidth - 20) / (n * 0.6)))}px` : "");
	const make = (key: string, name: string): Tile => {
		const t = { key, box: h("div", { class: "term", role: "group", "aria-label": m.terminal_of({ name }) }), scroll: h("div", { class: "term-scroll", tabindex: "0" }), state: h("p", { class: "term-state", role: "status" }, m.connecting()), fit: h("button", { type: "button", class: "cmp-link", "aria-pressed": "false" }, m.fit_width()), kb: h("button", { type: "button", class: "cmp-link term-kb", "aria-pressed": "false" }, m.keyboard()), typing: h("span", { class: "term-typing", hidden: "" }, m.typing_direct()), sink: h("textarea", { class: "term-sink", rows: "1", "aria-label": m.typing_hint(), inputmode: "text", enterkeyhint: "enter", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" }) as HTMLTextAreaElement, first: true } as Omit<Term, "conn" | "stop"> as Term; // conn and stop come from the join below
		// The font changes size, so the rows move: the view goes to the bottom, where pi's editor is, once the new size is laid out.
		t.fit.onclick = () => (t.fit.setAttribute("aria-pressed", String(t.fit.getAttribute("aria-pressed") !== "true")), fit(t), requestAnimationFrame(() => (t.scroll.scrollTop = t.scroll.scrollHeight)));
		t.scroll.append(t.box);
		// The keyboard goes to the pane while the sink has the focus: a click into the mirror on a desktop (not a drag that selects text to copy), or
		// the Keyboard button on any screen (a phone's soft keyboard opens for it). Keys and chords go from its keydown, characters from its input (so
		// an input method and dead keys work), a paste from its paste. A soft keyboard sends no key for Backspace or Enter on some phones (keydown
		// is "Unidentified", keyCode 229) but a beforeinput that names it, so that is read too, once: a keydown the pad took never reaches beforeinput.
		// A composition goes as one write when it ends. The mirror lights up as it takes the keyboard and flashes with each key.
		{
			const { sink } = t, rest = () => ((sink.value = SENTINEL), sink.setSelectionRange?.(1, 1)), typedIn = () => sink.value.replaceAll(SENTINEL, "");
			// An open box holds one zero-width character kept before the caret, so Backspace on an empty box still deletes something and a phone's
			// keyboard (Gboard sends nothing for Backspace on an empty input) fires its deleteContentBackward; the sentinel is never typed.
			const flush = () => ((typed) => (on ? rest() : (sink.value = ""), typed && t.pad?.text?.(typed)))(typedIn());
			let on = false;
			if (globalThis.matchMedia?.("(pointer: fine)").matches) {
				t.scroll.title = m.typing_hint();
				t.scroll.addEventListener("click", () => getSelection()?.isCollapsed !== false && sink.focus({ preventScroll: true }));
			}
			t.kb.addEventListener("mousedown", (e) => e.preventDefault()); // the button does not take the focus from the sink, so a second tap sees it open and closes it
			t.kb.addEventListener("click", () => (on ? sink.blur() : sink.focus({ preventScroll: true })));
			// Shift+Esc is the keyboard's way out of the sink (a plain Esc is the pane's: pi interrupts on it, vim leaves insert mode): the focus goes to the mirror's body, where Tab moves on.
			sink.addEventListener("keydown", (e) => (e.key === "Escape" && e.shiftKey ? (e.preventDefault(), sink.blur(), t.scroll.focus({ preventScroll: true })) : t.pad?.type?.(e) && e.preventDefault()));
			sink.addEventListener("beforeinput", (e) => {
				const { inputType, isComposing } = e as InputEvent, key = inputType === "deleteContentBackward" && !typedIn() ? "backspace" : inputType === "insertLineBreak" || inputType === "insertParagraph" ? "enter" : undefined;
				if (isComposing || !key) return;
				e.preventDefault();
				flush();
				t.pad?.key?.(key);
			});
			sink.addEventListener("input", (e) => !(e as InputEvent).isComposing && flush());
			sink.addEventListener("compositionend", flush);
			sink.addEventListener("paste", (e) => (e.preventDefault(), t.pad?.paste?.(e.clipboardData?.getData("text/plain") ?? "")));
			sink.addEventListener("focus", () => {
				const at = t.scroll.getBoundingClientRect(); // an input method's candidates show by the mirror's bottom-left corner
				Object.assign(sink.style, { left: `${at.left + 12}px`, top: `${Math.min(at.bottom, innerHeight) - 28}px` });
				on = true;
				rest();
				t.kb.setAttribute("aria-pressed", "true");
				t.typing.hidden = false;
				t.scroll.classList.add("typing", "engage");
			});
			sink.addEventListener("blur", () => ((on = false), t.kb.setAttribute("aria-pressed", "false"), (t.typing.hidden = true), t.scroll.classList.remove("typing", "engage", "blip"), flush()));
			t.scroll.addEventListener("animationend", (e) => t.scroll.classList.remove(e.animationName === "term-engage" ? "engage" : "blip"));
		}
		new ResizeObserver(() => fit(t)).observe(t.scroll);
		open.set(key, t);
		Object.assign(t, conns.join(key, { rows: (_, f, size) => (applyFrame(t.box, f), size && fit(t), t.first && f.whole && ((t.first = false), requestAnimationFrame(() => (t.scroll.scrollTop = t.scroll.scrollHeight)))), state: () => say(t), end: () => t.end?.(), entered: (sent) => t.entered?.(sent) }));
		const { conn } = t;
		if (conn.rows.length) applyFrame(t.box, { key, rows: conn.rows.length, set: conn.rows.map((row, i) => [i, row]) });
		if (conn.phase !== "connecting") say(t);
		t.pad = pad?.({ name, state: conn.state, post: conn.post, stream: conns.id, blip: () => replay(t.scroll, "blip"), entered: (sent) => conns.entered(conn, sent) });
		sync(t);
		return (t.tile = { id: `term:${key}`, title: m.terminal_title({ name }), icon: "i-comms", body: () => h("div", { class: "term-tile" }, h("div", { class: "term-bar" }, t.state, t.typing, t.kb, t.fit), t.scroll, t.sink, t.pad?.el), closed: () => (t.sink.blur(), t.stop(), open.delete(key)) });
	};
	return {
		/** Opens (or brings forward) the tile of a terminal, a session's or a pane an answer opened (key `grant:<id>`), the user's own act, so it takes focus; a mirror that ended tries again. `keys`: the keyboard goes to it (a desktop's; a phone has the pad under it, and its Keyboard button). */
		open(key: string, name: string, keys = false) {
			const t = open.get(key);
			if (t) conns.retry(t.conn);
			tiles.open(t?.tile ?? make(key, name), true);
			const at = open.get(key);
			if (keys && at && globalThis.matchMedia?.("(pointer: fine)").matches) requestAnimationFrame(() => at.sink.focus({ preventScroll: true }));
		},
		/** Shows a terminal inside `host` (the session view's terminal mode, Zen's layer) until the returned function takes it away. `keys`: the keyboard goes to it (a desktop's); `end`: its mirror ended (the pane closed, the grant ended, or its attach was refused as gone); `entered`: the pad sent an Enter (true) or the server refused it (false). */
		embed(key: string, name: string, host: HTMLElement, { keys = false, end, entered }: { keys?: boolean; end?: () => void; entered?: (sent: boolean) => void } = {}): () => void {
			const t = open.get(key);
			if (t) conns.retry(t.conn);
			const tile = t?.tile ?? make(key, name), at = open.get(key)!;
			[at.end, at.entered] = [end, entered];
			host.replaceChildren(tile.body());
			if (keys && globalThis.matchMedia?.("(pointer: fine)").matches) requestAnimationFrame(() => at.sink.focus({ preventScroll: true }));
			return () => ((at.end = at.entered = undefined), tile.closed?.(), host.replaceChildren());
		},
		/** The connection of `key` without a screen, for a view that draws its own (the terminal card): `rows`, `state`, `end` as the connection tells them, `taken` when a pad on this key sent an Enter. It shares the attach with a tile or embed of the same key, so the first to join attaches and the last to leave detaches; `stop` leaves. */
		watch(key: string, _name: string, { rows, state, end, taken }: { rows?(rows: string[]): void; state?(s: TermState, c: Conn): void; end?(): void; taken?(): void }) {
			return conns.join(key, { rows: rows && ((r) => rows(r)), state, end, entered: (sent) => sent && taken?.() });
		},
		/** A new stream said hello: every connection attaches to it. */
		hello: conns.hello,
		/** One `mirror` event from the stream. */
		frame: conns.frame,
	};
}
