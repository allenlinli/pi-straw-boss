# The terminal card: one small card for the terminal step an answer leaves

Status: built on `feat/terminal-card` (steps T1 to T7; see **As built** at the end). Base: `main` 6e53b81 (views-core R1–R3, the Zen terminal layer, answer-opens-terminal with pane tags). The one-tap prompt of §16 Q1 is a separate later step.

## 1. Decision and scope

The boss, after trying the Zen terminal layer: 「為什麼會需要整個 terminal？」 He chose a minimal card, expanded only when needed, and 「其實就算是 non-Zen mode，我也都覺得應該可以用一張 terminal card in com ui 處理不是嗎」. So **one terminal card**, shared by Standard, Geek, and Zen, skinned per view, replaces the full terminal that an accepted answer opens today.

What the boss does after each robot_hand outcome, and so all the card must do:

| Outcome (`then`) | What waits | What the boss does | Card kind |
|---|---|---|---|
| (1) *Put it in my prompt* (`{terminal: true}`) | The command in pi's prompt | Presses Enter; the output appears in the chat | `prompt` |
| (2) *Type it into a new Herdr pane* (`{pane: grant}`) | robot_hand's wrapper shows `$ <command>` (zsh `vared`, editable) and waits | Presses Enter; then usually types a sudo password or `y`, then Enter | `pane` |
| (3) *Run it in a new Herdr pane* (`{pane: grant}`) | The command already runs | Watches it finish; sometimes answers a prompt | `pane` |

The wrapper closes its own pane when the command ends (pi-robot-hand `src/herdr.ts` `checkRun`). Only ssh, vim, and other full-screen programs need a real terminal. They get the **Full terminal** link.

In:
- The card component, its pure model, its skins (Standard and Geek in `style.css`, Zen ink in `zen.css`), and its place in each view.
- Rewiring `openThen` so that an accepted answer's `then` opens the card in every view.
- Zen's layer: card mode plus the full terminal as the expansion. The full terminal's return rules move to the card's model.
- Demo states, tests, and docs.

Out:
- Any server change. No new endpoint, field, or confirm token. The card uses `POST …/sessions/<key>/keys`, `…/panes/<grant>/keys`, and `…/mirror` exactly as the key pad does.
- Standard's own **Terminal** (the session view's terminal mode, the pane and session tiles) and a read-only dialog's **Show terminal**. Both stay today's full terminal.
- The probe/confirm rules (Q1).
- pi-robot-hand.

## 2. The card

```
┌ ops-main · 終端機 ─────────────────── × ┐
│ $ sudo apt update                       │  command (the dialog's `select.copy`), mono, one or two lines, selectable
│                                         │
│ Hit:1 http://ports.ubuntu.com …         │  tail: the last 4 non-blank rows of the pane, plain text
│ [sudo] password for boss:               │
│                                         │
│ [••••••••          ] [遮住✓]  [送出 Enter]│  one line; masked automatically on a password prompt
│ 看起來在問密碼：輸入內容已遮住。          │  status line (role=status)
│                              完整終端機 → │  small link
└─────────────────────────────────────────┘
```

- **Header.** The unit's name and 「終端機」 (the existing `terminal_title`: 「終端機 · {name}」). For a pane, the name is the session that asked, not "Herdr pane". It has a × (`close`, 「關閉」).
- **Command.** `select.copy` of the answered dialog. robot_hand fills it with the raw command; a contract-v1 owner may leave it out. With none, the line is omitted. It is display only, with no Copy button (the dialog had one).
- **Tail** (`pane` only). The last 4 non-blank rows of the mirror, with trailing blank rows dropped, every escape stripped (`rowSpans` text without classes), each row right-trimmed, `white-space: pre-wrap; overflow-wrap: anywhere`. No frame, no box, no scrolling, no cursor. No row or column figure ever shows (the full terminal's `mirror_live` "80×24" is not used: no counts).
- **`prompt` kind**: no tail and no input. pi's bottom rows are its editor border and footer, which are noise. The card shows 「指令在 {name} 的提示列等 Enter。」 and one button, **執行** (`card_run`). The mirror is still attached (§4): the keys API refuses an Enter without a fresh frame.
- **`pane` kind**: one `<input>` line and one button, **送出 Enter** (`send_enter`). An empty line sends just Enter, which is the whole of outcome (2)'s first step.
- **Mask toggle** (`pane` only). `button[aria-pressed]` 「遮住」 next to the input (§5).
- **Inline confirm.** When the server asks to confirm an Enter (409 `confirm`), the status line holds a localized sentence, **確認送出** (`card_confirm_yes`), and **取消**. Focus goes to 取消, never to the confirm, as in `keypad.ts` `ask`.
- **Full terminal** (`card_full`, 「完整終端機」): a small link at the bottom right (§8).
- **No key pad, Keyboard button, Fit width, or 1–9.**

## 3. Where it lives

| View | Host | Under it | Notes |
|---|---|---|---|
| Standard, Geek | One **step slot** in the overlay layer's dock (`layer.ts`): an element in `.dock`'s grid at `grid-area: 1/1`, the dock's width, styled like `.dialog` (Geek: its own tokens, CSS only). | Not inert. The card is not modal. | It is not in the alert stack model (`overlay.ts`), so the queue rules cannot close or bury it. Dialogs open only by the user's act. An explicitly opened dialog covers it (higher `z-index`), and closing that dialog shows the card again. The answering alert dialog closes at once as today (`stack.close("go")`), so nothing queued opens over the card. **The route does not change**: answering in the session view keeps its chat, so outcome (1)'s output shows in that chat; answering in an alert stays on the map. Phone (≤ 640 px): a bottom sheet over the page, full width, `padding-bottom: env(safe-area-inset-bottom)`, above the composer. |
| Zen | Zen's existing layer `section.zen-term` (`zenterm.ts`) in **card mode**: ink ground over the stage. The card sits where the item card sits (the same width and top). 「回到禪」 stays in the corner. | `stage` and `corner` are `inert`, as today. The model goes on. | **Full mode** is today's full-screen ink terminal (§8). Leaving Zen lets the card go with the layer. |

One card per page. A new step replaces the card on show (Q4). The card follows each snapshot: `pagecore` passes `net` to Zen's `follow` as today, and to the Standard card from `draw`, for the name and a tower's held state.

## 4. Data source: the mirror, not history

The tail comes from the **mirror** (the `mirror` frames on the page's stream). Two reasons:
1. The keys API sends nothing unless this page's stream holds a fresh mirror of that pane (`keys.ts` `guard`/`bare`: 409 `no_mirror` without a frame in the last 3 s). The card must attach a mirror to send anything.
2. History is pi's chat log. A Herdr pane has none, and pi's prompt line is not in it.

How:
- `mirror.ts` splits into a **headless connection per key** and its views. The connection holds the attach queue, `hello`, the 5 s park while the tab is hidden, the 3 s stale check, `ended`, the refusals that end the mirror (404 `not_found`, 409 `pane_closed`), and `rows: string[]` kept from the frames' `set`. The views are the tile and `embed`, which still draw with `applyFrame`.
- `Terminals.watch(key, name, { rows(rows), state(s), end(), taken() })` gives the card the same connection that `open`/`embed` use. Expanding (§8) therefore reuses the mirror the card already holds: one attach per key, never two.
- A session card counts as one of the page's two terminals on the server (`src/mirror.ts`). A pane card's reader is bare and does not count.

## 5. Password prompts

**Rule** (pure, `cardmodel.ts` `secretPrompt(rows)`): take the last non-blank row of the mirror, strip its escapes, and trim it right. It is a password prompt when it matches

```
/(password|passphrase|passcode|\bpin\b|密碼|口令).{0,80}[:：]$/i
```

Examples that match: `[sudo] password for boss:`, `Password:`, `Enter passphrase for key '/Users/boss/.ssh/id_ed25519':`, `Password for 'https://boss@github.com':`, `請輸入密碼：`, `Enter PIN:`.
Examples that do not: `password updated.`, `$ echo password` (no trailing colon), `Enter command:`, and a password prompt that is no longer the last row.

Only the last row counts, because the mirror carries no cursor position and the prompt is where the cursor waits. The rule runs only for a `pane` card in state `live`.

**Mask behavior:**
- A match turns the mask on (`type="password"`). It turns off by itself only when the prompt is gone **and** the field is empty. It never unmasks characters already typed.
- The toggle 「遮住」 (`aria-pressed`) is always there. Pressing it sets the mask by hand, and a hand-set mask stays until the boss presses it again. That is the way out of a **false negative**: an unusual prompt (`Enter secret>`, a prompt followed by more output, a prompt in another language) shows the field as plain text, and the boss presses 遮住 before typing. The status line never claims a field is safe when it is not masked.
- A **false positive** (a mask that was not needed) costs only legibility. The boss presses 遮住 to unmask.
- On a match the status line says 「看起來在問密碼：輸入內容已遮住。」 On a desktop (fine pointer) the focus moves to the input. A phone does not move focus, because a focus without a tap opens no soft keyboard. The tap is the boss's.
- Secrecy of what is typed:
  - The input sits outside any `<form>` with `autocomplete="off"`, `autocapitalize="off"`, `autocorrect="off"`, and `spellcheck="false"`, so no submit event reaches a password manager.
  - Its value is cleared as soon as its writes are queued, whatever their outcome.
  - The card neither logs it nor keeps it.
  - Like any typed text, it goes as keys `text` writes to `pane.send_text`. The server logs no key text (`control.ts`). The tail cannot show it, because sudo and ssh do not echo.

## 6. Input semantics

- **`pane` card, 送出 Enter** (the button, or an Enter `keydown` in the input that is not `repeat` and not `isComposing`):
  1. The field's text, with control characters stripped, goes as `{text}` writes of at most 64 code points each.
  2. Then `{key: "enter"}`.
  3. Each write goes through `post("keys", { …, stream })`, one at a time and at least 130 ms apart (the server takes 8 a second). This uses the same queue as the key pad, extracted from `keypad.ts` into `keywriter.ts`.
  4. If any write is refused, the rest are dropped, so the Enter does not go after a text that did not land. A plain field keeps its text so the boss can retry. A masked field is already empty.
- **`prompt` card, 執行**: one `{key: "enter"}` to `sessions/<key>/keys`. The server probes the editor. A `command` (`/` or `!`, which every robot_hand shell command is: `! cmd`), `unread`, or ending command (`/reload` …) comes back as 409 `confirm`. The card shows the inline confirm. **確認送出** resends `{key: "enter", confirmed: <the token the server named>}`. 取消 clears the confirm.
- **What the card never sends**: Escape, arrows, Tab, chords, digits, paste markers, or a `confirmed` it was not given. It never sends anything while a write is on its way (the button is disabled, 「送出中…」).
- **Authorization is never widened.** The card uses the same endpoints, the same `stream`, and the same guards (secret, answerable dialog, `link_request`, LAN overlay, rate, fresh mirror, grant liveness), with the same confirm tokens, on a paired device as on this computer. A `hereOnly` choice was already refused before any `then` existed. The card adds no request shape. The tests in §11 assert its bodies against `keys.ts` `check`.

## 7. States and auto-close

States come from the pure model, `cardmodel.ts` `cardState(facts)`:

| State | When | Card shows | Button |
|---|---|---|---|
| `connecting` | No frame yet | 「連線中…」 | disabled |
| `live` | Frames arrive | Tail (pane); the prompt line (prompt) | enabled |
| `secret` | `live` + `secretPrompt` | Masked input, the password line | enabled |
| `sending` | A write on its way | 「送出中…」 | disabled |
| `confirm` | 409 `confirm` | Localized sentence, 確認送出 / 取消 | the two inline buttons |
| `running` | `pane`: an Enter of this card was taken, and the tail changed since | Tail; status 「已送出。」 until the next change | enabled (more prompts may follow) |
| `stale` | No frame for 3 s | Tail dimmed, 「終端機暫時沒有更新，稍候。」 | disabled (the server would refuse) |
| `paused` | Tab hidden 5 s | `paused_hidden` | disabled |
| `hidden` | Session mirror `hidden` (secret_drop) | `mirror_hidden` | disabled |
| `held` | A tower with no run live (`termHold`) | `tower_term_held` / `tower_term_standing`; attaches when a run is live | disabled |
| `refused` | Attach or write refused, but not gone (rate, `no_mirror`, `blocked`, `standing`, network) | The server's reason, or `unreachable` | enabled again (retry) |
| `ended` | `prompt`: the session's mirror ended (it left its pane) | `mirror_ended` (the boss should read why) | disabled; the card stays |
| `gone` | `pane`: `ended` frame; attach refused 404 / `pane_closed`; keys refused 404 / 409 `pane_closed` | (closes) | n/a |

**Auto-close** (`cardmodel.ts` `stepRule(kind, event) → "stay" | "close"`). This generalizes ZT-F001: only what this card sent counts. Per the sb backlog's bug report, it never waits for a mark change.

| Kind | Closes when | Never closes on |
|---|---|---|
| `prompt` (1) | An Enter **this card** (or its expansion, §8) sent is **taken**: the keys reply is 200, directly or after 確認送出 | Any mark (`idle`, `working`, `done`); another device's or the terminal's own Enter; a refusal; a confirm 取消; the mirror ending (shows why) |
| `pane` (2)(3) | `gone` (above): the wrapper closed its pane when the command ended, the grant ended, or the pane turned into a pi session | An Enter taken (a password is followed by more prompts); stale; paused; a network failure |
| `armed` (Zen's two **Open the terminal** buttons, full mode only, Q2) | The unit's first `working` after the terminal opened | Anything else |

Every card also closes by:
- its ×;
- Esc: in Standard, a `keydown` Esc while the focus is inside the card. In Zen card mode, the layer's two-press Esc and 「回到禪」, as today with `typing: false`, because the card has no sink;
- **Full terminal** (a hand-over);
- leaving Zen (a Zen card);
- a newer card.

On close:
- Standard: focus returns to where it was before the card opened, or to the page's `claim` when that element is gone.
- Zen: the layer's existing `closed()` path. The item card takes the focus back.

## 8. Expansion: the full terminal

The **Full terminal** link (「完整終端機」) is for ssh, vim, less, a TUI selector: anything that needs arrows, Esc, or a screen.
- **Standard / Geek**: the card closes, and today's full terminal opens:
  - `prompt` → `openSession(ws, key, { mode: "term" })` (the session view's terminal mode);
  - `pane` → `panels.terminal.open("grant:<id>", name, true)` (the pane tile with pad and keyboard).
  Today's tiles and terminal mode keep today's rules: no auto-close, and the tile says `mirror_ended`.
- **Zen**: the layer switches from card mode to full mode in place: today's full-screen ink terminal (`embed`, `keys: true`, pad, sink, Shift+Esc, Esc rules). Its return uses the **same `stepRule`** as the card, with the card's kind carried over:
  - `prompt`: an Enter from the pad or sink, taken;
  - `pane`: `end`;
  - `armed`: first `working`.
  This removes today's idle→working rule, which failed in the boss's demo.
- The expansion reuses the card's mirror connection (§4). It does not attach again.

## 9. Accessibility

- Card: `section` with `role="dialog"`, `aria-modal="false"` in Standard (non-modal, nothing trapped), and `aria-labelledby` its header. In Zen, a region inside the layer that the layer labels.
- Tail: `aria-live="off"`, so a screen reader is not flooded by updates up to once a second. The status line is `role="status"` (polite) and announces state changes only: connecting, password, sending, sent, confirm, refused, stale.
- Input: a visible-on-focus label `card_input` (「要送進終端機的一行」). The mask toggle is `aria-pressed` with its own label. When the mask switches on by itself, the status line says so.
- Focus on open:
  - The primary button never takes the focus. A held Enter from the answer must not run the command. Enter on 執行 / 送出 Enter ignores `repeat` and requires `isTrusted`.
  - Desktop: the input for `pane`, the card itself (`tabindex=-1`) for `prompt`.
  - Phone: the card's header.
- Inline confirm: the focus goes to 取消.
- Targets ≥ 44 px on a coarse pointer. Text scales with the page (`rem`).
- `prefers-reduced-motion`: no slide-in; the card appears.
- Forced colors: borders and the button use system colors, as the dialogs do.
- No counts: the card holds no number of rows, columns, items, or queue. The layer scan test (§11) covers it.

## 10. Strings (both languages; Paraglide `gui/messages/en.json`, `zh-TW.json`)

Reused as they are: `terminal_title`, `send_enter` (送出 Enter), `cancel`, `close`, `connecting`, `paused_hidden`, `mirror_hidden`, `mirror_ended`, `unreachable`, `refused`, `tower_term_held`, `tower_term_standing`, `zen_back_title`, `zen_term_esc_hint`.

New:

| Key | en | zh-TW |
|---|---|---|
| `card_run` | Run | 執行 |
| `card_waits` | The command waits in {name}'s prompt. | 指令在 {name} 的提示列等 Enter。 |
| `card_input` | A line for the terminal | 要送進終端機的一行 |
| `card_mask` | Hide what I type | 遮住 |
| `card_secret` | Looks like a password prompt: what you type is hidden. | 看起來在問密碼：輸入內容已遮住。 |
| `card_sending` | Sending… | 送出中… |
| `card_sent` | Sent. | 已送出。 |
| `card_stale` | The terminal has not updated for a moment; waiting. | 終端機暫時沒有更新，稍候。 |
| `card_full` | Full terminal | 完整終端機 |
| `card_confirm_yes` | Send it | 確認送出 |
| `card_confirm_command` | This runs a command in {name}'s prompt. | 這會在 {name} 的提示列執行指令。 |
| `card_confirm_unread` | {name}'s prompt could not be read, so Enter may run something else. | 讀不到 {name} 的提示列，Enter 可能會執行別的東西。 |
| `card_confirm_ending` | Enter runs /{command}, which ends or replaces this session. | Enter 會執行 /{command}，這會結束或取代這個 session。 |

The card maps confirm tokens to sentences itself:
- `command` → `card_confirm_command`;
- `unread` → `card_confirm_unread`;
- any other token is an ending command's name → `card_confirm_ending`;
- a token the card does not know, or a server that sends none, falls back to the server's English `reason`.

The tokens are `keys.ts` `ASK` and `confirm`. The card can only meet Enter's.

## 11. Budgets and tests

**Budgets** (`tests/imports.test.ts`):
- **Eager ≤ 0.3 KB raw**: only `pagecore.openStep` and the `onStep` registration in `main.ts`. `terminalthen.ts` is already eager (it is imported by `main.ts`).
- **The card in a lazy chunk.** `gui/termcard.ts` (DOM) and `gui/cardmodel.ts` (pure) load with the overlay chunk in Standard and with the Zen chunk in Zen. `keywriter.ts` and `mirrorconn.ts` are shared by the overlay chunk and the card.
- The lazy cap grows by the card, less what leaves `zenterm.ts` and `keypad.ts`. Target ≤ +3.5 KB raw / +1.4 KB gzipped, recorded with the figure.
- The stylesheet cap grows by the card's rules in `style.css` (Standard, Geek, phone sheet) and the ink skin in `zen.css`. Target ≤ +1.5 KB raw / +0.4 KB gzipped.
- New line figures: `termcard.ts` ≤ 160, `cardmodel.ts` ≤ 90, `keywriter.ts` ≤ 70, `mirrorconn.ts` ≤ 110. `mirror.ts` and `keypad.ts` must go down by what moved. `zenterm.ts` must go down (the idle bookkeeping leaves).

**Node tests**, each state its own case:
- `tests/cardmodel.test.ts` (pure, the single home of each rule):
  - `tail(rows)`: trailing blanks, escapes, 4 rows, right trim;
  - `secretPrompt`: the match and no-match tables in §5, and only the last row;
  - mask: on by match; off by itself only when the field is empty; a hand mask sticks; never unmasks typed text;
  - `cardState` for every row of §7's table;
  - `stepRule`: `prompt` closes on taken (direct and after confirm) and never on any mark sequence (idle→working, working→working, done) or on another device's Enter or a refusal; `pane` closes on each `gone` cause and never on Enter taken; `armed` on first working.
- `tests/termcard.test.ts` (DOM fakes):
  - each state drawn as its words and buttons;
  - `prompt`: 執行 posts `{key:"enter", stream}`; 409 `confirm` shows the localized sentence for `command`, `unread`, `reload`, and an unknown token (the server's reason); focus on 取消; 確認送出 posts exactly the named token; 200 closes; a refusal stays;
  - `pane`: empty 送出 Enter posts Enter only; text of 70 characters goes as 64 + 6 then Enter, in order, ≥ 130 ms apart on a fake clock; a refused text drops the Enter; a masked field is empty after send; Enter `repeat` and composing are ignored; Enter taken does not close; `ended`, 404, and `pane_closed` close;
  - × and Esc close; Full terminal hands over;
  - no element holds a digit from rows, columns, or a count;
  - every body the card posts passes `createKeys().check`.
- `tests/zen-terminal.test.ts` (updated): an accepted `then` opens card mode, not full; Full terminal switches to full mode with one attach; full mode returns per `stepRule` (the old idle/entered cases are replaced by "no mark sequence returns a `prompt`"); card-mode Esc is the two-press; the Open the terminal buttons open full mode armed; a held tower's sentence in both modes.
- `tests/pagecore.test.ts`: `openStep` goes to Zen's layer in Zen, to the Standard slot when away, and to Standard when Zen went away before its chunk; the route does not change.
- `tests/panel.test.ts`: an accepted `then` calls `onStep` with `{kind, key, command: select.copy}`; the alert dialog closes at once.
- `tests/mirror.test.ts` / `terminal-tile.test.ts`: the connection's `rows` model; `watch` and `embed` on one key share one attach; the tile is unchanged.
- `tests/keypad.test.ts`: `taken()` fires only on a 200 Enter (including after a confirm), never on its way or after a refusal.
- `tests/term-keys.test.ts` and `control.test.ts` unchanged. That no server test changed is the proof that the server did not change.

**Mutations** (each must be killed; record them in the review):
1. `prompt` closes on Enter going instead of taken.
2. `pane` closes on Enter taken.
3. Mask turns off with text in the field.
4. `secretPrompt` looks at any row.
5. Enter sent after a refused text.
6. `repeat` Enter accepted.
7. `confirmed` sent without a server token.
8. A mark rule revived for `prompt`.
9. The expansion attaches a second mirror.
10. The status shows `mirror_live`'s figures.

## 12. Demo states

Add `?card=<state>` to the dev fixture (`gui/fixture.ts`). It works with or without `?zen=`, and the fixture's keys handler scripts each reply:
- `prompt`: billing-main's robot_hand → *Put it in my prompt*. 執行 → 409 `command` → 確認送出 → 200 → closes.
- `reload`: the same, with `/reload` (409 ending `reload`).
- `type`: *Type it into a new Herdr pane*. The pane shows `$ sudo apt update`. Enter → `[sudo] password for boss:` (masked) → text + Enter → 3 output rows → the pane ends 4 s later → closes.
- `run`: *Run it in a new Herdr pane*. Output scrolls for 8 s, then ends → closes.
- `secretmiss`: the prompt `Enter secret>` (a false negative, so the mask is by hand).
- `refused`: keys 409 `no_mirror`.
- `stale`: frames stop.
- `gone`: attach 404 (closes at once).
- `hidden`: a session prompt behind a secret_drop.
- `held`: a tower standing by.

The existing toolbar robot_hand button and `?zen=terminal` move onto these states.

Screenshot audit before "it looks right" (the per-state lesson from the Zen terminal demo): every state above in Standard, Geek, and Zen; desktop and 390 px; the confirm, refusal, ended, held, and secret states included. The PNGs are read by the author, not only by the reviewer.

## 13. Docs

- `docs/how-it-works.md`, **An answer that needs the terminal opens it**: rewrite the opening half.
  - `then` opens the **terminal card**, which holds the command, the last rows, one line with automatic masking, and 執行 / 送出 Enter.
  - The card closes on its own Enter for a prompt and when the pane ends for a pane.
  - **Full terminal** opens today's terminal.
  - Replace the Zen sentences (full-screen layer first) with card mode, then full mode.
  - Keep the grant, tag, and server parts as they are.
  - Add the password rule and its manual mask.
- `docs/specs/2026-11-01-zen-view.md`, **A terminal in Zen**: add Z-D9 (the card first, full terminal on request; quote the boss) and amend the auto-return bullets to `stepRule`. Delete the idle→working paragraph and say why (the demo's working session plus the `/reload` confirm).
- `README.md`: the GUI bullet (line 49) and the Zen paragraph each gain one clause: an answer that leaves a terminal step shows a small card to finish it. A screenshot `docs/gui-terminal-card.png` (Standard) is optional; Zen's is covered by the item shot.
- `docs/specs/2026-10-18-dialog-answers.md`: one line pointing `then` at the card.

## 14. Step plan

Sequential on one branch (`feat/terminal-card`). Each step is one commit, with `npm run check && npm test` as its anchor and its own new test run first through `npm run test:one`.

1. **T1 `mirrorconn.ts`** (move, no behavior change). The connection core leaves `mirror.ts`: attach queue, hello, park, stale, ended/refused/end, `rows`. `mirror.ts` keeps `rowSpans`, `applyFrame`, the tile and `embed` DOM, and the sink. Add `Terminals.watch`. Anchor: mirror, terminal-tile, and session-term unchanged, plus new rows-model and shared-attach cases.
2. **T2 `keywriter.ts`** (move). `keypad.ts`'s queue, gap, confirm token, and refusal drop go to `keywriter.ts`. `keypad.ts` keeps its keys, chords, and DOM. Add `taken()`, and keep `entered(sent)` until T5. Anchor: keypad, term-keys.
3. **T3 `cardmodel.ts`** (new, pure): `tail`, `secretPrompt`, mask, `cardState`, `stepRule`. Anchor: `tests/cardmodel.test.ts`.
4. **T4 `termcard.ts`** (new) plus its strings and CSS (Standard, Geek, phone sheet; Zen ink in `zen.css`). Anchor: `tests/termcard.test.ts`.
5. **T5 wiring.**
   - `terminalthen.ts`: `openThen(then, at)` sends `{kind: "prompt", key}` or `{kind: "pane", key: "grant:<id>", asker}` with `command` to the registered `onStep`. `pane: null` is unchanged.
   - `ask.ts`: passes `select.copy` and the unit key. mountAsk's `terminal` argument becomes `{ key, show }`, because the three callers hold the key. `show` stays the read-only Show terminal.
   - `pagecore.ts`: `openStep(s)` replaces `openPane`.
   - `layer.ts`: the dock's step slot.
   - `zenterm.ts`: card mode and full mode. Its `Open.idled`, `entered`, and `mark` bookkeeping and the idle→working branch of `watch` are removed, and the return goes through `stepRule`. Zen's two Open the terminal buttons → full mode, armed (Q2).
   - `keypad.ts`: drops `entered(sent)`.
   - `main.ts`: `onStep(core.openStep)`.
   Anchor: zen-terminal, pagecore, panel, main-wiring, zen-layer.
6. **T6 demo** `?card=` states (§12) plus the screenshot audit.
7. **T7 docs and budgets** (§11, §13).
8. **Review.** One fresh reviewer: the keys path, the masked input, and the use of grants are security-adjacent. Then a visual check per state. P0/P1 block.

**What moves out of `zenterm.ts`:**
- the step rule (to `cardmodel.ts` `stepRule`);
- the held-tower decision is shared with the card (`termHold` through one helper).

**What stays as the full terminal:**
- `zenterm.ts` keeps the layer: section, bar, 回到禪, inert, the Esc two-press and hint, the phone focus, and full mode's `embed`;
- `mirror.ts` keeps the tile, `embed`, sink, and Shift+Esc;
- `keypad.ts` keeps the pad;
- Standard's session terminal mode and pane tile keep everything.

**Removed:**
- An accepted `then` no longer opens the full terminal first in any view. Standard no longer routes to the session's terminal mode or opens the pane tile for it.
- Zen's full-screen layer is no longer the first thing an answer shows.
- `openPane` and the `onPane` registration (replaced by `openStep` / `onStep`).
- zenterm's idle→working rule (`idled`, `entered`, `mark`).
- keypad's `entered(sent: boolean)`, replaced by `taken()`.
- `?zen=terminal` (replaced by `?card=`).

## 15. Open questions (where the code forces a choice)

| # | Question | Recommendation |
|---|---|---|
| Q1 | robot_hand puts `! cmd` in the prompt, and `probe.ts` classes every `/` or `!` line as `command`. So **every** outcome (1) takes two taps: 執行, then 確認送出. Avoiding it needs a server and bridge change: the card sends a hash of the command it shows, the bridge's probe reports whether the editor holds exactly that, and a match counts as the `command` confirm (never as an ending command's). | **Keep the confirm for now.** It is the server's safety rule, and the card makes it one inline tap with clear words. Build the hash match as a follow-up only if the boss finds the second tap annoying. Old bridges would fall back to the confirm, so it can ship later without breaking anything. |
| Q2 | Zen's two **Open the terminal** buttons (a blocked prompt; a read-only dialog: several at once, too long, secret_drop) are not `then` outcomes. What waits there is a pi TUI dialog that needs arrows, digits, or Esc, which the card deliberately lacks. | **Open full mode directly, armed** (first `working` returns). The read-only dialog's button becomes armed too, because its unit waits on that dialog now. Today it is unarmed only because it shares `then.terminal`'s callback. |
| Q3 | Masking: `type="password"` can trigger a browser's save-password prompt. `-webkit-text-security` avoids that but is not in every engine. | **`type="password"` outside any `<form>`, `autocomplete="off"`, and the value cleared on send.** No submit event fires, so Chrome and Safari offer no save. Note any prompt the live check sees. |
| Q4 | A second accepted `then` while a card is open. One slot means the first card goes (its pane keeps running in Herdr; nothing is lost but the card). Several cards mean a stack model and counts. | **Replace.** The boss answers one thing at a time, and a stack would bring back a count. |
| Q5 | A session card holds one of the page's two session mirrors (server limit). With two session terminals already open in tiles, the card's attach is refused. | **Accept.** The card shows the refusal, and Full terminal is still offered. It is rare, and widening the server limit is out of scope. |

## 16. Decisions (2026-11-02, sb backlog relaying the boss)

- Q1: **one tap.** Boss chose 「做成一下（建議）」: build the hash match now (card sends the shown command's hash; the bridge's probe confirms the editor holds exactly that; a match satisfies the `command` confirm only, never an ending command's such as /reload or /quit). Old bridges fall back to the inline confirm. Server + bridge change → its own step with a fresh security reviewer.
- Q2–Q5: recommendations accepted (full mode armed for Zen's Open-the-terminal buttons; `type="password"` outside a form, autocomplete off, cleared on send; a new card replaces the open one; a refused second session mirror shows the refusal plus Full terminal).
- T3 calls (sb backlog, 11-02): `tail` drops every blank row before taking the last 4 — accepted. A hand-set mask resets after each accepted send, so a later password prompt masks again on its own (a manual unmask never carries over to the next prompt); T4 implements and tests it. Taken-but-unchanged shows 「已送出」 — accepted.

## 17. As built (T1 to T7)

- **Steps**: T1 `mirrorconn.ts`, T2 `keywriter.ts`, T3 `cardmodel.ts`, T4 `termcard.ts` with its strings and skins, T5 wiring (`terminalthen.ts`, `ask.ts`, `pagecore.ts`, `layer.ts` with `stepslot.ts`, `zenterm.ts` with `zenhost.ts`, `main.ts`), T6 the demo (`gui/democard.ts`, `?card=<state>`: `prompt`, `reload`, `type`, `run`, `secretmiss`, `refused`, `stale`, `gone`, `hidden`, `held`, `second`; it replaces `?zen=terminal`) and the screenshot audit, T7 the changes below, the docs, and the budgets. The one-tap prompt of §16 Q1 (the hash match, a server and bridge change) is not built here: it is its own step.
- **Zen's decision number** is Z-D10 in `docs/specs/2026-11-01-zen-view.md` (Z-D9 was already the polish round).
- **Changes found by the audit and the boss's review after T5**: Zen's card sits in the middle of the layer without a focus ring around it; the card's rows leave out a row that only echoes the command shown above them (`tail(rows, command)`; a prompt and then exactly the command); the input's label is for screen readers only, in every view; the refusals of a terminal's keys and mirror, and the mirror's `ended` reasons, are said in the page's language by the server's code (`gui/termwords.ts`, a test per code and a test that the table lists exactly the codes `src/keys.ts` and `src/mirror.ts` refuse with), for the card and the key pad alike, and a code the page does not know shows the server's text; the confirm pair is one function (`gui/confirmbar.ts`) for the pad and the card.
- **Budgets** (`tests/imports.test.ts`). Eager: +40 bytes raw / +29 gzipped over main d922096 (`pagecore.openStep`, the registration in `main.ts`; target 0.3 KB). Lazy: +14.0 KB raw / +6.0 KB gzipped (target 3.5 / 1.4). About 6.5 KB of it is messages (the card's 13 and the refusals' 18, an English and a Chinese text each; a message's code is about 45 bytes, the rest is its two texts), and about 7.5 KB is code: `termcard.ts` 4.6, `mirrorconn.ts` 2.2 less the 0.8 that left `mirror.ts`, `keywriter.ts` 1.3 less the 0.8 that left `keypad.ts`, `cardmodel.ts` 1.0, `stepslot.ts` 1.0, `zenhost.ts` 1.1 (minified, before gzip). The card's code is already one function per concern with no duplicate of the pad's (the confirm pair, the writes, the connection core, and the text box rules are shared); what is left is the behavior of §7, the strings of §10, and the localized refusals. Stylesheet: +3.4 KB raw / +0.6 KB gzipped (target 1.5 / 0.4), Standard and Geek +1.7 KB, Zen ink +1.7 KB, after sharing the dialog's box rules, the pad's confirm pair rules, the page's text box rules, and the pad's phone rule. Line figures: `termcard.ts` 123, `cardmodel.ts` 49, `keywriter.ts` 71, `mirrorconn.ts` 83, `stepslot.ts` 63, `zenhost.ts` 59, `confirmbar.ts` 12, `termwords.ts` 18; `zenterm.ts` 111, `mirror.ts` and `keypad.ts` went down by what moved.
- **Mutations**: T5's wiring, 28 mutants (27 killed; the survivor, "armed for every kind of step", is equivalent: a prompt and a pane never receive a `working` mark rule); T7's refusal wiring, 8 killed of 8; the echo rule, 5 killed of 6 (the survivor, `includes` for `endsWith`, is equivalent: the prompt check on what precedes rejects the same rows); the label rule, 1 of 1.
- **Audit**: Standard, Geek, and Zen at 1280 × 800 and 390 × 844, in English and Traditional Chinese, 20 shots each, read one by one (`~/.local/share/sbd-review/zen/termcard/`). Known and accepted: a refusal shown for a code the page does not know is the server's English text; a phone's sheet header keeps a 44 px tap target above the command.

## 18. Review fixes (terminal card review, TC-F001 to F012)

- **TC-F001**: `watch` gives `retry` (`mirror.ts`, through `TermKit`). A refused or failed attach is tried again from the card's button, which sends no key meanwhile and says it is connecting; a second try waits 1 s, a third 2 s more, doubling to 8 s, and a live frame resets it.
- **TC-F002**: the input's Enter does nothing on `keyCode` 229 and is left to the browser, so an input method's committing Enter only commits.
- **TC-F003**: tests pin the key target: a pane step's writes and its connection both name `grant:<id>`, a prompt step's the session (`stepslot.test.ts`, `zen-terminal.test.ts`).
- **TC-F004**: a stopped card's `over` is silent, so a late reply of a replaced card closes neither the newer card nor the layer; Zen's host also asks that its layer is on show.
- **TC-F005 to F007**: a text that landed is not put back when its Enter is refused; the mask reset keeps `on` while the field holds text; the auto-mask moves the focus only from the body or from inside the card.
- **TC-F008**: `standing`, `not_found`, `pane_closed`, and `busy` have the page's words; the drift test reads `keys.ts`, `mirror.ts`, `answerpane.ts`, and the session routes of `control.ts`.
- **TC-F009 to F011**: the demo's `second` is the server's 429 `too_many` with keys refused for lack of a mirror; the how-it-works sentence names `card_confirm_*`; the audit was redone for every state.
- **TC-F012** (Chrome's password manager on a formless field) stays open for the live check.
