# The head's broadcast cards (2026-11-07, todo #124)

The boss, on the head tower's page: 「我看不懂主塔臺這邊的介面」. Three things made the broadcast rows unreadable. This record changes the **Asks** section of `2026-11-06-head-page-minimal.md` (the row, the state words, the order); the rest of that record stands.

1. The row was one truncated line that mixed the boss's own words (`「…」`), the head's English instruction, and the meta, so he could not tell what he had said from what was sent.
2. A tower that acted but answered the main that asked (not the head) showed `等回覆` for ever.
3. A correction of an order (H26 → H28 → H33) showed as an unrelated card.

## A card, in parts

A card's closed line is labelled parts, then one line of when and replies:

| Part | Label (en / zh-TW) | Source |
|---|---|---|
| What the boss said | You said / 你說 | `boss`: the boss's own words of the boss event the broadcast's `relay` names. Not shown when the server has none (an ask the head opened on its own, or one from before this record). Nothing is parsed out of the head's text. |
| What the head sent | Head sent / 主塔台送出 | the head's message: its first line with words in it. When it copies the boss's words exactly, that copy is shown as `…` (the words have their part); a paraphrase stays. |
| To whom | To / 送給 | the towers' labels |
| When, replies | `11m ago · 2/3 replied` / `11 分前・回覆 2/3` | as before; a tower that **handled** the order counts as a reply |

Each text part is clamped to two lines (the towers to one). Unfolding the card shows the whole boss text and the whole head message (both unclamped, scrolling past 14 em), then each tower: its label (a link when the net has the tower), its state, its newest answer, and, when the head's message to that tower differs from the first tower's, that message. Tap targets are 44 px (`summary`, `.ask-line`).

**Data.** `HeadAsk` (`asks.json`) gains `sent` (the message, at most 1,500 characters), `boss` (at most 1,500, on the first ask of a relayed broadcast only), `supersedes`, `read`, `acted`. The relay stays the server's check (`bossTaken`); `boss` is read from the queue by the event id the relay names (`HeadPort.boss`), never from what the model says. `HeadAskRow` carries `sent`, `boss` (first row of a group), `supersedes`. A file from before these fields still reads; its cards have no "You said" part and show the first line. The snapshot grows by at most 60 asks × 1,500 characters.

## A tower that acted is not waiting

What the head can see: the sb server runs the workspace towers, so it sees both the head's message arriving in a tower's queue and every tool call of the tower's run. Two facts are recorded on the ask (never moving its 24 hours):

- `read`: a run of the workspace's tower took the head's event (`run-taken`), the tower's own acknowledgement.
- `acted`: the tower's run called `tower_send` or `tower_reply` in a turn that event started (the `turn` the run's extension reports with every call, the same one the head's relay uses), whoever it sent to. An answer to the head is `tower_send {head: true}` and is `answered` as before.

Both count only for an event whose `from` is the head identity and whose header names `ask=H<n>` of that workspace; anyone else's header is its sender's own word. The row `state` is the best of: **answered** (an answer to the head; never otherwise) > **handled** (`acted`) > **received** (`read`) > **waiting** (open) > **silent** (24 h, closed, failed). Words: 已回覆 / 已處理 / 已收到 / 等回覆 / 沒回應. `handled` shows a muted line "answered someone else, not the head" / 「回給了別人，沒回報主塔台」, is green like answered, and counts in `k/N`; `received` is neutral and does not. `waiting` therefore only describes a tower that has not taken the message.

What the head still cannot see: a tower that took the message and did its work by tools that are not sends (no `tower_send` or `tower_reply` in the turn), and a main's report that goes straight to a main the tower opened. Those show `received` (neutral), then `silent` after 24 hours only for a tower that never took it.

## A correction replaces an order

The head records it; nothing is guessed from text. The head's `tower_send` has an optional `supersedes`: the id (`H12`) of any message of the earlier broadcast, set on every call of the correction (the tool description, the brief's tool line, and `prompts/head-run.md` say so). The server refuses an id that is not an ask of the file older than the new one (the tool's error, nothing sent). The row's `supersedes` is the replaced broadcast's group (the named id itself when the file no longer holds it; ignored when it is the ask's own group).

On the page the groups of one chain are one card: the newest on top says `replaces H24` / `取代 H24`, and under it a fold `Replaced orders (2)` / `被取代的舊指令（2）` holds the older cards, struck and saying `replaced by H27` / `已被 H27 取代`. A broadcast is folded once, under its newest correction (two corrections of one order: the newer folds it, the other keeps its own card and says what it replaced). A link that points forward, at itself, or at a group the snapshot does not hold folds nothing. A card's place (recent or `更早`) is its own activity's, not its folded orders'. Cards and folds the boss opened stay open across a redraw.

## Tests and demo

`tests/head-cards.test.ts` (kept text and boss words, `supersedes` validation, states, `read`/`acted` through the server including a forged header, the head's tool texts) and `tests/head-page.test.ts` (parts, `sentLine`, the states' words and counts, the chain model and DOM, the sheet). `?head=answers` and `?head=waiting` carry the chain of the boss's screenshot (an order, its correction, the correction of that; three towers that answered, handled, received, or wait). Pictures: `~/.local/share/sbd-review/head-log-cards/`.
