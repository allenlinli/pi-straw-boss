# pi-straw-boss, unreleased

## Upgrading

- The new tower pane look is in the sb server's prompt (`cli.mjs prompt`): it shows once the sb server runs this version and the prompt is typed again into the standing pane (after a run ends or Herdr restarts).

## Standing pane

- The tower's standing pane looks designed instead of like a stray command. It clears its visible screen when the prompt starts, so the `node "…/cli.mjs" prompt …` line the server typed no longer stays on it (the scrollback is kept). It shows the tower glyph and `tower · <label>` in bold, a state line with a glyph and a colour per state (a green dot for standing by), the hints as four key rows (`⏎`, `/new`, `/quit` and `⌃D`, `/boss tower <message>`), and a `󰐻 ❯ ` prompt. The lines it says in between (waking the tower, a new session, the server not answering, a refusal, an unknown command, leaving the pane) carry a glyph and a colour of their kind.
- `NO_COLOR` (set and not empty) takes the colours. `STRAW_BOSS_ASCII=1` in the shell of the pane takes every glyph outside ASCII and brings back `tower> `. A pipe or log gets plain ASCII with no escape sequence. See [The standing pane](../how-it-works.md#the-standing-pane).
