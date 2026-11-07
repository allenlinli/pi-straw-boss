# Straw Link: operating an unattended box from a controller

Status: decided, not built. Boss ruling 2026-11-07 (ask_user): all sixteen recommendations of section 12 taken, including the five places stricter than remote mode (decisions 5 to 9 and 12: no `!` lines, no `/boss` commands, no `hereOnly` choices, no answer panes, no opening of bases or mains and no closing of a base, shelf documents by name only), decision 2 (`box` scope only for the box's own units) and decision 15 (the relay's `live` class; R1 may ship alone, each relay deploy after a tower go). Todo #121. Base `main` 95df290 (0.61.0, untagged). Request relayed by 無人塔台規劃 (01a1a17a-c765) from the boss's ask_user answers. A boss addendum of 11/07 (via sb 主塔台實體化) sets the bar: 「基本上就和我們一般遠端模式完全一樣」. It follows [2026-11-05-link-shared-box.md](2026-11-05-link-shared-box.md) and [2026-11-07-link-remote-stop.md](2026-11-07-link-remote-stop.md). Section 12 lists the open decisions. Each one has options and a recommendation.

## 1. The request and the bar

The boss: 「無人塔臺不好控制的話不容易工作，包括終端機和對話內容」. The box is agent-tower-01: `herdr.service` and `straw-boss.service`, user units of `agent`. The controller is the boss's Mac.

1. **Live view and input** on the box's Herdr panes: the tower, and every main and worker. That covers the terminal screen and the conversation, typing, Escape and interrupt, and steering. **No arbitrary shell** (the boss rejected one).
2. **Who.** Team admins only, through a grant above `dispatch`. hq-signed grants stay dispatch-only. 「如果我同事建立他的團隊，也要能用」: the admin of any team the box serves, scoped to that team's units.
3. **History.** Live panes, and the pi session transcripts of finished runs on the box, readable from the controller.
4. **Acceptance bar (addendum).** The box's sessions behave in the controller's GUI exactly as local ones do under `/boss gui remote`:
   - the map: bases, tabs, the ⋯ menus, Dismiss;
   - the comms view: the full transcript and the input box;
   - queued messages, todos and monitors;
   - Zen items and waits.

   The box is shown as one more base, and it is reachable from the boss's paired phone through the Mac's GUI. The boss declined an interim `tailscale serve` of the box's own GUI, because it is a new inbound path on the box. The Link E2E channel is the only route.
5. **Constraints.**
   - E2E end to end: no plaintext at the relay, and no new relay-side content storage.
   - The box's root-owned `policy.json` decides who may operate.
   - Revoke, leave, or admin removal ends open operate streams at once.
   - Every attach and every input is logged in `link.log`: who, pane, when, and never the content.
   - A dispatch-only member sees nothing new.

**Design in one line.** A **remote base bridge**, not a bespoke viewer. The box's sb server runs its own GUI core for one operator session, under that operator's scope. The controller's sb server shows the result as bases of its own net. Page requests on those bases cross the link as sealed request and reply frames, and stream events cross back as sealed frames. The page itself barely changes (§8).

## 2. What the code has, and what it lacks

What the code has:

| Piece | Where | Reused for |
|---|---|---|
| The page's whole data surface: one SSE stream (`hello`, the net snapshot on every change, `problem`, `ping`, `view`, `mirror`, `history`, `cards`), the GETs `api/history` and `api/entry` (paged, `PAGE` 150, `limit` ≤ 300) and `api/image`, and the POSTs under `api/*` | `src/gui.ts:157-285`, `src/watch.ts`, `src/control.ts` | Everything that crosses. §6 lists it route by route. |
| The **remote** guards a paired device meets: `localOnlyText` (`BOSS_LOCAL`, `BOSS_LINK_LOCAL`); Escape-only while a `link_request` or a `/boss gui lan` face is open; a `hereOnly` choice, and a cancel of an all-hereOnly dialog, refused; a secret `value` refused from every page; `server`, `remote`, `lan` and most `link` routes refused | `src/control.ts:194-205`, `:239-248`, `:337-343`, `:390-399` | The box runs every operate request with `remote = true`. Operate adds more refusals (§7). Nothing is loosened. |
| The key pad: one key at a time, 8 a second per session, mirror freshness (3 s), the Enter probe and its confirms, Ctrl+Z never, Ctrl+D and a second Ctrl+C confirmed, typed text ≤ 64 characters, a paste ≤ 4,000 | `src/keys.ts` | The same function on the box. |
| The terminal mirror: polls `pane.read`, sends the rows that changed, at 250 ms while the screen moves and 1 s otherwise, with every row on attach, after a resize, and every 10 s. It sends `hidden` while a `secret_drop` is open, keeps SGR only, and allows at most 2 terminals per stream and 6 per server. | `src/mirror.ts` | The box's reader. The bridge paces its frames for the link (§5.4). |
| The session reader: an index in memory, items read by offset, previews capped at 2 KB | `src/history.ts`, `src/items.ts` | Live comms, and the transcripts of finished runs (§9). |
| Who started what: an ally run's record (`device`, `team`, `level`, the session file; the last 50 per workspace), the `opened` route rows (`device`, `team`, `pane`, `level`), the pane token `sb_opened_by=link:<device>` on a main's tab, and `dispatcherOf` | `src/server/towerrunstore.ts:14-25`, `src/server/allyroute.ts:22-60`, `src/server/dispatcher.ts` | The operate scope of a unit (§4). |
| Signed and sealed envelopes; X25519 key records in the roster; `seal` as the HKDF and ChaCha20-Poly1305 pattern | `src/link/envelope.ts`, `src/link/crypto.ts` | The session handshake (§5.2). |
| `caps` gating, with features expiring after 2 h | `src/link/holder.ts:163`, `:909` | `operate/1`. |
| The box's own GUI: guihost starts it whenever the sb server runs, on loopback | `src/server/guihost.ts:228` | The bridge calls it in process, not over HTTP (§6.1). |

What it lacks:

- **A carrier for interactive traffic.** The relay knows two classes of kind (`straw-relay/internal/store/store.go:342-400`):
  - **Queued** kinds are stored until acked, for up to 7 days. They post one at a time in `seq` order through the team's outbox, so a frame stream would block the box's notices and replies behind it, and each post writes the `seq` to disk.
  - **Ephemeral** kinds are also stored (in SQLite, `expires` = 7 days). The relay keeps the last one per `(team, sender, kind)`, so a later envelope **to another addressee replaces it**.

  Neither class meets "no new relay-side content storage" for screens and transcripts. Neither carries two operators' streams without them overwriting each other.
- **Rate.** The relay allows 600 envelopes a minute **per team** (`internal/server/server.go:56`). That budget is shared by every device of the team, and typing alone could spend it (§5.5).
- **Confidentiality from team members.** Every envelope is under the team key, and the Non-goals of the Straw Link spec say any member can read any message. A relay that hands a frame to a curious dispatch-only member would show it the box's screen. That breaks "a dispatch-only member sees nothing new".
- **A grant above `dispatch`.** The policy carries `unattended`, `trust` and `teams`. The grants sync accepts only `dispatch` (`agent-tower-grants-sync.py:278`) and only the levels `reply`, `forward` and `dispatch` in the base (`:65`, `:470`).
- **A team for every unit.** On the real box both teams bind the same project, `/srv/work` (moldplan-center `group_vars/agent_towers/core.yml:67-80`). A unit's team cannot come from the folder it works in (decision 3).
- **A list of finished runs.** The net shows sessions for 10 minutes after they end (`RECENT_MS`), and a tower's last runs while their files are known. No list reaches back further.

### 2.1 A gap found while designing (not part of operate)

`unit-status` is per controller: its `report` is the last `tower_send` text to that very controller (shared-box spec, row 10), and its `mains` follow the controller since the remote stop. It travels as an ephemeral kind, and the relay replaces the stored copy per `(sender, kind)`, whatever its `to` says. With two controllers, the box's pass posts A's status and then B's, and B's deletes A's. A stream that reads at once still gets A's (`hub.notify`), but a controller that reconnects only gets the status addressed to the last controller of the pass. So on a box with several controllers, all but one see "no status lately" after a reconnect until a pass happens to end with them.

**Fix:** the relay keys ephemeral replacement by `(sender, kind, to)`. It is task R1 of §11, and it can ship on its own before operate.

## 3. Who may operate (the grant and the check)

### 3.1 The policy grant

A new **root-owned** policy field. Section 13 gives the exact shape, and decision 1 weighs it against a new trust level:

```json
"operate": { "<device id>": "team" | "box" }
```

- **`team`.** The device may operate the units of every team it is a **roster admin** of, and nothing else.
- **`box`.** The same, plus the box's own units, which no team owns: the box's tower service and its local runs, a session someone opened at the box itself, and a worker in a tab of its own (§4). This is the box owner's grant: the boss's Mac.
- **Prerequisites.** The device is also at `dispatch` in `trust`. A device listed in `operate` but not at `dispatch` is not granted.
- **Validation.** A malformed `operate` turns operate off for the whole box, logged once as `policy-operate-refused`, and leaves the rest of the policy in force. The rest still refuses as today. This fails closed for the new power without taking down dispatch.
- **Grants.** The hq grants document cannot carry `operate`: its format is closed (`DOC_KEYS`, `GRANT_KEYS`). The grants sync copies `operate` from the base policy unchanged (`build_policy` already does `dict(base)`). The base validation must still accept it and check its shape (§13).

### 3.2 The check, made at the box on every request

1. This device is unattended, and its policy reads as unattended now. A refused or unreadable policy ends every operate session (§5.6).
2. The sender is a current, attended member of the team the envelope came on.
3. The sender is at `dispatch` in `trust` now, and `operate` names it with `team` or `box`.
4. The unit the request names is in the session's scope (§4): the team the session was opened on, or the box part. For the team part, the sender is an admin of that team in the roster now (`holder.isAdmin`). An admin of team X has no reach into team Y's units (g346-F001).

A refusal answers with a reason word (`not-granted`, `not-admin`, `out-of-scope`, `local-only`, `policy`) and is logged (§10). The session itself is admitted at open by checks 1 to 3, and the scope (the open's team, box part) is computed then. Every request rechecks all four, against the roster and the policy at that moment.

## 4. Whose unit is it: the operate scope

A unit belongs to a team only through the box's own records of who started it. The real box has two teams on `/srv/work`, so the folder cannot decide (decision 3).

| Unit on the box | Owner | Read from |
|---|---|---|
| An ally run, live or finished | The run's `team` | The run record (`towerrunstore.ts`), keyed `ally-<run>`. A live ally pane is also matched by pane id, as in `dispatcherOf`. |
| A main an ally run opened | The `opened` route row's `team` | The row's `to` (session id), only when the pane token `sb_opened_by=link:<device>` names the row's device. Two witnesses, as in `refuseTarget`. A disagreement makes the main nobody's. |
| A member or subagent pane in the tab of such a main | That main's team | Its tab, as `dispatcherOf` reads it today |
| The box's tower service, its standing pane, its local and event runs | The box | Not a team's: the tower serves every team bound to the workspace |
| A worker in a tab of its own, a session opened at the box, anything else | The box | Not attributed (the residual of the shared-box spec, §2) |

- The scope of a session is the team its `open` came on, when the operator admins it and the policy names it, plus the box's own units when the session holds `box` and asked for them. An admin of two teams has two sessions, one per team (§5.6), each reaching its own team: a team's units and traffic ride only that team's session. A `box` grant's session covers the box's own units plus that one team, so a `box` operator that admins two teams holds two sessions that both show the box's units. The controller (task 6) dedupes a box-own unit that appears in two sessions by its key.
- The box filters its net down to that set before anything leaves it (§6.2).
- A unit seen once is written to the ledger with its owner (§9). A finished run keeps the owner it had when it ran, even after its route row or run record ages out.

**Residual.** The box's units run as one Unix account, and the pane token is Herdr state any process of that account can write. As in the shared-box spec, this decides whom the box shows a unit to over the link. It is no wall between two devs who both hold a shell on the box.

## 5. Transport

### 5.1 A third class of kind at the relay: `live`

- **Delivery.** The relay keeps a `live` envelope in memory only, and only long enough to write it to the addressee's streams that are open now. It never writes the envelope to SQLite. An addressee with no open stream does not get it (the post answers `delivered: 0`).
- **Stream event.** The SSE event is `live`, with **no `id:` line**, so it never moves `Last-Event-ID`. A resumed stream replays nothing live.
- **Per-stream buffer.** Each stream has a bounded queue: 64 envelopes or 4 MB. On overflow the relay drops the oldest entries and counts them. The next delivered envelope carries `dropped: n` in its event data, which the receiver uses as a resync hint.
- **Ordering.** Envelopes from one sender to one addressee are written in arrival order.
- **Checks.** The relay checks a `live` envelope as it checks an ephemeral one: signature, membership, the kind's rules, `seq` = 0, and `to` naming exactly one member that is not the sender. Its limits are its own (§5.5).
- **Relay logs.** Team, sender, addressee count, size and status, as now. Never bodies.

**The `operate` kind.** One new kind: `{ ephemeral: true, wholeTeam: false, sender: "any", live: true }`. `KindRule` gains `live` in both repositories, and in the `kinds` cases of `tests/link/vectors.json`. Both directions use it. The holder checks direction by the roster's `attended` flag: an attended sender may send only `open`, `frame` and `close` (a `req` is an inner message, §5.3, carried in a `frame`); an unattended sender only `accept`, `refuse`, `frame` and `close`. A wrong direction is dropped and logged. The receiver checks its own role as well: an `open` is for the unattended box and an `accept` or `refuse` for the attended controller, and the holder drops the others.

**On the receiver.** A live envelope is delivered now, so the holder drops one whose `ts` is older than 60 s (`stale-live`), one that names other than a single addressee (`operate-addressees`), and an `operate` that arrives as a stored `envelope` event (`live-on-stored-path`, dropped unopened). The post side fails closed too: an answer without `delivered` means the relay stored the envelope, and `sendLive` stops posting for an hour (`operate-relay-not-live`). The envelope checks are those of an ephemeral kind, including "`ts` newer than the last one from `from` for this kind". So the sender keeps a strictly rising `ts` for `operate`, at least +1 ms per envelope, like `unitTs`. Nothing is acknowledged.

**Why not reuse what is there.**
- Queued envelopes are stored for 7 days and block the outbox.
- Ephemeral envelopes are stored for 7 days and replaced per sender, which overwrites one operator's frames with another's (§2.1).

Both break the constraint. Decision 15 records the choice.

### 5.2 The session: a key only the two ends hold

Outer plaintext of `operate`, a canonical structure: `v` (1), `session` (16 random bytes), `type`, `body`.

| `type` | Sender | `body` |
|---|---|---|
| `open` | Controller | `eph` (X25519 public key, 32 bytes), `caps` (list), `want` (`team` or `box`) |
| `accept` | Box | `eph` (32 bytes), `scope` (the team ids admitted, and whether the box part is in), `limits` (mirrors, watches, budget) |
| `refuse` | Box | A reason word |
| `frame` | Either | `ctr` (8-byte integer), `ct` (AEAD ciphertext) |
| `close` | Either | A reason word |

- **Keys.** `k = HKDF-SHA256(X25519(ephOp, ephBox), salt = empty, info = "straw-link/operate/1" ‖ team ‖ session ‖ operator device id ‖ box device id ‖ ephOp ‖ ephBox)`, 64 bytes. The first 32 key operator → box; the last 32 key box → operator.
- **Frames.** ChaCha20-Poly1305. The nonce is a 4-byte direction tag followed by the 8-byte `ctr`. The AAD is `session ‖ ctr`. `ctr` starts at 1 and rises by 1, and a receiver drops any `ctr` not above the last one it took.
- **Binding.** `open` and `accept` are signed envelopes, so each ephemeral key is bound to a device. `accept` also carries `sha256(open body)`, so the box's signature covers the operator's key too. The relay cannot sit in the middle. A team member who holds the team key reads only the outer layer: a session id and two public keys.
- **Forward secrecy.** The ephemeral private keys never leave memory and are dropped at close, so neither a later team-key leak nor a device-key leak opens a recorded session.
- **Replay.** A replayed `open` within the freshness window (`ts` no older than 60 s) yields a session whose key needs the operator's ephemeral private key, which the relay does not have. The box refuses a session id it has seen, and holds at most 2 open sessions per operator device per team and 6 in all, so a replay costs at most one refused slot.
- **Rekey.** A session lasts at most 12 hours. The controller then opens a new one, and the page sees nothing of it but one fresh snapshot.

Vectors: the key derivation, a frame's AEAD with the nonce and AAD layout, and the outer structure cases, in `tests/link/vectors.json` (`operateCases`). The relay replays only the structure cases.

### 5.3 Inner messages

The inner messages are JSON compressed with `deflateRaw` (Node's built-in zlib; still no runtime dependency) and sealed in `frame`.

| `t` | Direction | Fields | Meaning |
|---|---|---|---|
| `snap` | Box → operator | `net` (the sliced net, §6.2) | On change, at most one per 2 s, and one at once after `accept` |
| `watch` | Operator → box | `id`, `target` (a box key, or `w:<ws>`), `on` | Start or stop the box's `watchSession` or `watchWorkspace` |
| `ev` | Box → operator | `id` (a watch id, or `m:<key>` for a mirror), `e` (the event name), `d` | A stream event the page knows (`history`, `cards`, `mirror`) |
| `req` | Operator → box | `id`, `m` (GET or POST), `parts`, `q`, `body` (JSON, or the bytes of an upload as base64) | One page request on a box unit (§6.3) |
| `rep` | Box → operator | `id`, `status`, `body` | Its answer |
| `part` | Either | `of` (the message id), `i`, `n`, `bytes` | A message over 160 KB, in parts. Reassembly caps: 4 MB per message and 8 MB per session; a part missing after 10 s drops the message. |
| `ping` | Either | — | Every 15 s. No frame for 45 s ends the session on either side. |

### 5.4 Pacing on the box

- **The mirror.** The box's reader polls as it does locally. The bridge sends **whole visible screens**, never row diffs, at most 2 a second while the screen changes. When the screen is calm it sends an empty "current" frame every 2 s, so the controller's 3 s freshness holds through a slow link. A dropped frame then costs nothing: the next one is whole. A whole 120 × 40 screen with SGR compresses to a few KB.
- **Snapshots** are whole and deflated, at most one per 2 s.
- **History.** The first page (150 items with 2 KB previews, ≤ 300 KB raw) goes in parts. Appends are small.
- **The send budget.** One budget per box covers all operate sessions (§5.5). When it runs short the box stretches the mirror cadence first, to 1 s and then 2 s, then the snapshot cadence. It never drops a `rep`, `accept`, `refuse` or `close`, which queue ahead of everything.

### 5.5 Budget: bandwidth, rate and latency against the relay's limits

Peak per operator session (one page with the map, one comms view and one terminal):

| Stream | Envelopes/min | Bytes/min (deflated, before base64) |
|---|---|---|
| Snapshot on change | ≤ 30 | ≤ 450 KB (5 to 15 KB each) |
| Mirror, screen moving | ≤ 120 | ≤ 720 KB (≈ 6 KB each) |
| History appends | ≈ 10 | ≈ 20 KB |
| Pings, both ways | 8 | ≈ 3 KB |
| Typing: requests + replies, the controller coalescing typed text into ≤ 64-character runs and capping the pad at 4 requests/s per session | ≤ 480 while typing hard | ≈ 100 KB |
| **Peak total** | **≈ 650** | **≈ 1.3 MB** |
| First page of a comms view | 2 to 4 parts once | ≤ 300 KB raw, ≈ 80 KB deflated |

- **The relay's limits.** Today's 600 envelopes a minute is **per team**, shared with all queued traffic. A single operator typing hard at the box would push the team into 429s. The relay therefore gives `live` its own limiter (decision 15):
  - 1,200 envelopes and 8 MB a minute per `(team, sender)`;
  - 3,000 envelopes a minute per team;
  - the queued 600 a minute untouched.

  A `live` over its limit is refused with 429 and **not retried**. The box's own budget stays below it: 900 a minute across its sessions.
- **The envelope cap.** 256 KB stays. Parts are ≤ 160 KB, under that cap with room for the envelope.
- **Storage.** Nothing is added. `live` is never stored, so the team's 50 MB cap is untouched.
- **Latency.** These are estimates, measured in the live check (§11, task 10):
  - keystroke to echo: controller → relay → box, then the Herdr write, the next mirror read (≤ 250 ms), and box → relay → controller. About 0.6 s at p50, at most 1.5 s at p95 is the acceptance line.
  - snapshot staleness: at most 2 s, plus one relay hop.
  - a request's answer: one round trip, about 0.3 s. The controller gives up after 20 s with 504 "the box did not answer; check before sending again", as for a Herdr timeout.

### 5.6 Lifecycle and teardown

- **Open.** The controller's sb server holds one operate session per `(box, team)` while **any** GUI page stream is connected and the box's fresh `caps` list `operate/1`. That covers the Mac's page and every paired phone (decision 13). It closes the session 60 s after the last page stream leaves.
- **Refusals.** A `refuse` is remembered for 10 minutes for that box and team. The page then shows nothing new, which is what a dispatch-only member sees.
- **Reachability.** No frame for 45 s marks the remote bases `unreachable` (the page greys them, as a stale ally card) and reopens the session.
- **The box ends a session at once:** it sends `close` with a reason, stops the session's watches and mirrors, and drops its keys. It does so on:
  - **a roster change**, checked in `onRoster` right after `takeEntries`: the operator removed, no longer an admin of a team in the scope (that team leaves the scope; the session closes when the scope is empty), or the box removed;
  - **a policy change**, from `fs.watch` on `/etc/straw-link/policy.json` and its folder plus a 2 s poll of its stat (inode, size, mtime), re-read on any change: the operator gone from `operate`, below `dispatch`, or a policy that reads as refused or unattended no more;
  - **any request whose recheck (§3.2) fails.** The request is refused, and the session closes when the failure is the grant, not the unit.

  Unlike the revoker's two-look rule (shared-box spec, row 14), **one** bad read ends operate. Ending a view loses no work, and a session that outlives its grant is the one failure that must not happen.
- **On the controller.** The holder stopping a team (removal, fork, leave, a team dropped from the config) closes its sessions locally at once.
- **"At once"** means within the next 2 s poll for a policy edit, and when the roster event arrives for a removal or a role change.

## 6. The bridge

### 6.1 Box side: an in-process operate entry to its own GUI

`startGui` gains a transport-free entry, `gui.operate`. The bridge never calls the box's HTTP listeners, so no token, cookie or CSRF is involved, and nothing new listens on the box.

- `snapshot(scope)`: the net, sliced (§6.2).
- `watch(target, send)`: the same `watchSession` and `watchWorkspace`, with `send` going to the session.
- `mirror(key, on, send)`: `mirrors.toggle` on a synthetic stream id per operate session (`mirrors.open`), so the limit of 2 terminals per stream applies to the session and the 6 per server to the box.
- `request(method, parts, query, body, scope)`: the same routing as an HTTP request, after the operate refusals of §7. It runs `control` with `remote = true`, and the `api` GETs (`history`, `entry`, `image`).

The refactor is to split `handle` in `control.ts` so that its body takes `(parts, json, flags)`, while the HTTP shell keeps the origin, content-type, CSRF and body checks. One routing path then serves both, and a fix to a guard reaches operate without a second copy.

### 6.2 What the box shows: the sliced net

`sliceNet(net, scope)` keeps only units in scope (§4). A base whose tower is the box's own and not in scope keeps its in-scope tabs and units, with `tower: null`. It drops:

- `link`: the box's own allies, alerts, confirms and units;
- `stashed`;
- `trust`;
- `head`: the box's head tower is box-wide;
- `events` of units out of scope;
- every Shelf document's capability (`cap`). Decision 12: names only: the cards keep `display`, `kind`, `reason`, `revision`, `onScreen` and `docsCut`, and nothing serves a document. Task 6 validates the lengths of `display` and `reason`.
- Also (review round): a base's mark is recomputed from what is left; a team scope sees its own live ally runs on a stub tower that holds nothing else of the tower.

Operate input rules added by the review round (OR-F001 to F003): the composer's text goes only into an empty editor (any draft refuses it, `draft`); Enter on any `/` draft is refused (`command`, since the command menu's completion may turn `/b` into `/boss`); pad chords come from an explicit editor-only list (`OPERATE_COMBOS`: cursor and word moves, kills, yank, one Ctrl+C, Alt+Enter probed), so Ctrl+G and every other pi app action is refused (`chord`); a second Ctrl+C or Escape within a second is refused (`leaves-editor`); keys go only while pi is the pane's foreground program. Watches and mirrors keep their scope and end when their unit leaves it (`rescope`, and after each reading). Entry and image replies over 1 MB are bounded on the box.

Session files and paths never leave (they are not in the snapshot today either).

### 6.3 Routes: what crosses, what stays local on the box

The box's routes, by the scope's units only. **Crosses** means the page action on a box unit works as on a local unit under remote mode.

| Route or event | Operate | Note |
|---|---|---|
| Stream: the net snapshot | Crosses as `snap` | Sliced |
| Stream: `history`, `cards` (watch a session or workspace) | Crosses as `ev` | |
| Stream: `mirror` frames, `POST sessions/<k>/mirror` | Crosses | Paced (§5.4) |
| Stream: `hello`, `ping`, `view`, `problem` | Stay local | The controller's own server makes these for its pages |
| `GET api/history`, `api/entry`, `api/image` | Cross | |
| `POST sessions/<k>/input` (Send, follow-up) | Crosses | Plus the refusals of §7 |
| `POST sessions/<k>/keys` (the pad, typed text, paste, chords, Stop) | Crosses | Plus §7 |
| `POST sessions/<k>/answer` | Crosses | `hereOnly` refused as for a paired device; `value` refused (decision 7) |
| `POST sessions/<k>/dequeue` (Edit) | Crosses | |
| `POST sessions/<k>/commands` (slash completion) | Crosses | A read |
| `POST sessions/<k>/upload` | Crosses, capped at 2 MB (decision 11) | |
| `POST sessions/<k>/focus` | Refused | It brings a pane forward on a screen nobody looks at |
| `POST dismiss {key}`, `close/unit`, `close/tab` | Cross | For a tab, every unit in it must be in scope |
| `POST close/base`, `close/stash` | Refused | A base holds the box's tower and other teams' units (decision 9) |
| `POST open/*`, `dirs` | Refused | Decision 9; work still reaches the box by dispatch |
| `POST tower/<ws>/memory`, `leave`, `new`, `retry`, `deliver`, `drop` | Cross with `box` scope only | The tower is the box's (§4) |
| `POST panes/<grant>/*` (a pane an answer opened) | Refused | Such a pane runs a shell (decision 8) |
| `POST trust/answer` | Refused | Project trust on the box is its infra's (`trust.json`) |
| `POST link/*` | Refused | The box's own team settings |
| `POST server/*`, `remote/*`, `lan/*`, `head/*` | Refused | Box-wide, or this-computer-only already |
| `doc/*` | Refused | Decision 12 |
| `GET api/music` | Stays local | The controller plays its own |
| New: `GET api/transcripts` | Box only, operate only | §9 |

### 6.4 Controller side: remote bases

- **Merging.** The controller's net reading merges each live session's `snap` into `bases`, one base per box workspace in scope. Each base carries a `box` field: `{ device, short, label, team, scope, can, state: "live" | "unreachable" | "ended", why? }`. `can` lists the page actions §6.3 lets through, so the page hides the ⋯ entries it may not use.
- **Keys and ids.** The controller rewrites every key and base id to `x<16 hex of sha256(box ‖ team ‖ box key)>` and keeps a table back to the box's key. The page's routes stay plain and URL-safe (a subagent key on the box can hold a slash and free text), and no box key reaches a URL.
- **Routing.** `control.ts` asks `bridge.owns(key)` first: for a session key, a `close/*` or `dismiss` body key, a `tower/<ws>` id, an `api` GET key, and the `events?watch=` target. An owned key goes to the bridge, which sends `req` or `watch` and maps the `rep` back.
  - Controller-side guards still run first for a paired phone: `localOnlyText` and the rest. The box runs them again, so a phone through the Mac meets them twice.
  - The pad's freshness precondition is checked against the forwarded frames on the page's own stream, within 5 s for a remote mirror.
  - Several pages on the controller share one box watch or mirror for a key, fanned out locally.
- **Untrusted box data.** A malicious or compromised box sends this data, so the controller's bridge validates it against a strict schema before any page sees it:
  - known fields only;
  - lengths and character sets as the box's own net produces them;
  - marks and roles from their enums;
  - images only as `image/png|jpeg|gif|webp` data URLs under 1 MB;
  - `then` in an answer's reply limited to `terminal` and `run` (never `pane`);
  - a reply's `status` a number in 200 to 599 and its body under 1 MB.

  Anything else is dropped and counted (`operate-bad-frame` in the controller's link.log). Item text is already rendered as untrusted model text by the page (markdown.ts), and stays that way.
- **One card per dialog.** A box dialog then reaches the controller twice: as the forwarded card (`dialog-open`), and as the remote unit's `pending`. While a remote base for that box is live, the forwarded card of the same `(device, dialog id)` is not shown. The remote unit's own pending is shown and answered through operate. The box takes the first answer either way.

## 7. Input safety

Every operate request runs as a paired device's would (`remote = true`), with all its guards. On top of that the box refuses, and it decides this from its own state, never from the request:

1. **Shell lines** (decision 5): an `input` whose text starts with `!` (after leading blanks), and an Enter whose editor probe reports a `!` line. The probe gains a `shell` flag beside its `command` class; an older bridge cannot be on the box, which runs one build.
2. **`/boss` commands** (decision 6): any `input` text matching `^\s*/boss(\s|$)`, and an Enter whose probe reads such a line. `/boss send` and `/boss open` on the box can reach another team's sessions, and the box's own settings.
3. **Bare panes, spawning, base close, trust, link, server, head and documents**, as the table of §6.3 says.
4. **`hereOnly`** stays unanswerable by operate (decision 7). The box's "here" is a person at its own console. A deny, where some choice is not hereOnly, may be given.
5. **A secret** is never typed or read: `value` is refused, and the mirror stays `hidden` while `secret_drop` is open, as today.

6. **Which key is which, and who holds the terminal** (re-review of task 4, RR-F001 to RR-F005). A user's `keybindings.json` can put any app action on a key the pad sends (a chord, Tab, an arrow), and Herdr keeps labelling the pane `pi` while an external editor that pi started runs below it. So before every operate key write:
   - (a) the key's effective binding in the box's running pi must be confirmed an editor action. The session's bridge, inside pi, reads pi's live keybinding manager (`src/bindings.ts`) and reports with every flagged probe, as pi itself decides it, by the bytes the pad sends (`manager.matches(bytes, id)`, so `esc`, `escape` and `ctrl+[`, or `enter`, `return` and `ctrl+m`, are one key): `keys`, the pad keys (as Herdr names them) that any action outside a short allow-list holds (`tui.editor.*`, `tui.input.*` apart from submit, `tui.select.*`, `tui.altScreen.*`, Shift+Tab's thinking cycle, the tree, model and session-picker dialogs' keys); `holds`, the pad keys that hold each of submit, follow-up, clear and interrupt; and `raw` (see (b)). The box refuses a key in `keys` (`why: "binding"`). Submit and follow-up are local only on Enter and Alt+Enter, which are probed for the draft, clear only on Ctrl+C and interrupt only on Escape, whose double presses are counted; on any other pad key they are refused (`why: "binding"`), since there nothing guards them. A key id in `keybindings.json` that pi does not define (an extension's shortcut, such as `mcp.panel.open`) is taken as foreign, so its keys are in `keys`. A probe with no report (an older bridge, a pi whose app actions the manager does not hold, no answer, a report with a part missing) refuses every key (`why: "binding-unread"`). The check runs for every key, Escape and Stop included, and for Enter and Alt+Enter on the same probe as the draft's check.
   - (b) pi must hold the pane's terminal. Two looks, neither enough alone. `raw`: pi's own `process.stdin.isRaw`, which pi-tui's `stop()` clears before it hands the terminal to `$EDITOR` or suspends on Ctrl+Z; the box refuses every write whose probe does not say `raw: true` (`why: "terminal"`), typed text, paste, composer input and dequeue included (each probes for it). And `pane.process_info` must list exactly one `pi` (`why: "foreground"`); other programs beside it are no reason to refuse, since pi's helper children (claude-bridge's `claude`, stdio MCP servers, build tools) share its process group and a stock session has some. The process list is looked at inside the control job, right before each write, so one that arrives during the editor probe is seen. A Windows pane, whose list shows the shell alone, has no `pi` in it and refuses, as the spec's Windows non-goal already said.
   - Escape: under operate a second Escape within 1 s of the last is refused whatever Herdr's `agent_status` says (the status lags an abort), and `confirmed: "double-esc"` is never honoured: one Escape goes at most.
   - A watch or mirror begun while `rescope()` narrows the scope ends with the narrower scope: the session counts its rescopes, and an entry that was being set up re-reads the latest one after its wait (a mirror already attached is detached again).

Everything else in pi stays reachable. Typing into a main is driving a pi session at full rights, so an operator can still ask the model to run anything its hooks and the box's sandbox allow. That is no more than `dispatch` gives today. What operate adds is the view (screens and transcripts) and steering without a model run in between. §10 records this as the residual.

## 8. The controller's page

- **Placement.** A remote base shows on the map like a local base, with a device badge ("agent-tower-01") and the team's name. In Standard and Geek it sits after the local bases and before the ally cards. The ally card of that box (`gui/allyunits.ts`) stays for a box with no live session, and is folded under the base when one is live.
- **What works on it.** The comms view, the composer, the terminal tile and card, the key pad, queued messages, todos, monitors and Dismiss are the same components fed by the merged net. The ⋯ menu hides what `box.can` does not list.
- **States.** `unreachable` greys the base with "last seen …". `ended` replaces it with one line naming the reason: 「操作權限已撤銷」, or 「這台機器不讓這部裝置操作」 for a refusal shown once. Strings go in the paraglide messages, in both languages.
- **History.** A fold, "Earlier runs (n)", under the remote base, filled from `api/transcripts`. A row opens the existing read-only comms view, as a tower's `localRuns` key does.
- **Zen.** The box's waits and questions are items like local ones, from the merged net. Nothing in Zen is specific to the box.
- **Phone.** Nothing new. The phone pairs with the Mac, and the Mac's bridge carries it.
- **Pi.** No operate viewer in pi (decision 14). `/boss link operate` lists the live sessions (box, team, scope, since, pages) and `/boss link operate off` ends them all on this computer. Both are slash commands only (D23), and neither is a tool.

## 9. History: transcripts of finished runs

- **The ledger.** The box's server keeps `link/operate-ledger.jsonl`, mode 600 and append-only. A unit attributed in a net reading writes one line the first time it is seen, and one when it ends:
  - `id` (16 hex of a hash of the session file path);
  - `team`, or `box`;
  - the dispatcher device;
  - role, scrubbed unit name and workspace label;
  - the session file path (the box keeps it; it never leaves);
  - `first`, `last`.

  It holds no content. It keeps 30 days and at most 2,000 rows, compacted at start.
- **Listing.** `GET api/transcripts?before=&limit≤50` (operate only) answers the rows in the session's scope, newest first, whose file still exists: `id`, name, role, workspace, dispatcher label, first, last, size.
- **Reading.** `api/history` and `api/entry` take `t<id>` keys. The box resolves the id in the ledger, never a path from the request, checks the scope again, and reads the file through `history.ts`: the same paging, `limit` ≤ 300, 2 KB previews, and the one-entry fetch at 1 MB.
- **Redaction** (decision 10): none beyond today's. A transcript holds what the unit saw, and pattern scrubbing would give a false sense of safety. The grant is admin-only and scoped for this reason. Images are kept as the reader gives them.

## 10. Audit and threat model

**`link.log` on the box.** These lines go in the holder's log through `store.log`, never with text, keys, choices, or file content:

| Event | Fields |
|---|---|
| `operate-open` | team, from, session, want, verdict (`accepted`, or the refusal word) |
| `operate-close` | team, from, session, by (`box` or `operator`), reason, seconds open |
| `operate-watch`, `operate-mirror` | session, from, unit (the box key), pane, on/off |
| `operate-input` | session, from, team, unit, pane, action (`input`, `keys`, `answer`, `dequeue`, `upload`, `close-unit`, `close-tab`, `dismiss`, `memory`, `tower`), class (`text`, `paste`, `pad`, `chord`, `enter`, `esc`, or none), status |
| `operate-read` | session, from, unit, what (`history`, `entry`, `image`, `transcripts`) |
| `operate-refused` | session, from, route, reason |

`link.log` rotates at 1 MiB with one old copy (`store.ts:651`). An hour of typing would push a week of audit out (decision 16).

**Threats.**

| Threat | What it gets | Held by |
|---|---|---|
| A compromised admin device with `operate` | Everything its scope's units show: screens, transcripts, dialogs; and their input | The admin-only grant from the root-owned policy, the scope, the audit, and instant removal from `operate` or the roster. Code execution is what `dispatch` already gives. Shell lines and `/boss` are refused, so the remaining path runs through pi and its hooks. |
| A dispatch-only member, alone or with the relay | The outer layer: session ids and ephemeral public keys | The frames are under a key only the two ends derive. `open` from a device not granted is refused before any data. |
| A malicious relay | Drops, delays, replays and reorders | The AEAD counter drops replays and reordering. Drops cost a resync (whole frames, whole snapshots). A replayed `open` cannot be driven. Nothing is stored to leak later. |
| A malicious box | Feeds the controller's page | Strict schema validation (§6.4). No documents. `then.pane` stripped. Replies capped. The box cannot make the controller send anything, since the controller only forwards its own pages' requests. |
| A stolen paired phone | Operate through the Mac | As for every remote-mode action: unpair on the Mac. The box refuses `/boss` and shell lines anyway. |
| A stale grant | A session after a revoke | Single-read teardown, the policy watch, and a recheck on every request (§5.6) |
| Two holders during a takeover | Duplicate sessions | Sessions live in the holder's memory. A new holder has none, and the controller reopens after 45 s of silence. |

**Residual** (documented, not guarded):
- the one Unix account (§4);
- a pi session driven at full rights can do what the box lets the agent user do (§7);
- typed text crosses the relay sealed but reaches the box's pane in clear, as a local typist's would.

## 11. Tasks

Every task is red first, and its anchor is `npm run check && npm test` plus its files through `npm run test:one`. Relay tasks use `go test ./...` in straw-relay. GUI key tests also run with a Linux `navigator.platform`, and the post-merge set includes `tests/imports.test.ts`.

| # | Task | Repository and files | Red tests | Depends on | Fresh review |
|---|---|---|---|---|---|
| R1 | Ephemeral replacement keyed by `(sender, kind, to)`: the §2.1 fix | straw-relay `internal/store/store.go`, `EventsAfter` | Two addressees both get their own last status after a reconnect | none | Yes, with R2 |
| 1 | Wire: `live` in `KindRule`, the `operate` kind and its outer structure, vectors (`kinds`, `operateCases`, key derivation, AEAD), the SSE `live` event in `sse.ts`, a `postLive` path in `relay.ts` and the holder (serial per team, rising `ts`), caps `operate/1` | `src/link/kinds.ts`, `sse.ts`, `relay.ts`, `holder.ts`, `tests/link/vectors.json` | `tests/link-operate-wire.test.ts` | none | Yes (shared contract) |
| R2 | The relay's `live` class: no storage, a bounded per-stream queue, `dropped`, no `id:`, its own limiter; the `operate` kind; testdata pointer to task 1's vectors | straw-relay `internal/link/kinds.go`, `internal/server/envelopes.go`, `events.go`, `server.go` | Live never in SQLite (row count 0); not delivered to non-addressees or an offline device; order kept; overflow counted; a resume replays no live; limiter separate from the 600/min | 1's vectors | Yes |
| 2 | The session core: open, accept, refuse, close, key derivation, counters, parts, deflate, pings and timeouts, as a pure module over a fake transport | new `src/link/operate.ts` | `tests/link-operate-session.test.ts` (fake clock): replay and reorder dropped, wrong direction, a part missing, 45 s silence, the rekey at 12 h, vectors | 1 | Yes (crypto) |
| 3 | The grant, scope and teardown on the box: `operate` in `policy.ts` (fails closed for operate only), the §4 scope resolver, the §3.2 check, the policy watch and roster hook | `src/link/policy.ts`, new `src/server/operatescope.ts`, `holder.ts` (`onRoster`) | `tests/link-operate-authority.test.ts` (every refusal word, admin of another team, both teams on one project), `tests/operate-scope.test.ts` (each row of §4, two witnesses disagreeing), `tests/operate-teardown.test.ts` (policy edit within 2 s, refused policy, admin demoted, removed member; one bad read ends) | 1 | Yes (authorization) |
| 4 | The box's GUI seam: `gui.operate`, the split of `control.ts` `handle`, `sliceNet`, the §7 refusals (the probe's `shell` flag), the §6.3 table as one routing table with its own test | `src/gui.ts`, `src/control.ts`, `src/keys.ts`, `src/probe.ts` and its bridge half, new `src/operateroutes.ts` | `tests/operate-routes.test.ts` (table: every route allowed or refused, with remote guards kept), `tests/operate-slice.test.ts`, `tests/operate-input.test.ts` (`!` typed, pasted then Enter, `/boss`, hereOnly, `value`) | 1 | Yes (input safety) |
| 5 | The box's bridge: holder sink, sessions, pacing and budget, link.log lines | new `src/server/operatebox.ts`, `towers.ts` wiring | `tests/server-operate-box.test.ts` (server world: sliced snapshot, mirror at ≤ 2/s with whole frames, budget stretches the mirror first, every input logged without text) | 2, 3, 4 | With 6 |
| 6 | The controller's bridge: sessions while pages are connected, merge and key rewrite, routing in `control.ts` and the GETs and watch, strict validation, dialog dedupe, `unreachable` and `ended` | new `src/server/operatehost.ts`, `src/gui.ts`, `src/control.ts`, `src/net.ts` | `tests/operate-controller.test.ts`, `tests/operate-sanitize.test.ts` (hostile payloads: unknown fields, a key with `/..`, a script in a label, `then.pane`, a huge image, a 2 MB reply) | 2, 4's snapshot shape | Yes (a malicious box) |
| 7 | The page: the remote base badge, `can`, the states, the "Earlier runs" fold, strings, demo states | `gui/*`, messages | Model tests for the base, `can` and states; `visual-tester` for Standard, Geek, Zen and the phone width | 6 | No (anchor + visual check) |
| 8 | Transcripts: the ledger, `api/transcripts`, `t<id>` keys | `src/server/operateledger.ts`, `src/watch.ts` | `tests/operate-transcripts.test.ts` (scope, a file gone, 30-day compaction, a path never taken from the request) | 3, 4 | With 4 |
| P | The policy on the box (owned by 無人塔台規劃) | moldplan-center `agent_tower` role: `policy.json.j2` (`operate` from a new `agent_tower_operate` variable), `agent-tower-grants-sync.py` (`load_base` validates `operate`; `build_policy` keeps it; the fail-closed fallback has none), `tests/infra/test_agent_tower_grants_sync.py` | A grant document never adds `operate`; a malformed base `operate` is refused; the fallback has no `operate` | Shape fixed by §13 | That repository's own review |
| 9 | Docs and release | `docs/how-it-works.md`, `docs/unattended-device.md` (§2 policy, §7, §8), the Message kinds table and Relay section of the Straw Link spec, row 10 of the shared-box spec; release a minor (0.62.0) | — | 1 to 8 | One fresh reviewer over the whole change-set before release (AGENTS.md: wire, authorization, security) |
| 10 | Live check on agent-tower-01 | After R1, R2 are redeployed (the boss's go: moldplan-center cloud), 0.62.0 is on the box, and P has landed | The acceptance list of §14; latency measured | all | — |

Order: R1 can land alone. Task 1 and R2 go together, with the vectors first in this repository. Tasks 2, 3 and 4 run in parallel worktrees from task 1's commit. Task 5 follows 2, 3 and 4. Task 6 follows 2 and the snapshot shape of 4. Tasks 7 and 8 follow. Each relay task needs a relay redeploy, and so the boss's go.

### 11.1 Notes carried from the task 1 review

**What straw-relay R2 must enforce** (the client assumes each point):

1. `operate` enters `Kinds` together with the live class, in one commit. The rule is `{Ephemeral: true, WholeTeam: false, Sender: any, Live: true}`; `KindRule` gains `Live`, and `TestEnvelopeShapeVectors` compares it with the vectors' `rule.live`. There is never a commit where `operate` is a plain stored ephemeral kind: such a relay stores sealed frames for 7 days and replaces one operator's frames with another's. Copy `tests/link/vectors.json` from the commit that merges task 1, and update the commit line in `testdata/README.md`. The receive case "an operate from alice is taken" then passes through `CheckEnvelope`.
2. Never stored: no `PutEnvelope` for `Live`. Test: the SQLite row count for kind `operate` is 0 during and after delivery, and it is not in `EventsAfter` or on a resume.
3. The post answer is `{id, delivered}` (201, `delivered` a non-negative integer, `id` 32 lowercase hex). The client refuses any other shape. No `duplicate` through the store.
4. The SSE event is `event: live` with no `id:` line. Its `data` is `{id` (hex32, equal to the header id), `from` (equal to the header from), `ephemeral: true`, `envelope` (base64url without padding), `dropped?}`. `dropped` is omitted or a non-negative safe integer, carried on the next delivered envelope after an overflow. The client turns anything else into a `malformed` event that it never acknowledges.
5. Exactly one addressee, a member and not the sender. A `to` with 0 or more than one id, or a non-member, is refused with 422. Today's `postEnvelope` silently drops non-member ids and fans out to the rest.
6. Its own limiter, decided after the decode. The 600/min team limiter runs before the decode today (`s.limiter.allow` precedes `DecodeEnvelope`), so peek the kind first or split the path: a live post must not spend the queued budget. Limits as §5.5: 1,200 envelopes and 8 MB per (team, sender) per minute, 3,000 per team per minute; 429 `rate-limited`, which the client does not retry.
7. The per-stream queue: 64 envelopes or 4 MB, drop oldest, count into `dropped`. Order per sender and addressee is kept; the client posts serially per team and assumes arrival order equals send order.
8. The same checks as an ephemeral kind (signature, membership, epoch, head, `seq` 0, `ts` window), with no store-based staleness or replacement for `Live`. The client's `ts` rises per (sender, kind) across all addressees.
9. An unknown kind on an old relay stays `422 unknown-kind`: the client backs off an hour on that code, and again on a new stream.
10. Logs: team, sender, addressee count, size, status; never a body.
11. Removing a member stops live delivery to it at once: its streams end, as today for queued kinds.

**For task 2 (the session core).**
- The session object owns its send counter. Nothing outside it calls `operateSeal` with a caller-chosen `ctr`: `operateSeal` is stateless, so a repeated `(key, dir, ctr)` is a ChaCha20-Poly1305 nonce reuse. It never resumes a counter across a reopen: a fresh `operateEphemeral()` per `open`, keys dropped at close (§5.6's reopen after 45 s).
- `operateKeys` throws a raw OpenSSL error for a low-order peer key (all-zero, 1, the order-8 points). The session catches it and refuses the `open` or `accept`; it never lets it reach the stream handler. (No call site exists in task 1, so no test is added there.)
- `accept.limits` are unbounded integers on the wire. Task 6 clamps them (a malicious box).

**Built in `src/link/operate.ts` (task 2).** The core owns no timer: the host calls `session.tick()` about once a second (`OPERATE_LIMITS.tickMs`), and a session reads a clock and writes to a `send` it is given. Where the spec left a number or a rule open, the core takes:
- **Ping:** one frame when nothing was sent for 15 s (any frame is a sign of life, so traffic is a ping's work). Silence is no frame that opens for 45 s, counted from the accept; a junk frame that does not open moves nothing. Either end then sends a best-effort `close` and ends (`silence`).
- **Open:** an `open` nobody answers within 20 s ends as `no-answer` (a late accept finds the box told by the `close`).
- **Rekey:** both ends end at 12 h by their own clock (`rekey`, a `close` word). The operator counts from its `open`, which always comes before the box's `accept`, and the box ends 60 s later (`rekeyGraceMs`), so the controller's own `rekey` comes first and the box sees its `close` as `peer-closed`; the host reopens at once. The base never greys.
- **Clocks:** a session and the registry read `now` through `steady`, which turns a step back into no time passed (a wall clock stepping back would else stop the pings for the length of the step, and hold a dead session for as long). A step forward still counts.
- **Parts:** a deflated message over 160 KB is cut in parts of at most 120 KB, each its own frame with contiguous counters. A message's 10 s runs from the last part that arrived. Caps: 4 MB per message (also the inflate limit of any frame), 8 MB and 16 messages in flight per session, at most 64 parts per message. A lying part (changed `n`, repeated or out-of-range `i`, a nested part) drops its message.
- **The counter:** a received `ctr` has to be above the last one that opened; gaps are fine and a reorder loses the late frame. Only an opened frame moves it.
- **The registry:** `OperateRegistry` is the box's book for §5.2's Replay rule (a seen session id, 2 per operator device per team, 6 per box). The host passes it to `OperateSession.accept`, which admits, sends the `refuse` with the registry's word when it says no, gives the slot back when the key derivation fails, and makes a session that releases its slot when it ends: the host calls neither `admit` nor `release`, so no failure path can leak a slot. An id is remembered while its session is open and for 120 s after the admit and after the release: the holder's 60 s freshness window plus 60 s of a fast sender clock (the stale-live check lets a `ts` up to 10 min ahead pass, so a replay of an old `open` is held off by the strictly rising `ts` of the live session, not by the 120 s alone). `refuseOpen` is the one-line `refuse`.
- **A failed send** goes to `onTransportError` and does not end the session; the host decides (the silence timer ends a dead link). A handler that throws is swallowed. `onEnd`, `onDrop` and `onInner` must not throw: the host's timer wraps `tick()` and the holder's sink catches `receive`.
- **Test seam:** the fixed ephemeral key and session id of the vectors go in under a symbol key (`TEST_ENTROPY`) of the `open` and `accept` options, not in the deps; a test scans `src/` so that only `operate.ts` names it.

**For task 5 (the box's bridge).**
- `live()` and `sendLive()` each call `loadTeam`: a synchronous file read and a full roster replay with signature checks, about 0.6 ms for an 8-entry log, on every frame in both directions, at about 10 to 20 envelopes per second per session. Cache the replayed roster per head.
- `liveChain` has no cap: a stalled relay holds each send for up to `timeoutMs` while a producer that does not await piles up tasks. Pass an `AbortSignal` or a 5 s deadline to `postLive` (a late live frame is worth nothing) and bound the pending sends by the §5.4 budget.
- The sink must not throw an error that carries content: `operate-sink-failed` logs `String(error)`, and §10 says no text in link.log.

### 11.2 Notes from task 3 (the grant, scope and teardown as built)

**Files.** `src/link/policy.ts` (`operate`, `operateRefused`, `operateIdle`, `createOperateNotes`, `policyStamp`, `watchPolicy`), `src/server/operatescope.ts` (`ownerOf`, `admitOperate`, `checkOperate`, `narrow`, `storeOwnerWorld`), `src/server/operateguard.ts` (`createOperateGuard`), `holder.ts` (`member`, the `onRoster` option), and `service.ts` (the once-only `policy-operate-refused` and `policy-operate-idle` lines).

- **Words and ends.** `admitOperate` and `checkOperate` give exactly the words of §3.2: `policy` (attended, refused, a malformed `operate`, or a team the policy does not name), `not-granted` (not an attended member of the team the session came on, no `operate` entry, below `dispatch`), `not-admin` (nothing to reach; a team that left the reach), `out-of-scope` (a unit of another team, a box unit without the box part, a key nobody owns), `local-only`. `local-only` is the route table's (task 4) to raise: the check takes `localOnly` and answers it last, so a unit out of reach learns nothing from it. A failure of the grant carries `ends` (`policy` or `roster`); a failure of the unit does not, unless the scope is empty then.
- **Scope.** At the open: the team the open came on when the device is an attended roster admin of it (one session per (box, team), §5.6; review OAR-F003 narrowed it from every team the device admins), and the box part only for a `box` grant that asked for it (`want: box`). A session whose grant is `box` needs no team. Afterwards the scope only narrows: `narrow` drops a team the device no longer admins and the box part once the grant is lowered, and a session with nothing left ends (`roster`, or `policy` when the lowered box part was all it had).
- **Owner.** `ownerOf` reads: an `ally-<run>` key by its run record (live or finished; a record without a team is the box's); a live ally pane by pane id; a main by the `opened` row and the tab's `sb_opened_by` token, which must name the row's device (the row may find the main by its session id or by the `pane` it kept); a member or subagent by its tab. Any disagreement, two panes of a tab naming two devices, a token that is no device id, a row with no team, or one witness alone: the box's. A key the registry does not know has no owner (`out-of-scope`).
- **Teardown.** `watchPolicy(onChange)` is `fs.watch` on the file and its folder plus a 2 s poll of `policyStamp` (inode, size, mtime, ctime, owner, group and mode of both, `gone:<code>` for a path that cannot be read); `onChange` runs on any event or changed stamp, and the guard rereads the policy once per sweep. `LinkHolder` calls `onRoster(team)` after the entries are stored (outside its lock), when a team stops (`kill`: the box removed, a fork; `leave`; a team dropped from the config by `refresh`), and for every team when the holder stops. `member(team, device)` answers `{ role, attended }` from the roster now, and nothing for a non-member, a team this holder does not run or has stopped, or a roster that cannot be read: one bad read ends. A hook that throws is logged by the error's name only (`operate-roster-hook-failed`).

**For task 5 (wiring).**
- Build the guard with `policy: () => readPolicy(policyDeps)`, `member: (t, d) => link.holder.member(t, d)`, `owner: (k) => ownerOf(storeOwnerWorld({...}), k)` (the registry's refs, Herdr's listing and the live ally panes at the moment of the request), and an `end` that sends the `close` (reason `policy` or `roster`), stops the session's watches and mirrors, and writes `operate-close` with `by: box`. The guard writes no `operate-*` line itself except `operate-policy-unreadable` and `operate-end-failed`.
- Start `watchPolicy(() => guard.onPolicy())` with the box's server and stop it with it; pass `onRoster: (team) => guard.onRoster(team)` in the holder's options. The holder is built before the guard needs to exist: hold the guard in a variable the closure reads.
- Every `check` rereads the policy and replays the roster (`member` is one `loadTeam` per team it asks about). At the rate of §5.5 that is cheap, but the roster replay is the cost that task 1's note about caching per head applies to as well.
- The caps of the box list `operate/1` only when the guard exists, as `operate` in the holder's options says.
- **Bind the request to the session (review OAR-F006).** `guard.check(id, { from, team, unit?, localOnly? })` takes the envelope's sender and team and answers `not-granted` (ending nothing) when they differ from the session's own. The session layer passes them from the verified envelope, never from the inner message, so a member who learned a session id cannot ride another device's grant.
- **The hook on every holder.** `createLinkService` builds a fresh `LinkHolder` on each gain (service.ts), and `onRoster` is not yet in `ServiceOptions`: add it there and pass it to every holder the service builds. `member` reads the current `link.holder` and answers nothing when there is none.
- **`end` never waits on `store.withLock`.** `onRoster` runs inside the holder's lock from `kill` (in `takeEntries`) and from `displaced` to `stop`; a queued `sendLive` is fine, a synchronous wait on the lock deadlocks.
- **Start order.** Start `watchPolicy` before the first `admit`: a change before that is caught only by the next request.
- **Duplicate ids.** `admit` throws on a session id already in use, and the id is remote-chosen: the session layer catches the throw and answers with a refusal.

### 11.3 Notes from the third review round of task 4 (RR3-F001 to F007)

- **Extension shortcuts need a pi API.** pi runs an extension's shortcut (`onExtensionShortcut`, the first line of the custom editor's `handleInput`) before every binding, and only refuses one on keys of its reserved list. Which keys the installed extensions take is known inside pi's extension runner (`getShortcuts(effectiveConfig)`), and no seam passes it on. Until pi core gives one, the bridge treats the ids of `keybindings.json` that pi does not define as foreign (`bindingReport`), which catches a shortcut a user binds there (pi-mcp-adapter does) and not one an extension hard-codes. The residual is listed with §10's. The request to pi: an API that lists the effective extension shortcuts.
- **A custom editor** (`setEditorComponent`, a vim mode, say) shares the manager but has modal keys of its own that nothing here sees; the same residual.
- **Watches.** A request for a watch id that is superseded while it is set up (a second one for the same id, one asked off, `stop()`) does not register (409 `superseded`), so no watch lives outside the map `enforce` and `stop` walk.
""
## 12. Open decisions

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | The form of the grant | (a) A separate root-owned field `operate: { device: "team" \| "box" }`, with `dispatch` in `trust` as a prerequisite. (b) A new level `operate` in `trust`, above `dispatch`. | **(a).** The 16 places in `src/` that name the literal `"dispatch"` stay as they are, and a grants document cannot carry it. With (b), each of those places changes, and so do the sync's `BASE_LEVELS` and the meaning of `true`. Missing one site would silently strip an operator of dispatch. |
| 2 | The box's own units (tower, local runs, sessions opened at the box, unattributed workers) | (a) The `box` value only (the box owner). (b) Every admin of every team. (c) Nobody. | **(a).** The tower serves both teams on `/srv/work`. An admin of one team should not steer what the other team's runs feed. The boss is the box owner. |
| 3 | What makes a unit a team's | (a) The records of who started it (§4). (b) The workspace's project. | **(a).** (b) cannot work on agent-tower-01: both teams bind `/srv/work`, so every unit would be shared or nobody's. |
| 4 | A worker in a tab of its own | (a) The box's (only `box` sees it). (b) Its main's team, through pi-herdr-agents' parent record. | **(a) now.** The parent record is the child's own claim. Revisit once the placement of workers on the Linux box is confirmed (unattended-device.md §5 already flags it). |
| 5 | `!` shell lines | (a) Refused from operate. (b) Allowed with the `command` confirm, as for a paired device. | **(a).** It is the direct route to "an arbitrary shell", which the boss rejected. This is the one place operate is stricter than remote mode. |
| 6 | `/boss` commands typed through operate | (a) All refused. (b) Only the paired device's `localOnlyText` list. | **(a).** `/boss send` and `/boss open` on the box reach other teams' sessions. |
| 7 | `hereOnly` choices on the box | (a) Never through operate. (b) Answerable by `box` scope. | **(a).** The box's here is its console. The approvals it guards change who commands the box. |
| 8 | Panes an answer opened (`panes/*`) | (a) Refused. (b) As remote mode. | **(a).** They run a shell. |
| 9 | Spawning and closing bases | (a) Refuse `open/*`, `dirs`, `close/base`, `close/stash`; allow `close/unit`, `close/tab` (all in scope) and `dismiss`. (b) Full remote-mode parity. | **(a).** A new main opened this way would have no route row, so it would belong to no team. A base holds the box's tower. Work still reaches the box by dispatch. |
| 10 | Transcripts' secrets | (a) No redaction beyond today (secret_drop hidden, `value` never). (b) Pattern scrubbing. | **(a).** Scrubbing is unreliable. The grant is admin-only for this reason. |
| 11 | Uploads (a pasted image into a box composer) | (a) Allowed, capped at 2 MB. (b) Refused in v1. | **(a).** It is part of the composer the boss uses. The cap keeps it within ~14 parts. |
| 12 | Shelf documents of box units | (a) Names only, never served. (b) Proxied. | **(a) for v1.** A box's HTML served from the controller's origin is the widest path for a hostile box into the page. |
| 13 | When a session opens | (a) Automatically while any page stream is connected. (b) Only when the boss opens the box's base. | **(a).** The bar is "one more base" on the map and in Zen, which needs the snapshot before anyone clicks. The cost is about 30 snapshots a minute at most while a page is open. |
| 14 | Pi's side (D23) | (a) `/boss link operate` status and `off` only. (b) A TUI viewer in pi. | **(a).** The addendum's bar is the GUI. A local kill switch in pi keeps the boss's control without a page. |
| 15 | The relay | (a) The `live` class, its own limiter, and R1. (b) The existing ephemeral class. | **(a).** (b) stores frames for 7 days and overwrites one operator's frames with another's. That is the constraint broken twice. (a) needs a relay release and a moldplan-center cloud redeploy, which needs the boss's go. |
| 16 | Audit retention | (a) Raise `link.log` rotation on an unattended box to 8 MiB × 4 copies. (b) A separate `operate.log`. (c) As is. | **(a).** The request names `link.log`. (c) loses a week of audit to an hour of typing. |

## 13. What the policy file needs

For 無人塔台規劃 (moldplan-center `agent_tower` role). This assumes decisions 1 and 2 take their recommendations.

```json
{
  "unattended": true,
  "trust": { "ibzkd5ijmtravej475kmrykvye": "dispatch", "<colleague's device>": "dispatch" },
  "teams": {
    "91347f343c0c58fcc29b39a5eb91cc9b": { "project": "/srv/work", "share": "status" },
    "f437518ed8510b36b0d7013e62c791c1": { "project": "/srv/work", "share": "status" }
  },
  "operate": { "ibzkd5ijmtravej475kmrykvye": "box", "<colleague's device>": "team" }
}
```

- **Shape.** `operate` is optional. It maps a 26-character device id to `"team"` or `"box"`, and nothing else.
- **Effect.** A device in `operate` must also be at `dispatch` in `trust`, or `operate` names it to no effect, logged once. The box grants `team` only for the teams the device is a roster admin of (§3).
- **Validation in pi-straw-boss.** An unknown value, a bad id, or a non-object turns operate off for the whole box (`policy-operate-refused`) and leaves the rest in force.
- **Ansible.** Write `operate` from a new inventory variable, `agent_tower_operate: { <device id>: team | box }`, default `{}`, into `policy.json.j2` as `{'unattended': true, 'trust': …, 'teams': …, 'operate': agent_tower_operate}`. Omit the key when the variable is empty.
- **The grants sync** (`agent-tower-grants-sync.py`):
  - `load_base` validates `operate` (ids, the two values, every id also in the base `trust` at `dispatch`), so the box's own check never meets a sync-written mismatch;
  - `build_policy` keeps it from the base as it is (it already copies the base with `dict(base)`);
  - a grants document can never add it (the format stays closed);
  - `EMPTY_POLICY`, the fail-closed fallback, has no `operate`.
- **A colleague's own team.** Add the team to `teams` and the colleague's device to `trust` at `dispatch` and to `operate` at `team`. The colleague, as that team's founder, is its admin. Nothing else is needed.
- **The box's device id** stays out of `operate` and `trust`, as the grants stage already asserts for `trust`.

## 14. Acceptance

**On the Mac's GUI**, and from the boss's paired phone through it, with the policy giving the Mac `box`:

1. agent-tower-01's workspaces are bases with their tabs, units, marks, queued messages, todos and monitors.
2. Zen shows its waits and questions.
3. A box main's comms view shows its whole transcript, and Send and follow-up reach it.
4. The terminal tile shows its live screen, and the pad's Escape interrupts it.
5. Dismiss and close of a unit work.
6. "Earlier runs" lists finished ally runs and opens their transcripts.
7. The echo latency is at most 1.5 s at p95.

**Refusals and limits:**

8. A device at `dispatch` without `operate` (or with `team` but not admin) sees no remote base for the box's other units. The box logs `operate-open` with `not-granted` or `out-of-scope`.
9. Removing the Mac from `operate` ends the base within 2 s ("ended: the operate grant was withdrawn"). The box logs `operate-close reason=policy`.
10. `!echo x`, `/boss send …`, a bare pane's keys, `open/main` and a `hereOnly` choice through operate are refused, each with a logged `operate-refused`.
11. The relay's SQLite has no row of kind `operate` during or after a session.
12. A marker string typed through operate is in no log on the box or the relay.
13. Two controllers each keep their own `unit-status` across a reconnect (R1).
