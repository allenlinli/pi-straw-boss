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
| What the head sent | Head sent / 主塔台送出 | the head's message: its first line with words in it. When it copies the boss's words exactly, the copy is left out (the words have their part) together with the one pair of quotation marks (`「」`, `『』`, `“”`, `""`, `''`, `‘’`) around it and the one full stop (`.` or `。`) right after the pair, so `Boss CORRECTION 2: 「…」. Remove the time limit.` reads `Boss CORRECTION 2: Remove the time limit.`; a copy with no quotation marks around it is marked `…`; when nothing else would be left the line is the whole message; a paraphrase stays. Only the characters next to the exact copy are looked at: the head's text is not parsed. |
| To whom | To / 送給 | the towers' labels |
| When, handled | `11m ago · 2/3 handled` / `11 分前・已處理 2/3` | k of N towers that answered the head or **handled** the order (an answer is a handling, so the count never says "replied" for what a tower only handled) |

Each text part is clamped to two lines (the towers to one). Unfolding the card shows the whole boss text and the whole head message (both unclamped, scrolling past 14 em), then each tower: its label (a link when the net has the tower), its state, its newest answer, and, when the head's message to that tower differs from the first tower's, that message. Tap targets are 44 px (`summary`, `.ask-line`). The label column is one length (`--ask-tag`, 62 px) for the tag's width and the when line's indent, so the line sits under the text, not under the label's edge.

**Data.** `HeadAsk` (`asks.json`) gains `sent` (the message, at most 1,500 characters), `boss` (at most 1,500, on the first ask of a relayed broadcast only), `supersedes`, `read`, `acted`. The relay stays the server's check (`bossTaken`); `boss` is read from the queue by the event id the relay names (`HeadPort.boss`), never from what the model says. `HeadAskRow` carries `sent`, `boss` (first row of a group), `supersedes`. A file from before these fields still reads; its cards have no "You said" part and show the first line. A new field with the wrong type in the file (`sent` or `boss` not text, `supersedes` not an `H<n>`, `read` or `acted` not a finite number) is dropped when the file is read, and the ask still draws.

**Payload.** Every page and every paired phone gets the whole net snapshot on every change, so the cards' texts are bounded. `headnet.ts` sends a tower's copy of the message only when it differs from the first tower's (the page reads an omitted one as the first's), and sends whole texts (`sent` and `boss`) for the newest broadcasts while their sum is at most `TEXTS` = 24,000 UTF-16 units; the first broadcast that does not fit, and every older one, go without them and their cards show the first line (as an ask from before this record does). Measured worst case (`tests/head-cards.test.ts`: 60 rows, every text 1,500 units, a 120-character first line and answer on each row): 190,659 bytes of JSON for the costliest text (escaped control characters, six bytes a unit), 124,483 for Chinese text, 93,283 for emoji. Without the budget the same rows took about 1.1 MB (60 × (1,500 + 1,500) units × up to six bytes). A typical card is under 1,000 units, so a day's cards fit whole.

## A tower that acted is not waiting

What the head can see: the sb server runs the workspace towers, so it sees both the head's message arriving in a tower's queue and every tool call of the tower's run. Two facts are recorded on the ask (never moving its 24 hours):

- `read`: a run of the workspace's tower took the head's event (`run-taken`), the tower's own acknowledgement.
- `acted`: the tower's run called `tower_send`, `tower_reply`, or `boss_open_main` (the usual way to hand an order to a main) in a turn that event started (the `turn` the run's extension reports with every call, the same one the head's relay uses), whoever it sent to. An answer to the head is `tower_send {head: true}`, `answered` as before. A `tower_reply` (or other send) whose target is the head itself is an answer too: it is recorded on the ask as the tower's words, `answered`, not "answered someone else"; for an ask that is no longer open it is `acted`.

Both count only for an event whose `from` is the head identity and whose header names `ask=H<n>` of that workspace; anyone else's header is its sender's own word. The row `state` is the best of: **answered** (an answer to the head, by `tower_send {head: true}` or a reply sent to it; never otherwise) > **handled** (`acted`) > **received** (`read`) > **waiting** (open) > **silent** (24 h, closed, failed). Words: 已回覆 / 已處理 / 已收到 / 等回覆 / 沒回應. `handled` shows a muted line "answered someone else, not the head" / 「回給了別人，沒回報主塔台」, is green like answered, and counts in `k/N` (named 「已處理 k/N」 / "k/N handled": an answer is a handling, so the count has one meaning for answered and handled); `received` is neutral and does not. `waiting` therefore only describes a tower that has not taken the message.

What the head still cannot see: a tower that took the message and did its work by tools that are not sends (no `tower_send`, `tower_reply`, or `boss_open_main` in the turn), and a main's report that goes straight to a main the tower opened. Those show `received` (neutral), then `silent` after 24 hours only for a tower that never took it.

## A correction replaces an order

The head records it; nothing is guessed from text. The head's `tower_send` has an optional `supersedes`: the id (`H12`) of any message of the earlier broadcast, set on every call of the correction (the tool description, the brief's tool line, and `prompts/head-run.md` say so). The server refuses an id that is not an ask of the file older than the new one (the tool's error, nothing sent, and no tower opened for it: the check comes before the tower is looked up). The row's `supersedes` is the replaced broadcast's group (the named id itself when the file no longer holds it; ignored when it is the ask's own group).

On the page the groups of one chain are one card: the newest on top says how many orders it corrects, `corrects 2 earlier` / `更正了前 2 則`, and under it a fold `Replaced orders (2)` / `被取代的舊指令（2）` holds the older cards, struck and saying `corrected by the next` / `已被下一則更正`. No card shows an `H` id as words (the boss has no way to tell which card an id is): the ids are the chain line's tooltip (the orders a card corrects, newest first; the one that corrected a folded card) and each card's `data-id`. A broadcast is folded once, under its newest correction (two corrections of one order: the newer folds it, the other keeps its own card and says what it replaced). A link that points forward, at itself, or at a group the snapshot does not hold folds nothing. A card's place (recent or `更早`) is its own activity's, not its folded orders'. Cards and folds the boss opened stay open across a redraw.

## Tests and demo

`tests/head-cards.test.ts` (kept text and boss words, `supersedes` validation before any tower is opened, the fields' types on read, states, `read`/`acted` and the calls that count through the server including a forged header and two boss events in one head run, the one copy of a message and the text budget with its measured worst case, the head's tool texts) and `tests/head-page.test.ts` (parts, `sentLine`, the states' words and counts, the chain model and DOM, the sheet). `?head=answers` and `?head=waiting` carry the chain of the boss's screenshot (an order, its correction, the correction of that; three towers that answered, handled, received, or wait). Pictures: `~/.local/share/sbd-review/head-log-cards/` (first round) and `r2/` (after the review: no ids, the cut line, handled counts, the aligned when line).
