# Straw Link: an admin's remote stop of one unit on a shared box (draft)

Status: built, shipped in 0.61.0. Boss ruling 2026-11-07: all eleven recommendations of section 7 taken, including decision 5 (`interrupt`), decision 10 (a paired device may stop) and the relay redeploy once its change is reviewed. Base `main` 45b23a2 (0.60.4). Todo #100. It follows section 3 of [2026-11-05-link-shared-box.md](2026-11-05-link-shared-box.md), which ends with "Not done: an admin's remote stop of one unit (`boss_close_main` for a controller, from an admin's page)", and `docs/unattended-device.md` §8 ("a main that never goes idle has to be closed at the box").

The rows under **Open decisions** record what the boss decided; each took the recommendation.

## 1. The request

A dev at `dispatch` on a shared unattended box (G3/G4) opens mains there through ally runs (`boss_open_main`). Today such a main ends only when the dev's ally run closes it after its done report, or when the dev loses `dispatch` or leaves the team (revoke.ts). The team's admin, looking at the box's card, cannot end one main: not a forgotten idle main, and not one stuck in a turn. The request is a stop of **one** such main, asked from the admin's computer, decided and carried out by the box, and told to the admins. Pi comes first and the GUI mirrors it (sb-backend D23), so the stop must be possible from pi, not only from a page.

What the code already has:

- **A graceful quit.** `closemain.ts` asks the main over `straw-boss/control`. The main itself refuses while a turn, a queue, a dialog, a monitor or a subagent runs (`src/closemain.ts:29-40`); the tower side refuses a main that is not idle before asking (`:80`).
- **A sweep that keeps asking until the main quits.** It counts "gone" only on two witnesses and tells the admins through the scoped notices (`src/server/revoke.ts:32-84`). The rows it reads are the server's own record of the mains ally runs opened (`ally-routes.json` kind `opened`: workspace, main session id, name, device, team, level, pane; `src/server/allyroute.ts:22-37`).
- **The scope of section 2.** A notice goes to the dispatcher and that team's admins (`src/link/scope.ts:9-14`, `UnitReporter.notify` `src/link/unitstatus.ts:65`).

What it lacks:

- **A way to name one main from another computer.** `unit-status` carries one row per *workspace* (`towers.status()` rows, `src/server/main.ts:576-593`), never a main or a session id.
- **A signed request** that the box acts on without a model reading it.

## 2. A gap found while designing (closed by the same change-set)

An ally run's `boss_close_main` has no device check. `allyTool` (`src/server/runtools.ts:128-160`) checks `tower_send`, `boss_open_main` and `tower_reply` against the run's own device (`refuseTarget`, `:80-86`). `boss_close_main` goes straight to `localTool` (`:277-280`), to the workspace identity's `closeMain`, and from there to the main's `judge`. `judge` asks only for *some* `sb_opened_by` and a request from the workspace's tower (`src/closemain.ts:35-36`). So on a shared box, dev A's ally run at `dispatch` can ask the box's tower, in plain text, to close dev B's main, or a main the box's own tower opened. Since G3 a box has several devs, which makes this a cross-dev trust gap. A model-mediated "remote stop" therefore exists today, with no authority check. Decision 7 closes it.

## 3. Wire

### 3.1 New kind `unit-stop`

| Field | Value |
|---|---|
| Rule (`src/link/kinds.ts:16-29`) | `{ ephemeral: false, wholeTeam: false, sender: "attended" }`: queued and addressed to one box |
| Plaintext | `stopId` (16 random bytes, 32 lowercase hex), `handle` (16 lowercase hex, below), `mode` (`quit`, or `interrupt` if decision 5 takes it; the box refuses any other value), `reason` (at most 200 bytes, one line, may be empty) |
| Decode | Strict, as every kind (`canon.ts`): 4 fields; ids are checked like `askIdOk` |

**Signing.** Signing needs nothing new: the envelope signature covers the header and the ciphertext (`straw-link/envelope/1`), and the receive checks (`src/link/holder.ts:504-529`) already enforce three things: `from` is a current member, the kind's sender rule (attended), and that `to` names this device.

**Replay and ordering.** A queued kind has the per-sender `seq` guard, so the relay cannot replay or reorder a stop. A holder takeover delivers again, and the guard drops the second copy. The `stopId` is for correlation and the log, not for safety. Because a stop acts on a state the requester saw, the box also refuses a stop whose header `ts` is older than 15 minutes when it is received (decision 6). The envelope's own bound is 7 days, which is far too long for this. The box notes the refusal as `unit-stop-stale`.

**Relay.** The relay keeps a kind table (`straw-relay/internal/link/kinds.go:18-31`) and refuses an unknown kind with `unknown-kind`. Adding `unit-stop` takes one line there, the same entry in `tests/link/vectors.json` (structure cases; the relay replays the copy in its `testdata`), and a relay redeploy (moldplan-center's cloud). The outbox treats `unknown-kind` as refused for good (`src/link/outbox.ts:27`), so a stop sent before the relay is upgraded fails at once with "the relay does not take stop requests yet". It never blocks the queue.

### 3.2 Naming a main: an optional second field of `unit-status`

`unit-status` grows from one top-level field (`units`) to two: `units` and `mains`. This follows the precedent of `tower`'s optional fifth field. The decoder takes 1 or 2 fields (`src/link/kinds.ts:177-183`).

`mains` is a list of at most 20 entries, empty for a team that does not share `status`, and read from the broker and Herdr once per pass for all rows. Each entry has:

- `handle`: the first 8 bytes of `sha256(box device id ‖ main session id)`, in hex. This is the construction of the board's wire id, so no session id leaves the box.
- `unit`: the workspace's scrubbed label, the `unit` of its row.
- `name`: `allyLabel`, at most 40 characters.
- `state`: the pane's `agent_status` (`idle`, `working`, `done`, or `unknown`).
- `by`: the dispatcher's device id.
- `stopping`: whether a stop is pending.

**A restart under the same name.** The handle comes from the session id, so a new main with an old name gets a new handle. A stop that names the old handle finds nothing and is refused as `unit-stop-gone`; it never stops the new main. A main Herdr resumes from its session file keeps its session id, so it is the same main, and stopping it is right.

**Who sees which main.** The box fills `mains` per controller, as it already fills `report` per controller (`UnitReporter.pass`, `src/link/unitstatus.ts:45-63`). The dispatcher sees the mains of its own device. An admin of the team sees every main of that team (decision 11). This changes row 10 of the shared-box spec, which had `unit-status` the same for every controller.

### 3.3 Compatibility through `caps`

`CAPS_FEATURES` (`src/link/holder.ts:141`) gains two features:

- `unit-stop`: the box takes the kind.
- `unit-status.mains`: the controller takes the second field.

They are used like this:

- **A controller without the feature.** The box sends a 2-field `unit-status` only to a controller whose fresh `caps` (2 h; `capsOf`, `:886`) lists `unit-status.mains`. Every other controller gets today's 1-field status, so old controllers see no change.
- **A box without the feature.** A controller sends `unit-stop` only to a box whose fresh `caps` list `unit-stop`. The page shows no Stop button for such a box, and the pi command names the build the box needs. An old box would drop the kind as `unknown-kind` without telling anyone, which is why the controller checks first.

### 3.4 Results: `notice`, no second new kind

The box answers through the existing `notice` (unattended → controller, which the relay already knows), with these kinds:

| Notice kind | When |
|---|---|
| `unit-stop-refused` | The stop is refused, with its reason word: `not-recipient`, `gone`, `stale`, `level`, `mode`, or `failed` (the box could not carry out its own checks, as when the pane cannot be read; added in the build, UW-F007) |
| `main-stop-pending` | Once, when the main refuses as busy |
| `main-stopped` | The main quit |
| `main-stop-manual` | The box cannot end it; close it by hand |

Their keys follow `runNotice` (`src/link/unitstatus.ts:84-93`), and the text names the requester's label and the reason. The requester's page and pi match their own pending stop by box device and handle against the next `unit-status`, where `stopping` is set or the main is gone. The notices are what a person reads. Nothing parses notice text.

## 4. Authority: who may stop, and how the box checks

The checks run in two places, in this order, and a refusal spends nothing.

**In the holder** (a `takeUnitStop` beside `takeDialogAnswer`, `src/link/holder.ts:1141-1149`), on the bytes received:

1. This device is unattended.
2. The sender is an attended member.
3. The sender is at `dispatch` in the policy now. A policy that is refused makes every level `reply` (`policy.ts`), so this fails closed.
4. The header `ts` is no older than 15 minutes.
5. `mode` is a value this build takes.

A refusal logs `drop` with `unit-stop-*` in `link.log` and sends `unit-stop-refused` to the sender. The request then goes to a server sink (`o.unitStop`), as an answer goes to `o.dialogAnswer`.

**In the server** (new `src/server/unitstop.ts`, wired in `towers.ts` next to the revoker `:1006-1012`):

1. The handle matches exactly one `opened` row among the live services' routes, and the row's `team` is the team the envelope came on. A row of another team does not match.
2. The sender is the row's `device` (the dispatcher), or an admin of the row's team in the roster now (`holder.isAdmin`, `:1052`). An admin of another team is refused, as in g346-F001.
3. The second witness agrees. If the main's pane token `sb_opened_by=link:<id>` names a device other than the row's, the stop is refused. This is the two-witness rule of `refuseTarget`.

Only mains in the route table can be stopped (decision 4): mains an ally run opened. A main the boss opened on the box, a main the box's own tower opened, and an ally run are out of reach. None of them is listed in `mains`, so none has a handle.

**Audit.**

- `link.log` gets `unit-stop-in` (team, from, stopId, handle, verdict) on receipt, then `unit-stop-pending` and `unit-stop-done` (stopId, workspace, main), never the reason text.
- Every outcome of an accepted stop is a notice in the scope `{ device: row.device, team: row.team }`, which reaches the dispatcher and that team's admins (`reaches`, `src/link/scope.ts:9-14`). The requester is always one of them.
- A refused attempt (`not-recipient`) is told to the requester's scope too, so the team's admins see that someone tried. The other server refusals have no row to scope by and go to the sender alone: `gone` (also for a handle of another team's row and for a pane token that names another device) and `failed`.
- `link.log` also gets `unit-stop-refused` (team, from, stopId, verdict), `unit-stop-noop` and `unit-stop-failed` from the box's server half, so who tried to stop what is kept in the same log as `unit-stop-in`.

**Residual, unchanged from section 2 of the shared-box spec.** The box's units share one Unix account, and the pane token is Herdr state any process of it can write. This change decides whom the box obeys over the link. It is no wall between two devs who both hold a shell on the box.

## 5. Semantics on the box

- **Accepting writes the stop down.** An accepted stop is written on the route row as `stop: { by, at, stopId, mode, reason? }`; the reason (one line, at most 200 bytes) stays in the route file, which is not `link.log`. The row's `name` (generic, "opened main", from the open) becomes the main's own name, read at the same time, so the notices and the `mains` list name it. The file is durable and server-written, so a server restart keeps it. Renewing a row's `at` (each report) must keep the field, and the row caps (`addRoute`) must never drop a row that has a pending stop before rows without one.
- **The revoker carries it out.** The revoker takes stopped rows as a second reason, beside "the device lost dispatch" (`src/server/revoke.ts:42-84`). There are three differences:
  - It acts on the **first** sweep after acceptance; the server also triggers a sweep at once, and when a sweep is already in flight (it read the rows before the stop was written) one more pass follows it. The two-look rule guards against bad reads of the policy or roster, and a signed stop is no read.
  - It ignores `level`.
  - Its notices are the `main-stop-*` kinds above; their text names the requester's label and the reason, and never a session id (a broker miss is told as "the broker no longer lists it but its pane is still open").

  Everything else is the existing machinery: busy is asked again every 15 s and told once; gone takes two sweeps plus an absent pane; a main still in Herdr is reported; a stop that ends as gone is audited as `unit-stop-done` with `outcome: gone` and told as `main-stopped`; a notice nobody was told of is tried again.
- **`mode: quit`** is `boss_close_main` exactly. The tower side refuses a main that is not idle (`src/closemain.ts:80`), and the main refuses for anything running.
- **`mode: interrupt`** (decision 5) carries `interrupt: true` in the `close-main` payload. A main of this build that is not idle then calls `ctx.abort()` and answers busy; the next sweep finds it idle and quits it. The tower side skips its idle pre-check for this mode. Subagents, monitors and open dialogs still refuse, because they are work the abort does not end. An older main ignores the extra field (`onEvent`, `:47-52`) and behaves as `quit`. Whether `abort()` also drops pi's queued messages is unverified against the pinned pi. A queue that survives is just another busy answer.
- **No forced stop.** Nothing kills a pane or a pid. Even the box's own page Quit asks the session (`src/closer.ts:30-40`), and section 3 of the shared-box spec ruled out `kill` for a revoked controller.
- **How long a stop stays pending.** It stays until the main quits, is gone, or its route expires (7 days), as a revoke does (decision 8). There is no withdraw. A second stop of a pending main is a no-op, logged with the first `stopId`.
- **What the requester is told.**
  - The command answers with the outbox result: sent (queued at the relay) or refused, with the reason.
  - After that: the next `unit-status` shows `stopping`, then the main drops out, and the notices arrive.
  - A retry is a new `stopId`. Retrying a refused stop needs a fresh look at the units, because the handle may be gone.

## 6. The controller's side

### Pi (D23: boss-typed, the GUI calls the same function)

- **`/boss link units [device]`** lists each box's units and, under each unit, the mains this computer may stop: name, state, the dispatcher's label (for an admin), and the first 6 characters of the handle. It reads `link/state`, which already carries the holder's `units`.
- **`/boss link stop <device> <main name | handle prefix> [--interrupt] [reason]`**
  - It resolves the target against the last `mains` that box sent. An ambiguous or unknown name is an error that lists the candidates.
  - It asks a confirm in pi naming the box, the main, its dispatcher and the mode.
  - It then posts the control request `link/unit-stop {team, device, handle, mode, reason}` (`LINK_NAMES`, `src/control.ts:91`).
  - A slash command is boss-typed only, so a tower run, an ally run or a tool never reaches it (decision 9: no tool, and no `link_request` action in this cut).
- **The holder's `requestUnitStop`** checks the box's `caps`, builds the envelope through the team's outbox, and returns sent or the relay's refusal.

### GUI

- **Standard and Geek.** The ally card (`gui/allyunits.ts`) gains a fold "Mains (n)" per unit. Each row shows the name, a state word and, for an admin, the dispatcher's label, plus a **Stop** button that opens the page's confirm (Quit as `quit`; a second choice "Interrupt and quit" if decision 5 takes it). The button posts the same `link/unit-stop`. A row with `stopping` reads "stopping…" and has no button. A box without `unit-stop` in its caps shows the fold without buttons.
- **Zen.** Nothing: Zen shows one waiting item, and a stop is not one.
- **A paired phone.** It may stop: `unit-stop` joins `REMOTE_LINK` (`src/control.ts:90`), as `dialog-answer` did and as the page's Quit is allowed (decision 10).
- **Data.** The model data goes in `gui/linkmodel.ts` (`UnitCard` gains `mains`), with the strings in paraglide messages.

## 7. Open decisions

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | The carrier: a new kind `unit-stop`, or `tower` text read by the box's ally run | **The new kind** (relay table, vectors, relay redeploy) | `tower` text reaches a model. Either the model decides (the gap of section 2), or the holder parses peer text as a command, which every kind forbids ("never parsed as a header"). The relay cost is one table line plus a redeploy. |
| 2 | How results come back: through `notice` kinds, or a second new kind `unit-stop-result {stopId, outcome}` | **`notice`** | The admins need to be told anyway, `notice` is already scoped, and it keeps the relay change to one kind. The cost is that the page matches its pending stop through `unit-status` rather than by `stopId`. |
| 3 | Who may stop | **The main's dispatcher, and the roster admins of the main's team**, each attended and at `dispatch` on the box now | This is the G3 recipient set. A dev stopping its own work is natural, and that dev can already ask its ally run. An admin of another team is not one (g346-F001). An admin below `dispatch` is not one either: the box's policy decides who controls it. |
| 4 | Which units can be stopped | **Only mains an ally run opened** (route rows `opened`) | Only for these does the box keep a record of device and team, which authority needs. The boss's mains are the boss's. Mains the box's tower opened, and ally runs, have no dispatcher on record; an ally run also ends on its own when its turn ends. Ally runs can be added later. |
| 5 | Quit only, or also `interrupt` (abort the running turn, then quit) | **Take `interrupt` in this cut**: the `mode` field exists either way | The motivating case (§8 of unattended-device.md) is a main that never goes idle, which `quit` cannot end. `interrupt` loses only the turn in flight: no files and no subagent. Kill is not offered. If declined, v1 accepts `quit` only and refuses `interrupt` as `mode`. |
| 6 | How fresh a stop must be | **Refused when older than 15 minutes at the box** | A box that was offline for hours should not act on a stale view. 15 minutes is above the 10-minute future skew the envelope already allows, and the requester is told `stale`. |
| 7 | Close the gap of section 2 | **Yes, in this change-set.** An ally run's `boss_close_main` is refused, before the gate, for a main not opened for its own device (route table or pane token naming another device, or a main no ally route holds) | This is a cross-dev stop with no authority check. The new kind would be pointless while text still reaches any main. It narrows what a dev's own ally run may close, which is the change the boss must accept. |
| 8 | How long a stop stays pending | **Until the main quits, is gone, or its route expires (7 days); no withdraw** | Same as a revoke. The card shows "stopping". A withdraw would be another kind and another set of rules. |
| 9 | Pi path | **Slash commands only (`/boss link units`, `/boss link stop`); no model tool or `link_request` action now** | D23: the boss's typed input, out of reach of runs and tools. A tower that may stop a remote dev's work is a later and separate trust question. |
| 10 | May a paired phone stop | **Yes** (`REMOTE_LINK`) | The page's Quit and `dialog-answer` are allowed from a paired device, and a stop is graceful. The other answer is `BOSS_LOCAL` (this computer's page and pi only). |
| 11 | What `mains` shows whom | **The dispatcher sees its own mains; an admin sees every main of the team, with the dispatcher's label** | Same scope as the questions and notices. It amends row 10 of the shared-box spec (`unit-status` the same for every controller). |

## 8. Tests (red first) and the anchor

These tests are written red before the code. The anchor is `npm run check && npm test`, plus each of these files through `npm run test:one`:

| File | Covers |
|---|---|
| `tests/link-unit-stop-wire.test.ts` | `unit-stop` encode/decode (strict field count, ids, an unknown `mode` decodes and is refused later); `unit-status` with 1 and 2 fields; the kind rule (a `unit-stop` from an unattended sender is dropped by `openEnvelope`); `caps` gating both ways; the new vectors cases |
| `tests/link-unit-stop-authority.test.ts` | Holder refusals: an attended box, an unattended sender, a sender below `dispatch`, a refused policy, a stale `ts`, an unknown mode. Server refusals: an unknown handle; a handle of a main that restarted under the same name (new session id); another team's row; a dev who is neither dispatcher nor admin; an admin of another team; a pane token naming another device. Acceptances: the dispatcher's own main, and an admin of the same team. A refusal spends nothing and writes the `drop` line. |
| `tests/unit-stop.test.ts` (revoker, fake clock) | A stopped row is asked on the first sweep; busy is told once as pending; a quit ends it with `main-stopped` and forgets the route; gone needs two sweeps and an absent pane; the stop survives a server restart (it is on the route row); renewing a route keeps it; `interrupt` reaches the main and an older main acts as `quit` |
| `tests/link-unit-stop-notice.test.ts` | The outcome notices reach the dispatcher and the team's admins, never a third dev; a refusal reaches the requester's scope; `link.log` holds no reason text |
| `tests/ally-close-scope.test.ts` | Decision 7: an ally run's `boss_close_main` of another device's main, or of a main no ally route holds, is refused before the gate and spends no Allow |
| GUI and pi | `tests/link-model.test.ts` (`mains` cards, `stopping`, no button without caps); a control-route test for `link/unit-stop` (remote allowed or not, per decision 10); a `/boss link stop` parse/resolve/confirm test with the dialog's state signal (AGENTS.md: no key into a dialog by reading the screen) |

GUI key tests also run with a Linux `navigator.platform` (memory: 0.60.3 publish). The post-merge set includes `tests/imports.test.ts`.

## 9. Review and rollout

- **Review.** The change touches a trust boundary (wire, authority, a narrowed tool). By AGENTS.md it gets one fresh-context `reviewer` after the anchor passes, on the pi-straw-boss diff and on the `straw-relay` table and vectors change. Only P0 and P1 block.
- **Order.**
  1. Release the relay table change with its vectors, and redeploy the relay. This is a moldplan-center deploy and needs the boss's go.
  2. Release pi-straw-boss 0.61.0: a minor version, for the new wire.
  3. Upgrade the box.

  Until all three are done, the feature stays hidden or refused with a reason. Nothing breaks for old peers.
- **Docs.** Update `docs/how-it-works.md` (the commands, the card), `docs/unattended-device.md` §8 (remove "no remote stop"), the Message kinds table of the Straw Link spec (new kind, `unit-status` field, caps), and row 10 and the "Not done" line of the shared-box spec.

## 10. Tasks

1. **The ally close scope** (decision 7). Files: `src/server/runtools.ts`, test `tests/ally-close-scope.test.ts`. Depends on nothing; it can land first, on its own.
2. **Wire.** `kinds.ts` (new kind, optional `mains`), `holder.ts` (`CAPS_FEATURES`, `takeUnitStop`, `requestUnitStop`, the 2-field `unit-status` by caps), `tests/link/vectors.json`, and the straw-relay `kinds.go` with its testdata pointer. Test: `tests/link-unit-stop-wire.test.ts`.
3. **The box.** `src/server/unitstop.ts` (authority, handle map), the `stop` field in `allyroute.ts`, the revoker's second reason and its notices (`revoke.ts`, `unitstatus.ts runNotice`), `mains` in `main.ts` units, and `interrupt` in `closemain.ts`. Tests: authority, `unit-stop`, notice. Depends on 2.
4. **The controller.** `/boss link units` and `/boss link stop` (`bossopen.ts`), `control.ts` (`LINK_NAMES`, `REMOTE_LINK`), `gui/linkmodel.ts`, `gui/allyunits.ts`, messages. Depends on 2.
5. **Docs, a fresh review, and the release** in the order of section 9.

Tasks 3 and 4 depend only on 2 and can run in parallel worktrees from 2's commit.
