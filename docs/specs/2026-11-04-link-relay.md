# Straw Link: relaying a teammate's report (0.58.1)

Status: built on `fix/link-relay` (base `main` 3ab250a, 0.58.0). Found in the unattended-box trials of 2026-11-04: the Mac (the boss) and the box (ally device `n2knna`, sb 0.58.0).

## 1. The two gaps

**Gap 1, Mac side.** The Mac's workspace tower (MP Center) sent a brief to the box "relayed for 無人塔台規劃" and said it would relay the report. The box's report landed in the Mac's link thread (`dir=in`) and went no further.

Root cause. The only server-side way an ally's answer reaches a local session is the D4 ask (`sb-backend` spec, *Replies for a main*): `tower_send({ device, reply: true, for })` records an ask, the ally answers it with `inReplyTo`, and the holder hands the reply to that main. The tower sent without `for`: `prompts/tower-run.md` never mentions `for` (only the tool's description does), and `reply: true` without `for` was accepted silently. A plain answer goes to an ally run on the Mac (a restricted session that cannot write to a local session without the boss's confirm), because a peer's text never enters a local run. So the relay depended on a model remembering a parameter, and the tower's "I will relay it" had no mechanism behind it.

**Gap 2, box side.** The box's tower (an ally run for the Mac) called `boss_open_main` for a Link sender. `opener.ts` looks the sender up among the live sessions (`id` or `name`); `link:<device id>` is no session, so it refused, the main was opened for no one, no route was made, and the main's report arrived as a local event at the box tower, which relayed it on its next run (trial 7: the post-reboot report waited for a wake).

## 2. Approach

Gap 1 binds the requester server-side; Gap 2 lets an ally run name its own device as the sender of a main it opens, so the existing route relays each report. Neither gives a peer's text new authority (§3 and §4 list each decision and trust note).

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | The server binds the requester of a `tower_send` that has `device` and `reply: true` and no `for`: the one session that sent the run a `call_tower` with `reply=expected` among the events the run took, when it is a live main of the workspace. | The tower can already name any main of its workspace with `for`, so binding the one that called it grants nothing new; it only stops the relay depending on the model. A device's answer cannot reach the tower itself (spec: no local run receives a peer's message), so a `reply: true` send without a requester is useless to the tower. The ask stays the D4 ask: single-use, from the device asked, 24 hours, peer data in a remote turn at the replying device's level. |
| 2 | With no requester or several, nothing is guessed. The tool says "No session is bound to this send. The answer reaches an ally run here, not you or any session; pass for with a main of this workspace…". | A guess would put a peer's text into a main with full rights that may not have asked. The explicit text ends the tower's promise to relay. |
| 3 | Waking the tower with the reply and a mandatory relay was rejected. | It puts a peer's text into a local run and lets the tower hand it to a main as an instruction, which the ally design keeps out (the D4 path exists to avoid this). |
| 4 | An ally run's `boss_open_main` accepts `sender` = `link:<device id>` or `link:<short id>`, only for the device the run was claimed for. The server fills the sender from the claim (`peerSender`, `runtools.ts`); any other `link:` sender is refused; a bare label or short id is not taken as a device (a session of this computer may carry it). | Same trust as before: the level gate, the "device is still a member" check, and the one-main-per-sender limit are unchanged. An ally gains no new reach: the main already could be opened for the run's sender at `dispatch`; only the failing lookup is fixed. |
| 5 | The relay is the route the server already made for an opened main (`ally-routes.json`, kind `opened`): each report of the main is stored as an answer for that device and wakes a run of that device at once, which sends it with `tower_send`. No new egress path; the report leaves in the ally run's `tower_send` to its sender only, as every ally answer. The main is told its report leaves the computer as written. | The server-direct send (no run) would need the server to author a message at the device's trust without the ally gate; the run keeps `tower_send` pinned to the sender and its checks. The cost is one model run on the box per report. |
| 6 | The route keeps the one ask the opening run carried (none when it carried several); a report answered by a run carries it back as `asks=<id>` and `tower_send inReplyTo` is accepted; the ask is spent once a run answers it. The role prompt tells the run to send the "under way" note without `inReplyTo`. | The Mac's ask is single-use, so an "under way" answer would use it up and the final report would be a plain message with no requester. |

## 4. Authorization notes

Each place the change touches a trust decision, and what it decides.

- **Who the main reports for** (`runtools.ts` `peerSender`): the run's claim (`who.device`), never the argument. `link:` + another device's id or short id is refused with "for its own sender only". The matching device must also be a member now (`who.gone` already refuses every tool of a run whose sender left).
- **Level** (`allyTool`): the open is gated as before. At `reply` and `forward` the boss's Allow for that call id and argument digest is required; the test holds the refusal. At `dispatch` it runs, as it did for a local sender.
- **Wrong thread**: a route carries the device; the answer is stored for that device and `waiting()` offers it only to a run of that device. A test starts a run of a second device first and checks it never sees the report. An ally `tower_reply` from another device to a main opened for this device is refused (fail closed: the message is not sent and no route is added), so a newer `expect` route cannot take the main's next report; no spec'd flow writes to another device's main.
- **Revoked trust**: the report is stored, then `beginAlly` finds the device is no longer a member and hands the answer back, which deletes it; no run starts, nothing is sent. A test checks it.
- **Requester binding** (`towers.ts` `requester`): from the queue's events taken by this run, header `kind=call_tower reply=expected`, one distinct sender, live main of this workspace by the broker's sessions and Herdr's pane token. A forged header from a non-main, or a main of another workspace, does not bind (`mainOf`).
- **Egress**: nothing beyond the report. The server sends nothing itself; the ally run's `tower_send` is pinned to the sender, as in `allyTool`.
- **Residual**: a main opened on a peer's request acts at full rights on peer text, as at 0.58.0 for `dispatch` (and with the boss's Allow below it). The handoff says the request is a peer's, not the boss's instruction.

## 5. Tests

`tests/link-relay-requester.test.ts` (Gap 1), `tests/link-relay-peer-main.test.ts` (Gap 2 and the refusals).

## 6. A requester outside the tower's workspace (0.58.2)

Found in box trial 8 (both ends 0.58.1): `無人塔台規劃`, a main of workspace Agent Root, called MP Center's tower with `call_tower` (reply expected) to brief the box. MP Center's tower sent to the box, but 0.58.1 binds only a main of the tower's own workspace, so no ask was recorded; the box's report reached an ally run on the Mac and never reached the requester. The tower had said beforehand that it could not bind `for` to a main outside its workspace.

| # | Decision | Why |
| --- | --- | --- |
| 7 | The requester, and an explicit `for`, may be a live main of any workspace on this computer, provided it sent THIS tower a `call_tower` with `reply=expected` among the events the current run took. A main of the tower's own workspace needs no call for `for`, as before. | The asker is the one party that already put its request in this tower's hands; the delivery (`holder.ts` `takeReply`, `runtime.ts` `takes`) goes to a session id and never compared workspaces. The ask stays in the tower's own workspace file. |
| 8 | `for` naming a session that did not call this tower in this run is refused when it is outside the tower's workspace, and so is any session that is no main (checked with Herdr's `sb_role` pane token, not the header). With 0 or 2+ askers nothing is guessed; the tool says no session is bound and `tower-run.md` tells the tower to say so to the requester. | The header text is the sender's own words; only an event the server queued for this run from that session id counts. No arbitrary local session becomes a target. |
| 9 | Unchanged: single use, 24 hours, bound to the device asked, dropped with a revoked device, `reply: true` needed for any `for`. | The ask machinery (`asks.ts`) is not touched. |

Tests: `tests/link-relay-requester.test.ts` (far main binds implicitly and by `for`; a far main that never called, a far member, two askers across workspaces, a far main that left, a call that expected no answer), `tests/link-reply-main.test.ts` (the answer reaches a main whose tower is in another workspace).
