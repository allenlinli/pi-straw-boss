# The work board on the head page, `/boss board`, Ask, and Clear (draft)

Status: approved by the boss 2026-11-09 (ask_user, all three recommendations, plus three follow-ups in chat). Todo #135. Base `main` a40cfae1. Ships in 0.66.0 with Raven round 2.

## Why

The work board (`src/board.ts`, how-it-works "The work board") is read only by towers (`board_read`). The boss cannot see it, so cannot tell whether lines are cleaned up when work ends, and cannot ask a main how far its line has got. how-it-works says "A board never … reaches … the GUI": that rule was about allies' boards. This change opens the **local** board to the boss's own page and pi, and keeps allies' boards out.

## Boss decisions (2026-11-09)

| # | Question | Decision (verbatim where quoted) |
|---|---|---|
| B1 | What to build | GUI board panel + 「問進度」 + `/boss board` |
| B2 | Allies' boards | Not shown: local only |
| B3 | Clear button | Yes, only for an ended entry or one idle over 2 h |
| B4 | Where | 「最好的陳列方式應該和主塔台放在一起」: on the head (主塔台) page |
| B5 | Clear tells the writer | 「清的話要提醒寫的那個 agent（除非那個 agent 已經被關閉）」 |
| B6 | Release | 「有做的話明天可以和新版號一起發版」: in 0.66.0 |

## Data

- The server builds the board rows with the same code as a tower's local `board_read` (`readEntries` + `joinLocal`, `src/board.ts`; the mains from `netMembers` as in `src/boardread.ts`), unscrubbed (the boss's own view keeps raw text, as `board_read` does outside a remote turn), cut to the board's caps.
- **Ended entries stay visible while their file exists** (unlike `joinLocal`'s 30-minute window, which is for routing): a row whose session is not a live main shows as `ended` with its age until the file is gone. This is the point of the view: the boss sees what was not cleaned up. Add a variant or option to `joinLocal`; do not change what towers get.
- Row fields: `session` (id, the key for Ask/Clear/opening), `workspace`, `tab`, `main` (name), `role` (`train` when so), `state` (the net mark, or `ended`), `now`, `items` (t, done), `src` (`set` | `todo`), `updatedSecondsAgo`, `stale` (live idle main, entry older than 2 h, as `board_read`), `clearable` (ended, or stale), and a live main with no entry as a row with name and tab only.
- Delivered to the page in the net snapshot as `board` (local rows only, no ally data), only when it changed; the snapshot already goes to this computer's page and the boss's paired devices. No `board` field on the wire to allies, no change to the `board` link message.

## Head page (Standard, Geek, Raven; Zen unchanged)

- A **工作板 / Work board** section on the head page (`gui/headpage.ts` and the session view on the head's key), below the head's conversation/asks, folded by default to a one-line summary: `工作板 · 12 條（閒置 2、已結束 1）`. Open, it lists rows grouped by workspace, in tab order: main name (and `train` tag), state word, `now`, the done count `3/7` with the items behind a fold, the age (`12 分鐘前`). `stale` reads 「閒置超過 2 小時」, `ended` reads 「已結束」, each in words, not colour alone. A live main with no line reads 「沒有寫工作板」.
- Each row's name opens that main's session page (the route the map's card uses). An ended row has no link.
- **問進度 / Ask progress** (live mains only): posts the existing `sessions/<key>/input` with a fixed English prompt (agents read English): `The boss asks from the work board: how far has this work got? Reply in two or three lines (Traditional Chinese), and update your board line (board_set) if it is out of date.` The button then reads 「已問」 for 60 s and is disabled (no double sends); the answer is read in that main's session (the row's link). A main that is busy gets it queued as any input.
- **清掉 / Clear** (rows with `clearable` only): a confirm (the page's own sheet, Cancel first and focused) naming the main and the line, then `POST board/clear {session}`.
- Every field is model-written text: drawn as text only, never HTML, a link, or a route (`textContent`, the page's helpers). Tap targets ≥ 44 px on a phone. Strings via `gui/sentences.ts` (en and zh-TW). Raven words through its pack where Raven has one.

## Server routes

- `board/clear {session}`: refuse unless `session` matches the session-id form and names an existing file `<state dir>/board/<session>.json` (no path from the body), **and the server's own reading now** says the row is `ended` or `stale` (never the page's claim). Delete the file. If the writer is a live session (stale case), send it a notice through the server's existing path to a session (the one tower notices or `tower_send` to a main use, not a GUI input), text: `The boss cleared your work-board line from the head page (it was idle over 2 hours). If you still work on it, write it again with board_set; if the work is over, nothing to do.` An ended writer gets nothing (B5). Answer `{cleared: true, told: boolean}`; the page says 「已清掉，已通知它」 or 「已清掉」.
- After a clear the writer's auto-fill must not rewrite the same line at once: it compares with what it last wrote, not the file, so it writes again only when its todo list or name moves (check this holds; test it).
- Allowed from this computer's page and a paired device (`REMOTE` lists, like `input`); not from Straw Link.

## `/boss board`

In pi: prints the same rows as text (workspace › tab · main · state · now · n/m · age, `stale`/`ended` marked), local only. No clear or ask from pi in this change.

## Docs

- how-it-works "The work board": the local board is shown on the head page and by `/boss board`; allies' boards never reach the GUI; Clear and Ask as above.
- `docs/releases/0.66.0.md`: a section.

## Tests (red first)

- Rows: ended entries older than 30 min still listed while the file exists; stale and clearable flags; a live main with no entry; no ally rows ever (a link with boards present adds none).
- `board/clear`: refuses a bad id, a path, a missing file, a live working main, a fresh idle main; deletes for ended and stale; tells a live stale writer once, tells an ended one nothing; the page's claim is never used.
- Auto-fill does not rewrite a cleared line until the todo list or name moves.
- Page: the fold summary counts; rows group and order; name link only for live mains; Ask posts the exact prompt to `sessions/<key>/input` and disables for 60 s; Clear only on clearable rows, confirm with Cancel first, posts `board/clear`; all text as text (an `<img>` in `now` stays text).
- `/boss board` output.
- Mutation-check the clear guards.

## Notes from the build

Where the spec left a choice open, or the code showed a better way to the same end:

1. **`updated`, not `updatedSecondsAgo`.** A row carries when the line was written (epoch ms). A seconds-ago field would make every net snapshot different every second, and "only when it changed" would never hold. The page counts the age itself and rewrites the age words in place at every draw (it has no timer of its own: they move when the page redraws). `stale` flips once, at 2 hours.
2. **The rows are built from the net snapshot the server already made** (`mainsOfNet`, `src/boardview.ts`), not from a second `netMembers` read: a unit's key is its session id, and its mark already has `commanding` in it. A base of an operated box is not this computer's board and is skipped. The `state` of a row is the unit's mark (`working`, `waiting`, `idle`, `commanding`, …) or `ended`; a `commanding` main is never stale. `/boss board` reads the pi session's own net (`liveMains`, factored out of `board_read`'s reader) and maps a main that commands work to `commanding` (note 15).
3. **Ended rows.** `joinLocal` has a `keepEnded` option; a tower's join is unchanged. An ended row has no name unless the line was an auto line (it keeps `who`); the page and `/boss board` then show the first 8 characters of the session id. The view shows the newest 100 ended rows. The view only reads: it does not purge (a tower's `board_read` still deletes files of sessions gone for 24 hours, and a finished auto line after 30 minutes; a live main whose finished auto line is hidden by `joinLocal` shows as "not written" while that file stays).
4. **The fold's count** is lines (rows that have text, ended ones included) with `idle`, `ended` and `not written` (live mains with no line) in the brackets: `4 lines (1 idle, 1 ended, 1 not written)`. The spec's example had two of the three.
5. **Ask progress is sent as a steering message** (`as: "send"` to `sessions/<key>/input`), not a follow-up: a follow-up to a busy main would wait until its whole run ended, which is the opposite of asking how far it has got. A refusal (a main waiting on a dialog, a pane that left pi) is read out in the section's note line.
6. **Clear** is decided from the server's own reading (`createBoardPanel`, `src/server/boardpanel.ts`): the body's only field read is `session`; unknown ids 400, a missing file 404, a row that is not `clearable` in a fresh `net.read()` 409. A fifth refusal the spec did not list: the line's `updated` must equal the one the reading saw when the file is deleted (409 `changed`), so a writer that wrote again a moment ago keeps its fresh line. The notice goes through the server's own intercom client under a new header kind `board_clear` (from `straw boss`, role `session`); `told` says what became of it (note 12). Without a connected broker, or when the send fails, the line is still cleared and `told` is false.
7. **Who may ask.** `board/**` is a scope of the control routes (`SCOPES`), so this computer's page and a paired device reach it as they reach `input`; the operate table refuses it (`ROUTES`), and Straw Link has no message for it. The snapshot's `board` is absent from the operate slice (an allow list that does not name it), from the link summary, and from remote turns.
8. **Auto-fill after a clear.** The test (`tests/board-auto.test.ts`, "the server's Clear …") holds for a running session: auto-fill compares with what it last wrote, not with the file, so a cleared line (auto or `board_set`) is written again only when the todo list or the name moves. After a pi `/reload` the new extension does not know the line was withdrawn from outside (the withdrawal marker in the session is written only by the writer's own `board_set { clear }`), so a reloaded main writes its line again at its first refresh. Left as it is; telling the writer is the notice's job.
9. **Page.** The section is `<details class="head-board">` under the log in the session view (`gui/session.ts`), drawn only when the unit is the head. Rows are rebuilt only when what they show changes (a tap never lands on a replaced button; a fold the boss opened stays open). The result of Ask or Clear is one line at the top of the section (`role="status"`). Strings live in `gui/messages` (`board_*`) through `gui/sentences.ts`; none says 塔台, so Raven keeps the base words and its pack is untouched. Zen is unchanged.
10. **Not run in this round** (the machine's load order): the full suite, `npm run gui:build`, the caps of `tests/imports.test.ts` (the new `gui/board.ts` and strings add to the eager and page-line figures), and screenshots.

## Notes from the review round (BV-F002 to F007, `/boss board`)

11. **A line whose session is still open is told, though it is not a main (BV-F004).** Such an entry (a main that a takeover made a member, or one Herdr missed for a reading) is still an `ended` row, as the spec said a row whose session is not a live main is, but it carries `open: true`, from the session ids of the net's own units (`openSessions`: every unit of this computer's bases, subagents too, a box's not) together with every session the broker lists (a session Herdr's reading has no pane for is not closed; the same rule `/boss board` uses, BV2-F002). It is told with its own text (`OPEN_NOTICE`: its line had ended, nothing to do), since `board_set` refuses a non-main (BV2-F001). The page reads "not a main" instead of "ended" and its sheet says the writer will be told; `board/clear` tells it (B5: unless the agent is closed). A session that is not in the net gets nothing. `/boss board` takes the open sessions from the pi session's own net.
12. **`told` has three values (BV-F005).** `"delivered"`: the writer's intercom connection took the notice (`delivery: "socket_delivered"`); `"queued"`: the broker holds it for a session that is not connected; `false`: not sent, failed, or the broker said nothing of how (an older pi-intercom without `delivery` makes no claim). The page says 「已清掉，已通知它」, 「已清掉，提醒已排隊」 or 「已清掉」 (en: "Cleared; it was told.", "Cleared; the reminder is queued.", "Cleared.").
13. **Clear has an in-flight guard (BV-F006).** A `clearing` set per session, as Ask has `sending`: from the tap to the end of the request (the sheet included) a second tap does nothing, and the button is disabled once the request is on its way. A cancelled sheet or a refusal frees it.
14. **The board folder is parsed only when it changed (BV-F007).** `cachedEntries` keeps the last parse with the folder's signature (each file's name, size, modified time and inode: a writer replaces a file by rename, so even a same-size rewrite in the same millisecond is a new inode). Every net read still lists the folder and stats each file; it no longer opens and parses them. The rows are rebuilt at each read, because they depend on the mains and the clock. The view still shows the newest 100 ended rows.
15. **`/boss board` prints a main's real mark.** A main that commands work shows `commanding`, as the head page does (it printed `idle`); its line is still never stale.
16. **Caps.** The source budgets in `tests/imports.test.ts` are raised to the measured figures (the first commit had not run them). The eager and page-line caps, and the theme byte caps, need `npm run gui:build` and are not measured yet.
