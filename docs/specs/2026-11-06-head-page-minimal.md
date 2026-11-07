# The head page, minimal (2026-11-06)

The head tower's page (`/head`, Standard and Geek) is the session view on the head key. Until 0.60.0 it carried every part of a workspace tower's comms page: an ask chip per forward, the conversation box with its `⋯` and event runs, the waits with their buttons, and the memory footer. The head does no work of its own, so most of that meant nothing to the boss (scout: `~/.local/share/sbd-review/backlog/head-page-scout.md`; options: `/tmp/head-page/proposal.md`). This record replaces **The page** and the ask chips of `2026-11-04-head-tower.md` (Standard: the head page and its entries) and changes what `asks.json` holds. Workspace tower pages are unchanged.

## Boss decisions (2026-11-06, answers A / A / A)

1. "A 精簡版：對話＋輸入框；有事才出現『等你決定』；交辦收成一行摘要點開看。拿掉事件執行列、『…』、空記憶列、TOWER_DONE 原文。"
2. "A 一次廣播一行：『起床了 → 4 個塔台・2 小時前・回覆 1/4』，點開看各塔台回覆；24 小時沒動靜收進『更早』。"
3. "A 到期收起＋請主塔台結案：超過它自己的期限就不顯示，主塔台下次醒來會被提醒結案；伺服器保留 7 天可查。"

## What the head page shows

| Part | Rule |
|---|---|
| The log | The head's own prose, the boss's lines, tower answers (collapsed intercom notices), chapter dividers. **Not shown:** the head's tool cards (`tower_done`, `tower_send`, …), shell lines, and the sb server's own notices and timers (`[notice from the sb server]`, `[your wakeAfter follow-up is due]`). An assistant entry that has only tool cards is hidden whole. This holds for the session route's log only (`mountChat` with `page`); Zen's companion log of the head (history) is unchanged and draws them. |
| Waits for the boss | One row each, only while not lapsed (below). The wait panel keeps its buttons (they are `fix/wait-panel-buttons`'s). |
| Asks | One row per broadcast (below), under the log, above the composer. |
| Conversation actions | **End conversation** and **New conversation** (only while a boss conversation is live; End also not while it is closing) and **Close** (the head's own, asked once by `quit.ts`) sit in one row directly above the composer. No `⋯` popover, no conversation line, no `事件執行・N` bar, no event-run chips. |
| Memory footer | Only when the head's memory holds a standing instruction, a decision, or a pending proposal (or the file is unreadable). Not for `0・0・0`, and not for waits alone. Its wait count leaves out the lapsed waits for the boss, as the rows do. |
| Proposals | Rows of a pending proposal stay (they are a decision for the boss). |

The map card, the Zen strip, alerts, and the workspace tower pages keep the rows they had, except where they read the head's waits (below).

## Lapsed waits

`lapsed(w, now)` (`src/server/towermemory.ts`): the wait has a `due` and `now >= due`, or it has none and `now - at >= 24 h` (the page's existing FRESH window). The server's `memorySummary` takes `now` for the **head only** and then leaves lapsed boss waits out of `bossWaits`. Everything that reads `bossWaits` (the page rows, the Zen strip's hold, the alerts) therefore agrees, and no GUI copy of the rule exists. The waits stay in `memory.json` for 7 days (`MEM.expireMs`, unchanged) and `/boss memory -w head` and the memory route list them. `MemorySummary.waits` is the count of open waits, for the head without the lapsed ones for the boss (the footer must not count a wait the page does not show); a workspace tower's is all of them.

The head's brief: when any open wait is lapsed, the brief gains one line after the memory section: `Lapsed waits (the boss no longer sees them on the page): <ids>. Resolve each with tower_memory resolve, or ask the boss again with a new due.` The ids are the lapsed waits **for the boss** (`headside.ts`); a wait for an agent is not on the boss's page and not in the line. The memory section's per-wait `(overdue …)` marks stay.

## Asks: one row per broadcast

> The row, its state words, and the order of cards are changed by `2026-11-07-head-log-cards.md` (labelled parts, `handled` and `received`, corrections folded under the newest).

The head has no broadcast tool; one boss instruction becomes several `tower_send` calls with the same message. Each call still opens one ask.

- **Data.** `asks.json` asks gain `group?: string`, the id of the first ask of the broadcast (`H12`). One function (`groupsOf`) decides it, for a new ask and for a file without the field: an ask with a `relay` (`boss:<event id>`, the same for every ask of one boss instruction, however the head worded the message to each tower) joins the newest earlier ask with that `relay`, at any distance in time; an ask without one (a file from before the relay, the head's own notes) joins the newest earlier ask without one whose first line is identical and whose `at` is 0 to under 60 s before it (chained: a later member keeps the group alive; a prior `at` in the future, from clock skew, is no member); otherwise the ask is its own group. Relayed and unrelayed asks never join each other. The boss's own file (20 asks) is 6 broadcasts by this rule; grouped by first line alone it was 11. Nothing else in the file changes, `next` and the cap behave as before, and an ask file with no `group` anywhere still reads: the reader derives the same grouping (by the rule above) for asks that lack the field. Readers of `asks.json`: the GUI row source (`headnet.ts`) and the head brief (`headside.ts`, open asks, unchanged); nothing else (checked with `grep readAsks openAsks`).
- **Row source.** `HeadAskRow` becomes `{ id, group, workspace, label, at (last activity), since (opened), first, state: "waiting" | "answered" | "silent", answers: number, last?: string (the newest answer's first line) }`. `state` is **answered** when the ask has an answer, else **waiting** while it is open (24 h from its last forward), else **silent** (24 h without an answer, closed by the cap, or a failed send). 已回覆 is never shown without an answer. The snapshot carries the newest whole groups up to 60 asks (it cut mid-broadcast at 20 asks before).
- **Page.** A group row reads `<first words> → N 個塔台・<age>・回覆 k/N` (N = distinct workspaces in the group, k = those with an answer, age = since the first ask). Tapping the row unfolds one line per tower: its label, `等回覆` / `已回覆` / `沒回應`, and the newest answer's text (visible text, wrapped; not a `title`). A tower the net knows has its label as a link to that tower's comms; a workspace without a tower and without an answer shows only muted `沒有塔台` (no `等回覆`, no gold, no link: nothing will answer it, because `forward` made its tower first and it has since left); one that answered before it left shows `已回覆`, its answer, and `沒有塔台`. The line's `N` still counts every tower the instruction went to (it states what was sent; a tower that left never counts in `k`, and `N` does not shrink). A group whose newest activity is 24 h or more old folds into one `更早 (n)` row that unfolds to the same group rows. Unfolded rows stay unfolded while the snapshot redraws.
- **Order.** Newest group first.

## Tests

Server: grouping (new ask joins within 60 s, not after, not with other text), old file without `group`, the lapsed filter on the head's `bossWaits` (and a workspace tower's summary unchanged), the row `state` for answered / waiting / silent, the brief's lapsed line. GUI DOM: the head page's parts hide and show by the table; group rows, unfold, 更早, labels in both languages. `tests/phone-targets.test.ts`: every tappable part of the head page is at least 44 px.

## Demo

`?head=waiting` and `?head=answers` carry five broadcasts of four workspaces each (one without a tower), a lapsed wait and a fresh wait. Pictures: `~/.local/share/sbd-review/head-minimal/`.
