import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// A pi screen for a secret the boss types or reads (`/boss link create`'s relay token, `link invite show`'s invite text). pi's `ctx.ui.input` draws what is typed in clear and has no masked variant, so these go through
// `ctx.ui.custom`: the component draws bullets for the typed text, hands the value to its caller through the promise only, and leaves nothing behind (no notice, no session entry, no chat line). Editing is pi-tui's own `Input`
// (paste, backspace, kill ring); only its drawing is replaced. A ui without `custom` (print and RPC modes) gets undefined: there is no fallback that would echo.

type Ui = Pick<ExtensionContext["ui"], "custom">;
interface Screen { title: string; footer: string; hint?: string; lines?: string[] }
const MAX_SECRET = 512, BULLET = "•";

/** `text` cut into rows of at most `width` characters: at its own line breaks, then wherever the width ends (an invite is one long word). */
function rows(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const chars = [...line];
		if (!chars.length) out.push("");
		for (let at = 0; at < chars.length; at += width) out.push(chars.slice(at, at + width).join(""));
	}
	return out;
}
const draw = (s: Screen, width: number, body: string[]) => [s.title, "", ...(s.hint ? [...rows(s.hint, width), ""] : []), ...body, "", ...rows(s.footer, width)].flatMap((line) => rows(line, Math.max(1, width)));

/** The boss types a secret into a masked line; Enter returns it (possibly empty), Escape returns undefined. */
export async function readSecret(ui: Ui, screen: Screen & { hint: string }): Promise<string | undefined> {
	if (typeof ui.custom !== "function") return undefined;
	return ui.custom<string | undefined>((tui, _theme, _keys, done) => {
		const input = new Input();
		return {
			render: (width) => draw(screen, width, [`> ${BULLET.repeat(Math.min(input.getValue().length, Math.max(1, width - 4)))}`]),
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, "escape")) return done(undefined);
				if (matchesKey(data, "enter")) return done(input.getValue());
				const before = input.getValue();
				input.handleInput(data);
				if (input.getValue().length > MAX_SECRET) input.setValue(before);
				tui.requestRender();
			},
		};
	});
}

/** The boss reads `lines` (a credential) on a screen of its own until Enter or Escape (false when the ui drew nothing: pi's no-op `custom` in RPC mode); nothing of it stays in the chat or the terminal's scrollback. */
export async function showScreen(ui: Ui, screen: Screen & { lines: string[] }): Promise<boolean> {
	if (typeof ui.custom !== "function") return false;
	let drawn = false;
	await ui.custom<void>((_tui, _theme, _keys, done) => ((drawn = true), {
		render: (width) => draw(screen, width, screen.lines.flatMap((line) => rows(line, Math.max(1, width)))),
		invalidate() {},
		handleInput(data: string) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) done();
		},
	}));
	return drawn;
}
