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
