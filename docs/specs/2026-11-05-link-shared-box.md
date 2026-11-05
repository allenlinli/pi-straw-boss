# Straw Link: an unattended box shared by several devs (0.58.4)

Status: built on `feat/link-g346` (base `main` eed4865, 0.58.3). Requests G6, G3 and G4 of 無人塔台規劃's plan for the shared "agent-tower" team (moldplan-center, `.pi/plans/2026-11-03-unattended-tower/infra-dashboard-join-plan.md` §2.4): one unattended box, one team, several devs each at `dispatch` through the signed policy.

Nothing here adds a message kind, a wire field, or a policy field. The signed policy still carries `unattended`, `trust` and `teams`, and nothing else.

## 1. Audit: who sent what to which run (G6)

The box's `link/link.log` answers "which device sent a message, and which run took it", without the text.

| # | Decision | Why |
| --- | --- | --- |
| 1 | The holder writes `tower-in` once per inbound `tower` or `tower-reply` it puts in the inbox: `kind`, `team`, `from` (the sender's device id), `id` (the envelope id, which is the inbox id), and `ask` (the ask id the message carries: the fifth field of a `tower`, the `inReplyTo` of a `tower-reply`; absent when there is none). | The line is written in the same locked step as the inbox file, so every message that is kept has exactly one line, and one the checks drop has the existing `drop` line instead. |
| 2 | The server tells the holder when an ally run takes a message into its session (`AllyPort.delivered`, called from the run's `taken`), and the holder writes `tower-run`: `run` (the ally run id), `team`, `from`, `id`, `ask`. A message the inbox no longer holds writes nothing. | The run id exists only on the server, and only at the take: a message the run was admitted for but never took (a crash) goes to the next run and is logged for that one. The `id` joins the two lines. |
| 3 | No line carries the text, a label, or the sender's workspace. | The log is read by the box's operators, who are not the senders. A device id and a run id are enough to find the run's session file. |

Tests: `tests/link-audit.test.ts` (the holder's lines and the absence of the text), `tests/server-ally-runs.test.ts` (the server calls `delivered` when the run takes the message, not when it is admitted or offered).

## 2. Who is told: a question or a notice goes to the controller that dispatched the unit, and the admins (G3)

Before this, every attended member of a running team at `dispatch` in the policy was sent every question a unit of the box asked and every notice about a run, and any of them could answer: dev A saw, and could answer, dev B's worker's question.

| # | Decision | Why |
| --- | --- | --- |
| 4 | A question or a notice is for the controllers that pass today's test (an attended member of a running team, at `dispatch` in the policy now), narrowed to **the controller that dispatched the unit, and the team's roster admins**. | The request's own set. The signed policy carries `unattended`, `trust` and `teams` only, so there is no policy-named set, and none is added (it would be a new policy field, which needs the boss). |
| 5 | The dispatcher of a unit is read where the box already keeps the fact: the pane of a live **ally run** is its device's (the server's own run record, with the team); the tab of a **main an ally run opened** is its device's (the `sb_opened_by=link:<device>` token the opener puts on the main's pane before its pi starts, so a worker in that tab counts too). Any other unit (the tower's own runs, a session the boss opened on the box, a worker in a tab of its own) has no dispatcher. | These are the two ways a controller starts anything on the box (`dispatcher.ts`). The tower's pane shares the ally runs' tab, so an ally pane is matched by its own pane id and never by its tab. |
| 6 | A unit with no dispatcher is the **admins' alone**. A lookup that fails, or a pane Herdr does not list, is the same. | Fails closed: the unknown is not shown to every dev. A single-boss box loses nothing: its boss is the admin. |
| 7 | **An answer is refused by the box**, not just hidden: `DialogForwarder.answer` checks that the sender is a recipient of that question now (the dispatcher, or an admin of the sender's team) before the digest and the answer id, and logs `drop` with `dialog-answer-not-recipient`. A refused answer spends neither the answer id nor the question. | Hiding the card is not a check: the sender's device holds the same keys and can post a `dialog-answer` for a dialog id it has guessed or kept. The holder's existing checks (attended sender, `dispatch` now, digest, single use, first answer wins, here-only choices) all stay. |
| 8 | The recipients are worked out at every pass. A unit found to be someone's later moves the question to it; a controller that stops being a recipient (a demoted admin, a changed dispatcher) is sent `dialog-close` with `by: withdrawn`, as one that loses `dispatch` is. | The roster and Herdr change under an open question. |
| 9 | The notices follow the same scope (`scope.ts`). An ally run's end or refusal is for its device (`RunSignal.device`, `.team`) and the admins; a local run's, and a question's `dialog-oversize` and `dialog-unanswered`, follow the unit (a local run: the admins); `tower-open-failed` is for the controller whose message found no tower, and the admins. `UnitReporter.notify` takes the scope as a required argument (`EVERYONE` is the old behavior, for a computer that cannot tell). | A notice names a path or a reason from the box. A notice nobody was told is not remembered as told. |
| 10 | **Unchanged:** `unit-status` (each unit's state, monitors, and a report that is already the last `tower_send` text to that very controller), a forwarded confirm of a remote turn (already for the sender's own device), the 24 hour single-use asks, device binding, and revocation. | Out of the request. `unit-status` still shows every controller the same unit list; it carries no question and no notice text. |

Residual. The box's units run as one Unix account, and the token on a pane is Herdr state that any process of that account can write, as the close of a main already trusts it; so this decides whom the box bothers and whom it accepts an answer from, and is no wall between two devs who both hold a shell there. A worker a main starts in a tab of its own is nobody's: its question goes to the admins.

Tests: `tests/link-scope.test.ts` (the scope rule, the forwarder's recipients, withdrawal, the refused answer, the notices), `tests/server-dispatcher.test.ts` (whose pane is whose), `tests/server-link-units.test.ts` (the real wiring: a run nobody dispatched reaches the admin and not a second controller), `tests/server-ally-runs.test.ts` (the signal names the device and team, the ally panes are listed), `tests/link-unattended-dialogs.test.ts` (`isAdmin`), `tests/link-holder.test.ts` (the open names the controller).
