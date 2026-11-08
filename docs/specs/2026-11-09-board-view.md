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
